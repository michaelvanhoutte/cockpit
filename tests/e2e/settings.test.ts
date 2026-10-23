import { expect, press, signIn, test, MICHAEL, dashboardBar } from './support/app';

/**
 * F3, because only the drawn window has a width: that the sections are listed
 * in order, and that the longest name fits inside its highlight, are measured.
 * What each section draws, and that its controls still work, is
 * apps/web/tests/unit/components/SettingsWindow.test.tsx and the walks of the
 * sections themselves.
 */
test.describe('Settings', () => {
  test.describe('the sections are listed in order and each name fits inside its highlight', () => {
    test('lists Appearance, Connections, MCP and What Cockpit remembers, and the longest name stays inside its highlight', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone holds Appearance alone');
      await signIn(page, MICHAEL, isMobile);
      await expect(dashboardBar(page)).toBeVisible();

      await press(page.getByRole('button', { name: 'Profile' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Settings…', exact: true }), isMobile);
      const settings = page.getByRole('dialog', { name: 'Settings' });
      const sections = settings.getByRole('navigation', { name: 'Settings' }).getByRole('button');
      await expect(sections).toHaveText(['Appearance', 'Connections', 'MCP', 'What Cockpit remembers', 'Close']);
      // Opened from the profile menu on Connections, the one selected.
      await expect(settings.getByRole('button', { name: 'Connections', exact: true })).toHaveAttribute('aria-current', 'true');

      const longest = settings.getByRole('button', { name: 'What Cockpit remembers', exact: true });
      await press(longest, isMobile);
      await expect(settings.getByRole('heading', { name: 'What Cockpit remembers', exact: true })).toBeVisible();
      await expect(longest).toHaveAttribute('aria-current', 'true');
      const overrun = await longest.evaluate((button) => {
        const text = document.createRange();
        text.selectNodeContents(button);
        const style = getComputedStyle(button);
        const room = button.getBoundingClientRect().right - parseFloat(style.paddingRight);
        return text.getBoundingClientRect().right - room;
      });
      // A pixel of sub-pixel rounding still sits inside the button's own padding.
      expect(overrun).toBeLessThanOrEqual(1);
    });
  });
});
