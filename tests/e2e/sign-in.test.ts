import {
  ADA,
  MICHAEL,
  captureBox,
  dashboardBar,
  expect,
  inbox,
  itemRow,
  openSettings,
  press,
  signIn,
  test,
  uniqueTitle,
  whatTheBrowserStillHolds,
} from './support/app';

/**
 * F3, because every claim here is about a whole browser: that clicking a name
 * puts a cookie somewhere a reload still finds it, and - the one that exists
 * nowhere below this tier - that switching people leaves nothing of the first
 * one on screen or in the browser's own persisted cache. That cache is
 * IndexedDB, written by the app itself, and jsdom does not have one.
 *
 * What the gate refuses, and what makes a sign-in still current, are settled far
 * more cheaply in apps/api/tests/integration/http/sign-in.test.ts and
 * apps/api/tests/unit/auth/session.test.ts, and are not re-proved here.
 */
test.describe('Sign-in', () => {
  test.describe('you sign in by choosing your name, and Cockpit remembers who you are', () => {
    test('lists everyone, opens the workspaces of whoever you choose, and is still them after a reload', async ({
      page,
      isMobile,
    }) => {
      await page.goto('/');

      // Sent to the logon page rather than to the app: nothing works until you
      // have said who you are.
      await expect(page.getByText('Choose who you are.')).toBeVisible();
      await expect(page.getByRole('button', { name: MICHAEL, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: ADA, exact: true })).toBeVisible();

      await press(page.getByRole('button', { name: MICHAEL, exact: true }), isMobile);

      await expect(dashboardBar(page)).toBeVisible();
      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await expect(page.getByText(`Signed in as ${MICHAEL}`)).toBeVisible();
      await page.keyboard.press('Escape');

      await page.reload();

      await expect(dashboardBar(page)).toBeVisible();
      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await expect(page.getByText(`Signed in as ${MICHAEL}`)).toBeVisible();
    });
  });

  test.describe('signing out ends the visit and leaves nothing of it behind', () => {
    test('puts you back on the logon page, holding none of your work', async ({
      page,
      isMobile,
    }) => {
      await signIn(page, MICHAEL, isMobile);
      // Somewhere with something in it, so there is genuinely something to be
      // left behind: opening a workspace is what fills the stored copy and what
      // writes down which view it was on.
      //
      // The Inbox is beside the dashboards where there is room for it and a tab
      // in the bar where there is not ("Show the Inbox beside the dashboards
      // instead of as a tab", issue 117), so only the narrow one switches to
      // it; on the wide one it is already on screen.
      if (isMobile) {
        await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      }
      await expect(captureBox(page)).toBeVisible();
      await expect
        .poll(async () => (await whatTheBrowserStillHolds(page)).storedQueries.length)
        .toBeGreaterThan(1);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Sign out' }), isMobile);

      await expect(page.getByText('Choose who you are.')).toBeVisible();
      await expect(dashboardBar(page)).toHaveCount(0);

      // Off the screen is half of it. The other half is what a cold open would
      // paint from, and it has to hold nothing but the public list of people.
      await expect
        .poll(async () => (await whatTheBrowserStillHolds(page)).storedQueries)
        .toEqual(['["users"]']);
      expect((await whatTheBrowserStillHolds(page)).localKeys).toEqual([]);
    });
  });
});

test.describe('Accounts', () => {
  test.describe('signing in as somebody else shows their work and none of the last person’s', () => {
    /**
     * The one case that cannot be proved below a real browser. The leak it
     * watches for would live in the browser's own persisted copy of the read
     * model - written to IndexedDB so that a cold open paints without waiting
     * for the network - and a workspace or an item still readable from there
     * after somebody else signs in is exactly the thing the account boundary is
     * for.
     */
    test('leaves none of their workspaces or their thoughts on the screen', async ({
      page,
      isMobile,
    }) => {
      const workspace = uniqueTitle('Bookkeeping');
      const thought = uniqueTitle('Reconcile the quarter');

      // Made in Ada's account rather than in Michael's, and the direction
      // matters: every other spec in the run works in Michael's, and this walk
      // has no way to take back the workspace it makes - it ends signed in as
      // somebody else. One more permanent row on the settings list is one more
      // row the ordering walks have to drag past on a 480px phone. Which way
      // round the walk goes proves the same thing either way; this way it costs
      // nobody else anything.
      await signIn(page, ADA, isMobile);
      await openSettings(page, isMobile);
      await page.getByLabel('Name of the new workspace').fill(workspace);
      await press(page.getByRole('button', { name: 'New workspace' }), isMobile);
      const mine = page.locator('header').getByRole('link', { name: workspace });
      await expect(mine).toBeVisible();
      await press(mine, isMobile);
      // Already beside the dashboards on the wide project; a tab to switch to
      // on the narrow one (issue 117, as above).
      if (isMobile) {
        await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      }
      await captureBox(page).fill(thought);
      await press(inbox(page).getByRole('button', { name: 'Capture' }), isMobile);
      await expect(itemRow(page, thought)).toBeVisible();

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Sign out' }), isMobile);
      await expect(page.getByText('Choose who you are.')).toBeVisible();

      await press(page.getByRole('button', { name: MICHAEL, exact: true }), isMobile);

      await expect(dashboardBar(page)).toBeVisible();
      await expect(page.locator('header').getByRole('link', { name: workspace })).toHaveCount(0);
      await expect(itemRow(page, thought)).toHaveCount(0);
      // And it is genuinely Michael looking, rather than an empty screen.
      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await expect(page.getByText(`Signed in as ${MICHAEL}`)).toBeVisible();
    });
  });
});
