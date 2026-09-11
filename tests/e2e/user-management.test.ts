import type { Page } from '@playwright/test';
import {
  ADA,
  MICHAEL,
  STARTING_WORKSPACE,
  addressOf,
  dashboardBar,
  expect,
  press,
  signIn,
  signInWith,
  somebodyNew,
  test,
  workspaceTab,
} from './support/app';

/** Opens somebody's row, sets the role, and waits for the list to say so. */
async function makeThem(page: Page, who: string, role: 'Admin' | 'User', isMobile: boolean) {
  await press(page.getByRole('button', { name: `Actions for ${who}` }), isMobile);
  await press(page.getByRole('menuitem', { name: 'Edit…' }), isMobile);
  await press(page.getByRole('radio', { name: new RegExp(`^${role}`) }), isMobile);
  await press(page.getByRole('button', { name: 'Save' }), isMobile);

  const row = page.getByRole('row').filter({ hasText: who });
  await expect(row.getByRole('cell', { name: role, exact: true })).toBeVisible();
}

/**
 * Adds somebody from the box above the list, and waits for their row.
 *
 * **`exact`, because the chrome above this page carries an *Add a workspace*
 * control** and a name match is a substring match: the two are one locator
 * without it, and which one a press finds depends on whether the workspace list
 * has landed yet. Three walks pressed it that way and passed until one did not.
 */
async function addSomebody(
  page: Page,
  who: { name: string; address: string },
  isMobile: boolean,
) {
  await page.getByLabel('Name').fill(who.name);
  await page.getByLabel('Signs in with').fill(who.address);
  await press(page.getByRole('button', { name: 'Add', exact: true }), isMobile);

  const row = page.getByRole('row').filter({ hasText: who.address });
  await expect(row).toHaveCount(1);
  return row;
}

/** Takes somebody's access away, or gives it back, and waits for the row to say so. */
async function setAccess(page: Page, who: string, entry: 'Disable' | 'Enable', isMobile: boolean) {
  await press(page.getByRole('button', { name: `Actions for ${who}` }), isMobile);
  await press(page.getByRole('menuitem', { name: entry }), isMobile);

  // The row first, then the mark: a locator scoped to a row that is not there
  // finds no mark either, so "no longer marked" would pass against a person who
  // had dropped out of the list altogether - which is the one thing this is
  // meant to prove does not happen.
  const row = page.getByRole('row').filter({ hasText: who });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('No access')).toHaveCount(entry === 'Disable' ? 1 : 0);
}

/** Leaves as whoever is signed in. */
async function signOut(page: Page, isMobile: boolean) {
  await press(page.getByRole('button', { name: 'Settings' }), isMobile);
  await press(page.getByRole('menuitem', { name: 'Sign out' }), isMobile);
}

/**
 * Signs in from the logon page and lands in the app, whether or not the
 * question a new account opens on is in the way.
 *
 * **It is asked of more people than the one just added.** Whoever has not
 * *named* their workspace has an account nobody has started on, and signing out
 * forgets that this browser has been through the question
 * (`apps/web/src/welcoming.ts`) - so the same person meets it again on their
 * next sign-in. The walk that is *about* the question asserts it; every other
 * one is getting past it.
 *
 * Separate from `signOutAndIn` because it is also how somebody signs in when
 * there is nobody to sign out: a refused sign-in leaves the browser on the
 * logon page, with no Settings menu to leave from.
 */
async function signInPastTheQuestion(page: Page, address: string, isMobile: boolean) {
  await signInWith(page, address, isMobile);
  const skip = page.getByRole('button', { name: 'Skip' });
  await skip.or(dashboardBar(page)).first().waitFor({ state: 'visible' });
  if (await skip.isVisible()) await press(skip, isMobile);
  await expect(dashboardBar(page)).toBeVisible();
}

/** Leaves as whoever is signed in and comes back as somebody else. */
async function signOutAndIn(page: Page, address: string, isMobile: boolean) {
  await signOut(page, isMobile);
  await signInPastTheQuestion(page, address, isMobile);
}

