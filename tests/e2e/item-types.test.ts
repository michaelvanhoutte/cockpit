import { expect, test } from '@playwright/test';
import {
  captureBox,
  chooseRowAction,
  expectNoSidewaysScroll,
  itemRow,
  openInbox,
  press,
  uniqueTitle,
} from './support/app';

/**
 * F3, because none of this exists below a real browser: the header's menu is
 * opened by a tap on a 480px screen and by a mouse on a 1280px one, the route
 * it leads to is real navigation, and a rename made on that page has to reach
 * the rows of a workspace that was already open.
 *
 * It is not re-proving the naming rules, which
 * apps/api/tests/integration/http/item-types.test.ts owns against a real store,
 * nor the page's own behaviour, which
 * apps/web/tests/unit/pages/ItemTypeSettingsPage.test.tsx owns. One walk for
 * the capability, saying it works for a person.
 *
 * It renames a type it made itself. Every spec in a run shares one database
 * (support/app.ts), so renaming Action or Thought would take the other specs'
 * types with it.
 */
test.describe('Capture', () => {
  test.describe('renaming a type shows it on the rows without a reload', () => {
    test('changes the word under the title of every item of that type', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      // A type of this walk's own, made the only way one is made: by naming it.
      const kind = uniqueTitle('Kind');
      const thought = uniqueTitle('Why is this slow?');
      await captureBox(page).fill(thought);
      await page.getByLabel('What kind of thing this is').fill(kind);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(itemRow(page, thought).getByText(kind)).toBeVisible();

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Types' }), isMobile);
      await expect(page.getByRole('heading', { name: 'Types' })).toBeVisible();
      await expectNoSidewaysScroll(page);

      const renamed = uniqueTitle('Renamed');
      await chooseRowAction(page, kind, 'Rename', isMobile);
      await page.getByLabel(`New name for ${kind}`).fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(page.getByRole('button', { name: `Actions for ${renamed}` })).toBeVisible();

      // Back to the rows, which is where the rename has to show.
      await openInbox(page, isMobile);
      await expect(itemRow(page, thought).getByText(renamed)).toBeVisible();
      await expectNoSidewaysScroll(page);
    });
  });
});
