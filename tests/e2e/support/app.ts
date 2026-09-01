import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared arrangement for the F3 walks. Not a page-object layer — F3 is
 * deliberately thin (what each level is for, docs/testing-strategy.md §4) and
 * an abstraction over four locators would hide the thing the tests exist to
 * prove.
 *
 * Every run starts from the same place: scripts/e2e-stack.mjs stamps out a
 * fresh register before the stack comes up, and each account's own store is
 * created empty by the first request that opens it. Neither is the storage
 * `pnpm dev` uses. So a run cannot be affected by what was clicked yesterday,
 * and cannot leave anything in the storage being developed against.
 *
 * Every walk now begins by signing in, because nothing but the logon page works
 * until you have. Cookies are per browser context and Playwright gives each
 * test its own, so a walk is never carrying the sign-in of the one before it.
 *
 * What that does NOT give is isolation *within* a run. All the specs, under
 * both projects, share one stack and one database, so an item captured by the
 * first spec is still there when the second runs. There is no per-test reset
 * to be had cheaply: the only reliable one is restarting the stack, at about
 * nine seconds each. So the rule stands, for a smaller reason than before —
 * EVERY TEST CREATES WHAT IT NEEDS, NAMES IT UNIQUELY, AND ASSERTS ONLY ON
 * THAT. A count ("the inbox has three items") depends on which specs ran
 * first, and would break the day one is added.
 *
 * The way out now exists but is not taken: making a workspace is a capability
 * as of "Create a workspace from a settings page" (issue 30), and a spec that
 * makes its own would get real per-test isolation for free. It costs a
 * workspace and a page load per spec, so it stays available rather than
 * mandatory - and unique titles remain the rule for everything that does not
 * take it.
 */

/**
 * Presses a control the way the device under test would. This is not a
 * nicety: Playwright's `click()` dispatches mouse events even on a project
 * with `hasTouch`, so a suite that only clicks proves nothing about touch
 * however many phone projects it runs under, and a control reachable only by
 * mouse would pass everywhere. `tap()` dispatches the real touchstart and
 * touchend, and refuses to run without `hasTouch` — hence the gate rather
 * than using it everywhere.
 */
export async function press(locator: Locator, isMobile: boolean): Promise<void> {
  if (isMobile) await locator.tap();
  else await locator.click();
}

/** A title no other run — or branch — will have produced. */
export function uniqueTitle(label: string): string {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * The two people the register is seeded with (apps/api/seed.sql). Each owns an
 * account of their own, and they share nothing.
 */
export const MICHAEL = 'Michael';
export const ADA = 'Ada';

/**
 * Signs in by choosing a name, which is the only way into the app.
 *
 * Used as arrangement by every walk about something else - the walk about
 * signing in itself asserts its way through these steps rather than calling
 * this, because a helper that both arranges and asserts is a helper that can
 * make its own test vacuous.
 */
export async function signIn(page: Page, name: string, isMobile: boolean): Promise<void> {
  await page.goto('/signin');
  await press(page.getByRole('button', { name, exact: true }), isMobile);
  await expect(dashboardBar(page)).toBeVisible();
}

/**
 * Signs in as the first person and lands in their first workspace: "/" redirects
 * there and, inside it, to the view that workspace was last on (router.tsx).
 * Waits for the bar of dashboards, which is what says a workspace is open and
 * usable.
 */
export async function openFirstWorkspace(page: Page, isMobile: boolean): Promise<void> {
  await signIn(page, MICHAEL, isMobile);
}

/** The bar of views under the workspace tabs: the Inbox, then the dashboards. */
export function dashboardBar(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Dashboards' });
}

/**
 * Opens the first workspace and switches to its Inbox, which is where capture
 * and triage happen. A workspace opens on a dashboard unless it remembers
 * otherwise, so the walks about items say which view they need rather than
 * assuming one.
 */
export async function openInbox(page: Page, isMobile: boolean): Promise<void> {
  await openFirstWorkspace(page, isMobile);
  await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
  await expect(captureBox(page)).toBeVisible();
}

/**
 * Opens the workspace settings page through the header's menu. Used as
 * arrangement by the walks about renaming and deleting; the walk about
 * *reaching* the settings asserts its own way through those two controls
 * rather than calling this, because a helper that both arranges and asserts is
 * a helper that can make its own test vacuous.
 */
export async function openSettings(page: Page, isMobile: boolean): Promise<void> {
  await press(page.getByRole('button', { name: 'Settings' }), isMobile);
  await press(page.getByRole('menuitem', { name: 'Workspaces' }), isMobile);
  await expect(page.getByLabel('Name of the new workspace')).toBeVisible();
}

/**
 * The colour the page is actually painted in, as the browser computed it - the
 * shell covers the viewport, so this is the ground behind the panels. Read from
 * the computed style rather than the inline one, because what is under test is
 * what a person sees rather than what the attribute says.
 */
export async function groundOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    // The app shell is what the router mounts straight into #root.
    const shell = document.querySelector('#root > div');
    return shell ? getComputedStyle(shell).backgroundColor : '';
  });
}

