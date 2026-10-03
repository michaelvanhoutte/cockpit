import { useSyncExternalStore } from 'react';
import { browserStore } from './lastVisited';

/**
 * POC: whether a workspace shows its Done tab, remembered in this browser, and
 * whether the tab is the one being looked at (in memory only).
 */
const key = (workspaceId: string) => `cockpit.doneTab.${workspaceId}`;
/** The id the Done tab's filter is stored under, standing in for a dashboard's. */
export const doneFilterId = (workspaceId: string) => `done:${workspaceId}`;

let viewingIn: string | null = null;
let version = 0;
const readers = new Set<() => void>();
const tell = () => {
  version += 1;
  for (const reader of readers) reader();
};
const subscribe = (onChange: () => void) => {
  readers.add(onChange);
  return () => {
    readers.delete(onChange);
  };
};

function readEnabled(workspaceId: string): boolean {
  try {
    return browserStore()?.getItem(key(workspaceId)) === '1';
  } catch {
    return false;
  }
}

export function useDoneTab(workspaceId: string | undefined) {
  useSyncExternalStore(subscribe, () => version, () => 0);
  const enabled = workspaceId ? readEnabled(workspaceId) : false;
  const viewing = enabled && workspaceId !== undefined && viewingIn === workspaceId;
  const setEnabled = (on: boolean) => {
    if (!workspaceId) return;
    try {
      if (on) browserStore()?.setItem(key(workspaceId), '1');
      else browserStore()?.removeItem(key(workspaceId));
    } catch {
      /* a browser that refuses storage shows the tab for this visit only */
    }
    if (!on && viewingIn === workspaceId) viewingIn = null;
    tell();
  };
  const setViewing = (on: boolean) => {
    if (!workspaceId) return;
    if (on) viewingIn = workspaceId;
    else if (viewingIn === workspaceId) viewingIn = null;
    tell();
  };
  return { enabled, viewing, setEnabled, setViewing };
}
