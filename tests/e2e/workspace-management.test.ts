import { expect, test } from '@playwright/test';
import {
  dashboardBar,
  expectNoSidewaysScroll,
  groundOf,
  openFirstWorkspace,
  openSettings,
  press,
  uniqueTitle,
} from './support/app';

/**
 * F3, because none of this exists below a real browser: the "···" menu is
 * opened by a tap on a 480px screen and by a mouse on a 1280px one, the route
 * it leads to is real navigation, and the new workspace has to turn up in the
 * header of a page that was already open.
 *
 * It is not re-proving the naming rules, which
 * apps/api/tests/integration/http/workspace-management.test.ts owns against a
 * real database, nor the form's own behaviour, which
 * apps/web/tests/unit/pages/WorkspaceSettingsPage.test.tsx owns, nor where the
 * router sends you when a workspace is gone, which
 * apps/web/tests/unit/router.test.tsx owns. One walk per capability - making
 * one, renaming one, deleting one - saying it works for a person.
 *
 * None of them touches a seeded workspace. Every spec in a run, under both
 * projects, shares one database (support/app.ts), so deleting Work would take
 * the other specs' workspace with it; each walk makes the workspace it is
 * going to change. That is also why "the last workspace can be deleted" is not
 * here: it needs a database with nothing in it, which this tier cannot arrange
 * without emptying it for everything else. The router's side of it is proved
 * in apps/web/tests/unit/router.test.tsx, and the server's in the integration
 * tests above.
 */
test.describe('Workspace management', () => {
  test.describe('a workspace you make is one you can switch to', () => {
    test('reaches the settings from the header and puts the new workspace in the tabs', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Workspaces' }), isMobile);

      const box = page.getByLabel('Name of the new workspace');
      await expect(box).toBeInViewport();
      await expectNoSidewaysScroll(page);

      const name = uniqueTitle('Bookkeeping');
      await box.fill(name);
      await press(page.getByRole('button', { name: 'New workspace' }), isMobile);

      // In the header, not merely somewhere on the settings page: being able to
      // switch to it is the whole point of having made it.
      const tab = page.locator('header').getByRole('link', { name });
      await expect(tab).toBeVisible();
      await expectNoSidewaysScroll(page);

      await press(tab, isMobile);
      // Open, on a view of itself: a workspace opens on the view it was last
      // on, and a new one has never been opened, so that is its first
      // dashboard ("Add and switch dashboards", issue 32).
      await expect(page.getByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
    });
  });

  test.describe('a workspace you rename is called that everywhere you see it', () => {
    test('changes the name in the tabs, from the settings page', async ({ page, isMobile }) => {
      const before = uniqueTitle('Bookkeeping');
      const after = uniqueTitle('Accounts');
      await openFirstWorkspace(page, isMobile);
      await openSettings(page, isMobile);
      await page.getByLabel('Name of the new workspace').fill(before);
      await press(page.getByRole('button', { name: 'New workspace' }), isMobile);
      await expect(page.locator('header').getByRole('link', { name: before })).toBeVisible();

      await press(page.getByRole('button', { name: `Rename ${before}` }), isMobile);
      await page.getByLabel(`New name for ${before}`).fill(after);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);

      await expect(page.locator('header').getByRole('link', { name: after })).toBeVisible();
      await expect(page.locator('header').getByRole('link', { name: before })).toHaveCount(0);
      await expectNoSidewaysScroll(page);
    });
  });

  test.describe('the page is painted in the colours of the workspace you are in', () => {
    test('takes the colour you choose, and changes back when you switch workspace', async ({
      page,
      isMobile,
    }) => {
      // F3 for the reason the whole rule is F3: "the page is a different
      // colour" is a computed style, and there is no computed style without a
      // browser. Everything below it - which three colours a theme is, what the
      // picker asks for, what the server stores - is settled at its own level.
      const mine = uniqueTitle('Repainted');
      await openFirstWorkspace(page, isMobile);
      const firstGround = await groundOf(page);

      await openSettings(page, isMobile);
      await page.getByLabel('Name of the new workspace').fill(mine);
      await press(page.getByRole('button', { name: 'New workspace' }), isMobile);
      // Deliberately not asserting that a *new* workspace already differs from
      // the first: which colour it is handed depends on how many workspaces
      // exist, every spec in the run shares one database, and the palette wraps
      // once all eight are taken - so that claim is true or false depending on
      // what ran before. It is the server's rule anyway, and is proved against
      // a real database in apps/api/tests/integration/http.
      const row = page.getByRole('listitem').filter({ hasText: mine });
      await press(row.getByRole('button', { name: `Olive for ${mine}` }), isMobile);
      await press(page.locator('header').getByRole('link', { name: mine }), isMobile);
      await expect(dashboardBar(page)).toBeVisible();

      // Repainted, without a reload anywhere in the walk.
      //
      // Polled rather than read once, and the difference is not cosmetic. Every
      // other assertion in this walk is an `expect(locator)`, which retries;
      // this one reads a computed style out of the page in a single
      // `page.evaluate` and would have to be right on the first try. What it is
      // waiting for is the workspace list being re-read after the colour was
      // accepted, so the window is however long that round trip takes - 12ms on
      // one run and 184ms on the next, and the slow one failed on a phone in CI
      // while the same commit passed on the desktop project beside it.
      await expect.poll(() => groundOf(page)).toBe('rgb(230, 235, 214)');

      // And switching away takes the colour with it. Polled for the same reason.
      await press(page.locator('header').getByRole('link', { name: 'Work' }), isMobile);
      await expect(dashboardBar(page)).toBeVisible();
      await expect.poll(() => groundOf(page)).toBe(firstGround);
    });
  });

  test.describe('deleting the workspace you were looking at leaves you somewhere that works', () => {
    test('takes the workspace out of the tabs and lands you on one that is still there', async ({
      page,
      isMobile,
    }) => {
      const name = uniqueTitle('Doomed');
      await openFirstWorkspace(page, isMobile);
      await openSettings(page, isMobile);
      await page.getByLabel('Name of the new workspace').fill(name);
      await press(page.getByRole('button', { name: 'New workspace' }), isMobile);

      // Look at it, so what is deleted is the workspace being viewed.
      const tab = page.locator('header').getByRole('link', { name });
      await press(tab, isMobile);
      await expect(dashboardBar(page)).toBeVisible();
      const itsUrl = page.url();

      await openSettings(page, isMobile);
      await press(page.getByRole('button', { name: `Delete ${name}` }), isMobile);
      // What goes with it, before it goes: nothing was put in this one.
      await expect(page.getByText(`Delete ${name}? There is nothing in it.`)).toBeVisible();
      await press(page.getByRole('button', { name: `Yes, delete ${name}` }), isMobile);

      await expect(tab).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Delete ${name}` })).toHaveCount(0);
      await expectNoSidewaysScroll(page);

      // Going back to where it was is not a dead end: a workspace you can work
      // in, not a failed read of one that is gone.
      await page.goto(itsUrl);
      await expect(dashboardBar(page)).toBeVisible();
      expect(page.url()).not.toBe(itsUrl);
    });
  });
});
