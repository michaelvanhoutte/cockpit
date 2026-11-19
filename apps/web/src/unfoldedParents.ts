import { useCallback, useSyncExternalStore } from 'react';

/**
 * Which parents are unfolded to show their children under their row
 * ("Brainstorming: an Item can't hold other Items", issue 1825). **Held in
 * memory and nowhere else**, as a collapsed Panel is: unfolding is a way of
 * looking at the page in hand, so a reload folds every parent again. Shared by
 * every list, so a parent unfolded on one Panel is unfolded wherever it shows.
 */
let unfolded: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Unfolds a parent that is folded and folds one that is unfolded. */
export function toggleUnfolded(itemId: string): void {
  const next = new Set(unfolded);
  if (next.has(itemId)) next.delete(itemId);
  else next.add(itemId);
  unfolded = next;
  listeners.forEach((listener) => listener());
}

/** Unfolds these parents, leaving every other as it is: what landing on a child row needs first. */
export function unfoldAll(itemIds: Iterable<string>): void {
  const next = new Set([...unfolded, ...itemIds]);
  if (next.size === unfolded.size) return;
  unfolded = next;
  listeners.forEach((listener) => listener());
}

/** Whether this parent shows its children, and the one way to change it. */
export function useUnfolded(itemId: string): { unfolded: boolean; toggle: () => void } {
  const open = useSyncExternalStore(
    subscribe,
    () => unfolded.has(itemId),
    () => false,
  );
  const toggle = useCallback(() => toggleUnfolded(itemId), [itemId]);
  return { unfolded: open, toggle };
}

/** Folds every parent: what a test starts each case from. */
export function foldEveryParent(): void {
  unfolded = new Set();
  listeners.forEach((listener) => listener());
}
