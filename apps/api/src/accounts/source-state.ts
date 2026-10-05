import type { SourceStateChange } from '@cockpit/connector-sdk';
import type { AccountDb } from './client.js';
import { runCommand } from './command-service.js';
import { getItem } from './repo.js';

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
 * them like any other change.
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
  if (change === 'resolved') {
    if (item.completedAt !== null) return 'unchanged';
    runCommand(db, accountName, 'set_done', { ...envelope, commandId: crypto.randomUUID(), done: true });
    return 'changed';
  }
  if (item.completedAt === null && item.deletedAt === null) return 'unchanged';
  if (item.completedAt !== null) {
    runCommand(db, accountName, 'set_done', { ...envelope, commandId: crypto.randomUUID(), done: false });
  }
  if (item.deletedAt !== null) {
    runCommand(db, accountName, 'set_dismissed', { ...envelope, commandId: crypto.randomUUID(), dismissed: false });
  }
  return 'changed';
}
