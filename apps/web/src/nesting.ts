import { CHILDREN_ADDED_AT_ONCE, childIdsOf, type ChildRow, type Filing, type Panel } from '@cockpit/shared';
import { filedOrderOnPanel } from './filing';
import type { RowDropWas } from './puttingBack';
import { refusesNesting } from './nestingAim';

/**
 * What a row dropped onto another row comes to ("Drag to nest in Panels and
 * the Inbox", issue 1857), decided from the held copy and pure. Fetched with
 * `rowDrop.ts` once a drag is under way; where the pointer is lives in
 * `nestingAim.ts`, which the initial bundle carries.
 */

export { whereOnARow, refusesNesting, type WhereOnARow } from './nestingAim';

/** One place an Item leaves: the parent or the Panel it comes out of. */
export interface Leave {
  itemId: string;
  parentId?: string;
  panelId?: string;
}

/** Where the carried row was picked up, and which list it is dropped in. */
export interface DropOntoARow {
  /** The Items carried, in the order drawn: the grabbed one alone, or a selection. */
  carried: readonly string[];
  /** The row they are dropped on. */
  target: string;
  rows: readonly ChildRow[];
  filings: readonly Filing[];
  /** What the grabbed row was picked up from. */
  from: { parentId: string | null; panelId: string | null };
  /**
   * Set for a selection: the Panels each of its Items leaves, those of the Dashboard it was picked on,
   * as a selection dropped between Panels takes each off the other Panels of its Dashboard (issue 1217).
   */
  selectionPanels: readonly string[] | null;
  /** The list dropped in: the Panel it is a Panel's (null in the Inbox), and the parent whose children it draws. */
  list: { panelId: string | null; heldBy: string | null };
  /** Shift moves and Ctrl or Option adds, where the question would have been asked. */
  keys: { move: boolean; add: boolean };
}

export type RowDropPlan =
  | { refused: string }
  | {
      refused?: undefined;
      /** The Items going inside, and the parent's whole order afterwards. */
      childIds: string[];
      order: string[];
      /** The ones that were not inside already, which an Undo takes out again. */
      arrived: string[];
      /** What the drop leaves where it moves: every place the carried Items are lifted from. */
      leaves: Leave[];
      /** Whether leaving is a question: some of it is from another list than this one. */
      asks: boolean;
      /** Moves, adds or asks; what the question (or the keys) settles. */
      answer: 'move' | 'add' | 'ask';
    };

/**
 * Every place the carried Items are lifted from, as putting them inside `target` takes them: the parent they were
 * picked in where they are its children, and the Panels of the selection's Dashboard, or the one Panel the grabbed
 * row is on, where they are filed on them.
 */
export function leavesOf(
  drop: Pick<DropOntoARow, 'carried' | 'target' | 'rows' | 'filings' | 'from' | 'selectionPanels'>,
): Leave[] {
  const leaves: Leave[] = [];
  const selection = drop.selectionPanels !== null;
  for (const itemId of drop.carried) {
    const { parentId, panelId } = drop.from;
    if (parentId && parentId !== drop.target && drop.rows.some((row) => row.parentId === parentId && row.childId === itemId)) {
      leaves.push({ itemId, parentId });
    }
    const panels = selection ? drop.selectionPanels! : panelId ? [panelId] : [];
    for (const onPanel of panels) {
      if (drop.filings.some((filing) => filing.itemId === itemId && filing.panelId === onPanel)) {
        leaves.push({ itemId, panelId: onPanel });
      }
    }
  }
  return leaves;
}

/**
 * Where Items were picked, for what they leave when put inside a parent ("Panels: Items put inside a parent stay
 * where they were", issue 1876): the Panel and the parent the list was a list of, and whether it was a selection,
 * which leaves every Panel of the Dashboard it was picked on rather than the one row's.
 */
export interface PickedIn {
  panelId: string | null;
  heldBy: string | null;
  dashboardId: string | null;
  selection: boolean;
}

/** What these Items leave when put inside `target` ('' for a parent not made yet), picked where `where` says. */
export function leavesOfAPick(d: {
  carried: readonly string[];
  target: string;
  rows: readonly ChildRow[];
  filings: readonly Filing[];
  panels: readonly Pick<Panel, 'id' | 'dashboardId'>[];
  where: PickedIn;
  /** The parents unfolded now (`unfoldedNow`), which a Dashboard's selection reads its child rows' lists from. */
  unfolded?: ReadonlySet<string>;
}): Leave[] {
  const { where } = d;
  const selectionPanels =
    where.selection && where.dashboardId !== null
      ? d.panels.filter((panel) => panel.dashboardId === where.dashboardId).map((panel) => panel.id)
      : null;
  const leaves = leavesOf({
    carried: d.carried,
    target: d.target,
    rows: d.rows,
    filings: d.filings,
    from: { parentId: where.heldBy, panelId: where.panelId },
    selectionPanels,
  });
  if (selectionPanels === null || !d.unfolded || d.unfolded.size === 0) return leaves;
  // A selection on a Dashboard does not record which parent's list a child was ticked in, so it is read from what the
  // Dashboard draws: the parents unfolded under a row filed on one of its Panels, however deep.
  const shown = new Set(d.filings.filter((filing) => selectionPanels.includes(filing.panelId)).map((filing) => filing.itemId));
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of d.rows) {
      if (shown.has(row.parentId) && d.unfolded.has(row.parentId) && !shown.has(row.childId)) {
        shown.add(row.childId);
        grew = true;
      }
    }
  }
  const taken = new Set(leaves.map((leave) => `${leave.itemId}/${leave.parentId ?? ''}`));
  for (const itemId of d.carried) {
    for (const row of d.rows) {
      if (row.childId !== itemId || row.parentId === d.target || !shown.has(row.parentId) || !d.unfolded.has(row.parentId)) continue;
      if (!taken.has(`${itemId}/${row.parentId}`)) leaves.push({ itemId, parentId: row.parentId });
    }
  }
  return leaves;
}

