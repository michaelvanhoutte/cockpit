import { useCallback, useSyncExternalStore } from 'react';
import type { ScreenSizePick } from './arrangement';

/**
 * Which screen size is overriding the width rule, where somebody has picked
 * one from the menu rather than taking the screen's own answer ("Layouts
 * follow the screen you are on"; "Draw a dashboard against the screen sizes
 * its account has", issue 263).
 *
 * **Remembered in the browser, not in the database**, for the reason the last
 * view of a workspace is (lastVisited.ts) - and here the reason is the whole
 * feature. Layouts exist because the phone and the 4K screen want different
 * arrangements; storing "I am looking at the wide one" would push that choice
 * onto every other device, which is exactly what following the screen avoids.
 *
 * **One key for the whole app, not one per Dashboard.** Which screen you are
 * on is a fact about you, not about which Dashboard happens to be open - so a
 * pick made on one Dashboard is honoured on the next one you switch to, where
 * it has defined that size, and inert where it has not (`layoutToDraw`).
 *
 * **What is stored is a pick and the answer it overrides**, never a bare
 * screen size id, because a pick that outlives the screen it was made on is
 * the fault this module was written to fix (`ScreenSizePick` says how it
 * expires).
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

const KEY = 'cockpit.layoutPick';

/**
 * The pick currently held, or null where there is none to honour.
 *
 * **Anything that is not a pick in the current shape is no pick**, which
 * covers a value a browser is holding from before this rewrite: one keyed per
 * Dashboard and naming a layout id rather than a screen size. Reading those
 * forward would misapply a pick made for one Dashboard to whichever is open
 * now, so they are dropped, and every Dashboard goes back to following the
 * screen. The next pick overwrites the dead value.
 */
export function pickFor(store: Storage | undefined): ScreenSizePick | null {
  return parsePick(held(store));
}

/** What is stored, unparsed, or null where nothing can be read. */
function held(store: Storage | undefined): string | null {
  try {
    return store?.getItem(KEY) ?? null;
  } catch {
    // Storage that refuses to be read is a dashboard following the screen.
    return null;
  }
}

/** That string as a pick, or null where it is not one. */
function parsePick(raw: string | null): ScreenSizePick | null {
  if (!raw) return null;
  try {
    const read: unknown = JSON.parse(raw);
    if (typeof read !== 'object' || read === null) return null;
    const { screenSizeId, whileNearestIs } = read as Record<string, unknown>;
    if (typeof screenSizeId !== 'string' || typeof whileNearestIs !== 'string') return null;
    return { screenSizeId, whileNearestIs };
  } catch {
    return null;
  }
}

/** `null` puts every Dashboard back on whichever layout is nearest the screen. */
export function pickScreenSize(store: Storage | undefined, pick: ScreenSizePick | null): void {
  try {
    if (pick === null) store?.removeItem(KEY);
    else store?.setItem(KEY, JSON.stringify(pick));
  } catch {
    // Not remembering is a smaller thing than not drawing the dashboard.
  }
}

/**
 * Everything currently reading the pick, so that changing it in the bar
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
 * The pick, and the way to change it - kept current for every reader in this
 * document.
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
): [ScreenSizePick | null, (pick: ScreenSizePick | null) => void] {
  const stored = useSyncExternalStore(subscribe, () => held(store), () => null);
  const pick = parsePick(stored);
  const choose = useCallback(
    (next: ScreenSizePick | null) => {
      pickScreenSize(store, next);
      for (const tell of readers) tell();
    },
    [store],
  );
  return [pick, choose];
}
