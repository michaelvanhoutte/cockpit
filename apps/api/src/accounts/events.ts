import { and, gt } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
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
  const workspaceIds = new Set<string>();
  for (const row of rows) {
    workspaceIds.add(row.workspaceId);
    if (row.receivedAt > cursor) cursor = row.receivedAt;
  }

  const events: ServerEvent[] = [...workspaceIds].map((workspaceId) => ({
    type: 'snapshot_invalidated',
    workspaceId,
  }));
  return { events, cursor };
}
