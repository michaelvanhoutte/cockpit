import { useCallback, useSyncExternalStore } from 'react';

/**
 * Which layout a dashboard is being drawn with, when somebody has said ("Pick
 * the layout you are on, by name").
 *
 * **Remembered in the browser, not in the database**, for the reason the last
 * view of a workspace is (lastVisited.ts) - and here the reason is the whole
 * feature. Layouts exist because the phone and the 4K screen want different
 * arrangements; storing "I am looking at the wide one" would push that choice
 * onto every other device, which is exactly what *Automatic* is there to avoid.
 *
 * The storage is handed in rather than reached for, so the deciding is provable
 * without a browser and so a private window, or a browser that refuses storage,
 * is a dashboard drawn with the closest layout rather than one that throws.
 *
 * **Two things on screen read this, and they are in different halves of the
 * app**: the control in the dashboard's bar, which is the shell's, and the
 * board below it, which is the page's. Neither owns the other, so what they
 * share is this module - a store they both subscribe to, rather than a prop one
 * would have to hand the other through the router.
 */

const KEY = 'cockpit.layout.';

/** The value standing for "whichever fits this screen", which is the default. */
export const AUTOMATIC = 'automatic';

/** The layout chosen by hand for this dashboard, or null for "whichever fits". */
export function chosenFor(store: Storage | undefined, dashboardId: string): string | null {
  try {
    return store?.getItem(KEY + dashboardId) ?? null;
  } catch {
    return null;
  }
}

/** `null` puts the dashboard back on whichever layout fits the screen it is on. */
export function chooseLayout(
  store: Storage | undefined,
  dashboardId: string,
  layoutId: string | null,
): void {
  try {
    if (layoutId === null) store?.removeItem(KEY + dashboardId);
    else store?.setItem(KEY + dashboardId, layoutId);
  } catch {
    // Not remembering is a smaller thing than not drawing the dashboard.
  }
}

/**
 * Everything currently reading a choice, so that changing one in the bar
 * redraws the board under it.
 *
 * A plain set of callbacks rather than the `storage` event, which browsers only
 * fire at *other* tabs: the two readers here are in the same document, so the
 * one event that would carry this is the one event that never arrives.
 */
const readers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  readers.add(onChange);
  return () => {
    readers.delete(onChange);
  };
}

/**
 * The choice for one dashboard, and the way to change it - kept current for
 * every reader in this document.
 *
 * `null` means *Automatic*, which is both "nothing has been picked" and "picked
 * on purpose": the two are the same state, because picking Automatic is asking
 * for the choice to be made by the screen rather than remembered.
 */
export function useChosenLayout(
  store: Storage | undefined,
  dashboardId: string,
): [string | null, (layoutId: string | null) => void] {
  const chosen = useSyncExternalStore(
    subscribe,
    () => chosenFor(store, dashboardId),
    () => null,
  );
  const choose = useCallback(
    (layoutId: string | null) => {
      chooseLayout(store, dashboardId, layoutId);
      for (const tell of readers) tell();
    },
    [store, dashboardId],
  );
  return [chosen, choose];
}
