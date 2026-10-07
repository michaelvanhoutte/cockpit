import { MICHAEL, dashboardBar, expect, groundOf, press, signIn, test } from './support/app';

/**
 * F3, because only a browser paints before the app's script runs, and only one
 * can be told its device is dark. When the decision is made, and every way the
 * stored choice and the device combine, is apps/web/tests/unit/appearanceBoot.test.ts;
 * the colours the shell computes are packages/shared/tests/unit/domain/
 * workspace-shell.test.ts. This proves the three meet: the document is dark
 * before anything is drawn, and the screens and a menu over them read it.
 */
test.describe('Appearance', () => {
  test.describe('the whole app is dark from its first frame when the device is set to dark', () => {
    test.use({ colorScheme: 'dark' });

    // The dark page and the dark surface, as styles.css gives them.
    const PAGE = 'rgb(27, 28, 33)';
    const SURFACE = 'rgb(36, 37, 43)';

    test('is dark on the logon page, on a Dashboard and in a menu opened over it', async ({ page, isMobile }) => {
      // Asked as soon as the document exists, before the app has drawn a thing.
      await page.goto('/signin', { waitUntil: 'domcontentloaded' });
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(PAGE);
      await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('#root > div')!).backgroundColor)).toBe(PAGE);

      await signIn(page, MICHAEL, isMobile);
      await expect(dashboardBar(page)).toBeVisible();
      expect(await groundOf(page)).toBe(PAGE);

      await press(page.getByRole('button', { name: 'Profile' }), isMobile);
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      expect(await menu.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(SURFACE);
    });
  });
});
