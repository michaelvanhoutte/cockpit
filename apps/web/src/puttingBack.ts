import { childIdsOf, type Item, type WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from './api/queries';
import { allAnswered, filedOrderOnPanel } from './filing';
import { uuidv7 } from '@cockpit/shared';

/**
 * Putting back what a filing took ("Undo what just happened", issue 144):
 * fetched when Undo is pressed, so none of it is in the initial bundle.
 *
 * Every change is handed to the tab's queue before any is awaited, so the screen
 * has them all back at once (`changeQueue.ts`); a refusal is thrown once every
 * one has been answered, which is what the undo bar says.
 */
export interface Putting {
  workspaceId: string;
  send: (change: CommandArgs) => Promise<unknown>;
  /** The Workspace as the screen draws it now (`useLatestSnapshot`). */
  latest: (workspaceId: string) => Promise<WorkspaceSnapshot>;
}

/** A Panel an Item was on, and the whole order that Panel was in. */
export interface WasOn {
  panelId: string;
  order: string[];
}

const envelope = (d: Putting, itemId: string) => ({
  commandId: uuidv7(),
  issuedAt: new Date().toISOString(),
  workspaceId: d.workspaceId,
  itemId,
});

async function allBack(sends: readonly Promise<unknown>[]): Promise<void> {
  const { refused } = await allAnswered(sends, sends);
  if (refused[0]) throw refused[0].error;
}

/**
 * Puts an item back on every panel it was on, in the order each was in.
 *
 * **The first is a move and the rest are adds**, which is what makes this one
 * inverse rather than two: the move takes it off wherever it is now and puts it
 * on the first, and each add puts it on one more without disturbing that. An
 * item that was on no panel at all is moved to the Inbox, which is the absence
 * of a filing.
 */
export function putItBackOn(d: Putting, item: Item, panels: readonly WasOn[]): Promise<void> {
  const [first, ...rest] = panels;
  return allBack([
    d.send({
      name: 'move_item_to_panel',
      payload: { ...envelope(d, item.id), panelId: first?.panelId ?? null, order: first?.order ?? [] },
    }),
    ...rest.map((also) =>
      d.send({ name: 'add_item_to_panel', payload: { ...envelope(d, item.id), panelId: also.panelId, order: also.order } }),
    ),
  ]);
}

/**
 * The arrangement a panel is put back into as one item returns to it.
 *
 * **Built from what the panel holds now, not from what it held before.** An
 * order has to name exactly the panel's items plus the one arriving or it is
 * refused (bar those finished more than a day ago, which no read here holds),
 * and half-way through putting several back a panel holds neither what
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
export function orderPuttingBack(was: readonly string[], heldNow: readonly string[], itemId: string): string[] {
  // Named once, however it got there: the item arriving can already be on this
  // panel, which is what putting one back onto the panel it was filed onto is.
  const alsoThere = heldNow.filter((id) => id !== itemId);
  const present = new Set([...alsoThere, itemId]);
  return [...was.filter((id) => present.has(id)), ...alsoThere.filter((id) => !was.includes(id))];
}

/**
 * Puts back everything a filing of several took, onto the panels each was on.
 *
 * **One order per filing, each read from what the panel holds by then** - the
 * screen's copy, with the puts-back already handed over drawn over it. An order
 * naming an item the panel does not hold is refused exactly as a stale one is,
 * and half-way through this a panel holds neither what it held before nor what
 * it will hold after. Computing what that ought to be is how the overlap case
 * was got wrong; asking is how it is got right.
 */
export async function putSeveralBack(
  d: Putting,
  moved: readonly Item[],
  wasOn: ReadonlyMap<string, readonly WasOn[]>,
): Promise<void> {
  /** What a panel holds at this moment, which each order has to name. */
  const heldOn = async (panelId: string) => filedOrderOnPanel((await d.latest(d.workspaceId)).filings, panelId);
  const sends: Promise<unknown>[] = [];
  // Never left unhandled, should a later read fail before they are waited on.
  const hand = (answer: Promise<unknown>) => {
    answer.catch(() => {});
    sends.push(answer);
  };
  for (const item of moved) {
    // On no panel at all is the Inbox, which is the absence of a filing.
    const [first, ...rest] = wasOn.get(item.id) ?? [];
    hand(
      d.send({
        name: 'move_item_to_panel',
        payload: {
          ...envelope(d, item.id),
          panelId: first?.panelId ?? null,
          order: first ? orderPuttingBack(first.order, await heldOn(first.panelId), item.id) : [],
        },
      }),
    );
    for (const also of rest) {
      hand(
        d.send({
          name: 'add_item_to_panel',
          payload: {
            ...envelope(d, item.id),
            panelId: also.panelId,
            order: orderPuttingBack(also.order, await heldOn(also.panelId), item.id),
          },
        }),
      );
    }
  }
  await allBack(sends);
}

/**
 * Takes what an Also show on… added off the panel again. **Read when pressed**:
 * one taken off meanwhile (another tab) is already what Undo wants, and its
 * refusal must not leave the rest on.
 */
export async function takeOffAgain(d: Putting, items: readonly Item[], panelId: string): Promise<void> {
  const now = (await d.latest(d.workspaceId)).filings;
  await allBack(
    items
      .filter((item) => now.some((f) => f.itemId === item.id && f.panelId === panelId))
      .map((item) => d.send({ name: 'remove_item_from_panel', payload: { ...envelope(d, item.id), panelId } })),
  );
}

/**
 * Takes an Item moved to the Inbox out of every Item holding it, or it would
 * be in no Inbox ("Brainstorming: an Item can't hold other Items", issue 1825);
 * here rather than in the list, so it is fetched with the move's Undo.
 */
export async function takeOutOfParents(d: Pick<Putting, 'workspaceId' | 'send'>, childId: string, parentIds: readonly string[]): Promise<unknown[]> {
  const sends = parentIds.map((parentId) =>
    d.send({ name: 'remove_child', payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId: d.workspaceId, parentId, childId } }),
  );
  await allBack(sends);
  // The answers, for the cards the last of them may have taken off (`putCardsBackAfter`).
  return Promise.all(sends);
}

