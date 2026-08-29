import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared arrangement for the F3 walks. Not a page-object layer — F3 is
 * deliberately thin (docs/testing-strategy.md §4) and an abstraction over four
 * locators would hide the thing the tests exist to prove.
 *
 * The one rule worth stating loudly, because breaking it fails only sometimes
 * and only later: THESE TESTS NEVER ASSUME AN EMPTY DATABASE. The same suite
 * runs against the shared `cockpit-preview` database, which every open branch
 * writes to and which is re-seeded rather than reset (docs/deployment.md §4),
 * and against a local D1 that persists between runs. So every test creates
 * what it needs, identifies it uniquely, and asserts only on that. A count
 * ("the inbox has three items") or a first-row assertion is a test that passes
 * alone and fails the moment anything else is running.
 */

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
export async function capture(page: Page, title: string): Promise<void> {
  await captureBox(page).fill(title);
  await page.getByRole('button', { name: 'Capture' }).click();
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
