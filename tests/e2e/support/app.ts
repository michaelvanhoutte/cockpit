import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared arrangement for the F3 walks. Not a page-object layer — F3 is
 * deliberately thin (what each level is for, docs/testing-strategy.md §4) and
 * an abstraction over four locators would hide the thing the tests exist to
 * prove.
 *
 * Every run starts from the same place: scripts/e2e-stack.mjs stamps out a
 * fresh register before the stack comes up, and the account's own store is
 * created empty by the run's first request. Neither is the storage `pnpm dev`
 * uses. So a run cannot be affected by what was clicked yesterday, and cannot
 * leave anything in the storage being developed against.
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
 * Opens the app at "/", which redirects to the first workspace (router.tsx),
 * and waits for it to be usable rather than merely loaded.
 */
export async function openFirstWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await expect(captureBox(page)).toBeVisible();
}

export function captureBox(page: Page): Locator {
  return page.getByLabel('Capture a note or to-do');
}

/** The panel with this heading — "Inbox", "In play", "Done". */
export function panel(page: Page, name: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
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
