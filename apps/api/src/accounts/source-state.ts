import { and, eq } from 'drizzle-orm';
import type { SourceStateChange } from '@cockpit/connector-sdk';
import type { Item } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { runCommand } from './command-service.js';
import { getItem, recentCapturedTimeZones } from './repo.js';
import { connectorAccounts, pulledLinks } from './schema.js';
import { dueDateIsTheConnections, dueDateOnArrival } from '../domain/due-in-days.js';

/** The source-state changes the host applies to an Item; `removed` is not yet one. */
export type AppliedSourceChange = Exclude<SourceStateChange['change'], 'removed'>;

/**
 * What the host does with a connector's source-state change (the SDK's
 * `SourceStateChange`): `resolved` marks the Item done, `reopened` makes it
 * open and undismissed ("Close a Gmail task when its label comes off, and
 * reopen it when it goes back", issue 727).
 *
 * **Through the same changes a person makes** - `set_done` and
 * `set_dismissed` - so the command log records them and open tabs hear of
 * them like any other change; but as the source's own, so they ask nothing
 * of a source mirroring the Item's open state in return ("Take the Cockpit
 * label off in Gmail when its task is done in Cockpit", issue 728).
 *
 * **A reopen also gives a date still the connection's a fresh one**, in the
 * same transaction (`givenAFreshDate`; issue 1409).
 *
 * **Only what differs is written**: done on a done Item, or reopen on an open
 * and undismissed one, sends nothing, so applying the same change again adds
 * nothing to the log. Synchronous, so nothing falls between the read of the
 * Item and the write it decides.
 */
export function applySourceStateChange(
  db: AccountDb,
  accountName: string,
  itemId: string,
  change: AppliedSourceChange,
  observedAt: string,
): 'changed' | 'unchanged' {
  const item = getItem(db, accountName, itemId);
  if (!item) return 'unchanged';
  // Never older than what the Item last heard, or the change would be
  // refused as stale: the source says this is how things stand now.
  const issuedAt = observedAt < item.updatedAt ? item.updatedAt : observedAt;
  const envelope = { issuedAt, workspaceId: item.workspaceId, itemId };
  const asTheSource = { fromTheSource: true };
  if (change === 'resolved') {
    if (item.completedAt !== null) return 'unchanged';
    runCommand(db, accountName, 'set_done', { ...envelope, commandId: crypto.randomUUID(), done: true }, asTheSource);
    return 'changed';
  }
  if (item.completedAt === null && item.deletedAt === null) return 'unchanged';
  db.transaction(() => {
    if (item.completedAt !== null) {
      runCommand(db, accountName, 'set_done', { ...envelope, commandId: crypto.randomUUID(), done: false }, asTheSource);
    }
    if (item.deletedAt !== null) {
      runCommand(
        db,
        accountName,
        'set_dismissed',
        { ...envelope, commandId: crypto.randomUUID(), dismissed: false },
        asTheSource,
      );
    }
    // Counted from when the source said so, not from the Item's own clock,
    // which a device running fast can have put ahead of today.
    givenAFreshDate(db, accountName, item, issuedAt, observedAt);
  });
  return 'changed';
}

/**
 * A reopened Item's due date counted again from the day it reopened, by the
 * days its connection gives now ("Give each email a Gmail or Outlook
 * connection brings in a due date a set number of days out", issue 1409) - and
 * only where the date is still the one the connection gave: not set or cleared
 * by the person, not replaced by a reading. Nothing where the connection has
 * been switched off, or disconnected, by then; the old date stays.
 *
 * Through `set_due_date`, as the source's own so the person's marker is left
 * alone, and recorded on the link, so the new date is the connection's in turn.
 */
function givenAFreshDate(db: AccountDb, accountName: string, item: Item, issuedAt: string, reopenedAt: string): void {
  const link = db
    .select({
      givenDueDate: pulledLinks.givenDueDate,
      workspaceId: pulledLinks.workspaceId,
      connectorId: pulledLinks.connectorId,
      externalAccountKey: pulledLinks.externalAccountKey,
      sourceId: pulledLinks.sourceId,
    })
    .from(pulledLinks)
    .where(and(eq(pulledLinks.tenantId, accountName), eq(pulledLinks.itemId, item.id)))
    .get();
  if (!link || !dueDateIsTheConnections(item, link.givenDueDate)) return;
  const days = db
    .select({ dueInDays: connectorAccounts.dueInDays })
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.tenantId, accountName),
        eq(connectorAccounts.workspaceId, link.workspaceId),
        eq(connectorAccounts.connectorId, link.connectorId),
        eq(connectorAccounts.externalAccountKey, link.externalAccountKey),
      ),
    )
    .get()?.dueInDays;
  if (days === null || days === undefined) return;
  const fresh = dueDateOnArrival(reopenedAt, recentCapturedTimeZones(db, accountName), days);
  const result = runCommand(
    db,
    accountName,
    'set_due_date',
    {
      commandId: crypto.randomUUID(),
      issuedAt,
      workspaceId: item.workspaceId,
      itemId: item.id,
      dueDate: fresh,
    },
    { fromTheSource: true },
  );
  if (!result.applied) return;
  db.update(pulledLinks)
    .set({ givenDueDate: fresh })
    .where(
      and(
        eq(pulledLinks.tenantId, accountName),
        eq(pulledLinks.workspaceId, link.workspaceId),
        eq(pulledLinks.connectorId, link.connectorId),
        eq(pulledLinks.externalAccountKey, link.externalAccountKey),
        eq(pulledLinks.sourceId, link.sourceId),
      ),
    )
    .run();
}
