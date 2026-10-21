import { itemLabel, uuidv7, workspaceIsDecided, type Filing, type Item } from '@cockpit/shared';
import { refusalFrom, type CommandArgs } from './api/queries';
import {
  allAnswered,
  filedOrderOnPanel,
  howToFileSelected,
  ordersForFilingSeveral,
  unlessNoneLanded,
  type Answered,
  type HowToFileSelected,
} from './filing';
import { browserStore } from './lastVisited';
import { putSeveralBack, type Putting, type WasOn } from './puttingBack';
import { rememberRecentPanel } from './recentPanels';
import { dashboardOfScope, updateSelection } from './selection';
import type { Undoable } from './undo';

/**
 * Filing everything a selection holds onto one panel, or one more
 * ("Select several items, and file them all in one go", issue 169): the work
 * `useFilingSeveral` hands over when the question is answered or a selection is
 * dropped. Fetched on the first such gesture, so none of it is in the initial
 * bundle.
 */
export interface FilingSeveral {
  workspaceId: string;
  /** The dashboard being looked at. Null in the Inbox. */
  openDashboardId: string | null;
  /** Where the selection is held, which what moved leaves. */
  scope: string;
  send: (change: CommandArgs) => Promise<unknown>;
  /** The Workspace as the screen draws it now (`useLatestSnapshot`). */
  latest: Putting['latest'];
  offerToUndo: (change: Undoable) => void;
  nameOf: (panelId: string | null) => string;
  nextSteps: (moved: readonly Item[] | Promise<readonly Item[]>, panelId: string) => Pick<Undoable, 'show' | 'alsoShowOn'>;
  whereItIs: (item: Item, filings: readonly Filing[]) => WasOn[];
  setFiling: (on: boolean) => void;
  /** Why a filing stopped, said above the rows or in the selection's bar. */
  setRefusal: (why: string | null) => void;
  /** Closes the bar's Move to… question. */
  closeQuestion: () => void;
  /** Closes the question asked by the undo bar's Also show on…. */
  closeAdding: () => void;
  /** Why adding stopped with nothing added, said in that question. */
  setAddingRefusal: (why: string | null) => void;
}

/**
 * That a filing of several is going, in this tab: a drop is handled by the Panel
 * it lands on, so a second drop on another Panel is a different hook asking.
 */
let running = false;

/**
 * Files everything picked onto one panel, or back into the Inbox.
 *
 * **Handed to the queue whole, in the order the list shows them, before any is
 * answered.** Each carries the panel's whole arrangement afterwards, so each is
 * built on the one before it (`ordersForFilingSeveral`); the queue sends them one
 * at a time in that order (`changeQueue.ts`), and the screen shows all of them
 * filed the moment this runs.
 *
 * **It can stop part way, and that is a state rather than an accident.** A
 * refusal sends back the one it was about and every one built on it: onto a
 * Panel that is all that came after, so what did move is filed and leaves the
 * selection, what did not is picked again, and asking again files exactly the
 * remainder. The way back offers what happened rather than what was asked for.
 *
 * It is what the bar's Move to… does for the rows picked and what a *drop* of a
 * selection does for the rows it carried ("Drag a selection, and drop it on the
 * Dashboard it was picked on", issue 1217) - one path, so the two cannot come to
 * different answers. `landing` is only a drop's: `at` is where the block goes
 * among what the Panel holds without it (the top, for the bar's Move to…),
 * `alsoShow` is the answer *Add it here as well*, which leaves every source, and
 * `scope` is where the rows were picked, when that is not this list's own (an
 * Inbox selection dropped on a Panel).
 */
