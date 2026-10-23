import { useSyncExternalStore } from 'react';

/**
 * A request, from outside the Workspace's menu, to open the Recurring items modal
 * straight on one recurring item's form ("Point a copy at its master, and retire
 * the Repeats chip", issue 1450): a copy's *From recurring item* line is in the
 * Item form, and the modal belongs to the tabs (`WorkspaceTabs.tsx`). It is a
 * request and not state: the tabs take it once and the modal's own state is what
 * lasts.
 */
export interface RecurringRequest {
  /** The Workspace the recurring item is listed in. */
  workspaceId: string;
  /** The recurring item whose form opens. */
  seriesId: string;
}

let asked: RecurringRequest | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Asks for the modal, open on this recurring item. */
export function askForRecurringItem(request: RecurringRequest): void {
  asked = request;
  for (const listener of listeners) listener();
}

/** Takes the request, so it is answered once. */
export function takeRecurringRequest(): RecurringRequest | null {
  const taken = asked;
  if (taken === null) return null;
  asked = null;
  for (const listener of listeners) listener();
  return taken;
}

/** The request waiting to be answered, if any. */
export function useRecurringRequest(): RecurringRequest | null {
  return useSyncExternalStore(subscribe, () => asked, () => null);
}
