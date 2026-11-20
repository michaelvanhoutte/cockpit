import { CHILDREN_ADDED_AT_ONCE, childIdsOf, type ChildRow, type Filing } from '@cockpit/shared';
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
 * What a drop onto a row comes to: the one change it is, and whether leaving
 * where the Items were is asked. Never a plan for Items that would nest into
 * themselves, or for more than a change takes.
 */
export function planDropOntoARow(drop: DropOntoARow): RowDropPlan | null {
  if (refusesNesting(drop.carried, drop.target, drop.rows)) return null;
  const held = childIdsOf(drop.rows, drop.target);
  const inside = new Set(held);
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
