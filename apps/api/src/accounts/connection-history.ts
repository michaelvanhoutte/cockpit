import { and, desc, eq, sql } from 'drizzle-orm';
import type { ConnectionHistoryLine } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { SourceAccountNotFoundError } from './command-service.js';
import { getSourceAccount } from './repo.js';
import { connectionHistory } from './schema.js';
import {
  HISTORY_MOST_LINES,
  whatACheckWrites,
  type CheckOutcome,
  type CheckReason,
} from '../domain/connection-history.js';

/**
 * A connection's history in the account's store ("See when a pulled
 * connection was checked, and why it failed, from its row's History…", issue
 * 1140): the line each check's end writes, and the read *History…* opens.
 */

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];

/**
 * Writes the line of a check that ended at `at`, inside the transaction that
 * ends it: the line before it extended where the check is alike
 * (`whatACheckWrites`), a line of its own otherwise.
 */
export function recordCheck(
  tx: InATransaction,
  accountName: string,
  sourceAccountId: string,
  reason: CheckReason,
  ended: CheckOutcome,
  at: string,
): void {
  const previous = tx
    .select({
      id: connectionHistory.id,
      outcome: connectionHistory.outcome,
      message: connectionHistory.message,
      messageCut: connectionHistory.messageCut,
    })
    .from(connectionHistory)
    .where(and(eq(connectionHistory.tenantId, accountName), eq(connectionHistory.sourceAccountId, sourceAccountId)))
    .orderBy(desc(connectionHistory.lastAt), desc(connectionHistory.firstAt))
    .limit(1)
    .get();
  if (previous && whatACheckWrites(previous, ended) === 'extend') {
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
      count: 1,
      firstAt: at,
      lastAt: at,
    })
    .run();
}

/**
 * One connection's history, newest line first and at most
 * `HISTORY_MOST_LINES` of it - refused as not found unless the connection is
 * this Workspace's and still connected.
 */
export function connectionHistoryOf(
  db: AccountDb,
  accountName: string,
  workspaceId: string,
  sourceAccountId: string,
): ConnectionHistoryLine[] {
  const held = getSourceAccount(db, accountName, sourceAccountId);
  if (!held || held.workspaceId !== workspaceId) throw new SourceAccountNotFoundError(sourceAccountId);
  return db
    .select({
      id: connectionHistory.id,
      outcome: connectionHistory.outcome,
      reason: connectionHistory.reason,
      message: connectionHistory.message,
      messageCut: connectionHistory.messageCut,
      count: connectionHistory.count,
      firstAt: connectionHistory.firstAt,
      lastAt: connectionHistory.lastAt,
    })
    .from(connectionHistory)
    .where(and(eq(connectionHistory.tenantId, accountName), eq(connectionHistory.sourceAccountId, sourceAccountId)))
    .orderBy(desc(connectionHistory.lastAt), desc(connectionHistory.firstAt))
    .limit(HISTORY_MOST_LINES)
    .all();
}
