import { useSyncExternalStore } from 'react';
import { browserStore } from './lastVisited';

/**
 * Whether a workspace shows its *All items* tab ("Put each setting where a
 * person looks for it", issue 688): on or off per workspace, **remembered in
 * this browser and forgotten at sign-out**, the shape `agentDockHidden.ts`
 * carries and for the same reason - it is a choice about the chrome, not about
 * the workspace's data. A browser that refuses the write still shows the tab
 * for this visit: the readers are told either way.
 */

const PREFIX = 'cockpit.all-items-tab.';
const key = (workspaceId: string) => `${PREFIX}${workspaceId}`;

/** On only where the stored value says so; anything else is off. */
export function readAllItemsTab(store: Storage | undefined, workspaceId: string): boolean {
  try {
    return store?.getItem(key(workspaceId)) === '1';
  } catch {
    return false;
  }
}

/** Off is the default, so switching off removes the entry rather than storing it. */
export function writeAllItemsTab(store: Storage | undefined, workspaceId: string, on: boolean): void {
  try {
    if (on) store?.setItem(key(workspaceId), '1');
    else store?.removeItem(key(workspaceId));
  } catch {
    // Not remembering the choice is a smaller thing than one that throws.
  }
}

/** Called from `session/forget.ts`: the tab is one person's way of looking. */
export function forgetEveryAllItemsTab(store: Storage | undefined): void {
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

/** Everything drawing the tab or its menu entries, so a change redraws all of them. */
let version = 0;
const readers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  readers.add(onChange);
  return () => {
    readers.delete(onChange);
  };
}

/** Switches the tab on or off for a workspace and tells everything showing it. */
export function setAllItemsTab(workspaceId: string, on: boolean): void {
  writeAllItemsTab(browserStore(), workspaceId, on);
  version += 1;
  for (const tell of readers) tell();
}

/** Whether the workspace shows the tab, redrawn when it is switched. */
export function useAllItemsTab(workspaceId: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return workspaceId !== undefined && readAllItemsTab(browserStore(), workspaceId);
}
