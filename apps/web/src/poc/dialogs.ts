import { useSyncExternalStore } from 'react';

/** POC (throwaway): which Combine or Split dialog is open, opened from anywhere. */
export interface Asking {
  combine: { itemIds: string[]; dashboardId: string | null; boardNodeIds: string[] } | null;
  split: { itemId: string; dashboardId: string | null } | null;
}

let asking: Asking = { combine: null, split: null };
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((listener) => listener());

export function useAsking(): Asking {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => asking,
    () => asking,
  );
}

export function askToCombine(itemIds: string[], dashboardId: string | null, boardNodeIds: string[] = []) {
  asking = { ...asking, combine: { itemIds: [...new Set(itemIds)], dashboardId, boardNodeIds } };
  tell();
}

export function askToSplit(itemId: string, dashboardId: string | null) {
  asking = { ...asking, split: { itemId, dashboardId } };
  tell();
}

export function stopAsking() {
  asking = { combine: null, split: null };
  tell();
}

/** The Dashboard open in the address bar, read where no route params are at hand. */
export function openDashboardId(): string | null {
  const found = /\/d\/([^/?#]+)/.exec(window.location.pathname);
  return found ? decodeURIComponent(found[1]!) : null;
}
