import { expect, test } from '@playwright/test';

/**
 * F3, and deliberately one walk: what nothing below can prove is that this
 * screen is *reached at all* when a read fails — the component has to be wired
 * into the router as its error component, survive the service worker answering
 * the navigation out of its own cache, and paint on the device in hand.
 * Which reason gets named in which circumstance is settled far more cheaply in
 * apps/web/tests/unit/components/LoadFailure.test.tsx and is not re-proved here.
 *
 * The walk cuts Cockpit off entirely rather than staging an expired sign-in,
 * because proving the sign-in path end to end needs a deployed environment —
 * which is what "Run the F3 suite against a deployed environment, as its own
 * account" (issue 64) exists to make possible.
 */
test.describe('Offline', () => {
  test.describe('Cockpit says why it could not load your work instead of showing a raw failure', () => {
    test('names the reason and offers the way on', async ({ page }) => {
      await page.route('**/v1/**', (route) => route.abort());
      await page.route('**/health', (route) => route.abort());

      await page.goto('/');

      await expect(page.getByRole('heading', { name: "Cockpit can't be reached" })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

      // The failure the whole change exists to remove.
      await expect(page.getByText('Something went wrong!')).toHaveCount(0);
      await expect(page.getByText('Failed to fetch')).toHaveCount(0);
    });
  });
});
