import { useCallback, useState, useSyncExternalStore } from 'react';
import type { KeyPress } from './inboxCollapsed';

/**
 * Go to panel, the column at a Dashboard's right ("Show a Dashboard's Panels
 * in a collapsible column at its right, and jump to one", issue 803; "Go to a
 * Panel of this Dashboard from the keyboard with G", issue 813): whether it is
 * hidden to its strip, the key that shows and hides it, and what the board
 * hands the column to draw.
 *
 * **Hidden until first shown, then remembered in the browser and forgotten at
 * sign-out**, the shape `inboxCollapsed.ts` carries and for the same reason: it
 * is a choice about the chrome. Shown is what is stored, since hidden is the
 * default. A browser that refuses the write still shows it for this visit: the
 * caller holds the state, this only remembers it.
 */

/** The key that shows and hides the column, named in both of its controls' tooltips. */
export const PANEL_LIST_KEY = 'g';

const KEY = 'cockpit.panel-list-collapsed';

/** Where the dragged width is kept; read and written by `panelListWidth.ts`, which only the column loads. */
export const PANEL_LIST_WIDTH_KEY = 'cockpit.panel-list-width';

/** Called from `session/forget.ts`: the width a drag last left the column at. */
export function forgetPanelListWidth(store: Storage | undefined): void {
  try {
    store?.removeItem(PANEL_LIST_WIDTH_KEY);
  } catch {
    // A browser that refuses storage remembered nothing to forget.
  }
}

/** Hidden unless the stored value says it was shown. */
export function readPanelListCollapsed(store: Storage | undefined): boolean {
  try {
    return store?.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function writePanelListCollapsed(store: Storage | undefined, collapsed: boolean): void {
  try {
    store?.setItem(KEY, collapsed ? '1' : '0');
  } catch {
    // Not remembering the choice is a smaller thing than one that throws.
  }
}

/** Called from `session/forget.ts`, alongside the Inbox's own collapse. */
export function forgetPanelListCollapsed(store: Storage | undefined): void {
  try {
    store?.removeItem(KEY);
  } catch {
    // A browser that refuses storage remembered nothing to forget.
  }
}

/**
 * Whether this key press shows or hides the column: not while typing, not with
 * a modifier held, not while a menu or a window is open, and not for a key held
 * down - the four guards `togglesTheInbox` carries, for the same reasons.
 */
export function togglesThePanelList(press: KeyPress, covered: boolean): boolean {
  if (press.key.toLowerCase() !== PANEL_LIST_KEY) return false;
  if (press.ctrlKey || press.altKey || press.metaKey) return false;
  if (press.repeat || press.defaultPrevented) return false;
  return !press.typing && !covered;
}

/**
 * Whether the column is hidden to its strip, read once like the Inbox's, with
 * the setter that remembers it. The key itself is heard by the column
 * (`components/PanelList.tsx`), which holds the keys once G has shown it.
 */
export function usePanelListCollapsed(
  store: Storage | undefined,
): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => readPanelListCollapsed(store));
  const set = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      writePanelListCollapsed(store, next);
    },
    [store],
  );
  return [collapsed, set];
}

/**
 * One Panel as the list names it: its title, the count its header shows (none
 * on a Panel of text), and whether the Dashboard filter leaves it undrawn.
 */
export type PanelListEntry = { panelId: string; title: string; count: number | null; hidden: boolean };

/**
 * What the board hands the column: every Panel of the Dashboard, a row at a
 * time in reading order, and the way to bring one to the top. Published rather
 * than read from the snapshot because the board is what knows which Panels a
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
