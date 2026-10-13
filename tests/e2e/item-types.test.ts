import {
  closeSettings,
  openSettings,
  chooseRowAction,
  expect,
  expectNoSidewaysScroll,
  openInbox,
  press,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, because the header's menu is opened by a tap on a 480px screen and by a
 * mouse on a 1280px one, and the window it leads to is drawn over the
 * workspace. Rows no longer name an Item's type ("Take Type off an Item's
 * form, its row and bulk editing", issue 1068), so this walk stops at the
 * window: that a type made there, and renamed there, is shown there.
 *
 * It is not re-proving the naming rules, which
 * apps/api/tests/integration/http/item-types.test.ts owns against a real store,
 * nor the window's own behaviour, which
 * apps/web/tests/unit/components/ManageTypes.test.tsx owns. One walk for
 * the capability, saying it works for a person.
 *
 * It makes and renames a type of its own. Every spec in a run shares one
 * database (support/app.ts), so renaming Action or Thought would take the other
 * specs' types with it.
 */
test.describe('Capture', () => {
  test.describe('a type is made and renamed where types are managed', () => {
    test('shows a type made in the window, and its rename in the window', async ({ page, isMobile }) => {
      // Settings is the pointer's, by decision.
      test.skip(isMobile, 'a phone has no Types, only Appearance');
      await openInbox(page, isMobile);

      await openSettings(page, 'Types', isMobile);
      // Over the workspace rather than instead of it, like the dashboards'
      // list and the workspaces'.
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
      await expectNoSidewaysScroll(page);

      // A type of this walk's own, made the only way one is made.
      const kind = uniqueTitle('Kind');
      await page.getByLabel('Name of the new type').fill(kind);
      await press(page.getByRole('button', { name: 'New type' }), isMobile);
      await expect(page.getByRole('button', { name: `Actions for ${kind}` })).toBeVisible();

      const renamed = uniqueTitle('Renamed');
      await chooseRowAction(page, kind, 'Edit…', isMobile);
      await page.getByLabel(`Name of ${kind}`).fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(page.getByRole('button', { name: `Actions for ${renamed}` })).toBeVisible();
      await closeSettings(page, isMobile);
      await expectNoSidewaysScroll(page);
    });
  });
});
