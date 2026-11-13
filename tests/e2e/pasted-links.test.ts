import {
  capture,
  chooseRowAction,
  closeSettings,
  dashboardBar,
  deleteWorkspace,
  expect,
  inbox,
  itemRow,
  makeWorkspace,
  openFirstWorkspace,
  openSettings,
  press,
  switchTo,
  test,
  uniqueTitle,
  workspaceTab,
} from './support/app';

/**
 * F3, the one walk "Read pasted Teams links" (issue 1755) gets: that a note
 * holding a pasted Teams link, captured in the browser, turns into the Teams
 * save on the row a moment later, with nothing pressed. That needs the capture,
 * the background reading, Graph's stand-in and the live update to the open page
 * all tied together, which no lower level holds. Which links are read, in which
 * order, and every failure, are apps/api/tests/integration/http/pasted-message-links.test.ts's.
 *
 * Graph is the stub issuer's stand-in (scripts/lib/stub-graph.mjs), which holds
 * Els's message in a chat; the stack has no Claude key, so the Item is titled
 * from her message as any capture is.
 *
 * **It makes its own workspace and puts it back**, disconnecting first, for the
 * reason connections.test.ts records.
 */
const ELS_SAID = 'Can you send me the Q3 numbers by Friday?';
const CHAT_LINK =
  'https://teams.microsoft.com/l/message/19%3Astub-chat-with-els%40thread.v2/1731490000000?tenantId=stub-tenant';

test.describe('Capture', () => {
  test.describe('a note holding a pasted Teams link is read from Teams and becomes a Teams save', () => {
    test('the row turns into Microsoft Teams · Els Maes, with her message and your words in Details', async ({ page, isMobile }) => {
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Pasted');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      if (isMobile) {
        // Settings is the pointer's, so a phone connects by the same navigation the Connect button starts.
        const workspaceId = (await workspaceTab(page, workspace).getAttribute('href'))!.split('/').at(-1)!;
        await page.goto(`/v1/workspaces/${workspaceId}/connections/teams/connect`);
        await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
        await page.waitForURL((url) => url.pathname.startsWith(`/w/${workspaceId}/`));
        await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      } else {
        const settings = await openSettings(page, 'Connections', isMobile);
        await press(settings.getByRole('button', { name: 'Connect Microsoft Teams' }), isMobile);
        await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
        await expect(page.getByRole('dialog', { name: 'Settings' }).getByText('Reads pasted chat links')).toBeVisible();
        await closeSettings(page, isMobile);
      }
      await expect(inbox(page)).toBeVisible();

      const yours = uniqueTitle('ring Els back');
      await capture(page, `${CHAT_LINK} ${yours}`, isMobile);

      const row = itemRow(page, yours);
      await expect(row.getByText(/Microsoft Teams/)).toBeVisible({ timeout: 10_000 });
      await expect(row.getByText(/Els Maes/)).toBeVisible();

      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open', exact: true }), isMobile);
      const form = page.getByRole('dialog');
      await press(form.getByRole('tab', { name: 'Details' }), isMobile);
      // The captured message: hers, then your words as its note, and the link no longer in it.
      const captured = form.getByRole('tabpanel').locator('dd').first();
      await expect(captured).toContainText(ELS_SAID);
      await expect(captured).toContainText(yours);
      await expect(captured).not.toContainText('teams.microsoft.com');
      await press(form.getByRole('button', { name: 'Cancel' }), isMobile);

      if (!isMobile) {
        await openSettings(page, 'Connections', isMobile);
        await chooseRowAction(page, 'michael@example.com', 'Disconnect', isMobile);
        await press(page.getByRole('button', { name: 'Yes, disconnect michael@example.com' }), isMobile);
        await closeSettings(page, isMobile);
      }
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
});
