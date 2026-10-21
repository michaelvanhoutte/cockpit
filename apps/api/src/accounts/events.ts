import { and, desc, eq, gt, max } from 'drizzle-orm';
import { ACCOUNT_WIDE, type CommandName, type ServerEvent } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { commands, connectionHistory, connectorAccounts, itemMeanings, items } from './schema.js';

/** The changes to a remembered sentence, which the stream announces on their own (`collectInvalidations`). */
const REMEMBERED_SENTENCE_COMMANDS: ReadonlySet<string> = new Set([
  'remember_sentence',
  'edit_remembered_sentence',
  'delete_remembered_sentence',
] satisfies CommandName[]);

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
    .select({ workspaceId: commands.workspaceId, name: commands.name, receivedAt: commands.receivedAt })
    .from(commands)
    .where(and(eq(commands.tenantId, tenantId), gt(commands.receivedAt, since)))
    .all();

  let cursor = since;
  let sentencesChanged = false;
  // POC (own-event refetch): the newest change per workspace rather than the
  // set of workspaces, so each event can say when it happened. A poll covering
  // several changes to one workspace answers for the last of them, which is
  // what a tab compares its own copy against.
  const newestPerWorkspace = new Map<string, string>();
  const sawChange = (workspaceId: string, at: string) => {
    const seen = newestPerWorkspace.get(workspaceId);
    if (seen === undefined || at > seen) newestPerWorkspace.set(workspaceId, at);
    if (at > cursor) cursor = at;
  };
  for (const row of rows) {
    // **A remembered sentence is no Workspace's**: nothing a Workspace draws moves
    // with it, so it is announced for the list of sentences alone ("Show a
    // remembered-sentence change the moment you make it", issue 1370). The
    // cursor still passes it, or the next poll would find it again.
    if (REMEMBERED_SENTENCE_COMMANDS.has(row.name)) {
      sentencesChanged = true;
      if (row.receivedAt > cursor) cursor = row.receivedAt;
    } else sawChange(row.workspaceId, row.receivedAt);
  }

  /**
   * **A note being read for what it means is a change nothing logs a command
   * for**, and it moves what the Inbox draws: it is what makes a note say it
   * may be repeating another ("Flag a captured note that says what another one
   * already said", issue 407). So the readings are a second source of the same
   * event, and without it a mark would sit unseen until the next thing somebody
   * did happened to refresh the page.
   *
   * **Losing a reading is one of those changes too**, which is why forgetting
   * one empties the row and stamps it rather than deleting it (`forgetMeaning`,
   * repo.ts): a row that has gone is newer than nothing, so this query would
   * pass straight over it and leave every tab drawing a mark the note no longer
   * earns.
   *
   * A note nobody has said the Workspace of is drawn in every Workspace's
   * Inbox, so its reading is a change to all of them - which is what
   * `ACCOUNT_WIDE` says.
   */
  for (const row of readingsSince(db, tenantId, since).all()) {
    sawChange(row.workspaceDecided ? row.workspaceId : ACCOUNT_WIDE, row.readAt);
  }

  const events: ServerEvent[] = [...newestPerWorkspace].map(([workspaceId, at]) => ({
    type: 'snapshot_invalidated',
    workspaceId,
    at,
  }));

  if (sentencesChanged) events.push({ type: 'remembered_sentences_changed' });

  /**
   * **A check's end writes no command**, and the line it writes moves what an
   * open history draws ("Check a pulled connection now, from its row or its
   * history", issue 1143). So the lines are a source of their own event, naming
   * the connection and not the snapshot, which they do not change.
   */
  for (const line of historyWrittenSince(db, tenantId, since).all()) {
    events.push({ type: 'connection_history_changed', workspaceId: line.workspaceId, sourceAccountId: line.sourceAccountId });
    if (line.lastAt > cursor) cursor = line.lastAt;
  }
  return { events, cursor };
}

/**
 * The connections of a live Workspace whose history a check wrote to after a
 * cursor, each once with the newest time - a line a quiet check extends moves
 * its `last_at`, so it counts as written too. Unrun, so the test that proves a
 * poll with nothing new reads no line can plan this very statement.
 */
export function historyWrittenSince(db: AccountDb, tenantId: string, since: string) {
  return db
    .select({
      workspaceId: connectorAccounts.workspaceId,
      sourceAccountId: connectionHistory.sourceAccountId,
      lastAt: max(connectionHistory.lastAt).mapWith(String),
    })
    .from(connectionHistory)
    .innerJoin(connectorAccounts, eq(connectorAccounts.id, connectionHistory.sourceAccountId))
    .where(
      and(
        eq(connectionHistory.tenantId, tenantId),
        eq(connectorAccounts.tenantId, tenantId),
        gt(connectionHistory.lastAt, since),
      ),
    )
    .groupBy(connectorAccounts.workspaceId, connectionHistory.sourceAccountId);
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

/**
 * The readings newer than a cursor, unrun - so the test that proves a poll with
 * nothing new visits no readings can plan this very statement rather than a
 * copy of it (`item_meanings_tenant_read_at` is what it is answered from).
 */
export function readingsSince(db: AccountDb, tenantId: string, since: string) {
  return db
    .select({
      workspaceId: items.workspaceId,
      workspaceDecided: items.workspaceDecided,
      readAt: itemMeanings.readAt,
    })
    .from(itemMeanings)
    .innerJoin(items, eq(itemMeanings.itemId, items.id))
    .where(and(eq(itemMeanings.tenantId, tenantId), gt(itemMeanings.readAt, since)));
}