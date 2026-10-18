import { useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';

/**
 * Whether Cockpit is working offline: one switch the whole app obeys
 * (architecture, "The read model: persisted snapshot, revalidate, push"),
 * driven through TanStack Query's `onlineManager` so reads pause and routes
 * resolve from memory and the checked saved reads, rather than each place
 * deciding for itself.
 *
 * **Two ways in, one effect.** *Found*: the server did not answer on opening
 * (`opening.tsx`). *Chosen*: the person asked to work offline, which no control sets yet; the
 * flag is here so the two are told apart and either one is offline.
 *
 * **The browser's own online/offline events do not drive it.** `navigator.onLine`
 * is believed only when it says false (`api/loadFailure.ts`), and a bare `true`
 * coming back must not end offline that was found by a server not answering.
 */
export interface Standing {
  /** Opening has asked the server and is waiting on the answer. */
  connecting: boolean;
  /** The server did not answer; ends by itself once it does, and is never remembered. */
  found: boolean;
  /** The person chose to work offline; remembered on this device. */
  chosen: boolean;
}

/** Connecting until the open (`opening.tsx`) decides how it draws. */
let standing: Standing = { connecting: true, found: false, chosen: false };
const listeners = new Set<() => void>();

// Taken from the browser's two events, which would otherwise flip the manager
// on a `true` nothing here believes.
onlineManager.setEventListener(() => () => {});

/** Moves the switch and tells everything watching. A no-op when nothing changes. */
export function stand(change: Partial<Standing>): void {
  const next = { ...standing, ...change };
  if (next.connecting === standing.connecting && next.found === standing.found && next.chosen === standing.chosen) {
    return;
  }
  standing = next;
  onlineManager.setOnline(!isOffline());
  listeners.forEach((listener) => listener());
}

export const currentStanding = (): Standing => standing;

/** Whether reads are paused and changes refused, found or chosen alike. */
export const isOffline = (): boolean => standing.found || standing.chosen;

/** Called after every change of standing; returns what stops it. */
export const onStandingChange = subscribe;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStanding(): Standing {
  return useSyncExternalStore(subscribe, currentStanding, currentStanding);
}

export function useIsOffline(): boolean {
  const { found, chosen } = useStanding();
  return found || chosen;
}

/** Where this device remembers that the person chose to work offline; other tabs hear it change. */
export const CHOSEN_KEY = 'cockpit-working-offline';

export function readChosen(): boolean {
  try {
    return localStorage.getItem(CHOSEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberChosen(on: boolean): void {
  try {
    if (on) localStorage.setItem(CHOSEN_KEY, '1');
    else localStorage.removeItem(CHOSEN_KEY);
  } catch {
    // Storage refused: the choice holds for this visit and is forgotten at its end.
  }
}

/** Back to a fresh page load's standing, for a test. */
export function resetStanding(): void {
  rememberChosen(false);
  stand({ connecting: false, found: false, chosen: false });
}

/** What a change is refused with while offline, found or chosen. */
export class WorkingOffline extends Error {
  constructor() {
    super("You're working offline");
    this.name = 'WorkingOffline';
  }
}

/**
 * Called before a change is sent. A capture does not call it: it goes to the
 * outbox and is sent when the server answers.
 */
export function refuseWhileOffline(): void {
  if (!isOffline()) return;
  refusals++;
  listeners.forEach((listener) => listener());
  throw new WorkingOffline();
}

/** How many changes have been refused, so a notice can offer Go online each time. */
let refusals = 0;
export function useRefusals(): number {
  return useSyncExternalStore(subscribe, () => refusals, () => refusals);
}

/**
 * A route asked for a read that is neither in memory nor saved here in a shape
 * this version can read, while offline: said, rather than waited on in a paused
 * query that never settles (`router.tsx`).
 */
export class CannotBeLoadedOffline extends Error {
  constructor(readonly queryKey: readonly unknown[]) {
    super('can’t be loaded offline');
    this.name = 'CannotBeLoadedOffline';
  }
}
