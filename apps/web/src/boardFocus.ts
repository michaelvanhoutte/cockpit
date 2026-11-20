import { useSyncExternalStore } from 'react';

/**
 * What a whiteboard and the Panels beside it say to each other
 * ("Brainstorming: give every Dashboard a whiteboard of its own", issue 1829),
 * held outside React so the Panels need none of the board's code: the Items
 * whose cards are selected on the board, which their rows mark, and a card
 * asked to be shown (Relations' *On whiteboards*), which the board selects and
 * brings into view once it is drawn. A row picked in the Panels selects its
 * card the other way, read by the board from the selection itself.
 */
let selected: ReadonlySet<string> = new Set();
let wanted: { dashboardId: string; cardId: string } | null = null;
/** The Dashboard whose whiteboard a phone shows in place of its Panels, if any. */
let boardOnPhone: string | null = null;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The Items whose cards the board has selected now. */
export function selectedOnTheBoard(itemIds: Iterable<string>): void {
  const next = new Set(itemIds);
  if (next.size === selected.size && [...next].every((id) => selected.has(id))) return;
  selected = next;
  tell();
}

/** Whether this Item's card is selected on the board, which its row marks. */
export function useSelectedOnTheBoard(itemId: string): boolean {
  return useSyncExternalStore(subscribe, () => selected.has(itemId), () => false);
}

/** Asks the board of `dashboardId` to select this card and bring it into view, once drawn. */
export function showTheCard(dashboardId: string, cardId: string): void {
  wanted = { dashboardId, cardId };
  // On a phone the board is shown in place of the Panels to get there.
  boardOnPhone = dashboardId;
  tell();
}

/** *Panels | Whiteboard* on a phone: the Dashboard whose board is shown, or null for its Panels. */
export function showBoardOnPhone(dashboardId: string | null): void {
  boardOnPhone = dashboardId;
  tell();
}

/** Whether a phone shows this Dashboard's whiteboard in place of its Panels. */
export function useBoardOnPhone(dashboardId: string): boolean {
  return useSyncExternalStore(subscribe, () => boardOnPhone === dashboardId, () => false);
}

/** The card asked to be shown on this board, if any, taken so it is shown once. */
export function cardWanted(dashboardId: string): string | null {
  if (wanted?.dashboardId !== dashboardId) return null;
  const { cardId } = wanted;
  wanted = null;
  return cardId;
}

/** Changes whenever a card is asked to be shown, for a board already drawn to hear of it. */
export function useCardWanted(): unknown {
  return useSyncExternalStore(subscribe, () => wanted, () => null);
}

/**
 * Parents made by Combine from a Dashboard ("Brainstorming: cards on the
 * whiteboard can't be nested, combined or moved between boxes", issue 1830),
 * whose card the board draws unfolded to its children once the read brings it.
 */
const toUnfold = new Set<string>();

/** Asks the board to draw this Item's card unfolded when it first has one. */
export function unfoldWhenDrawn(itemId: string): void {
  toUnfold.add(itemId);
}

/** The Items asked to be unfolded that this board now draws a card of, each taken so it is unfolded once. */
export function takeUnfolds(drawn: ReadonlySet<string>): string[] {
  const now = [...toUnfold].filter((id) => drawn.has(id));
  for (const id of now) toUnfold.delete(id);
  return now;
}
