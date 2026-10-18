import type { QueryClient } from '@tanstack/react-query';
import { browserStore, forgetEveryView } from '../lastVisited';
import { forgetEveryRecentPanel } from '../recentPanels';
import { forgetItemFormSize } from '../itemFormSize';
import { forgetItemFormDockedWidth } from '../itemFormDockedWidth';
import { forgetInboxWidth } from '../inboxWidth';
import { forgetInboxCollapsed } from '../inboxCollapsed';
import { forgetPanelListCollapsed, forgetPanelListWidth } from '../panelList';
import { forgetEveryDashboardFilter } from '../dashboardFilter';
import { forgetEveryAllItemsTab } from '../allItemsTab';
import { forgetEverySeenChange } from '../cockpitChanges';
import { forgetWhatJustHappened } from '../undo';
import { forgetEverySavedRead } from '../persistence';

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
 * - every read saved in IndexedDB, which is what the *next* offline open would
 *   draw from, a week later if need be (`persistence.tsx`) - and only those:
 *   the capture outbox, kept recordings and held shares are each in a database
 *   of their own and stay;
 * - which view each workspace was last on, which panels were last filed into,
 *   the size a drag last left the item form at, the width a drag last left it
 *   docked to, the size a drag last left the Inbox column and the Panel list at, whether the
 *   Inbox and the Panel list are collapsed, which dashboards are filtered,
 *   which workspaces show their All items tab, and which of what Cockpit
 *   changed on an item has been seen, all eleven in localStorage - the last
 *   ten of them
 *   because leaving one behind gives the first person's answer to the second;
 * - what the undo bar is still offering, which is a title of theirs drawn over
 *   whatever screen comes next.
 *
 * Order matters for the first two. Emptying the cache first and removing the
 * saved reads second means nothing can write the old contents back out
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
    await forgetEverySavedRead();
  } catch {
    // A browser with no usable IndexedDB - a private window, storage refused,
    // or a test environment that has none - stored nothing to remove. Failing
    // here would leave the in-memory cache emptied and the sign-out half done,
    // which is worse than the thing that could not happen anyway.
  }
  forgetEveryView(browserStore());
  forgetEveryRecentPanel(browserStore());
  forgetItemFormSize(browserStore());
  forgetItemFormDockedWidth(browserStore());
  forgetInboxWidth(browserStore());
  forgetInboxCollapsed(browserStore());
  forgetPanelListCollapsed(browserStore());
  forgetPanelListWidth(browserStore());
  forgetEveryDashboardFilter(browserStore());
  forgetEveryAllItemsTab(browserStore());
  forgetEverySeenChange(browserStore());
  forgetWhatJustHappened();
}
