import { ADA, MICHAEL, expect, press, signIn, test } from './support/app';

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
