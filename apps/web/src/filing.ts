import { stillOpen, type Filing, type Item, type Panel } from '@cockpit/shared';

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
 * The Inbox itself, and which filings file, are `@cockpit/shared`'s (`filing.ts`).
 */

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
 * order naming one twice is refused as a shape. Whether what is sent for it is
 * a move or an add, and what the move takes it off, is `howToFileSelected`'s
 * to say; a reorder within one panel is the other gesture (`reorder`, which
 * sends an add for exactly this reason).
 */
export function ordersForFilingSeveral(
  held: readonly string[],
  ids: readonly string[],
  at = 0,
): string[][] {
  // `at` is counted among what the panel holds without any of them, which is
  // what a drop's landing line is measured in (`placeSeveralAmongHeld`).
  const anchor = held.filter((id) => !ids.includes(id))[at];
  return ids.map((_, k) => {
    const sent = ids.slice(0, k + 1);
    // Those still to be sent that the panel holds already stay in `rest`, so
    // each order names exactly what the panel holds plus what has arrived.
    const rest = held.filter((id) => !sent.includes(id));
    const place = at <= 0 ? 0 : anchor === undefined ? rest.length : rest.indexOf(anchor);
    return [...rest.slice(0, place), ...sent, ...rest.slice(place)];
  });
}

/** What a run of changes handed to the queue together came to: the ones that landed and the ones refused, each with its Item. */
export type Answered<T> = Promise<{ landed: T[]; refused: { item: T; error: unknown }[] }>;

/**
 * How each of a run of changes handed to the queue together was answered, in the
 * order they were handed over: the changes that landed and the first refusal.
 *
 * **Handed over before any is awaited**, so the whole run is drawn at once
 * (`changeQueue.ts`); this is what is read off them afterwards. Every one is
 * waited for, so a refusal met early never leaves a later one unhandled.
 */
export async function allAnswered<T>(sends: readonly Promise<unknown>[], items: readonly T[]): Answered<T> {
  const settled = await Promise.allSettled(sends);
  const landed: T[] = [];
  const refused: { item: T; error: unknown }[] = [];
  settled.forEach((result, at) => {
    if (result.status === 'fulfilled') landed.push(items[at]!);
    else refused.push({ item: items[at]!, error: result.reason });
  });
  return { landed, refused };
}

/** Rejects when not one of the run landed, so an offer made at the press is taken back. */
export async function unlessNoneLanded(answered: Answered<unknown>): Promise<void> {
  if ((await answered).landed.length === 0) throw new Error('every Item was refused');
}

/**
 * Fetches the code a filing gesture runs, saying so in words when it cannot be
 * had: a tab left open across a deploy asks for a file that is gone, and the
 * browser's own message names a URL. Nothing is sent when it fails.
 */
export async function fetchedChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch {
    throw new Error('That could not load. Reload the page and try again.');
  }
}

/**
 * What filing one picked item onto a panel sends ("Move a selection off only
 * the Panels of the Dashboard it was selected on", issue 924).
 *
 * **A move takes it off the Panels of the Dashboard the selection was made on,
 * and no others.** Panels on other Dashboards keep it, as a move from one row's
 * menu leaves them (issue 923). The target is never named as a source: the item
 * is landing there.
 *
 * **Naming no Panel is not "none" but "every"** (`fromPanelIds` absent or empty),
 * so an item shown here only by a Filter, and filed only on other Dashboards,
 * is sent as an add: it loses nothing and lands on the target as well.
 *
 * Plain, taking it off every Panel, where nothing is being left: an item filed
 * nowhere (the Inbox's), a move to the Inbox, and a selection held in the Inbox
 * (`dashboardId` null).
 */
export type HowToFileSelected =
  | { how: 'move'; fromPanelIds?: string[] }
  | { how: 'add' };

export function howToFileSelected(
  filings: readonly Filing[],
  panelsInWorkspace: readonly Panel[],
  dashboardId: string | null,
  target: string | null,
  itemId: string,
): HowToFileSelected {
  if (target === null || dashboardId === null) return { how: 'move' };
  const mine = filings.filter((filing) => filing.itemId === itemId);
  if (mine.length === 0) return { how: 'move' };
  const here = new Set(
    panelsInWorkspace.filter((panel) => panel.dashboardId === dashboardId).map((panel) => panel.id),
  );
  const sources = [
    ...new Set(
      mine.map((filing) => filing.panelId).filter((id) => id !== target && here.has(id)),
    ),
  ];
  return sources.length > 0 ? { how: 'move', fromPanelIds: sources } : { how: 'add' };
}
