import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { CheckDidShown, CommandPayload, CommandResult, ConnectionHistory } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { SourceAccountNotFoundError, runCommand } from './command-service.js';
import { getSourceAccount } from './repo.js';
import { connectionHistory, items } from './schema.js';
import {
  HISTORY_MOST_LINES,
  didAnything,
  keptDid,
  keptMessage,
  whatACheckWrites,
  type CheckDid,
  type DidKind,
  type CheckEnded,
  type CheckOutcome,
  type CheckReason,
  type DidStored,
} from '../domain/connection-history.js';

/**
 * A connection's history in the account's store ("See when a pulled
 * connection was checked, and why it failed, from its row's History…", issue
 * 1140): the line each check's end writes, and the read *History…* opens.
 */

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];

const KINDS = ['broughtIn', 'closed', 'sentBack', 'refused'] as const;

/** How many Item ids one statement binds when naming Items. */
const NAMED_AT_A_TIME = 50;

/**
 * Writes the line of a check that ended at `at`, inside the transaction that
 * ends it: the line before it extended where the check is alike
 * (`whatACheckWrites`), a line of its own otherwise. A check that did
 * anything is a line of its own, keeping what it did (issue 1141).
 */
export function recordCheck(
  tx: InATransaction,
  accountName: string,
  sourceAccountId: string,
  reason: CheckReason,
  ended: CheckEnded,
  did: CheckDid,
  at: string,
): void {
  const previous = tx
    .select({
      id: connectionHistory.id,
      reason: connectionHistory.reason,
      outcome: connectionHistory.outcome,
      message: connectionHistory.message,
      messageCut: connectionHistory.messageCut,
      status: connectionHistory.status,
      did: connectionHistory.did,
    })
    .from(connectionHistory)
    .where(and(eq(connectionHistory.tenantId, accountName), eq(connectionHistory.sourceAccountId, sourceAccountId)))
    .orderBy(desc(connectionHistory.lastAt), desc(connectionHistory.firstAt))
    .limit(1)
    .get();
  const kept = keptDid(did);
  // Only a check that worked has a complete listing to count (issue 1196).
  const listed = ended.outcome === 'worked' ? (did.listed ?? null) : null;
  const checkEnded: CheckOutcome = { ...ended, did: didAnything(did), reason };
  if (previous && whatACheckWrites({ ...previous, did: previous.did !== null }, checkEnded) === 'extend') {
    tx.update(connectionHistory)
      .set({ count: sql`${connectionHistory.count} + 1`, lastAt: at, listed })
      .where(and(eq(connectionHistory.tenantId, accountName), eq(connectionHistory.id, previous.id)))
      .run();
    return;
  }
  tx.insert(connectionHistory)
    .values({
      id: crypto.randomUUID(),
      tenantId: accountName,
      sourceAccountId,
      outcome: ended.outcome,
      reason,
      message: ended.outcome === 'failed' ? ended.message : null,
      messageCut: ended.outcome === 'failed' && ended.messageCut,
      status: ended.outcome === 'failed' ? ended.status : null,
      count: 1,
      firstAt: at,
      lastAt: at,
      did: kept === null ? null : JSON.stringify(kept),
      listed,
    })
    .run();
}

/**
 * Files a delivery a source pushed, attributed to one connection ("See what
 * each Teams save became, in its connection's history", issue 1144): the
 * capture and the line naming the Item it made are one transaction, so neither
 * lands without the other. A delivery whose capture made nothing new - the same
 * click delivered again - writes no second line, and one whose connection has
 * gone since it was attributed writes no line to nobody.
 */
export function capturePushed(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  capture: CommandPayload<'capture_item'>,
  at: string,
): CommandResult {
  return db.transaction((tx) => {
    const result = runCommand(db, accountName, 'capture_item', capture);
    if (result.applied && getSourceAccount(db, accountName, sourceAccountId)) {
      recordCheck(
        tx,
        accountName,
        sourceAccountId,
        'delivery',
        { outcome: 'worked' },
        { broughtIn: [capture.itemId], closed: [], sentBack: [], refused: [] },
        at,
      );
    }
    return result;
  });
}

/**
 * Writes the *Failed* line of a delivery that failed after it was attributed
 * to a connection (issue 1144). The message is kept to 2 KB like a pulled
 * check's; nothing happens where the connection has gone.
 */
export function recordPushFailed(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  failure: { message: string; status: number | null },
  at: string,
): void {
  if (!getSourceAccount(db, accountName, sourceAccountId)) return;
  db.transaction((tx) =>
    recordCheck(
      tx,
      accountName,
      sourceAccountId,
      'delivery',
      { outcome: 'failed', ...keptMessage(failure.message), status: failure.status },
      { broughtIn: [], closed: [], sentBack: [], refused: [] },
      at,
    ),
  );
}

/**
 * One connection's history, newest line first and at most
 * `HISTORY_MOST_LINES` of it, saying whether older lines remain beyond it
 * (issue 1145) - refused as not found unless the connection is this
 * Workspace's and still connected. Each Item a line names is named by its
 * title now - dismissed or not - null only where no such Item is held, and left
 * out where it is another Workspace's (issue 1141).
 */
