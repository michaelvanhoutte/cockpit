import { useSyncExternalStore } from 'react';

/**
 * Whether the open Dashboard's Panels are collapsed to their headers on a phone
 * ("Collapse every Panel to its header on a phone", issue 784).
 *
 * **Held in memory and nowhere else**: collapsed is a way of looking at the page
 * in hand, so switching Dashboard, going to the Inbox or reloading opens every
 * Panel. The board and the Dashboard bar's "…" menu are far apart in the tree
 * and both read it, which is the only reason it is not state in the board; it
 * names the Dashboard it is about so the bar never reads another one's.
 */
let collapsedOn: string | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function set(next: string | null) {
  if (next === collapsedOn) return;
  collapsedOn = next;
  listeners.forEach((listener) => listener());
}

/** Whether this Dashboard's Panels are collapsed, and the two ways to change it. */
export function usePanelsCollapsed(dashboardId: string | null) {
  const on = useSyncExternalStore(
    subscribe,
    () => collapsedOn,
    () => null,
  );
  return {
    collapsed: dashboardId !== null && on === dashboardId,
    collapse: () => set(dashboardId),
    open: () => set(null),
  };
}

/** Forgets it, but only if it is this Dashboard's: the board leaving must not open the one that replaced it. */
export function forgetPanelsCollapsed(dashboardId: string) {
  if (collapsedOn === dashboardId) set(null);
}

/** Collapses, or with null opens, from outside a component - what a test drives the board with. */
export const setPanelsCollapsed = set;
