import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test as base } from './support/app';
import { serveDeployments, type Deployments } from './support/deployments';

/**
 * F3, against a real service worker, which is the one thing every walk before
 * this lacked: the suite runs on Vite's dev server, which registers none, and
 * every upgrade bug so far was in the worker's lifecycle across a deploy.
 *
 * What the browser opens is the production build behind a server this spec
 * owns (support/deployments.ts), which decides when a deploy lands and removes
 * the files of the version it replaces, as Cloudflare does. It is not
 * Cloudflare, so looking at staging before promoting is still the check on
 * that. The message's wording and the "Could not load" card are settled in
 * apps/web/tests/unit/components/Updating.test.tsx and are not re-proved here.
 *
 * The signed-out start page is enough to walk on: Updating wraps the whole
 * window, the sign-in page included, so nothing here needs an account.
 */
const test = base.extend<{ deployed: Deployments }>({
  deployed: async ({}, use, testInfo) => {
    const deployed = await serveDeployments(resolve(testInfo.config.rootDir, '../../apps/web/dist'));
    try {
      await use(deployed);
    } finally {
      await deployed.close();
    }
  },
});

const MESSAGE = { name: 'A new version of Cockpit is out' };

/** Opens the deployed version and reloads once, so this tab is held by its worker: a page that loaded before its worker was active is not. */
async function open(page: Page, deployed: Deployments): Promise<void> {
  await page.goto(deployed.origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

/** The build the page in this tab is running: the module its start page loaded, which is how the app tells versions apart. */
function buildOf(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null);
}

/** Waits until the page in this tab is running `entry`'s build, across however many reloads that takes. */
async function onBuild(page: Page, entry: string): Promise<void> {
  await page.waitForFunction(
    (wanted) => document.querySelector('script[type="module"][src]')?.getAttribute('src') === wanted,
    entry,
  );
}

/** The tab coming back into view, the trigger a deploy is noticed on. */
async function comeBackIntoView(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

/** The status the server gives a file, asked of it directly rather than through any worker. */
async function serverSays(deployed: Deployments, path: string): Promise<number> {
  return (await fetch(`${deployed.origin}${path}`)).status;
}

/** What the page itself gets when it asks for a file, through its own worker. */
function pageAsks(page: Page, path: string): Promise<number> {
  return page.evaluate(async (address) => (await fetch(address)).status, path);
}

test.describe('Updating', () => {
  test.describe('a tab open across a deploy keeps working on its own version until the click', () => {
    test('says a new version is out, once', async ({ page, deployed }) => {
      await open(page, deployed);
      deployed.deploy();

      await comeBackIntoView(page);

      await expect(page.getByRole('alertdialog', MESSAGE)).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
      expect(await buildOf(page)).toBe(deployed.entryOf(1));
    });

    test('still gets a file of its own version that the server no longer has', async ({ page, deployed }) => {
      const file = deployed.aFileOf(1);
      await open(page, deployed);
      deployed.deploy();
      await comeBackIntoView(page);
      await expect(page.getByRole('alertdialog', MESSAGE)).toBeVisible();

      expect(await serverSays(deployed, file)).toBe(404);
      expect(await pageAsks(page, file)).toBe(200);
    });
  });

  test.describe('Continue loads the deployed version, and a plain reload stays on it', () => {
    test('runs the new build after Continue', async ({ page, deployed }) => {
      await open(page, deployed);
      const next = deployed.deploy();
      await comeBackIntoView(page);

      await page.getByRole('button', { name: 'Continue' }).click();

      await page.waitForFunction(
        (entry) => document.querySelector('script[type="module"][src]')?.getAttribute('src') === entry,
        deployed.entryOf(next),
      );
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(page.getByRole('alertdialog', MESSAGE)).toHaveCount(0);
    });

    test('opens Cockpit on the new build with no message after a plain reload', async ({ page, deployed }) => {
      await open(page, deployed);
      const next = deployed.deploy();
      await comeBackIntoView(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForFunction(
        (entry) => document.querySelector('script[type="module"][src]')?.getAttribute('src') === entry,
        deployed.entryOf(next),
      );

      await page.reload();

      expect(await buildOf(page)).toBe(deployed.entryOf(next));
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(page.locator('#root > *')).not.toHaveCount(0);
      await expect(page.getByRole('alertdialog', MESSAGE)).toHaveCount(0);
    });
  });

  test.describe('however many versions have stacked up, there is one message and Continue loads the latest', () => {
    test('lands on the newest when a version waits from an earlier visit and a newer one was deployed since', async ({ page, deployed }) => {
      await open(page, deployed);
      deployed.deploy();
      await comeBackIntoView(page);
      await expect(page.getByRole('alertdialog', MESSAGE)).toBeVisible();
      const newest = deployed.deploy();

      await page.reload();
      await expect(page.getByRole('alertdialog', MESSAGE)).toHaveCount(1);
      await page.getByRole('button', { name: 'Continue' }).click();

      await onBuild(page, deployed.entryOf(newest));
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(page.locator('#root > *')).not.toHaveCount(0);
      await expect(page.getByRole('alertdialog', MESSAGE)).toHaveCount(0);
    });
  });

  test.describe('a plain reload always loads Cockpit', () => {
    test('loads the newest after Continue while that version was still downloading', async ({ page, deployed }) => {
      await open(page, deployed);
      deployed.deploy();
      await comeBackIntoView(page);
      await expect(page.getByRole('alertdialog', MESSAGE)).toBeVisible();
      const newest = deployed.deploy();
      const download = deployed.hold();
      await comeBackIntoView(page);
      await download.asked;

      const reloaded = page.waitForEvent('load');
      await page.getByRole('button', { name: 'Continue' }).click();
      download.release();
      await reloaded;
      // Whichever version the click loaded, a second message is answered the same way.
      const message = page.getByRole('alertdialog', MESSAGE);
      await Promise.race([onBuild(page, deployed.entryOf(newest)), message.waitFor()]);
      if (await message.isVisible()) await page.getByRole('button', { name: 'Continue' }).click();
      await onBuild(page, deployed.entryOf(newest));

      await page.reload();

      expect(await buildOf(page)).toBe(deployed.entryOf(newest));
      await expect(page.locator('#root > *')).not.toHaveCount(0);
    });

    test('loads from the network when the stored copy is missing its start page', async ({ page, deployed }) => {
      await open(page, deployed);
      await page.evaluate(async () => {
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const request of await cache.keys()) {
            if (new URL(request.url).pathname.match(/^\/(index\.html)?$/)) await cache.delete(request);
          }
        }
      });

      await page.reload();

      expect(await buildOf(page)).toBe(deployed.entryOf(1));
      await expect(page.locator('#root > *')).not.toHaveCount(0);
    });
  });

  test.describe('opening with nothing new shows no message', () => {
    test('opens the app when no deploy has landed since the last visit', async ({ page, deployed }) => {
      await open(page, deployed);

      await page.reload();

      // Past the opening check, which holds the window empty until it has an answer.
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(page.locator('#root > *')).not.toHaveCount(0);
      await expect(page.getByRole('alertdialog', MESSAGE)).toHaveCount(0);
      expect(await buildOf(page)).toBe(deployed.entryOf(1));
    });
  });

  test.describe("another tab's click reaches this tab", () => {
    test('shows the message in the tab that did not click', async ({ page, context, deployed }) => {
      await open(page, deployed);
      const other = await context.newPage();
      await open(other, deployed);
      const next = deployed.deploy();
      await comeBackIntoView(page);
      await comeBackIntoView(other);
      await expect(page.getByRole('alertdialog', MESSAGE)).toBeVisible();
      await expect(other.getByRole('alertdialog', MESSAGE)).toBeVisible();

      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForFunction(
        (entry) => document.querySelector('script[type="module"][src]')?.getAttribute('src') === entry,
        deployed.entryOf(next),
      );

      await expect(other.getByRole('alertdialog', MESSAGE)).toHaveCount(1);
      expect(await buildOf(other)).toBe(deployed.entryOf(1));
      // Not asserted, because it does not hold: the click activates the new
      // worker, which clears the old version's files from the shared precache, so
      // `pageAsks(other, deployed.aFileOf(1))` is a 404 until this tab's own
      // click. That is the risk the update work accepted: an on-demand file here
      // can fail in that window, and "Get the new version" is the last resort.
      // "Load the latest version on one click" (issue 1186) does not claim to fix it.
    });
  });
});
