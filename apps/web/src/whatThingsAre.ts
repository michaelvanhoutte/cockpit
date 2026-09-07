/**
 * What a workspace, a dashboard and a panel are, in the words the app explains
 * them in.
 *
 * **Written once here because each is said in more than one place**, and two
 * copies of an explanation drift into two explanations.
 *
 * **They are shown where the thing is made, not before it.** Pressing `+` is
 * the moment somebody is asking what the thing is; a screen at sign-in that
 * explained all of it would be teaching words before there is anything to use
 * them on - and nobody can know when they want a second dashboard until they
 * have used the first for a while, so asking earlier would be demanding a
 * decision in the one moment it cannot be made.
 *
 * **The example is the half that does the work.** A definition tells you what
 * the word means; an example tells you whether the thing in front of you is one
 * - and the workspace's is a *pair*, because the obvious advice is wrong for
 * half the people who read it. "One for work, one for personal, one per
 * customer" tells somebody at one company serving two customers to make two
 * workspaces, when what they want is one workspace and a dashboard each. What
 * decides between the two is whether the whole context changes.
 */

export const WHAT_A_WORKSPACE_IS =
  'Everything you want in front of you while you work in one context: the accounts it connects, and everything filed in it. Switching workspace switches all of it. A contractor working for two customers wants one each; somebody at one company serving two customers wants one workspace, and a dashboard per customer.';

export const WHAT_A_DASHBOARD_IS =
  'A view inside one workspace, switched to like a tab. Everything in the workspace is still there — a dashboard is which slice of it you are looking at. One per project, or per customer, is a good place to start.';

export const WHAT_A_PANEL_IS =
  'A box on this dashboard holding whatever you file into it — everything about your one-on-ones, what is waiting on somebody else, or what the next board meeting needs.';

/**
 * How an item gets onto a panel, said until it has been done once.
 *
 * **Both ends of one gesture**, because on a wide screen the Inbox and the
 * panels are side by side and on a phone they are two screens: whichever half
 * somebody is looking at says it.
 *
 * **Neither says only "drag".** There is no drag from the Inbox to a panel on a
 * phone - it is a swipe, or *Move to…* in the row's own menu - so both name the
 * menu, which is the one way that works everywhere.
 */
export const HOW_AN_ITEM_IS_FILED =
  'Drag an item onto it from the Inbox, or file it from the item’s own menu.';

export const HOW_TO_FILE_FROM_THE_INBOX =
  'Drag one onto a panel to file it, or file it from its own menu.';
