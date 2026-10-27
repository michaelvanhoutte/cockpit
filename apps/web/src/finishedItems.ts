import type { FinishedItems, Item, WorkspaceSnapshot } from '@cockpit/shared';

/**
 * A Workspace's read and its finished Items drawn as one ("Fetch a Workspace's
 * finished Items the first time All items opens", issue 1434): what *All items*
 * and an Item's form read an Item from.
 *
 * **Merged by Item, the later change winning**: an Item in both is the copy
 * changed last (`updatedAt`, which a change to an Item only ever moves forward),
 * the Workspace's on a tie. The two reads are made beside each other and land in
 * either order, so a finished Item reopened elsewhere is open in whichever read
 * saw it reopened, and a finished read made before it never brings it back.
 * **Where an Item comes from the finished read its filings and files do too**,
 * so a row never says where an Item is from one read and what it is from another.
 *
 * Pending changes are drawn over the result (`changes.drawnOver`), not over
 * either read.
 */
export function withFinishedItems(snapshot: WorkspaceSnapshot, finished: FinishedItems | undefined): WorkspaceSnapshot {
  if (!finished || finished.items.length === 0) return snapshot;
  const held = new Map(snapshot.items.map((item) => [item.id, item]));
  /** The Items the finished read is the one to say: those the Workspace's read lacks, and those it changed later. */
  const taken = new Map<string, Item>();
  for (const item of finished.items) {
    const have = held.get(item.id);
    if (!have || Date.parse(item.updatedAt) > Date.parse(have.updatedAt)) taken.set(item.id, item);
  }
  if (taken.size === 0) return snapshot;
  const items = [
    ...snapshot.items.map((item) => taken.get(item.id) ?? item),
    ...[...taken.values()].filter((item) => !held.has(item.id)),
  ];
  return {
    ...snapshot,
    items,
    filings: [
      ...snapshot.filings.filter((filing) => !taken.has(filing.itemId)),
      ...finished.filings.filter((filing) => taken.has(filing.itemId)),
    ],
    attachments: [
      ...snapshot.attachments.filter((file) => !taken.has(file.itemId)),
      ...finished.attachments.filter((file) => taken.has(file.itemId)),
    ],
  };
}
