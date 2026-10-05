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

/** What an empty panel of items says. */
export const NOTHING_FILED_HERE = 'Nothing filed here yet.';

/**
 * What a panel of text says when nothing has been written in it and nobody may
 * ("Put a panel of text on a dashboard, and write in it", issue 250).
 *
 * Only when it is read-only: a panel somebody may write in says so in the box
 * itself, which is a placeholder rather than a sentence about emptiness.
 */
export const NOTHING_WRITTEN_HERE = 'Nothing written here yet.';

/** The invitation in an empty panel of text somebody may write in. */
export const WRITE_HERE = 'Write here…';

/**
 * What a panel is made of, asked when it is made because it is settled then and
 * never after (`panelKindSchema`).
 *
 * **Items, not actions.** A panel holds Items of whatever Type - a Task, a
 * Note, anything else somebody names - and *Action* stopped being one of the
 * product's words with "Call the two standard types Task and Note" (issue 194).
 */
export const WHAT_A_PANEL_HOLDS = [
  { kind: 'items' as const, label: 'Items', says: 'Holds whatever you file into it.' },
  { kind: 'text' as const, label: 'Text', says: 'A box you write in.' },
  { kind: 'filter' as const, label: 'Filter', says: 'Gathers what matches a rule.' },
];

/**
 * What a Filter says before anybody has told it what to show ("Add a Filter
 * panel that shows every filed item due in a window", issue 463).
 *
 * **It names the way in rather than only reporting.** A Filter with no
 * conditions gathers nothing, so an empty box saying so would be a dead end -
 * the same reason an empty panel of items says how one arrives.
 */
export const NOTHING_CHOSEN_TO_SHOW = 'Choose what this shows from its menu.';

/** What a Filter that has conditions says while nothing filed anywhere meets them. */
export const NOTHING_MATCHES_YET = 'Nothing matches this yet.';