export async function fileOnto(
  d: FilingSeveral,
  chosen: readonly Item[],
  target: string | null,
  landing?: { at: number; alsoShow?: boolean; scope?: string },
): Promise<void> {
  if (running || chosen.length === 0) return;
  running = true;
  d.setFiling(true);
  d.setRefusal(null);
  let handedOver: { answered: Answered<Item>; wasOn: ReadonlyMap<string, WasOn[]>; reordering: boolean } | null = null;
  try {
    // The screen's own copy, with the changes made a moment ago over it, so
    // every order below describes the Panels as they are drawn.
    const drawn = await d.latest(d.workspaceId);
    // Read before anything moves, because afterwards it is gone - and read for
    // all of them at once, so every order below describes the same moment.
    const wasOn = new Map(chosen.map((item) => [item.id, d.whereItIs(item, drawn.filings)] as const));
    // What each one is taken off is decided now too, from the same moment.
    const held = target ? filedOrderOnPanel(drawn.filings, target) : [];
    // A drop of rows every one of which the Panel already holds is a reorder:
    // they gather at the landing line and leave every other Panel alone.
    const reordering = landing !== undefined && target !== null && chosen.every((item) => held.includes(item.id));
    // A move leaves the Panels of the Dashboard the rows were picked on, which is
    // not the one on screen when the drag switched Dashboard on the way.
    const pickedOn = (landing?.scope ? dashboardOfScope(landing.scope) : null) ?? d.openDashboardId;
    const how = new Map<string, HowToFileSelected>(
      chosen.map((item) => [
        item.id,
        landing?.alsoShow || reordering
          ? { how: 'add' }
          : howToFileSelected(drawn.filings, drawn.panels, pickedOn, target, item.id),
      ]),
    );
    const orders = target
      ? ordersForFilingSeveral(
          held,
          chosen.map((item) => item.id),
          landing?.at,
        )
      : [];
    // Dropped where they already sit together: a reorder that changes nothing,
    // which must not offer an undo of nothing.
    if (reordering && orders[orders.length - 1]!.join() === held.join()) return;

    const sends = chosen.map((item, at) => {
      const sent = how.get(item.id)!;
      const envelope = {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId: d.workspaceId,
        itemId: item.id,
      };
      // An add where the selection's Dashboard holds it on no Panel to leave:
      // a move naming none would take it off every Panel (`howToFileSelected`).
      return sent.how === 'add'
        ? d.send({ name: 'add_item_to_panel', payload: { ...envelope, panelId: target!, order: orders[at]! } })
        : d.send({
            name: 'move_item_to_panel',
            payload: {
              ...envelope,
              panelId: target,
              // The Inbox has no order - it is by age - so filing there sends none.
              order: target ? orders[at]! : [],
              ...(sent.fromPanelIds ? { fromPanelIds: sent.fromPanelIds } : {}),
            },
          });
    });
    handedOver = { answered: allAnswered(sends, chosen), wasOn, reordering };
  } catch (error) {
    d.setRefusal(refusalFrom({ error }));
  } finally {
    running = false;
    d.setFiling(false);
    // **The question is answered either way, so it closes either way.** A
    // picker left open over a refusal seemed friendlier - the reason where
    // the choice was, and the panels still there to try again - but it is a
    // modal dialog, so while it is up nothing outside it can be clicked: the
    // way back offered underneath it took one click to dismiss the dialog
    // and a second to press, with the offer expiring on its own meanwhile.
    // The bar says why instead, above the rows that are still picked.
    d.closeQuestion();
  }
  if (!handedOver) return;
  const { answered, wasOn, reordering } = handedOver;
  const selectionScope = landing?.scope ?? d.scope;
  const where = d.nameOf(target);

  // Out of the selection at the click, like the rows leaving their lists; back
  // in it for any that are refused, below.
  const leaving = new Set(chosen.map((item) => item.id));
  updateSelection(selectionScope, (was) => ({
    picked: new Set([...was.picked].filter((id) => !leaving.has(id))),
    reachingFrom: null,
  }));

  // **No way back once any of them belonged nowhere.** Filing an item that
  // belongs to no workspace is also what decides where it belongs, and that
  // question is asked once: undoing would take it off the panel and leave it
  // in *this* workspace's Inbox rather than in every workspace's, which is
  // not where it was. The single move withholds the offer for exactly this
  // (`decides`), and one offer covers a whole run here - so one undecided
  // item in the selection is enough to withhold it, rather than a bar that
  // puts some of them back and quietly settles the rest.
  const decides = chosen.some((item) => !workspaceIsDecided(item));
  // Onto a panel only, as a single move does: the Inbox has nowhere to show
  // and nothing to also show on. Show and Also show on… cover exactly what
  // moved, and an undecided item withholds Undo alone.
  if (!(decides && target === null)) {
    d.offerToUndo({
      what: whatMoved(chosen, chosen.length, where, reordering),
      // Offered at the click and taken back if every one is refused; Undo puts
      // back exactly the ones that landed, once the run has been answered.
      unlessRefused: unlessNoneLanded(answered),
      saidAfter: answered.then(({ landed }) =>
        landed.length > 0 && landed.length < chosen.length
          ? { what: whatMoved(landed, chosen.length, where, reordering) }
          : undefined,
      ),
      ...(chosen.length === 1 ? { split: { title: `“${itemLabel(chosen[0]!)}”`, rest: ` moved to ${where}` } } : {}),
      ...(decides
        ? {}
        : {
            undo: async () =>
              putSeveralBack({ workspaceId: d.workspaceId, send: d.send, latest: d.latest }, (await answered).landed, wasOn),
          }),
      // A reorder shows nothing new and adds to no other Panel: Undo alone.
      ...(target && !reordering ? d.nextSteps(answered.then(({ landed }) => landed), target) : {}),
    });
  }

  const { landed, refused } = await answered;
  // Remembered only once something has happened, the way a single move does:
  // a panel everything was refused for is not one you have been filing into.
  if (target && landed.length > 0) rememberRecentPanel(browserStore(), d.workspaceId, target);
  if (refused.length === 0) return;
  d.setRefusal(refusalFrom({ error: refused[0]!.error }));
  // What stopped is picked again, so asking again files exactly the remainder.
  const back = new Set(refused.map(({ item }) => item.id));
  updateSelection(selectionScope, (was) => ({ picked: new Set([...was.picked, ...back]), reachingFrom: null }));
}