export function connectionHistoryOf(
  db: AccountDb,
  accountName: string,
  workspaceId: string,
  sourceAccountId: string,
): ConnectionHistory {
  const held = getSourceAccount(db, accountName, sourceAccountId);
  if (!held || held.workspaceId !== workspaceId) throw new SourceAccountNotFoundError(sourceAccountId);
  const read = db
    .select({
      id: connectionHistory.id,
      outcome: connectionHistory.outcome,
      reason: connectionHistory.reason,
      message: connectionHistory.message,
      messageCut: connectionHistory.messageCut,
      status: connectionHistory.status,
      count: connectionHistory.count,
      firstAt: connectionHistory.firstAt,
      lastAt: connectionHistory.lastAt,
      did: connectionHistory.did,
      listed: connectionHistory.listed,
    })
    .from(connectionHistory)
    .where(and(eq(connectionHistory.tenantId, accountName), eq(connectionHistory.sourceAccountId, sourceAccountId)))
    .orderBy(desc(connectionHistory.lastAt), desc(connectionHistory.firstAt))
    // One more than the read carries, to learn whether older lines remain.
    .limit(HISTORY_MOST_LINES + 1)
    .all();
  const olderRemain = read.length > HISTORY_MOST_LINES;
  const lines = read.slice(0, HISTORY_MOST_LINES);
  const stored = lines.map((line) => (line.did === null ? null : (JSON.parse(line.did) as DidStored)));
  const titles = titlesOf(
    db,
    accountName,
    workspaceId,
    stored.flatMap((did) =>
      did ? [...KINDS.flatMap((kind) => did[kind].ids), ...(did.named?.messages.map((one) => one.itemId) ?? [])] : [],
    ),
  );
  return {
    lines: lines.map(({ did: _did, ...line }, index) => ({ ...line, did: shown(stored[index] ?? null, titles) })),
    olderRemain,
  };
}

/**
 * Deletes every line of the account's connections' history that last ran
 * before `keptFrom` ("Keep a connection's history 30 days, and fold a quiet
 * past day into one line", issue 1145), and answers how many went. One
 * statement, so a store's deletion is applied whole or not at all, and a
 * second run with the same `keptFrom` finds nothing. A line's end decides: one
 * folded across the boundary is kept whole. Nothing else is touched.
 */
export function pruneConnectionHistory(db: AccountDb, accountName: string, keptFrom: string): number {
  return db
    .delete(connectionHistory)
    .where(and(eq(connectionHistory.tenantId, accountName), lt(connectionHistory.lastAt, keptFrom)))
    .returning({ id: connectionHistory.id })
    .all().length;
}

type ItemNamed = { title: string | null; dismissed: boolean };

/** What a line did, with each Item named; nothing where it did nothing. */
function shown(did: DidStored | null, titles: Map<string, ItemNamed>): CheckDidShown {
  const kind = (which: DidKind) => ({
    count: did?.[which].count ?? 0,
    items: (did?.[which].ids ?? []).flatMap((id) => {
      const named = titles.get(id);
      return named ? [{ id, ...named }] : [];
    }),
  });
  return {
    broughtIn: kind('broughtIn'),
    closed: kind('closed'),
    sentBack: kind('sentBack'),
    refused: kind('refused'),
    named: {
      count: did?.named?.count ?? 0,
      messages: (did?.named?.messages ?? []).flatMap(({ itemId, names }) => {
        const named = titles.get(itemId);
        return named ? [{ id: itemId, ...named, names }] : [];
      }),
    },
  };
}

/**
 * Each Item of this Workspace by its title now, and whether it is dismissed
 * (`items.deletedAt`, the Dismissed tombstone - no Item is ever removed), which
 * the Item form does not open. The title is null only for an id with no row. An
 * id of another Workspace is left out of the map altogether, so a line cannot
 * name another Workspace's Item.
 */
function titlesOf(
  db: AccountDb,
  accountName: string,
  workspaceId: string,
  ids: readonly string[],
): Map<string, ItemNamed> {
  const wanted = [...new Set(ids)];
  const named = new Map<string, ItemNamed>();
  const found = new Map<string, { title: string; workspaceId: string; deletedAt: string | null }>();
  for (let from = 0; from < wanted.length; from += NAMED_AT_A_TIME) {
    const rows = db
      .select({ id: items.id, title: items.title, workspaceId: items.workspaceId, deletedAt: items.deletedAt })
      .from(items)
      .where(and(eq(items.tenantId, accountName), inArray(items.id, wanted.slice(from, from + NAMED_AT_A_TIME))))
      .all();
    for (const row of rows) found.set(row.id, row);
  }
  for (const id of wanted) {
    const row = found.get(id);
    if (!row) named.set(id, { title: null, dismissed: false });
    else if (row.workspaceId === workspaceId) named.set(id, { title: row.title, dismissed: row.deletedAt !== null });
  }
  return named;
}
