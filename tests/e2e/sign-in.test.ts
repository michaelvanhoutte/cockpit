import {
  ADA,
  MICHAEL,
  addressOf,
  captureBox,
  dashboardBar,
  expect,
  inbox,
  itemRow,
  makeWorkspace,
  pastOnboarding,
  press,
  signIn,
  somebodyNew,
  switchTo,
  test,
  uniqueTitle,
  workspaceTab,
  whatTheBrowserStillHolds,
} from './support/app';

/**
 * F3, because every claim here is about a whole browser: that a sign-in which
 * *leaves the application and comes back* ends with a cookie a reload still
 * finds, and - the one that exists nowhere below this tier - that switching
 * people leaves nothing of the first one on screen or in the browser's own
 * persisted cache. That cache is IndexedDB, written by the app itself, and
 * jsdom does not have one.
 *
 * The round trip is the reason this tier is worth the seconds: below it, the
 * two halves of a sign-in are two function calls, and nothing checks that a
 * real browser carries what it has to carry between them.
 *
 * Every way a reply can be wrong is settled far more cheaply in
 * apps/api/tests/unit/auth/oidc.test.ts, what the gate refuses in
 * apps/api/tests/integration/http/sign-in.test.ts, and what makes a sign-in
 * still current in apps/api/tests/unit/auth/session.test.ts. None of it is
 * re-proved here.
 */
test.describe('Sign-in', () => {
  test.describe('you sign in with your Google account, and Cockpit remembers who you are', () => {
    test('leaves for Google, comes back in your own workspaces, and is still you after a reload', async ({
      page,
      isMobile,
    }) => {
      await page.goto('/');

      // Sent to the logon page rather than to the app: nothing works until you
      // have signed in - and the page offers one way to, with nothing on it
      // about who else uses this Cockpit.
      await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
      await expect(page.getByText(MICHAEL, { exact: true })).toHaveCount(0);

      await press(page.getByRole('link', { name: 'Continue with Google' }), isMobile);

      // Away from the application entirely, at the issuer, which is where the
      // question "who are you" is actually answered.
      await expect(page).toHaveURL(/\/authorize/);
      await press(page.getByRole('link', { name: addressOf(MICHAEL), exact: true }), isMobile);

      await expect(dashboardBar(page)).toBeVisible();
      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await expect(page.getByText(`Signed in as ${MICHAEL}`)).toBeVisible();
      await page.keyboard.press('Escape');

      await page.reload();

      await expect(dashboardBar(page)).toBeVisible();
      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await expect(page.getByText(`Signed in as ${MICHAEL}`)).toBeVisible();
    });

    /**
     * Anybody with a Google account gets in ("Sign in with any Google account,
     * so a recruiter doesn't need to be added first", issue 343): an address
     * nobody added lands in an account of its own, called what Google calls
     * them. What the register ends up holding - one person however often or
     * however concurrently they sign in - is settled at
     * apps/api/tests/integration/http/sign-in.test.ts and not re-proved here.
     */
    test('lets in a Google account nobody added, into an account of its own', async ({
      page,
      isMobile,
    }) => {
      // Fresh per run and per project, since the register is not rebuilt
      // between the two and would otherwise already hold them the second time.
      const { name, address } = somebodyNew('Recruiter');
      await page.goto('/signin');
      await press(page.getByRole('link', { name: 'Continue with Google' }), isMobile);

      await page.getByPlaceholder('somebody@example.com').fill(address);
      await page.getByPlaceholder('Their name at Google').fill(name);
      await press(page.getByRole('button', { name: 'Continue' }), isMobile);

      // Either landing, waited for as one: an account nobody has opened before
      // may ask the onboarding question first (as `signInWithoutSkipping`).
      await page
        .getByRole('button', { name: 'Skip' })
        .or(dashboardBar(page))
        .first()
        .waitFor({ state: 'visible' });
      await pastOnboarding(page, isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
    });
  });

  /**
   * The capability's one walk ("Sign in as a guest, without a password", issue
   * 354): a stranger with no account of their own presses once and is working.
   * What the register ends up holding - one account however many press it - is
   * settled far more cheaply at
   * apps/api/tests/integration/http/sign-in.test.ts and is not re-proved here.
   */
  test.describe('you can continue as a guest, with no account of your own', () => {
    test('goes straight from one press into a workspace', async ({ page, isMobile }) => {
      await page.goto('/signin');

      await press(page.getByRole('link', { name: 'Continue as guest' }), isMobile);

      // Either landing, waited for as one: the guest account may never have
      // been opened on before, and the question that asks is the first thing on
      // screen. (The same wait `signInWithoutSkipping` makes, and for the same
      // reason - asserting against a page mid-redirect fails saying it could
      // not find a heading rather than that it never arrived.)
      await page
        .getByRole('button', { name: 'Skip' })
        .or(dashboardBar(page))
        .first()
        .waitFor({ state: 'visible' });
      await pastOnboarding(page, isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await expect(page.getByText('Signed in as Guest')).toBeVisible();
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

      await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
      await expect(dashboardBar(page)).toHaveCount(0);

      // Off the screen is half of it. The other half is what a cold open would
      // paint from, and it has to hold nothing at all: the list of people was
      // the one thing kept back, and it went with the picker.
      await expect
        .poll(async () => (await whatTheBrowserStillHolds(page)).storedQueries)
        .toEqual([]);
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
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
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
      await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();

      await press(page.getByRole('link', { name: 'Continue with Google' }), isMobile);
      await press(page.getByRole('link', { name: addressOf(MICHAEL), exact: true }), isMobile);

      await expect(dashboardBar(page)).toBeVisible();
      await expect(workspaceTab(page, workspace)).toHaveCount(0);
      await expect(itemRow(page, thought)).toHaveCount(0);
      // And it is genuinely Michael looking, rather than an empty screen.
      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await expect(page.getByText(`Signed in as ${MICHAEL}`)).toBeVisible();
    });
  });
});
