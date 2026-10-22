import { useSyncExternalStore } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { browserStore } from './lastVisited';

/**
 * Whether a workspace shows its *Scheduled* tab ("See what is scheduled to come
 * back", issue 1431): on or off per workspace, **remembered in this browser and
 * forgotten at sign-out**, as `allItemsTab.ts` keeps *All items*. A choice about
 * the chrome, not about the workspace's data. A browser that refuses the write
 * still shows the tab for this visit: the readers are told either way.
 */

const PREFIX = 'cockpit.scheduled-tab.';
const key = (workspaceId: string) => `${PREFIX}${workspaceId}`;

export function readScheduledTab(store: Storage | undefined, workspaceId: string): boolean {
  try {
    return store?.getItem(key(workspaceId)) === '1';
  } catch {
    return false;
  }
}

export function writeScheduledTab(store: Storage | undefined, workspaceId: string, on: boolean): void {
  try {
    if (on) store?.setItem(key(workspaceId), '1');
    else store?.removeItem(key(workspaceId));
  } catch {
    // Not remembering the choice is a smaller thing than one that throws.
  }
}

export function forgetEveryScheduledTab(store: Storage | undefined): void {
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

let version = 0;
const readers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  readers.add(onChange);
  return () => {
    readers.delete(onChange);
  };
}

export function setScheduledTab(workspaceId: string, on: boolean): void {
  writeScheduledTab(browserStore(), workspaceId, on);
  version += 1;
  for (const tell of readers) tell();
}

export function useScheduledTab(workspaceId: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return workspaceId !== undefined && readScheduledTab(browserStore(), workspaceId);
}

/** The workspace whose *Scheduled* is the page on screen, or null on any other page. */
export function useScheduledOnScreen(): string | null {
  return useRouterState({
    select: (state) => /^\/w\/([^/]+)\/scheduled\/?$/.exec(state.location.pathname)?.[1] ?? null,
  });
}

export function useScheduledTabs(): (workspaceId: string) => boolean {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return (workspaceId) => readScheduledTab(browserStore(), workspaceId);
}
