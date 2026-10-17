import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { CheckDidShown, ConnectionHistoryLine } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { SourceAccountNotFoundError } from './command-service.js';
import { getSourceAccount } from './repo.js';
import { connectionHistory, items } from './schema.js';
import {
  HISTORY_MOST_LINES,
  didAnything,
  keptDid,
  whatACheckWrites,
  type CheckDid,
  type CheckEnded,
  type CheckOutcome,
  type CheckReason,
  type DidKept,
} from '../domain/connection-history.js';

/**
 * A connection's history in the account's store ("See when a pulled
 * connection was checked, and why it failed, from its row's History…", issue
 * 1140): the line each check's end writes, and the read *History…* opens.
 */

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];

type DidAsStored = Record<keyof CheckDid, DidKept>;

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
  const checkEnded: CheckOutcome = { ...ended, did: didAnything(did), reason };
  if (previous && whatACheckWrites({ ...previous, did: previous.did !== null }, checkEnded) === 'extend') {
    tx.update(connectionHistory)
      .set({ count: sql`${connectionHistory.count} + 1`, lastAt: at })
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
    })
    .run();
}

/**
 * One connection's history, newest line first and at most
 * `HISTORY_MOST_LINES` of it - refused as not found unless the connection is
 * this Workspace's and still connected. Each Item a line names is named by its
 * title now - dismissed or not - null only where no such Item is held, and left
 * out where it is another Workspace's (issue 1141).
 */
export function connectionHistoryOf(
  db: AccountDb,
  accountName: string,
  workspaceId: string,
  sourceAccountId: string,
): ConnectionHistoryLine[] {
  const held = getSourceAccount(db, accountName, sourceAccountId);
  if (!held || held.workspaceId !== workspaceId) throw new SourceAccountNotFoundError(sourceAccountId);
  const lines = db
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
    })
    .from(connectionHistory)
    .where(and(eq(connectionHistory.tenantId, accountName), eq(connectionHistory.sourceAccountId, sourceAccountId)))
    .orderBy(desc(connectionHistory.lastAt), desc(connectionHistory.firstAt))
    .limit(HISTORY_MOST_LINES)
    .all();
  const stored = lines.map((line) => (line.did === null ? null : (JSON.parse(line.did) as DidAsStored)));
  const titles = titlesOf(
    db,
    accountName,
    workspaceId,
    stored.flatMap((did) => (did ? KINDS.flatMap((kind) => did[kind].ids) : [])),
  );
  return lines.map(({ did: _did, ...line }, index) => ({ ...line, did: shown(stored[index] ?? null, titles) }));
}

type ItemNamed = { title: string | null; dismissed: boolean };

/** What a line did, with each Item named; nothing where it did nothing. */
function shown(did: DidAsStored | null, titles: Map<string, ItemNamed>): CheckDidShown {
  const kind = (which: keyof CheckDid) => ({
    count: did?.[which].count ?? 0,
    items: (did?.[which].ids ?? []).flatMap((id) => {
      const named = titles.get(id);
      return named ? [{ id, ...named }] : [];
    }),
  });
  return { broughtIn: kind('broughtIn'), closed: kind('closed'), sentBack: kind('sentBack'), refused: kind('refused') };
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
