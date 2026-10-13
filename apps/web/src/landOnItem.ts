import { useRef, useState, useSyncExternalStore } from 'react';

/**
 * Land on an Item ("Find an open Item with F and Shift+F, and land on its row",
 * issue 828): the request to bring the screen to one Item's row, made by Find as
 * the highlight moves (`focus` false: scrolled to and outlined for a moment) or
 * as Enter goes to it (`focus` true: keyboard focus on the row, outlined until
 * focus leaves it).
 *
 * **A request outside the column** that makes it, because going to an Item
 * closes the column and may switch Dashboards, unmounting it. The first board
 * that draws the row - a Dashboard's, the Inbox's or *All items* (issue 829) - takes it, does the
 * landing and settles it. **Held in memory only, never in the address**: a
 * reload or a shared link must not re-focus a row, nor add history.
 *
 * **It goes stale after a couple of seconds.** A row that is never drawn - a slow load, an
 * Item gone meanwhile - must not pull focus from wherever the person has gone
 * since. A new request replaces the one waiting, so the second of two quick
 * Enters is the only one that lands.
 */
export type LandingPlace =
  | { kind: 'panel'; dashboardId: string; panelId: string }
  | { kind: 'inbox' }
  /** A finished Item, on no Dashboard: its row in the Workspace's *All items* table. */
  | { kind: 'allItems'; workspaceId: string };

export type LandingRequest = { itemId: string; place: LandingPlace; focus: boolean; at: number };

/** How long a request waits for its row to be drawn, in milliseconds. */
export const LANDING_WAIT_MS = 2000;

/** How long a row must have stayed drawn before its landing is settled, in milliseconds. */
export const LANDING_STAYS_MS = 400;

let waiting: LandingRequest | null = null;
const listeners = new Set<() => void>();
const announce = () => listeners.forEach((listener) => listener());

export function askToLand(request: Omit<LandingRequest, 'at'>): void {
  waiting = { ...request, at: Date.now() };
  announce();
}

/** Takes the request off, once a board has acted on it. */
export function settleLanding(request: LandingRequest): void {
  if (waiting !== request) return;
  waiting = null;
  announce();
}

/** Drops whatever is waiting: Esc has put the screen back, so there is nothing left to land on. */
export function forgetLanding(): void {
  if (waiting === null) return;
  waiting = null;
  announce();
}

/** Whether the request can still land. */
const isLive = (request: LandingRequest): boolean => Date.now() - request.at <= LANDING_WAIT_MS;

/** The request now waiting, or null where none is or the last one has gone stale. */
export function useLanding(): LandingRequest | null {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => waiting,
    () => null,
  );
  return current && isLive(current) ? current : null;
}

/** The row an Item is drawn as inside `root`, or null where it is not drawn. */
export function rowOf(root: ParentNode | null, itemId: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[data-item-id="' + itemId + '"]') ?? null;
}

/** How long a row stays outlined after the screen is brought to it, in milliseconds. */
const LANDED_ROW_MS = 1600;

/** Takes the outline off the row that carries it. */
let unoutline: (() => void) | null = null;

/**
 * Lands on the row: brought into view in the middle of its box and outlined,
 * for a moment; with `focus`, given keyboard focus and outlined until focus
 * leaves it. Only one row is outlined at a time, in the whole window.
 */
export function landOn(row: HTMLElement, focus: boolean): void {
  unoutline?.();
  row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  row.setAttribute('data-shown', '');
  const timer = focus ? 0 : window.setTimeout(() => unoutline?.(), LANDED_ROW_MS);
  const off = () => {
    window.clearTimeout(timer);
    row.removeAttribute('data-shown');
    row.removeEventListener('focusout', off);
    unoutline = null;
  };
  unoutline = off;
  if (!focus) return;
  // A row is no tab stop: it takes the focus this once, for the keys that follow.
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
  row.addEventListener('focusout', off);
}

/**
 * One step of a board's landing, run from an effect that runs on every render:
 * the row now drawn is landed on, and looked at again shortly until it has
 * stayed `LANDING_STAYS_MS`, since a list just switched to redraws its rows as
 * they load and the landing is then made again on the row now there. Returns
 * the effect's cleanup. **Shared by every board, so they settle alike.**
 */
export function useLandingStep(): (request: LandingRequest, row: HTMLElement | null) => () => void {
  const landed = useRef<{ request: LandingRequest; row: HTMLElement; at: number } | null>(null);
  const [, again] = useState(0);
  return (request, row) => {
    const timer = window.setTimeout(() => again((n) => n + 1), 100);
    const last = landed.current;
    if (!row) return () => window.clearTimeout(timer);
    if (last?.request !== request || last.row !== row) {
      landed.current = { request, row, at: Date.now() };
      landOn(row, request.focus);
    } else if (Date.now() - last.at > LANDING_STAYS_MS) {
      window.clearTimeout(timer);
      settleLanding(request);
    }
    return () => window.clearTimeout(timer);
  };
}