/**
 * F3, because the claim is about a whole browser reaching a page: that an admin
 * is offered a way in and lands on the list, and that an ordinary user typing
 * the address is refused by the server rather than merely un-offered the entry.
 * The second is the half nothing below this tier can make - the API suite
 * proves the refusal and the component suite proves the drawing, and neither
 * can say that a person who types `/admin` meets the one and sees the other.
 *
 * Michael is the seeded admin and Ada is not (`apps/api/seed.sql`), which is
 * why the seed has two people holding different roles.
 *
 * Every way the role can be read wrong is settled at
 * apps/api/tests/unit/auth/admin.test.ts, and what the list holds at
 * apps/api/tests/integration/http/user-management.test.ts. None of it is
 * re-proved here.
 */
test.describe('User management', () => {
  test.describe('the admin page is reachable by an admin and refused to everyone else', () => {
    test('takes an admin from the menu to the list of everyone who can sign in', async ({
      page,
      isMobile,
    }) => {
      await signIn(page, MICHAEL, isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Admin' }), isMobile);

      await expect(page).toHaveURL(/\/admin$/);
      await expect(page.getByRole('heading', { name: 'Who can sign in' })).toBeVisible();

      // Both seeded people, which is also the account boundary being crossed on
      // purpose: Ada's row is here while none of her work ever is.
      //
      // Found by the address rather than the name, because an account is named
      // after the person who owns it - so "Michael" is in his row twice, and a
      // locator for the name alone matches the Account column as well.
      for (const { who, address } of [
        { who: MICHAEL, address: 'michael@example.com' },
        { who: ADA, address: 'ada@example.com' },
      ]) {
        const row = page.getByRole('row').filter({ hasText: address });
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(who);
      }
    });

    /**
     * The capability, end to end and only provable here: somebody who did not
     * exist when the page was opened signs in and lands in an account of their
     * own. Every rule about what a name derives and what an address folds to is
     * settled far more cheaply at apps/api/tests/unit/accounts/new-user.test.ts,
     * and the refusals at the integration tier; none of it is re-proved.
     */
    test('adds somebody who can then sign in and land in their own account', async ({
      page,
      isMobile,
    }) => {
      await signIn(page, MICHAEL, isMobile);
      await page.goto('/admin');

      // Somebody this run has not added before: the stack rebuilds its storage
      // once and serves both projects from it, so a fixed address would meet
      // the row the other project just added.
      const anna = somebodyNew('Anna');
      const row = await addSomebody(page, anna, isMobile);
      await expect(row).toContainText('not yet');

      // Now hers: a person the register did not hold a minute ago signs in and
      // arrives in an account of her own.
      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Sign out' }), isMobile);
      await signInWith(page, anna.address, isMobile);

      // Asserted here rather than inside the helper: that somebody added a
      // moment ago can get in at all is what this walk claims.
      //
      // **And what she gets in *to* is the question a new account opens on**
      // (apps/web/src/pages/WelcomePage.tsx). Her account is the only one this
      // tier ever sees untouched - every other is started on by the walks that
      // share this database - so this is where that lands, and it is one line
      // rather than a walk of its own.
      await expect(
        page.getByRole('heading', { name: 'What are you going to use Cockpit for?' }),
      ).toBeVisible();
      await press(page.getByRole('button', { name: 'Skip' }), isMobile);

      await expect(dashboardBar(page)).toBeVisible();
      await expect(workspaceTab(page, STARTING_WORKSPACE)).toBeVisible();

      /**
       * And the register now says when, not only that she has ("Show when
       * each person last signed in, on the admin page", issue 342). Nothing
       * below this tier can prove that a real sign-in moves what a whole
       * browser reads on the admin page a moment later - the API suite proves
       * the column is written and the component suite proves the cell draws a
       * timestamp it is given, neither can say the one causes the other.
       */
      await signOutAndIn(page, addressOf(MICHAEL), isMobile);
      await page.goto('/admin');
      // The row first, then the text: a locator scoped to a row that has not
      // drawn yet finds no text either, so "not yet" not being there would
      // pass against a page still loading - which is the one thing this is
      // meant to prove does not happen (`setAccess`, above).
      await expect(row).toHaveCount(1);
      await expect(row).not.toContainText('not yet');
    });

    /**
     * The capability of "Rename a user, and make somebody an admin" (issue
     * 232), and only provable here: a role is read from the register on every
     * request, so what it changes is what a whole browser is offered and
     * refused on the next thing it does. Which changes are refused is settled at
     * apps/api/tests/unit/accounts/user-changes.test.ts and what the register
     * does with them at the integration tier; none of it is re-proved.
     *
     * Somebody added by this walk rather than Ada, for the reason the walk above
     * adds one: the stack rebuilds its storage once and serves both projects
     * from it, so promoting a seeded person would reach across to the other.
     */
    test('makes somebody an admin, and takes it back', async ({ page, isMobile }) => {
      const anna = somebodyNew('Anna');
      await signIn(page, MICHAEL, isMobile);
      await page.goto('/admin');
      await addSomebody(page, anna, isMobile);

      await makeThem(page, anna.name, 'Admin', isMobile);

      // Hers now: she is offered the way in rather than having to know the
      // address, and the page answers her.
      await signOutAndIn(page, anna.address, isMobile);
      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Admin' }), isMobile);
      await expect(page.getByRole('heading', { name: 'Who can sign in' })).toBeVisible();

      // And taken back by the admin who gave it, which is the half that cannot
      // be shown without two people: she cannot take it back herself.
      await signOutAndIn(page, addressOf(MICHAEL), isMobile);
      await page.goto('/admin');
      await makeThem(page, anna.name, 'User', isMobile);

      await signOutAndIn(page, anna.address, isMobile);
      await page.goto('/admin');
      await expect(page.getByText(/for admins/i)).toBeVisible();
    });

    /**
     * The capability of "Take somebody's access away without taking their
     * work" (issue 233), and only provable here: what a person meets is the
     * logon page telling them why, and what an admin does about it is two
     * presses in a menu. Which refusal the register gives is settled at
     * apps/api/tests/integration/http/sign-in.test.ts and the sentence at
     * apps/web/tests/unit/pages/LogonPage.test.tsx; neither can say that
     * somebody signing in meets the one and reads the other.
     */
    test('takes somebody’s access away and gives it back', async ({ page, isMobile }) => {
      const anna = somebodyNew('Anna');
      /** What she calls her workspace, so what survives is something she chose. */
      const HERS = `${anna.name}’s work`;
      await signIn(page, MICHAEL, isMobile);
      await page.goto('/admin');
      await addSomebody(page, anna, isMobile);

      /**
       * She signs in and *names* her workspace rather than skipping it, which
       * is what makes the end of this walk mean anything: her account is no
       * longer one nobody has started on, so what she comes back to at the end
       * is work she did rather than an account that looks new either way.
       */
      await signOut(page, isMobile);
      await signInWith(page, anna.address, isMobile);
      await page.getByLabel('Name of the workspace').fill(HERS);
      await press(page.getByRole('button', { name: 'Open Cockpit' }), isMobile);
      await expect(workspaceTab(page, HERS)).toBeVisible();

      await signOutAndIn(page, addressOf(MICHAEL), isMobile);
      await page.goto('/admin');
      await setAccess(page, anna.name, 'Disable', isMobile);

      // Turned away, and told which of the two refusals this is: her work is
      // still there and the sentence says so.
      await signOut(page, isMobile);
      await signInWith(page, anna.address, isMobile);
      await expect(page.getByRole('alert')).toContainText(/access to this Cockpit was removed/i);

      // Given back by the admin who took it. She was never signed in, so there
      // is nothing to sign out of - this is the logon page answering somebody
      // else.
      await signInPastTheQuestion(page, addressOf(MICHAEL), isMobile);
      await page.goto('/admin');
      await setAccess(page, anna.name, 'Enable', isMobile);

      // And she is back in the account she already had, which is the whole
      // point of this being the reversible half: the workspace she named is
      // still there, and she is not asked to name one again - an account
      // somebody has started on is not one nobody has.
      await signOut(page, isMobile);
      await signInWith(page, anna.address, isMobile);
      await expect(dashboardBar(page)).toBeVisible();
      await expect(workspaceTab(page, HERS)).toBeVisible();
    });

    test('refuses an ordinary user who types the address, and offers them no way in', async ({
      page,
      isMobile,
    }) => {
      await signIn(page, ADA, isMobile);

      // Straight to the address. That the entry is not offered to her is
      // apps/web/tests/unit/pages/Layout.test.tsx's, and re-proving it here
      // would be the upward duplication the testing strategy rejects; what
      // only a browser can show is somebody typing the address anyway.
      await page.goto('/admin');

      // Not sent to the logon page: she is signed in, and signing in again is
      // the one thing that cannot help her.
      await expect(page.getByText(/for admins/i)).toBeVisible();
      await expect(page.getByRole('cell', { name: MICHAEL, exact: true })).toHaveCount(0);
    });
  });
});
