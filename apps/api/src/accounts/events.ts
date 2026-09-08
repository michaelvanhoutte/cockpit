import { and, desc, eq, gt } from 'drizzle-orm';
import type { ServerEvent } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { commands } from './schema.js';

/**
 * SSE invalidation source (architecture, "The read model", amended by
 * reality): a module-level in-memory bus does NOT work on the Workers runtime,
 * because one request context may not write to another request's response
 * stream ("Cannot perform I/O on behalf of a different request"). Instead, each
 * SSE connection polls the command log - which every write already lands in for
 * idempotency - from inside its own request context.
 *
 * **The stream stays in the Worker, and only this query moves into the store.**
 * Durable Objects bill wall-clock duration and an open connection keeps one in
 * memory, so a long-lived stream is the one thing that must not live inside an
 * account's object (see
 * [account-storage-options.md](../../../../docs/account-storage-options.md)).
 * The Worker polls the account; the account does not hold the stream.
 */
export function collectInvalidations(
  db: AccountDb,
  tenantId: string,
  since: string,
): { events: ServerEvent[]; cursor: string } {
  const rows = db
    .select({ workspaceId: commands.workspaceId, receivedAt: commands.receivedAt })
    .from(commands)
    .where(and(eq(commands.tenantId, tenantId), gt(commands.receivedAt, since)))
    .all();

  let cursor = since;
  // POC (own-event refetch): the newest change per workspace rather than the
  // set of workspaces, so each event can say when it happened. A poll covering
  // several changes to one workspace answers for the last of them, which is
  // what a tab compares its own copy against.
  const newestPerWorkspace = new Map<string, string>();
  for (const row of rows) {
    const seen = newestPerWorkspace.get(row.workspaceId);
    if (seen === undefined || row.receivedAt > seen) {
      newestPerWorkspace.set(row.workspaceId, row.receivedAt);
    }
    if (row.receivedAt > cursor) cursor = row.receivedAt;
  }

  const events: ServerEvent[] = [...newestPerWorkspace].map(([workspaceId, at]) => ({
    type: 'snapshot_invalidated',
    workspaceId,
    at,
  }));
  return { events, cursor };
}

/**
 * POC (own-event refetch): the newest change this account has taken, for a
 * snapshot to be stamped with (`upTo` in workspaceSnapshotSchema, where the
 * reasoning lives).
 *
 * **Read before the rows it vouches for, never after.** Both orders are atomic
 * inside the object today, so both work; they fail differently if that ever
 * stops being true. Read first, a snapshot can only under-claim - it contains
 * changes its stamp does not mention - and the cost is a refetch that was not
 * needed. Read last, it can claim a change it does not contain, and a tab
 * skips a refetch it needed. Only one of those two heals on its own.
 *
 * `undefined` where the account has never taken a change.
 */
export function watermark(db: AccountDb, tenantId: string): string | undefined {
  const row = db
    .select({ receivedAt: commands.receivedAt })
    .from(commands)
    .where(eq(commands.tenantId, tenantId))
    .orderBy(desc(commands.receivedAt))
    .limit(1)
    .get();
  return row?.receivedAt;
}
