import {
  chooseTabAction,
  dashboardBar,
  dashboardTab,
  expect,
  expectNoSidewaysScroll,
  makeWorkspace,
  openFirstWorkspace,
  press,
  switchTo,
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
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      await expect(dashboardBar(page)).toBeInViewport();
      await expectNoSidewaysScroll(page);

      const name = uniqueTitle('Research');
      await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
      // The question says what a dashboard is, which is the moment somebody
      // pressing `+` is asking. Matched on the opening clause, so rewording the
      // sentence around it does not re-break this walk.
      //
      // Walking away from it is not here: Escape closing the question and
      // adding nothing belongs to the shared dialog rather than to this bar,
      // and is proved on it (apps/web/tests/unit/components/DashboardBar.test.tsx
      // presses Escape after a refusal and finds the box empty on reopening).
      await expect(
        page.getByRole('dialog').getByText(/A view inside one workspace/),
      ).toBeVisible();
      // Enter, not the button: adding a dashboard is a one-gesture thing you do
      // often, and a real key event is the only way to know the field takes it.
      await page.getByLabel('Name of the new dashboard').fill(name);
      await page.getByLabel('Name of the new dashboard').press('Enter');

      // In the bar, and open on it: adding one puts you on it, so this walk
      // does not have to switch first.
      const tab = dashboardBar(page).getByRole('link', { name });
      await expect(tab).toBeVisible();
      await expect(page.getByRole('heading', { name })).toBeVisible();
      // A dashboard you add is one you can file into: it arrives with a panel,
      // so the Inbox has a target from the moment the dashboard exists rather
      // than an empty sheet. Matched on the title the panel arrives under.
      await expect(page.getByRole('heading', { name: 'Panel 1' })).toBeVisible();
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
    test('renames one on its own tab, and lands elsewhere after deleting it', async ({
      page,
      isMobile,
    }) => {
      // Its own workspace: every spec in a run shares one database, and a walk
      // that deleted a dashboard out of Work would take it from whatever ran
      // next.
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const doomed = uniqueTitle('Recherche');
      await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
      await page.getByLabel('Name of the new dashboard').fill(doomed);
      await page.getByLabel('Name of the new dashboard').press('Enter');
      await expect(page.getByRole('heading', { name: doomed })).toBeVisible();
      // The dashboard being deleted is the one being looked at.
      const itsAddress = page.url();

      // The tab itself is how what can be done to a dashboard is reached
      // ("Change a workspace or a dashboard on the tab it is", issue 255): a
      // right-click with a mouse, a press on the tab you are on with a finger.
      // Which gesture opens a menu is a browser question, and the form it
      // opens is a dialog over the workspace rather than a screen, which is a
      // stacking and focus-trapping question only a browser answers.
      const renamed = uniqueTitle('Renamed');
      await chooseTabAction(page, dashboardTab(page, doomed), 'Edit…', isMobile);
      await page.getByLabel(`Name of ${doomed}`).fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      // In the bar, which is the only place a dashboard's name is now: the
      // list that used to hold a second copy of it is gone.
      await expect(dashboardTab(page, renamed)).toBeVisible();

      await chooseTabAction(page, dashboardTab(page, renamed), 'Delete', isMobile);
      // Its one panel is the one it arrived with, and the question names what
      // goes with the dashboard rather than only that it is going. The
      // "nothing on it" wording is reachable only after that panel has been
      // deleted, and is proved on the question itself
      // (apps/web/tests/unit/components/DashboardBar.test.tsx).
      await expect(page.getByText(`Delete ${renamed}? Its one panel goes with it.`)).toBeVisible();
      await press(page.getByRole('button', { name: `Yes, delete ${renamed}` }), isMobile);

      // Somewhere that works: a dashboard that is still there, and no tab in
      // the bar pointing at the one that has gone. The workspace moved
      // underneath by itself, the dashboard deleted being the one being looked
      // at.
      await expect(dashboardBar(page).getByRole('link', { name: renamed })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(page.url()).not.toBe(itsAddress);
      await expectNoSidewaysScroll(page);
    });
  });
});
