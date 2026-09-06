import {
  captureBox,
  chooseRowAction,
  expect,
  expectNoSidewaysScroll,
  inbox,
  itemRow,
  openInbox,
  press,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, because none of this exists below a real browser: the header's menu is
 * opened by a tap on a 480px screen and by a mouse on a 1280px one, the window
 * it leads to is drawn over the workspace, and a type made and then renamed in
 * it has to reach the capture row and the rows of a workspace already open.
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
  test.describe('a type is made where types are managed, and used at capture', () => {
    test('offers a type made in the window, and shows a rename on the rows without a reload', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Manage types' }), isMobile);
      // Over the workspace rather than instead of it, like the dashboards'
      // list and the workspaces'.
      await expect(page.getByRole('dialog', { name: 'Manage types' })).toBeVisible();
      await expectNoSidewaysScroll(page);

      // A type of this walk's own, made the only way one is made.
      const kind = uniqueTitle('Kind');
      await page.getByLabel('Name of the new type').fill(kind);
      await press(page.getByRole('button', { name: 'New type' }), isMobile);
      await expect(page.getByRole('button', { name: `Actions for ${kind}` })).toBeVisible();
      await press(page.getByRole('button', { name: 'Done' }), isMobile);

      // On offer at capture the moment it exists, without a reload.
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Why is this slow?');
      await captureBox(page).fill(thought);
      await page.getByLabel('What kind of thing this is').selectOption({ label: kind });
      await press(inbox(page).getByRole('button', { name: 'Capture' }), isMobile);
      await expect(itemRow(page, thought).getByText(kind)).toBeVisible();

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Manage types' }), isMobile);
      const renamed = uniqueTitle('Renamed');
      await chooseRowAction(page, kind, 'Edit…', isMobile);
      await page.getByLabel(`Name of ${kind}`).fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(page.getByRole('button', { name: `Actions for ${renamed}` })).toBeVisible();
      await press(page.getByRole('button', { name: 'Done' }), isMobile);

      // Back to the rows, which is where the rename has to show.
      await openInbox(page, isMobile);
      await expect(itemRow(page, thought).getByText(renamed)).toBeVisible();
      await expectNoSidewaysScroll(page);
    });
  });
});
