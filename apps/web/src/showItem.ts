import { useSyncExternalStore } from 'react';

/**
 * Show, on the undo bar after an Item is moved onto a Panel ("Show and Also
 * show on… in the undo bar after moving an Item", issue 849): the request to
 * bring the screen to an Item on a Panel.
 *
 * **A request rather than a call**, because the Dashboard holding the Panel may
 * not be on screen yet. The bar asks and the router switches; the board of that
 * Dashboard, once it draws, takes the request and does what Go to panel does
 * for a Panel (`PanelBoard`'s jump) and then the Item's row. The same board
 * code serves a phone, which draws no Go to panel column.
 */
export type ShowRequest = { dashboardId: string; panelId: string; itemId: string; at: number };

/** How long a request waits for its Dashboard to draw, in milliseconds. */
export const A_REQUEST_WAITS_MS = 10_000;

let waiting: ShowRequest | null = null;
const listeners = new Set<() => void>();
const announce = () => listeners.forEach((listener) => listener());

export function askToShow(request: Omit<ShowRequest, 'at'>): void {
  waiting = { ...request, at: Date.now() };
  announce();
}

/** Takes the request off, once the board has acted on it. */
export function settleTheShowRequest(request: ShowRequest): void {
  if (waiting !== request) return;
  waiting = null;
  announce();
}

/** The request now waiting, or null where none is or the last one has gone stale. */
export function useShowRequest(): ShowRequest | null {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => waiting,
    () => null,
  );
  return current && Date.now() - current.at <= A_REQUEST_WAITS_MS ? current : null;
}
