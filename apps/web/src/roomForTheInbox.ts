import { useSyncExternalStore } from 'react';

/**
 * Whether there is room to show the Inbox beside the dashboards rather than
 * instead of them ("Show the Inbox beside the dashboards instead of as a tab",
 * issue 117).
 *
 * **768px, and a fifth of the width is why.** On a 480px phone a fifth is
 * about ninety pixels, which is not an Inbox - it is a column too narrow to
 * read a title in. Below this the Inbox stays what it was: a tab pinned at the
 * left of the bar, opening a screen of its own.
 *
 * Asked rather than watched in most places, because it is asked in two kinds
 * of place: the router, which decides before React renders anything, and the
 * components, which have to notice a window being resized. One question, two
 * ways of putting it.
 *
 * A browser with no `matchMedia` at all answers "no room", which is the phone
 * shape - the one that works everywhere - rather than a crash.
 */
export const ROOM_FOR_THE_INBOX = '(min-width: 768px)';

function theQuestion(): MediaQueryList | null {
  try {
    return globalThis.matchMedia?.(ROOM_FOR_THE_INBOX) ?? null;
  } catch {
    return null;
  }
}

/** Asked once, for the router, which decides before anything is rendered. */
export function roomForTheInbox(): boolean {
  return theQuestion()?.matches ?? false;
}

/** Asked and then watched, for the shell, which has to survive a resize. */
export function useRoomForTheInbox(): boolean {
  return useSyncExternalStore(whenItChanges, roomForTheInbox, () => false);
}

function whenItChanges(announce: () => void): () => void {
  const question = theQuestion();
  question?.addEventListener('change', announce);
  return () => question?.removeEventListener('change', announce);
}
