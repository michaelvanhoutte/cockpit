import { captureBox, expect, openFirstWorkspace, press, test } from './support/app';

/**
 * F3, because the tip belongs to a mouse and to a 1280px screen, and the phone
 * is the one place it must not appear: neither a pointer nor a viewport exists
 * below a real browser. Which control earns which tip, and how a tip comes and
 * goes, is apps/web/tests/unit/shortcutTip.test.tsx; this proves the shell
 * shows it and Capture still opens.
 */
test.describe('Shortcuts', () => {
  test.describe('a mouse click on Capture names its key, and a tap on a phone does not', () => {
    test('shows the tip, still opens Capture, and goes on ✕', async ({ page, isMobile }) => {
      await openFirstWorkspace(page, isMobile);
      const tip = page.getByText('Tip: press C to capture from anywhere');

      await press(page.locator('header').first().getByRole('link', { name: 'Capture' }), isMobile);
      await expect(captureBox(page)).toBeVisible();

      if (isMobile) {
        await expect(tip).toHaveCount(0);
        return;
      }
      // By text: the open Capture window hides the rest of the page from the
      // accessibility tree, the tip included.
      await expect(tip).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(captureBox(page)).toBeHidden();
      await page.getByRole('button', { name: 'Dismiss the tip' }).click();
      await expect(tip).toHaveCount(0);
    });
  });
});
