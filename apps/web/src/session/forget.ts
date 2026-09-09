import type { QueryClient } from '@tanstack/react-query';
import { browserStore, forgetEveryView } from '../lastVisited';
import { forgetEveryRecentPanel } from '../recentPanels';
import { forgetItemFormSize } from '../itemFormSize';
import { forgetWhatJustHappened } from '../undo';
import { forgetWelcomed } from '../welcoming';
import { persister } from '../persistence';

/**
 * Everything this browser is holding about the person who was signed in.
 *
 * Called from one place, when the logon page opens - which is where both ways a
 * visit can end arrive, whether the person signed out or the sign-in ran out,
 * and the only screen with none of the app mounted to write what it removes
 * straight back out again (the reason is in `pages/LogonPage.tsx`). It is the
 * whole of "nothing of what you were looking at is left on screen or in the
 * browser's cache for whoever signs in next". There are four places to reach,
 * and missing any one of them leaves a leak that only shows up when a second
 * person uses the same browser:
 *
 * - the in-memory cache, which is what is on screen;
 * - the copy of it in IndexedDB, which is what the *next* cold open would paint
 *   from, a week later if need be (`persistence.tsx`);
 * - which view each workspace was last on, which panels were last filed into,
 *   the size a drag last left the item form at, and whether the question a
 *   new account opens on has been answered, all four in localStorage - the
 *   last of them because leaving it behind gives the first person's answer
 *   to the second;
 * - what the undo bar is still offering, which is a title of theirs drawn over
 *   whatever screen comes next.
 *
 * Order matters for the first two. Emptying the cache first and removing the
 * stored copy second means the persister cannot write the old contents back out
 * in between.
 */
export async function forgetEverything(queryClient: QueryClient): Promise<void> {
  // Everything, with nothing held back. There used to be an exception - the
  // list of people to sign in as, which the logon page was watching as this ran
  // - and it went with the list ("Sign in with Google, and retire the list of
  // names", issue 196). The logon page now reads nothing at all, so there is no
  // observer left for a removed query to strand.
  queryClient.removeQueries();
  try {
    await persister.removeClient();
  } catch {
    // A browser with no usable IndexedDB - a private window, storage refused,
    // or a test environment that has none - stored nothing to remove. Failing
    // here would leave the in-memory cache emptied and the sign-out half done,
    // which is worse than the thing that could not happen anyway.
  }
  forgetEveryView(browserStore());
  forgetEveryRecentPanel(browserStore());
  forgetItemFormSize(browserStore());
  forgetWelcomed(browserStore());
  forgetWhatJustHappened();
}
