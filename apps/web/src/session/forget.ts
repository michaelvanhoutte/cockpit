import type { QueryClient } from '@tanstack/react-query';
import { browserStore, forgetEveryView } from '../lastVisited';
import { persister } from '../persistence';

/**
 * Everything this browser is holding about the person who was signed in.
 *
 * Called from one place, when the logon page opens - which is where both ways a
 * visit can end arrive, whether the person signed out or the sign-in ran out,
 * and the only screen with none of the app mounted to write what it removes
 * straight back out again (the reason is in `pages/LogonPage.tsx`). It is the
 * whole of "nothing of what you were looking at is left on screen or in the
 * browser's cache for whoever signs in next". There are three places to reach,
 * and missing any one of them leaves a leak that only shows up when a second
 * person uses the same browser:
 *
 * - the in-memory cache, which is what is on screen;
 * - the copy of it in IndexedDB, which is what the *next* cold open would paint
 *   from, a week later if need be (`persistence.ts`);
 * - which view each workspace was last on, in localStorage.
 *
 * Order matters for the first two. Emptying the cache first and removing the
 * stored copy second means the persister cannot write the old contents back out
 * in between.
 */
export async function forgetEverything(queryClient: QueryClient): Promise<void> {
  // Everything except the list of people to sign in as, which is the one read
  // that belongs to nobody: it answers before anyone has signed in and carries
  // names only. It is also the very query the logon page is watching by the
  // time this runs, and removing a query an observer is mounted on leaves that
  // observer waiting for an answer nothing will ever fetch - which is a logon
  // page stuck on "Looking who is here…" for good.
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'users' });
  try {
    await persister.removeClient();
  } catch {
    // A browser with no usable IndexedDB - a private window, storage refused,
    // or a test environment that has none - stored nothing to remove. Failing
    // here would leave the in-memory cache emptied and the sign-out half done,
    // which is worse than the thing that could not happen anyway.
  }
  forgetEveryView(browserStore());
}