/**
 * Adds everything a selection moved to one more panel, from the undo bar's
 * Also show on… (`fileOnto`), leaving each on the panels it is on.
 *
 * **Read when the picker answers, not when the bar was drawn**: those already
 * on the panel by then (a move made meanwhile in another tab) are left out,
 * and the one Undo takes off exactly those added. All handed to the queue at
 * once, each order built on the one before, as filing several is, and the
 * picker closes at the click. With some refused, the bar says so; the Undo
 * covers the rest.
 */
export async function addSeveral(d: FilingSeveral, items: readonly Item[], panelId: string): Promise<void> {
  if (running) return;
  running = true;
  d.setFiling(true);
  d.setAddingRefusal(null);
  let handedOver: { toAdd: Item[]; answered: Answered<Item> } | null = null;
  try {
    const filings = (await d.latest(d.workspaceId)).filings;
    const toAdd = items.filter((item) => !filings.some((f) => f.itemId === item.id && f.panelId === panelId));
    if (toAdd.length === 0) {
      d.closeAdding();
      return;
    }
    const orders = ordersForFilingSeveral(
      filedOrderOnPanel(filings, panelId),
      toAdd.map((item) => item.id),
    );
    const sends = toAdd.map((item, at) =>
      d.send({
        name: 'add_item_to_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: d.workspaceId,
          itemId: item.id,
          panelId,
          order: orders[at]!,
        },
      }),
    );
    handedOver = { toAdd, answered: allAnswered(sends, toAdd) };
  } catch (error) {
    // Nothing was sent, so the question stays up with the reason on it.
    d.setAddingRefusal(refusalFrom({ error }));
  } finally {
    running = false;
    d.setFiling(false);
  }
  if (!handedOver) return;
  const { toAdd, answered } = handedOver;
  d.closeAdding();
  const where = d.nameOf(panelId);
  d.offerToUndo({
    what: `${toAdd.length} items added to ${where}`,
    unlessRefused: unlessNoneLanded(answered),
    saidAfter: answered.then(({ landed }) =>
      landed.length > 0 && landed.length < toAdd.length
        ? { what: `${landed.length} of ${toAdd.length} items added to ${where}` }
        : undefined,
    ),
    undo: async () => (await import('./puttingBack')).takeOffAgain({ workspaceId: d.workspaceId, send: d.send, latest: d.latest }, (await answered).landed, panelId),
  });
  const { landed, refused } = await answered;
  if (landed.length > 0) rememberRecentPanel(browserStore(), d.workspaceId, panelId);
  if (refused.length > 0) d.setRefusal(refusalFrom({ error: refused[0]!.error }));
}

/**
 * What the way back says a filing of several did.
 *
 * **What happened, not what was asked for.** A filing that stopped part way
 * moved some of them, and a sentence saying six when four went would offer to
 * undo two things that never happened. One row keeps its own title, because
 * that is what a single move has always said and picking one row out is not a
 * different act from moving it. A reorder of several says they moved *in* one
 * Panel, nowhere else.
 */
function whatMoved(moved: readonly Item[], asked: number, target: string, reordering = false): string {
  if (!reordering && moved.length === 1 && asked === 1) return `“${itemLabel(moved[0]!)}” moved ${reordering ? 'in' : 'to'} ${target}`;
  const how = moved.length === asked ? `${asked} items` : `${moved.length} of ${asked} items`;
  return `${how} moved ${reordering ? 'in' : 'to'} ${target}`;
}