export function captureBox(page: Page): Locator {
  return page.getByLabel('Capture a note or to-do');
}

/** The workspace's Inbox, holding everything still to deal with. */
export function inbox(page: Page): Locator {
  return page.getByRole('region', { name: 'Inbox' });
}

/** The row for one captured title, wherever it currently sits. */
export function itemRow(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

/**
 * Captures a thought and waits until it is on screen. Used as arrangement by
 * tests about something else — the capture walk itself asserts its way through
 * the same steps rather than calling this, because a helper that both arranges
 * and asserts is a helper that can make its own test vacuous.
 */
export async function capture(page: Page, title: string, isMobile: boolean): Promise<void> {
  await captureBox(page).fill(title);
  await press(page.getByRole('button', { name: 'Capture' }), isMobile);
  await expect(itemRow(page, title)).toBeVisible();
}

/**
 * What this browser is still holding of whoever was signed in: the query keys
 * in the stored copy of the read model (IndexedDB, written by
 * `apps/web/src/persistence.ts`) and the keys the app has written to
 * localStorage.
 *
 * Read straight out of the browser rather than off the screen, because that is
 * where the leak this guards against would live: a screen showing nothing of
 * the last person can still be sitting on a stored copy the *next* cold open
 * paints from, a week later. jsdom has no IndexedDB, so nothing below this tier
 * can look.
 */
export async function whatTheBrowserStillHolds(
  page: Page,
): Promise<{ storedQueries: string[]; localKeys: string[] }> {
  return page.evaluate(async () => {
    const stored = await new Promise<unknown>((resolve) => {
      const open = indexedDB.open('keyval-store');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('keyval')) return resolve(undefined);
        const read = db.transaction('keyval').objectStore('keyval').get('cockpit-query-cache-v1');
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => resolve(undefined);
      };
      open.onerror = () => resolve(undefined);
    });
    const queries =
      (stored as { clientState?: { queries?: { queryKey: unknown[] }[] } } | undefined)?.clientState
        ?.queries ?? [];
    return {
      storedQueries: queries.map((q) => JSON.stringify(q.queryKey)),
      localKeys: Object.keys(localStorage),
    };
  });
}

/**
 * Fails if the page scrolls sideways. The check that catches "it renders, but
 * off the edge of the phone" — the failure that is invisible to every test
 * below this tier, because jsdom has no layout engine and reports every width
 * as zero.
 */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const { scrollWidth, clientWidth } = document.documentElement;
    return { scrollWidth, clientWidth };
  });
  expect(
    overflow.scrollWidth,
    `page scrolls sideways: content is ${overflow.scrollWidth}px wide in a ${overflow.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}
