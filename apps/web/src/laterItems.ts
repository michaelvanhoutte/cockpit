import { useSyncExternalStore } from 'react';
import { browserStore } from './lastVisited';

/**
 * Whether a Panel of Items shows the Items due more than 30 days out ("Items
 * due months from now crowd this week's work", issue 1873): hidden unless this
 * Panel's choice says otherwise, **remembered in this browser and forgotten at
 * sign-out**, the shape `allItemsTab.ts` carries and for the same reason - it
 * is a way of looking, not part of the Workspace's data, so it is neither
 * shared with another device nor sent anywhere.
 *
 * A browser that refuses the write still shows the Items for this visit: what
 * was chosen is held in memory too, and read first.
 */

const PREFIX = 'cockpit.later-items.';
const key = (panelId: string) => `${PREFIX}${panelId}`;

/** What was chosen since this page loaded, which wins over the store so a refused write still takes effect. */
const chosen = new Map<string, boolean>();

/** Shown only where the stored value says so; anything else, unreadable included, is hidden. */
export function readLaterShown(store: Storage | undefined, panelId: string): boolean {
  try {
    return store?.getItem(key(panelId)) === '1';
  } catch {
    return false;
  }
}

/** Hidden is the default, so hiding removes the entry rather than storing it. */
export function writeLaterShown(store: Storage | undefined, panelId: string, shown: boolean): void {
  try {
    if (shown) store?.setItem(key(panelId), '1');
    else store?.removeItem(key(panelId));
  } catch {
    // Not remembering the choice is a smaller thing than one that throws.
  }
}

/** Called from `session/forget.ts`: the choice is one person's way of looking. */
export function forgetEveryLaterShown(store: Storage | undefined): void {
  chosen.clear();
  try {
    if (!store) return;
    const ours: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const stored = store.key(i);
      if (stored?.startsWith(PREFIX)) ours.push(stored);
    }
    for (const stored of ours) store.removeItem(stored);
  } catch {
    // A browser that refuses storage remembered nothing to forget.
  }
}

/** Whether a Panel shows its later Items, as this browser holds it right now. */
export function isLaterShown(panelId: string): boolean {
  return chosen.get(panelId) ?? readLaterShown(browserStore(), panelId);
}

/** Everything drawing a Panel's rows or its later entries, so a change redraws all of them. */
let version = 0;
const readers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  readers.add(onChange);
  return () => {
    readers.delete(onChange);
  };
}

/** Shows or hides a Panel's later Items and tells everything drawing them. */
export function setLaterShown(panelId: string, shown: boolean): void {
  chosen.set(panelId, shown);
  writeLaterShown(browserStore(), panelId, shown);
  version += 1;
  for (const tell of readers) tell();
}

/** Whether each Panel shows its later Items, redrawn when any is switched. */
export function useLaterShown(): (panelId: string) => boolean {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return isLaterShown;
}
