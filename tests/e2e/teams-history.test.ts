import {
  chooseRowAction,
  closeSettings,
  deleteWorkspace,
  expect,
  makeWorkspace,
  openFirstWorkspace,
  openSettings,
  press,
  switchTo,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F1 for "See what each Teams save became, in its connection's history" (issue
 * 1144): a Teams row offers *History…* and no *Check now*, since a save is
 * pushed to Cockpit and there is nothing to check. Delivering a save needs
 * Teams' own menu, which no browser can drive, so what a delivery writes is
 * apps/api/tests/integration/http/teams-history.test.ts's.
 *
 * It makes its own workspace and puts it back, for the reason
 * workspace-management.test.ts records.
 */
test.describe('Connector management', () => {
  test.describe('a pushed connection has a history and nothing to check', () => {
    test('the Teams row offers History… and no Check now, in its menu or at the head of its history', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'a phone has no Connections, only Appearance');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Pushed');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const window = await openSettings(page, 'Connections', isMobile);
      await press(window.getByRole('button', { name: 'Connect Microsoft Teams' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      const connections = page.getByRole('dialog', { name: 'Settings' });
      await expect(connections.getByText('Connected.')).toBeVisible();

      await press(connections.getByRole('button', { name: 'Actions for michael@example.com' }), isMobile);
      await expect(page.getByRole('menuitem', { name: 'History…' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Check now' })).toHaveCount(0);
      await press(page.getByRole('menuitem', { name: 'History…' }), isMobile);

      const history = connections.getByRole('region', { name: 'History of michael@example.com' });
      await expect(history.getByText('Nothing delivered yet.')).toBeVisible();
      await expect(history.getByRole('button', { name: 'Check now' })).toHaveCount(0);

      await press(history.getByRole('button', { name: '‹ Connections' }), isMobile);
      await chooseRowAction(page, 'michael@example.com', 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: 'Yes, disconnect michael@example.com' }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
});
