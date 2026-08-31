import { expect, test } from '@playwright/test';
import { expectNoSidewaysScroll, openFirstWorkspace, press, uniqueTitle } from './support/app';

/**
 * F3, because none of this exists below a real browser: the "···" menu is
 * opened by a tap on a 480px screen and by a mouse on a 1280px one, the route
 * it leads to is real navigation, and the new workspace has to turn up in the
 * header of a page that was already open.
 *
 * It is not re-proving the naming rules, which
 * apps/api/tests/integration/http/workspace-management.test.ts owns against a
 * real database, nor the form's own behaviour, which
 * apps/web/tests/unit/pages/WorkspaceSettingsPage.test.tsx owns. This is the
 * one walk that says the capability works for a person.
 */
test.describe('Workspace management', () => {
  test.describe('a workspace you make is one you can switch to', () => {
    test('reaches the settings from the header and puts the new workspace in the tabs', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Workspaces' }), isMobile);

      const box = page.getByLabel('Name of the new workspace');
      await expect(box).toBeInViewport();
      await expectNoSidewaysScroll(page);

      const name = uniqueTitle('Bookkeeping');
      await box.fill(name);
      await press(page.getByRole('button', { name: 'New workspace' }), isMobile);

      // In the header, not merely somewhere on the settings page: being able to
      // switch to it is the whole point of having made it.
      const tab = page.locator('header').getByRole('link', { name });
      await expect(tab).toBeVisible();
      await expectNoSidewaysScroll(page);

      await press(tab, isMobile);
      await expect(page.getByLabel('Capture a note or to-do')).toBeVisible();
    });
  });
});
