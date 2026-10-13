import {
  closeSettings,
  openSettings,
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
 * it has to reach the rows of a workspace already open.
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
  test.describe('a type is made where types are managed, and shown on the rows', () => {
    test('shows a type made in the window, and a rename on the rows without a reload', async ({
      page,
      isMobile,
    }) => {
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
      await closeSettings(page, isMobile);

      // Capture never asks for a Type ("Capture without a Type, at every front
      // door", issue 1067), so an Item takes this one the way a form gives it:
      // here by the same two commands, which is all the rename needs to show.
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Why is this slow?');
      const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
      const known = await page.request.get('/v1/item-types');
      const { id: typeId } = ((await known.json()) as { itemTypes: { id: string; name: string }[] }).itemTypes.find(
        (one) => one.name === kind,
      )!;
      const itemId = crypto.randomUUID();
      const send = async (command: string, data: Record<string, unknown>) => {
        const sent = await page.request.post(`/v1/commands/${command}`, {
          data: { commandId: crypto.randomUUID(), issuedAt: new Date().toISOString(), workspaceId, itemId, ...data },
        });
        expect(sent.ok(), `${command} from outside failed: ${sent.status()}`).toBe(true);
      };
      await send('capture_item', { message: thought });
      await send('set_item_type', { typeId });
      await expect(itemRow(page, thought).getByText(kind)).toBeVisible({ timeout: 30_000 });

      await openSettings(page, 'Types', isMobile);
      const renamed = uniqueTitle('Renamed');
      await chooseRowAction(page, kind, 'Edit…', isMobile);
      await page.getByLabel(`Name of ${kind}`).fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(page.getByRole('button', { name: `Actions for ${renamed}` })).toBeVisible();
      await closeSettings(page, isMobile);

      // Back to the rows, which is where the rename has to show.
      await openInbox(page, isMobile);
      await expect(itemRow(page, thought).getByText(renamed)).toBeVisible();
      await expectNoSidewaysScroll(page);
    });
  });
});
