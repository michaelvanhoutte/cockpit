import {
  chooseRowAction,
  dashboardBar,
  expect,
  expectNoSidewaysScroll,
  openFirstWorkspace,
  openSettings,
  press,
  test,
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
      await openFirstWorkspace(page, isMobile);
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
      // What the screen is for, rather than a report that it is empty
      // ("Modernise the app shell", issue 125). Matched on the opening clause
      // so the walk is not re-broken by the sentence being reworded around it.
      await expect(page.getByText(/A dashboard holds the panels you want in view/)).toBeVisible();
      await expectNoSidewaysScroll(page);

      // The Inbox is on screen either way, which is what says the bar holds
      // dashboards and the Inbox is not one of them: a tab in the same bar
      // where there is no room beside, and already there where there is
      // ("Show the Inbox beside the dashboards instead of as a tab", issue
      // 117). Which of the two, and that they fit, is tests/e2e/inbox.test.ts.
      const address = page.url();
      if (isMobile) {
        await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      }
      await expect(page.getByLabel('Capture a note or to-do')).toBeVisible();

      // Reachable by its own address, which is what makes a dashboard something
      // you can link to and come back to.
      await page.goto(address);
      await expect(page.getByRole('heading', { name })).toBeVisible();
    });
  });

  test.describe('deleting the dashboard you are on leaves you somewhere that works', () => {
    test('opens the list from the bar, renames one, and lands elsewhere after deleting', async ({
      page,
      isMobile,
    }) => {
      // Its own workspace: every spec in a run shares one database, and a walk
      // that deleted a dashboard out of Work would take it from whatever ran
      // next.
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
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

      // The menu at the right of the bar is how the list is reached, and
      // choosing the entry is what proves it still opens it: the control opens
      // a menu rather than navigating ("Open every menu from the same control",
      // issue 115), and the list is a dialog over the workspace rather than a
      // screen, which is a stacking and focus-trapping question only a browser
      // answers.
      await press(dashboardBar(page).getByRole('button', { name: 'Dashboard actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Manage dashboards' }), isMobile);
      await expect(page.getByRole('dialog', { name: 'Manage dashboards' })).toBeVisible();
      const renamed = uniqueTitle('Renamed');
      await chooseRowAction(page, doomed, 'Rename', isMobile);
      await page.getByLabel(`New name for ${doomed}`).fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      // In the list, not in the bar: the bar is behind the dialog and hidden
      // from a reader while it is open, which is what a modal is for. That the
      // bar keeps up with the list is what the end of this walk shows.
      await expect(
        page.getByRole('dialog', { name: 'Manage dashboards' }).getByText(renamed),
      ).toBeVisible();

      await chooseRowAction(page, renamed, 'Delete', isMobile);
      await expect(page.getByText(`Delete ${renamed}? There is nothing on it.`)).toBeVisible();
      await press(page.getByRole('button', { name: `Yes, delete ${renamed}` }), isMobile);

      // The list stays open with the row gone, and closing it is what puts you
      // back on the workspace - which moved underneath while it was open,
      // because the dashboard being deleted was the one being looked at.
      const list = page.getByRole('dialog', { name: 'Manage dashboards' });
      await expect(list).toBeVisible();
      await expect(list.getByText(renamed)).toHaveCount(0);
      await press(page.getByRole('button', { name: 'Done' }), isMobile);
      await expect(page.getByRole('dialog', { name: 'Manage dashboards' })).toHaveCount(0);

      // Somewhere that works: a dashboard that is still there, and no entry in
      // the bar pointing at the one that has gone.
      await expect(dashboardBar(page).getByRole('link', { name: renamed })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(page.url()).not.toBe(itsAddress);
      await expectNoSidewaysScroll(page);
    });
  });
});
