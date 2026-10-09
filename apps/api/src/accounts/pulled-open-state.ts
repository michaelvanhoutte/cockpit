import { and, eq, exists, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { OpenStateWanted } from '@cockpit/connector-sdk';
import type { AccountDb } from './client.js';
import { connectorAccounts, pulledConnections, pulledLinks } from './schema.js';

/**
 * What a person's change to an Item asks of a pulled source that mirrors its
 * open state, through the generic host ("Mirror an Item's open state back to
 * a pulled source through the generic host", issue 893), naming no source.
 *
 * **Wanted state, not an event**: the link the host keeps for the Item records
 * what Cockpit wants the source to show until the connector confirms it,
 * written in the same transaction as the Item, so a run that stops before
 * pushing it leaves it waiting rather than lost, and a quick undo replaces it
 * rather than replaying behind it. Each run hands the connector every one
 * still waiting before it reads (`pulled-host.ts`), and a change still waiting
 * wins over the source's own (`applyPulledSourceChange`, pulled.ts).
 *
 * `mirroring` is which connectors mirror open state - the registry's to say,
 * and never more values than there are connectors.
 */

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];

/** Open is neither done nor dismissed: what a mirrored source's own mark stands for. */
export function isOpen(item: { completedAt: string | null; deletedAt: string | null }): boolean {
  return item.completedAt === null && item.deletedAt === null;
}

/**
 * Records the open state an Item has just moved to as wanted of its link -
 * where it moved at all, where its connector mirrors, and only while its
 * connection is still held, since disconnecting stops the mirroring.
 */
export function wantPulledOpenStateMirrored(
  tx: InATransaction,
  tenantId: string,
  before: { id: string; completedAt: string | null; deletedAt: string | null },
  after: { completedAt: string | null; deletedAt: string | null },
  mirroring: readonly string[],
): void {
  const open = isOpen(after);
  if (mirroring.length === 0 || isOpen(before) === open) return;
  tx.update(pulledLinks)
    .set({ openWanted: open })
    .where(
      and(
        eq(pulledLinks.tenantId, tenantId),
        eq(pulledLinks.itemId, before.id),
        inArray(pulledLinks.connectorId, [...mirroring]),
        exists(
          tx
            .select({ id: connectorAccounts.id })
            .from(connectorAccounts)
            .where(
              and(
                eq(connectorAccounts.tenantId, tenantId),
                eq(connectorAccounts.connectorId, pulledLinks.connectorId),
                eq(connectorAccounts.workspaceId, pulledLinks.workspaceId),
                eq(connectorAccounts.externalAccountKey, pulledLinks.externalAccountKey),
              ),
            ),
        ),
      ),
    )
    .run();
}

/** A connection going takes whatever it had still to push with it. */
export function dropPulledWanted(
  tx: InATransaction,
  tenantId: string,
  connection: { workspaceId: string; connectorId: string; externalAccountKey: string },
): void {
  tx.update(pulledLinks)
    .set({ openWanted: null })
    .where(
      and(
        eq(pulledLinks.tenantId, tenantId),
        eq(pulledLinks.workspaceId, connection.workspaceId),
        eq(pulledLinks.connectorId, connection.connectorId),
        eq(pulledLinks.externalAccountKey, connection.externalAccountKey),
        isNotNull(pulledLinks.openWanted),
      ),
    )
    .run();
}

/**
 * Whether the Item's link has a change waiting for its source - and, where it
 * has, makes the connection's check due now, so the change reaches the source
 * within seconds rather than at the next five-minute check. A connection
 * whose check is already queued or running is left: that check reads what is
 * waiting when it starts, and a run in hand holds the connection's time.
 */
export function bringPulledCheckForward(db: AccountDb, tenantId: string, itemId: string, now: Date): boolean {
  const link = db
    .select({
      workspaceId: pulledLinks.workspaceId,
      connectorId: pulledLinks.connectorId,
      externalAccountKey: pulledLinks.externalAccountKey,
    })
    .from(pulledLinks)
    .where(and(eq(pulledLinks.tenantId, tenantId), eq(pulledLinks.itemId, itemId), isNotNull(pulledLinks.openWanted)))
    .get();
  if (!link) return false;
  db.update(pulledConnections)
    .set({ dueAt: now.toISOString() })
    .where(
      and(
        eq(pulledConnections.tenantId, tenantId),
        isNull(pulledConnections.queuedAt),
        isNull(pulledConnections.runId),
        gt(pulledConnections.dueAt, now.toISOString()),
        exists(
          db
            .select({ id: connectorAccounts.id })
            .from(connectorAccounts)
            .where(
              and(
                eq(connectorAccounts.id, pulledConnections.sourceAccountId),
                eq(connectorAccounts.tenantId, tenantId),
                eq(connectorAccounts.workspaceId, link.workspaceId),
                eq(connectorAccounts.connectorId, link.connectorId),
                eq(connectorAccounts.externalAccountKey, link.externalAccountKey),
              ),
            ),
        ),
      ),
    )
    .run();
  return true;
}

/** Every open state still waiting for the source of this connection, as the connector is handed it. */
export function openStatesWaiting(
  db: AccountDb,
  tenantId: string,
  connection: { workspaceId: string; connectorId: string; externalAccountKey: string },
): OpenStateWanted[] {
  return db
    .select({ sourceId: pulledLinks.sourceId, open: pulledLinks.openWanted })
    .from(pulledLinks)
    .where(
      and(
        eq(pulledLinks.tenantId, tenantId),
        eq(pulledLinks.workspaceId, connection.workspaceId),
        eq(pulledLinks.connectorId, connection.connectorId),
        eq(pulledLinks.externalAccountKey, connection.externalAccountKey),
        isNotNull(pulledLinks.openWanted),
      ),
    )
    .all()
    .map((row) => ({ sourceId: row.sourceId, open: row.open === true }));
}

/**
 * Clears what the source confirmed holding or the connector gave up on - each only where it is still
 * what was handed over, so a change made while the connector pushed is kept
 * waiting. One statement per link, so no statement's parameters grow with how
 * many were waiting.
 */
export function confirmOpenStates(
  db: AccountDb,
  tenantId: string,
  connection: { workspaceId: string; connectorId: string; externalAccountKey: string },
  confirmed: readonly OpenStateWanted[],
): void {
  db.transaction((tx) => {
    for (const { sourceId, open } of confirmed) {
      tx.update(pulledLinks)
        .set({ openWanted: null })
        .where(
          and(
            eq(pulledLinks.tenantId, tenantId),
            eq(pulledLinks.workspaceId, connection.workspaceId),
            eq(pulledLinks.connectorId, connection.connectorId),
            eq(pulledLinks.externalAccountKey, connection.externalAccountKey),
            eq(pulledLinks.sourceId, sourceId),
            eq(pulledLinks.openWanted, open),
          ),
        )
        .run();
    }
  });
}
