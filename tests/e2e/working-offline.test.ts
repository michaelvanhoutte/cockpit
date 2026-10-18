import { expect, openFirstWorkspace, press, test, whatTheBrowserStillHolds } from './support/app';

/**
 * F3, and one walk: choosing to work offline and coming back. What only the
 * real app can show is the whole path together: the menu entry, the mark in
 * the header, a reload that draws the board from IndexedDB without asking the
 * server, and Go online clearing it. The mark for each standing is
 * apps/web/tests/unit/pages/offlineMark.test.tsx; the rules of the switch are
 * apps/web/tests/unit/workingOffline.test.tsx.
 */
test.describe('Offline', () => {
  test.describe('working offline is chosen from the account menu, survives a reload and ends with Go online', () => {
    test('shows the mark, draws the board without the server, refuses a change and clears on Go online', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      await expect
        .poll(async () => (await whatTheBrowserStillHolds(page)).storedQueries.some((key) => key.includes('snapshot')))
        .toBe(true);
      const mark = page.getByRole('button', { name: /^Offline/ });
      await expect(mark).toHaveCount(0);

      await press(page.getByRole('button', { name: 'Profile' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Work offline' }), isMobile);
      await expect(mark).toBeVisible();

      let asked = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/v1/')) asked += 1;
      });
      await page.reload();
      await expect(page.getByRole('navigation', { name: 'Dashboards' })).toBeVisible();
      await expect(mark).toBeVisible();
      expect(asked).toBe(0);

      await press(page.getByRole('button', { name: 'Add a workspace' }), isMobile);
      await page.getByLabel('Name of the new workspace').fill('Not now');
      await page.getByLabel('Name of the new workspace').press('Enter');
      await expect(page.getByText("You're working offline").first()).toBeVisible();
      await page.keyboard.press('Escape');

      await press(mark, isMobile);
      await press(page.getByRole('menuitem', { name: 'Go online' }), isMobile);
      await expect(mark).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Dashboards' })).toBeVisible();
    });
  });
});
