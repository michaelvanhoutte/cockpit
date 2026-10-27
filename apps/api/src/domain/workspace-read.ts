/**
 * How long a finished Item stays in its Workspace's read ("Open a Workspace
 * without its finished Items", issue 1435): a day, so Undo of Done and an open
 * form keep working whether it was finished here or on another device. Every
 * other finished Item is read by *All items* alone, and a Panel's order is
 * checked without it, since no up-to-date screen holds its filing.
 */
export const FINISHED_KEPT_IN_THE_READ_MS = 24 * 60 * 60 * 1000;

/**
 * The moment an Item must have been finished after, as of `now`, to be in its
 * Workspace's read: one finished exactly a day ago is out. The store's clock,
 * never the device's, so the read and the check a move meets later agree.
 */
export function finishedKeptAfter(now: Date): string {
  return new Date(now.getTime() - FINISHED_KEPT_IN_THE_READ_MS).toISOString();
}
