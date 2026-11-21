import type { ChildRow } from '@cockpit/shared';
import type { PickedIn } from '../nesting';
import { refusesNesting } from '../nestingAim';
import type { Undoable } from '../undo';

/**
 * What a card is dropped on, and what a click on a title comes to ("Brainstorming:
 * cards on the whiteboard can't be nested, combined or moved between boxes",
 * issue 1830), decided here and pure, for the reason `layout.ts` is: jsdom has
 * no layout engine, so what a test can prove is the arithmetic once the boxes
 * and the keys are given.
 */

/** A card's frame on the board itself. */
export interface Frame {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The card a point on the board is over, other than the ones `leaving`; the last drawn where several overlap. */
export function cardUnder(frames: readonly Frame[], point: { x: number; y: number }, leaving: ReadonlySet<string>): string | null {
  let found: string | null = null;
  for (const frame of frames) {
    if (leaving.has(frame.id)) continue;
    if (point.x >= frame.x && point.y >= frame.y && point.x <= frame.x + frame.w && point.y <= frame.y + frame.h) found = frame.id;
  }
  return found;
}

/**
 * What may be done with an Item let go on a card holding another: *Put inside* it,
 * unless that would put the Item inside itself or something it holds, or it is
 * already inside; and *Combine with* it, always.
 */
export function dropAnswers(itemId: string, onto: string, rows: readonly ChildRow[]): ('inside' | 'combine')[] {
  const inside = !refusesNesting([itemId], onto, rows) && !rows.some((row) => row.parentId === onto && row.childId === itemId);
  return inside ? ['inside', 'combine'] : ['combine'];
}

/**
 * Where an Item put inside a card was picked, for what it leaves ("Panels: Items put inside a parent stay where they
 * were", issue 1876): a card, or a row carried with a selection, is picked on this Dashboard as its selection is, and
 * leaves every Panel of it the Item is on; a lone row leaves the Panel or the parent it was lifted from.
 */
export function pickedOnTheBoard(dashboardId: string, lifted: { panelId: string | null; parentId: string | null } | null): PickedIn {
  return lifted
    ? { panelId: lifted.panelId, heldBy: lifted.parentId, dashboardId, selection: false }
    : { panelId: null, heldBy: null, dashboardId, selection: true };
}

/**
 * *Put inside* a card, offered back with the Item's own card on this board: the card comes off only once the Item is
 * on its way inside, a refusal of either is the refusal of both, and Undo puts the card back only after the Item is
 * back where it was, so it is never brought back onto the board while the Item is in the Inbox. Without a card of its
 * own here, the change is offered as it is.
 */
export function offeredWithItsCard(
  offerToUndo: (change: Undoable) => void,
  card: { takeOff: () => Promise<unknown>; putBack: () => Promise<unknown> } | null,
): (change: Undoable) => void {
  if (!card) return offerToUndo;
  return (change) => {
    const off = card.takeOff();
    off.catch(() => {});
    const { undo } = change;
    offerToUndo({
      ...change,
      unlessRefused: Promise.all([change.unlessRefused, off]),
      ...(undo
        ? {
            undo: async () => {
              await undo();
              await card.putBack();
            },
          }
        : {}),
    });
  };
}

/** A press and the click that followed it on a title. */
export interface TitlePress {
  /** Where it was pressed, and whether what it belongs to was already selected before the press. */
  x: number;
  y: number;
  wasSelected: boolean;
}
export interface TitleClick {
  x: number;
  y: number;
  /** 1 for a first click, 2 for the second of a double-click. */
  detail: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * Whether a click on a title renames it: only the second click on what was
 * already selected, a click that was not a drag, a double-click, or a key held
 * to select; and never on a board that is only to look at.
 */
export function clickRenames(press: TitlePress | null, click: TitleClick, readOnly: boolean): boolean {
  if (readOnly || !press?.wasSelected) return false;
  if (click.detail > 1 || click.shiftKey || click.metaKey || click.ctrlKey || click.altKey) return false;
  return Math.hypot(click.x - press.x, click.y - press.y) <= 4;
}

/** Whether F2 renames: one card or box selected, and the focus on the board rather than in a field, window or menu. */
export function f2Renames(state: { readOnly: boolean; selected: number; typing: boolean; windowOpen: boolean; focusOnBoard: boolean }): boolean {
  return !state.readOnly && state.selected === 1 && !state.typing && !state.windowOpen && state.focusOnBoard;
}

/** Whether a rename waiting out a double-click still goes ahead: the card is the one thing selected, as it was at the click. */
export function renameStillWanted(selected: readonly string[], id: string): boolean {
  return selected.length === 1 && selected[0] === id;
}
