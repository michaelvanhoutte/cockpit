import type { Filing, Item } from '@cockpit/shared';

/**
 * What a panel holds and what the Inbox holds, derived from the one snapshot
 * the workspace already reads ("Panels hold the items filed into them, and the
 * Inbox holds the rest", issue 36).
 *
 * **Both are views evaluated in the client** (architecture, "The read model:
 * persisted snapshot, revalidate, push"): the wire carries the workspace's open
 * items and its filings, and nothing about how they are grouped. That is why
 * these are here and pure rather than inside the components that draw them.
 *
 * **The Inbox is the absence of a filing**, not a panel with rows of its own,
 * which is what makes filing an item the thing that takes it out of the Inbox.
 */

/**
 * Whether an item is still yours to deal with, which is the whole of what an
 * item can be besides finished with ("An item is either yours to deal with or
 * finished with", issue 154).
 *
 * Dismissed items never reach the client at all - the snapshot leaves them out
 * server-side - and finished ones do, so this is what keeps a completed item
 * off the panel it was filed on as well as out of the Inbox. One predicate for
 * both lists, because "gone from the Inbox but still on a panel" is a
 * distinction nobody asked for.
 *
 * **They arrive so that undoing has something to put back.** A finished item
 * has to be in the copy the browser holds for the bar offering to undo it to
 * work without a round trip.
 */
export function stillOpen(item: Item): boolean {
  // Falsy rather than `=== null`, because a copy restored from IndexedDB is
  // never parsed again (main.tsx) - so an item stored before this field existed
  // has `undefined` here, and comparing to null would hide every one of them
  // from both lists. The buster moves with this shape change as well, which is
  // the fix; this is what makes the week of stored copies in between harmless.
  return !item.completedAt;
}

/**
 * The items filed on one panel, in the order they were filed into.
 *
 * Driven from the filings rather than from the items, because the filings are
 * what carry the order. An id with no item behind it is skipped rather than
 * drawn as a gap: an item dismissed in another tab leaves the snapshot while
 * its filing is still on the panel, and a hole in a list is worse than one row
 * fewer.
 */
export function itemsOnPanel(
  items: readonly Item[],
  filings: readonly Filing[],
  panelId: string,
): Item[] {
  const byId = new Map(items.filter(stillOpen).map((item) => [item.id, item]));
  return filings
    .filter((filing) => filing.panelId === panelId)
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((filing) => byId.get(filing.itemId))
    .filter((item): item is Item => item !== undefined);
}

/**
 * Everything still to deal with that is filed nowhere - the Inbox.
 *
 * The snapshot leaves out the filings of deleted panels, so an item whose only
 * panel has gone is back here without anything on this side knowing that a
 * panel was ever deleted.
 */
export function itemsInTheInbox(items: readonly Item[], filings: readonly Filing[]): Item[] {
  const filed = new Set(filings.map((filing) => filing.itemId));
  return items.filter((item) => stillOpen(item) && !filed.has(item.id));
}

/**
 * Every item filed on one panel, in order - **including the ones the panel does
 * not draw**.
 *
 * That is the whole reason it is separate from `itemsOnPanel`. A move carries
 * the panel's whole order and the server checks it against every filing the
 * panel has, and a filing outlives the item being finished or dismissed - so an
 * order built from what is *drawn* would leave those out and be refused. Filing
 * anything onto a panel that had ever held a completed item would fail, for
 * good, with nothing on screen to explain it.
 *
 * Ids rather than items, because a filing whose item has left the snapshot
 * entirely - dismissed in another tab - still has to be named.
 */
export function filedOrderOnPanel(filings: readonly Filing[], panelId: string): string[] {
  return filings
    .filter((filing) => filing.panelId === panelId)
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((filing) => filing.itemId);
}

/**
 * The panel's whole order once this item has been put at `at` - what a move
 * carries, because a move sends an arrangement rather than a position (see
 * `moveItemToPanelSchema`).
 *
 * It takes the order the panel is *filed* in (`filedOrderOnPanel`), not the one
 * it is drawn in.
 *
 * The item is taken out before it is put back in, so moving one *within* a
 * panel is the same call as filing a new one into it: without that, a row
 * dragged two places down would appear twice in the order and be refused.
 *
 * `at` is clamped rather than trusted, so a drop past the end of a list that
 * has since shrunk lands last instead of leaving a gap the position numbers
 * could not describe.
 */
export function orderWithItemAt(
  held: readonly string[],
  itemId: string,
  at: number,
): string[] {
  const without = held.filter((id) => id !== itemId);
  const place = Math.max(0, Math.min(at, without.length));
  return [...without.slice(0, place), itemId, ...without.slice(place)];
}

/**
 * The order each filing carries when several items are filed onto one panel at
 * once ("Select several items, and file them all in one go", issue 169) - one
 * per item, in the order they are sent.
 *
 * **Each is built on the one before it.** A filing carries the panel's whole
 * arrangement afterwards and the server refuses one that is not this panel's
 * (`orderIsNotOfThePanel`), so the second filing has to name the first item as
 * well: by then it is on the panel.
 *
 * They land at the top in the order the list showed them, which is where a
 * single move puts one - so after the last filing the panel reads as the
 * selection, then whatever it already held.
 *
 * **An item already on the panel is named once rather than twice**, because an
 * order naming one twice is refused as a shape. What is sent for it is still a
 * *move*, not an add, so it comes off every other panel it was on - which is
 * what moving it there means, and what the same item picked out on its own and
 * moved from its row's menu already does. A reorder within one panel is the
 * other gesture (`reorder`, which sends an add for exactly this reason).
 */
export function ordersForFilingSeveral(
  held: readonly string[],
  ids: readonly string[],
): string[][] {
  return ids.map((_, k) => {
    const sent = ids.slice(0, k + 1);
    return [...sent, ...held.filter((id) => !sent.includes(id))];
  });
}

/**
 * The arrangement a panel is put back into as one item returns to it ("Undo
 * what just happened", issue 144).
 *
 * **Built from what the panel holds now, not from what it held before.** An
 * order has to name exactly the panel's items plus the one arriving or it is
 * refused, and half-way through putting several back a panel holds neither what
 * it held before nor what it will hold after: the ones already returned are
 * there, the ones still to come are not, and the panel that was *filed onto* is
 * still holding every item waiting its turn. Only the live list knows which.
 *
 * `was` decides the order and not the membership: everything that is there
 * again takes the place it had, and anything the panel has gained since - the
 * items still waiting to be moved off it - goes after them, where their own
 * turn will take them off anyway. So the last item back leaves the panel
 * arranged exactly as it was.
 */
export function orderPuttingBack(
  was: readonly string[],
  heldNow: readonly string[],
  itemId: string,
): string[] {
  // Named once, however it got there: the item arriving can already be on this
  // panel, which is what putting one back onto the panel it was filed onto is.
  const alsoThere = heldNow.filter((id) => id !== itemId);
  const present = new Set([...alsoThere, itemId]);
  return [
    ...was.filter((id) => present.has(id)),
    ...alsoThere.filter((id) => !was.includes(id)),
  ];
}
