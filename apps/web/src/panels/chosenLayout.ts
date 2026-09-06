import { useCallback, useSyncExternalStore } from 'react';
import type { LayoutPick } from './arrangement';

/**
 * Which layout a dashboard is being drawn with, where somebody has picked one
 * by name rather than taking the screen's own answer ("Layouts follow the
 * screen you are on").
 *
 * **Remembered in the browser, not in the database**, for the reason the last
 * view of a workspace is (lastVisited.ts) - and here the reason is the whole
 * feature. Layouts exist because the phone and the 4K screen want different
 * arrangements; storing "I am looking at the wide one" would push that choice
 * onto every other device, which is exactly what following the screen avoids.
 *
 * **What is stored is a pick and the answer it overrides**, never a bare layout
 * id, because a pick that outlives the screen it was made on is the fault this
 * module was rewritten to fix (`LayoutPick` says how it expires).
 *
 * The storage is handed in rather than reached for, so the deciding is provable
 * without a browser and so a private window, or a browser that refuses storage,
 * is a dashboard drawn with the nearest layout rather than one that throws.
 *
 * **Two things on screen read this, and they are in different halves of the
 * app**: the control in the dashboard's bar, which is the shell's, and the
 * board below it, which is the page's. Neither owns the other, so what they
 * share is this module - a store they both subscribe to, rather than a prop one
 * would have to hand the other through the router.
 */

const KEY = 'cockpit.layout.';

/**
 * The pick held for this dashboard, or null where there is none to honour.
 *
 * **Anything that is not a pick in the current shape is no pick**, which covers
 * the value browsers are holding from before this: a bare layout id, written
 * when picking one meant picking it for good. Reading those forward would keep
 * every browser pinned to the layout it was stuck on, and being unstuck is the
 * point - so they are dropped, and the dashboard goes back to following the
 * screen. The next pick overwrites the dead value.
 */
export function pickFor(store: Storage | undefined, dashboardId: string): LayoutPick | null {
  return parsePick(held(store, dashboardId));
}

/** What is stored for this dashboard, unparsed, or null where nothing can be read. */
function held(store: Storage | undefined, dashboardId: string): string | null {
  try {
    return store?.getItem(KEY + dashboardId) ?? null;
  } catch {
    // Storage that refuses to be read is a dashboard following the screen.
    return null;
  }
}

/** That string as a pick, or null where it is not one. */
function parsePick(raw: string | null): LayoutPick | null {
  if (!raw) return null;
  try {
    const read: unknown = JSON.parse(raw);
    if (typeof read !== 'object' || read === null) return null;
    const { layoutId, whileNearestIs } = read as Record<string, unknown>;
    if (typeof layoutId !== 'string' || typeof whileNearestIs !== 'string') return null;
    return { layoutId, whileNearestIs };
  } catch {
    return null;
  }
}

/** `null` puts the dashboard back on whichever layout is nearest the screen. */
export function pickLayout(
  store: Storage | undefined,
  dashboardId: string,
  pick: LayoutPick | null,
): void {
  try {
    if (pick === null) store?.removeItem(KEY + dashboardId);
    else store?.setItem(KEY + dashboardId, JSON.stringify(pick));
  } catch {
    // Not remembering is a smaller thing than not drawing the dashboard.
  }
}

/**
 * Everything currently reading a pick, so that changing one in the bar redraws
 * the board under it.
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
 * The pick for one dashboard, and the way to change it - kept current for every
 * reader in this document.
 *
 * `null` means nothing is being overridden, which is both "nothing has been
 * picked" and "the pick has expired": the two are the same state, because a
 * pick only ever holds while the screen it was made on is the screen you are
 * on, and what happens either side of that is the dashboard following the
 * screen.
 *
 * **A fresh object every read would spin `useSyncExternalStore` forever**,
 * since it compares snapshots by identity and a parse returns a new one each
 * time. The raw string is what is subscribed to, and the parse hangs off *that
 * string* rather than off a second read of the store - which would be a second
 * trip to storage every render, and one that can see a different value than the
 * render is holding.
 */
export function useChosenLayout(
  store: Storage | undefined,
  dashboardId: string,
): [LayoutPick | null, (pick: LayoutPick | null) => void] {
  const stored = useSyncExternalStore(subscribe, () => held(store, dashboardId), () => null);
  const pick = parsePick(stored);
  const choose = useCallback(
    (next: LayoutPick | null) => {
      pickLayout(store, dashboardId, next);
      for (const tell of readers) tell();
    },
    [store, dashboardId],
  );
  return [pick, choose];
}
