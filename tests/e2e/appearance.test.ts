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
    // The Car view's night ground, as styles.css gives it.
    const NIGHT = 'rgb(17, 18, 22)';

    // The Car view is offered only where the browser can recognise speech.
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        class FakeSpeechRecognition {
          start() {}
          stop() {}
          abort() {}
        }
        Object.assign(window, { SpeechRecognition: FakeSpeechRecognition, webkitSpeechRecognition: FakeSpeechRecognition });
      });
    });

    test('is dark on the logon page, on a Dashboard and in a menu opened over it, and is chosen in Settings, on a phone too', async ({ page, isMobile }) => {
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
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();

      const choose = async (choice: RegExp) => {
        await press(page.getByRole('button', { name: 'Profile' }), isMobile);
        await press(page.getByRole('menuitem', { name: 'Settings…', exact: true }), isMobile);
        const settings = page.getByRole('dialog', { name: 'Settings' });
        await expect(settings).toBeVisible();
        // A phone holds Appearance alone; at a desk it is one section among the rest.
        await expect(settings.getByRole('button', { name: 'Types', exact: true })).toHaveCount(isMobile ? 0 : 1);
        if (!isMobile) await press(settings.getByRole('button', { name: 'Appearance', exact: true }), isMobile);
        await press(settings.getByRole('radio', { name: choice }), isMobile);
        await press(settings.getByRole('button', { name: 'Close', exact: true }), isMobile);
        await expect(settings).toBeHidden();
      };

      await choose(/^Light/);
      expect(await groundOf(page)).not.toBe(PAGE);

      await page.reload();
      await expect(dashboardBar(page)).toBeVisible();
      expect(await groundOf(page)).not.toBe(PAGE);

      await choose(/^Dark/);
      expect(await groundOf(page)).toBe(PAGE);

      // The Car view is in its night look whenever the app is dark, with no
      // moon/sun switch; Light brings the switch back and the view follows its own choice.
      const body = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.goto('/capture');
      await press(page.getByRole('link', { name: 'Car' }), isMobile);
      await expect(page.getByRole('button', { name: 'Speak a note' })).toBeVisible();
      await expect.poll(body).toBe(NIGHT);
      await expect(page.getByRole('button', { name: 'Dark view' })).toHaveCount(0);

      await choose(/^Light/);
      await expect(page.getByRole('button', { name: 'Dark view' })).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(body).not.toBe(NIGHT);
    });
  });
});
