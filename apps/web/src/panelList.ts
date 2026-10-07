import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isTypedInto, somethingIsOpenOverThePage } from './inboxCollapsed';
import type { KeyPress } from './inboxCollapsed';

/**
 * The Dashboard's Panel list, the column at its right ("Show a Dashboard's
 * Panels in a collapsible column at its right, and jump to one", issue 803):
 * whether it is collapsed, the key that toggles it, and what the board hands
 * the column to draw.
 *
 * **Collapsed is remembered in the browser and forgotten at sign-out**, the
 * same shape `inboxCollapsed.ts` carries and for the same reason: it is a
 * choice about the chrome. A browser that refuses the write still collapses
 * for this visit: the caller holds the state, this only remembers it.
 */

/** The key that toggles the list, named in both of its controls' tooltips. */
export const PANEL_LIST_KEY = 'p';

const KEY = 'cockpit.panel-list-collapsed';

/** Collapsed only where the stored value says so; anything else is open. */
export function readPanelListCollapsed(store: Storage | undefined): boolean {
  try {
    return store?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Open is the default, so opening removes the entry rather than storing it. */
export function writePanelListCollapsed(store: Storage | undefined, collapsed: boolean): void {
  try {
    if (collapsed) store?.setItem(KEY, '1');
    else store?.removeItem(KEY);
  } catch {
    // Not remembering the choice is a smaller thing than one that throws.
  }
}

/** Called from `session/forget.ts`, alongside the Inbox's own collapse. */
export function forgetPanelListCollapsed(store: Storage | undefined): void {
  writePanelListCollapsed(store, false);
}

/**
 * Whether this key press toggles the list: not while typing, not with a
 * modifier held, not while a menu or a window is open, and not for a key held
 * down - the four guards `togglesTheInbox` carries, for the same reasons.
 */
export function togglesThePanelList(press: KeyPress, covered: boolean): boolean {
  if (press.key.toLowerCase() !== PANEL_LIST_KEY) return false;
  if (press.ctrlKey || press.altKey || press.metaKey) return false;
  if (press.repeat || press.defaultPrevented) return false;
  return !press.typing && !covered;
}

/**
 * Whether the list is collapsed, read once like the Inbox's, with the setter
 * that remembers it and the key that flips it. `listening` is whether the list
 * is on screen at all: with no list there is nothing for the key to toggle.
 */
export function usePanelListCollapsed(
  store: Storage | undefined,
  listening: boolean,
): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => readPanelListCollapsed(store));
  const set = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      writePanelListCollapsed(store, next);
    },
    [store],
  );
  // Read at press time, so the one listener never goes stale.
  const now = useRef(collapsed);
  now.current = collapsed;
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      const toggles = togglesThePanelList(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
          defaultPrevented: event.defaultPrevented,
          typing: isTypedInto(event.target),
        },
        somethingIsOpenOverThePage(),
      );
      if (toggles) set(!now.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening, set]);
  return [collapsed, set];
}

/** One Panel as the list names it: its title, and the count its header shows (none on a Panel of text). */
export type PanelListEntry = { panelId: string; title: string; count: number | null };

/**
 * What the board hands the column: the Panels it draws, a row at a time in
 * reading order, and the way to bring one to the top. Published rather than
 * read from the snapshot because the board is what knows which Panels a
 * Dashboard filter leaves drawn, and which count each header shows.
 */
export type PanelListing = {
  dashboardId: string;
  rows: readonly (readonly PanelListEntry[])[];
  jumpTo: (panelId: string) => void;
};

let published: PanelListing | null = null;
const listeners = new Set<() => void>();

const announce = () => listeners.forEach((listener) => listener());

/**
 * Replaces what is published. A republish that says the same thing is not
 * announced, since the board publishes after every render and the shell
 * should redraw only when the list changed.
 */
export function publishPanelList(next: PanelListing): void {
  // `jumpTo` is compared by identity, since a function drops out of the JSON.
  const same =
    published !== null &&
    published.dashboardId === next.dashboardId &&
    published.jumpTo === next.jumpTo &&
    JSON.stringify(published.rows) === JSON.stringify(next.rows);
  if (same) return;
  published = next;
  announce();
}

/** Withdraws a board's listing, but only its own: the next board may already have published. */
export function withdrawPanelList(jumpTo: PanelListing['jumpTo']): void {
  if (published?.jumpTo !== jumpTo) return;
  published = null;
  announce();
}

/** The listing now published, or null where no board is on screen. */
export function usePanelListing(): PanelListing | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => published,
    () => null,
  );
}
