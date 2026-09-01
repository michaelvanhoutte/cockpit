import { expect, test } from '@playwright/test';
import {
  dashboardBar,
  expectNoSidewaysScroll,
  openFirstWorkspace,
  openSettings,
  press,
  uniqueTitle,
} from './support/app';

/**
 * F3, because the bar, the field that grows in it and the address only exist in
 * a browser: the `+` is reached by a tap on a 480px screen and by a mouse on a
 * 1280px one, and landing on a dashboard by its own address is real navigation.
 *
 * It is not re-proving the naming rules, which
 * apps/api/tests/integration/http/dashboards.test.ts owns against a real store,
 * nor which view a workspace opens on, which
 * apps/web/tests/unit/router.test.tsx owns. This is the one walk that says the
 * capability works for a person.
 *
 * It adds its dashboard to a workspace it makes, not to a seeded one: every
 * spec in a run shares one database (support/app.ts), so a walk that filled
 * Work's bar would leave it filled for whatever ran next.
 */
test.describe('Dashboards', () => {
  test.describe('a dashboard you add is one you can switch to and come back to', () => {
    test('puts it in the bar, opens it empty, and is reachable by its address', async ({
      page,
      isMobile,
    }) => {
      // Its own workspace, which is what the note above promises: adding to
      // Work would leave its bar filled for whatever spec ran next.
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page);
      await openSettings(page, isMobile);
      await page.getByLabel('Name of the new workspace').fill(workspace);
      await press(page.getByRole('button', { name: 'New workspace' }), isMobile);
      await press(page.locator('header').getByRole('link', { name: workspace }), isMobile);
      await expect(dashboardBar(page)).toBeInViewport();
      await expectNoSidewaysScroll(page);

      const name = uniqueTitle('Research');
      await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
      // Enter, not the button: adding a dashboard is a one-gesture thing you do
      // often, and a real key event is the only way to know the field takes it.
      await page.getByLabel('Name of the new dashboard').fill(name);
      await page.getByLabel('Name of the new dashboard').press('Enter');

      // In the bar, and open on it: adding one puts you on it, so this walk
      // does not have to switch first.
      const tab = dashboardBar(page).getByRole('link', { name });
      await expect(tab).toBeVisible();
      await expect(page.getByRole('heading', { name })).toBeVisible();
      await expect(page.getByText('Nothing on this dashboard yet. Panels are what go here.')).toBeVisible();
      await expectNoSidewaysScroll(page);

      // The Inbox is pinned in the same bar, and switching to it is a switch
      // like any other.
      const address = page.url();
      await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      await expect(page.getByLabel('Capture a note or to-do')).toBeVisible();

      // Reachable by its own address, which is what makes a dashboard something
      // you can link to and come back to.
      await page.goto(address);
      await expect(page.getByRole('heading', { name })).toBeVisible();
    });
  });

  test.describe('deleting the dashboard you are on leaves you somewhere that works', () => {
    test('reaches the settings from the bar, renames one, and lands elsewhere after deleting', async ({
      page,
      isMobile,
    }) => {
      // Its own workspace: every spec in a run shares one database, and a walk
      // that deleted a dashboard out of Work would take it from whatever ran
      // next.
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page);
      await openSettings(page, isMobile);
      await page.getByLabel('Name of the new workspace').fill(workspace);
      await press(page.getByRole('button', { name: 'New workspace' }), isMobile);
      await press(page.locator('header').getByRole('link', { name: workspace }), isMobile);

      const doomed = uniqueTitle('Recherche');
      await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
      await page.getByLabel('Name of the new dashboard').fill(doomed);
      await page.getByLabel('Name of the new dashboard').press('Enter');
      await expect(page.getByRole('heading', { name: doomed })).toBeVisible();
      // The dashboard being deleted is the one being looked at.
      const itsAddress = page.url();

      // The menu at the right of the bar is how the settings are reached, and
      // choosing the entry is what proves it still leads there: the control
      // opens a menu rather than navigating ("Open every menu from the same
      // control", issue 115), and no level below this one can see where its
      // entry goes.
      await press(dashboardBar(page).getByRole('button', { name: 'Dashboard actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Manage dashboards' }), isMobile);
      const renamed = uniqueTitle('Renamed');
      await press(page.getByRole('button', { name: `Rename ${doomed}` }), isMobile);
      await page.getByLabel(`New name for ${doomed}`).fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(dashboardBar(page).getByRole('link', { name: renamed })).toBeVisible();

      await press(page.getByRole('button', { name: `Delete ${renamed}` }), isMobile);
      await expect(page.getByText(`Delete ${renamed}? There is nothing on it.`)).toBeVisible();
      await press(page.getByRole('button', { name: `Yes, delete ${renamed}` }), isMobile);

      // Somewhere that works: a dashboard that is still there, and no entry in
      // the bar pointing at the one that has gone.
      await expect(dashboardBar(page).getByRole('link', { name: renamed })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(page.url()).not.toBe(itsAddress);
      await expectNoSidewaysScroll(page);
    });
  });
});