/** Puts it back inside each of them: the other half of the move's Undo. */
export function putBackInParents(d: Pick<Putting, 'workspaceId' | 'send'>, childId: string, parentIds: readonly string[]): Promise<void> {
  return allBack(
    parentIds.map((parentId) =>
      d.send({ name: 'add_children', payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId: d.workspaceId, parentId, childIds: [childId] } }),
    ),
  );
}

/**
 * What a drop onto a row (issue 1857) took from where the Items were, as it
 * stood before the drop: each parent they left with its whole order, each
 * Panel with its whole order, and the Items that were not inside the new
 * parent already.
 */
export interface RowDropWas {
  target: string;
  arrived: readonly string[];
  parents: readonly { parentId: string; itemIds: readonly string[]; was: readonly string[] }[];
  panels: readonly { panelId: string; itemIds: readonly string[]; was: readonly string[] }[];
}

/**
 * A parent's whole order as an Item comes back into it: what it held before
 * where it is still there, the Items returning where they were, and whatever
 * it has gained since after them.
 */
export function orderBackInto(was: readonly string[], heldNow: readonly string[], returning: readonly string[]): string[] {
  const present = new Set([...heldNow, ...returning]);
  return [...was.filter((id) => present.has(id)), ...[...present].filter((id) => !was.includes(id))];
}

/**
 * Puts back both halves of a drop onto a row: an Item that left a parent goes
 * back into it at its old place, leaving the new one (one change, as the drop
 * was); one that left a Panel is filed on it again at its old place and taken
 * out of the new parent, with today's two changes until a drag out gives
 * move-to-Panel the parents it leaves ("Drag to nest in Panels and the Inbox",
 * issue 1859). One that left nothing is only taken out.
 */
export async function putBackFromARowDrop(d: Putting, was: RowDropWas): Promise<void> {
  const sends: Promise<unknown>[] = [];
  const hand = (answer: Promise<unknown>) => {
    answer.catch(() => {});
    sends.push(answer);
  };
  const out = (itemId: string) =>
    hand(
      d.send({
        name: 'remove_child',
        payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId: d.workspaceId, parentId: was.target, childId: itemId },
      }),
    );
  const takenOut = new Set<string>();
  for (const left of was.parents) {
    const heldNow = childIdsOf((await d.latest(d.workspaceId)).children ?? [], left.parentId);
    const leaving = left.itemIds.filter((id) => was.arrived.includes(id));
    hand(
      d.send({
        name: 'put_inside',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: d.workspaceId,
          parentId: left.parentId,
          childIds: [...left.itemIds],
          order: orderBackInto(left.was, heldNow, left.itemIds),
          leaves: leaving.map((itemId) => ({ itemId, parentId: was.target })),
        },
      }),
    );
    for (const id of leaving) takenOut.add(id);
  }
  for (const left of was.panels) {
    for (const itemId of left.itemIds) {
      const heldNow = filedOrderOnPanel((await d.latest(d.workspaceId)).filings, left.panelId);
      hand(
        d.send({
          name: 'add_item_to_panel',
          payload: { ...envelope(d, itemId), panelId: left.panelId, order: orderPuttingBack(left.was, heldNow, itemId) },
        }),
      );
      if (was.arrived.includes(itemId) && !takenOut.has(itemId)) {
        out(itemId);
        takenOut.add(itemId);
      }
    }
  }
  // Added and leaving nothing: out of the new parent only.
  for (const itemId of was.arrived) if (!takenOut.has(itemId)) out(itemId);
  await allBack(sends);
}