/** The changes putting Items inside an existing parent comes to: as many as take them, 50 at a time. */
export interface PuttingInside {
  childIds: string[];
  order: string[];
  leaves: Leave[];
  /** The ones that were not inside already. */
  arrived: string[];
}

/**
 * Putting Items inside an existing parent, as a drop onto its row does: one change per 50 Items, each with its own
 * leaves and the parent's whole order at that point. One already inside with nothing to leave is not sent.
 */
export function planPuttingInside(d: {
  carried: readonly string[];
  target: string;
  rows: readonly ChildRow[];
  leaves: readonly Leave[];
}): PuttingInside[] {
  const held = childIdsOf(d.rows, d.target);
  const inside = new Set(held);
  const going = d.carried.filter((id) => !inside.has(id) || d.leaves.some((leave) => leave.itemId === id));
  const order = [...held];
  const batches: PuttingInside[] = [];
  for (let at = 0; at < going.length; at += CHILDREN_ADDED_AT_ONCE) {
    const childIds = going.slice(at, at + CHILDREN_ADDED_AT_ONCE);
    const arrived = childIds.filter((id) => !inside.has(id));
    order.push(...arrived);
    for (const id of arrived) inside.add(id);
    batches.push({ childIds, order: [...order], arrived, leaves: d.leaves.filter((leave) => childIds.includes(leave.itemId)) });
  }
  return batches;
}

/**
 * What a drop onto a row comes to: the one change it is, and whether leaving
 * where the Items were is asked. Never a plan for Items that would nest into
 * themselves, or for more than a change takes.
 */
export function planDropOntoARow(drop: DropOntoARow): RowDropPlan | null {
  if (refusesNesting(drop.carried, drop.target, drop.rows)) return null;
  const held = childIdsOf(drop.rows, drop.target);
  const inside = new Set(held);
  const leaves = leavesOf(drop);
  // One already inside with nothing to leave has nowhere to go.
  const childIds = drop.carried.filter((id) => !inside.has(id) || leaves.some((leave) => leave.itemId === id));
  if (childIds.length === 0) return null;
  if (childIds.length > CHILDREN_ADDED_AT_ONCE) {
    return { refused: `Can't put more than ${CHILDREN_ADDED_AT_ONCE} Items inside one at once` };
  }
  const arrived = childIds.filter((id) => !inside.has(id));
  // The same list is the Panel's own top level, or the parent's own children.
  const sameList = (leave: Leave) =>
    leave.parentId !== undefined ? leave.parentId === drop.list.heldBy : leave.panelId === drop.list.panelId && drop.list.panelId !== null;
  const asks = leaves.some((leave) => !sameList(leave));
  const answer = !asks || drop.keys.move ? 'move' : drop.keys.add ? 'add' : 'ask';
  return { childIds, order: [...held, ...arrived], arrived, leaves, asks, answer };
}

/** What the plan sends once answered: everything it leaves where moved, nothing where added. */
export function leavesAnswered(plan: Exclude<RowDropPlan, { refused: string }>, answer: 'move' | 'add'): Leave[] {
  return answer === 'move' ? plan.leaves : [];
}

/**
 * What putting Items inside \`target\` took from where they were, as it stood before: each parent they left with its
 * whole order, each Panel with its whole order, and the Items that were not inside already. What an Undo puts back
 * (`putBackFromARowDrop`).
 */
export function wasBeforeLeaving(d: {
  target: string;
  arrived: readonly string[];
  leaves: readonly Leave[];
  rows: readonly ChildRow[];
  filings: readonly Filing[];
}): RowDropWas {
  const places = <K extends 'parentId' | 'panelId'>(key: K) => [...new Set(d.leaves.flatMap((one) => (one[key] ? [one[key]!] : [])))];
  const leaving = (key: 'parentId' | 'panelId', place: string) => d.leaves.filter((one) => one[key] === place).map((one) => one.itemId);
  return {
    target: d.target,
    arrived: d.arrived,
    parents: places('parentId').map((parentId) => ({ parentId, itemIds: leaving('parentId', parentId), was: childIdsOf(d.rows, parentId) })),
    panels: places('panelId').map((panelId) => ({ panelId, itemIds: leaving('panelId', panelId), was: filedOrderOnPanel(d.filings, panelId) })),
  };
}
