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
  tell();
}

/** The card asked to be shown on this board, if any, taken so it is shown once. */
export function cardWanted(dashboardId: string): string | null {
  if (wanted?.dashboardId !== dashboardId) return null;
  const { cardId } = wanted;
  wanted = null;
  return cardId;
}

/** Whether a card is waiting to be shown on this board, without taking it: what opens a phone's board. */
export function aCardIsWanted(dashboardId: string): boolean {
  return wanted?.dashboardId === dashboardId;
}

/** Changes whenever a card is asked to be shown, for a board already drawn to hear of it. */
export function useCardWanted(): unknown {
  return useSyncExternalStore(subscribe, () => wanted, () => null);
}
