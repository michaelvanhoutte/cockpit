import {
  chooseRowAction,
  closeSettings,
  openSettings,
  deleteWorkspace,
  expect,
  makeWorkspace,
  openFirstWorkspace,
  press,
  switchTo,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, and the one walk this capability gets: connecting leaves the application
 * entirely, signs in at a second server and comes back, which is the one thing
 * no level below a real browser can do at all. Everything the walk finds on the
 * way back - the row, its name, its absence after disconnecting - is drawn from
 * a real store the browser really read.
 *
 * It is not re-proving what is stored, which
 * apps/api/tests/integration/http/connections.test.ts owns against a real
 * store, including that the credential is sealed and that disconnecting takes
 * it; nor what the window draws and sends, which
 * apps/web/tests/unit/components/ManageConnections.test.tsx owns.
 *
 * **The issuer it signs in at is the stub the stack runs**
 * (scripts/lib/stub-issuer.mjs), which stands in for Microsoft exactly as it
 * stands in for Google - one `OIDC_ISSUER` covering both flows
 * (apps/api/src/auth/issuer.ts). So the walk drives a real redirect, a real
 * code exchange and a real signature check, against the one server a test run
 * can reach.
 *
 * **It makes its own workspace and puts it back**, for the reason
 * workspace-management.test.ts records: the run shares one database across
 * both projects, so a connection left behind would be in the list the next
 * project's walk reads.
 */
test.describe('Connector management', () => {
  test.describe('a source account connected to a workspace is listed there until it is disconnected', () => {
    test('connects one, lists it once however often it is connected, and disconnects it', async ({
      page,
      isMobile,
    }) => {
      // Settings is the pointer's, by decision: a phone has no way to it.
      test.skip(isMobile, 'a phone has no Settings');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Connected');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const window = await openSettings(page, 'Connections', isMobile);
      await expect(window.getByRole('combobox', { name: /Workspace/ })).toHaveValue(/.+/);
      await expect(window.getByText(/Nothing connected yet/)).toBeVisible();

      // Out to the issuer, choose an account there, and back - the whole page
      // leaves, which is why the window has to be reopened by what comes back
      // rather than by anything this walk does.
      await press(window.getByRole('button', { name: 'Connect Microsoft Teams' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);

      // Reopened by the return, on Connections, saying it connected.
      const back = page.getByRole('dialog', { name: 'Settings' });
      await expect(back.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
      await expect(back.getByText('Connected.')).toBeVisible();
      await expect(back.getByText('michael@example.com')).toBeVisible();
      expect(new URL(page.url()).search).toBe('');
      await expect(back.getByText(/Nothing was stored/)).toHaveCount(0);

      // The same account again is the same row, not a second one - the rule the
      // store keeps, seen here as what a person is shown.
      await press(back.getByRole('button', { name: 'Connect Microsoft Teams' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      await expect(page.getByRole('dialog').getByText('michael@example.com')).toHaveCount(1);

      await chooseRowAction(page, 'michael@example.com', 'Disconnect', isMobile);
      await press(
        page.getByRole('button', { name: 'Yes, disconnect michael@example.com' }),
        isMobile,
      );
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();

      // Reopened from scratch, which is the claim the issue makes about this
      // window: what it shows is what is stored, never what the last press
      // guessed.
      await closeSettings(page, isMobile);
      const again = await openSettings(page, 'Connections', isMobile);
      await expect(again.getByText(/Nothing connected yet/)).toBeVisible();

      // Gmail, beside it ("Connect a Gmail account to a workspace, and
      // disconnect it", issue 724): a step before Google, which Cancel leaves
      // without going anywhere, and then the same trip out and back.
      await press(again.getByRole('button', { name: 'Connect Gmail' }), isMobile);
      const steps = page.getByRole('dialog', { name: /^Connect Gmail to / });
      await expect(steps.getByText(/Create a label called Cockpit in Gmail/)).toBeVisible();
      await press(steps.getByRole('button', { name: 'Cancel' }), isMobile);
      await expect(steps).toHaveCount(0);
      await press(again.getByRole('button', { name: 'Connect Gmail' }), isMobile);
      await press(page.getByRole('button', { name: 'Sign in with Google' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);

      const backFromGoogle = page.getByRole('dialog', { name: 'Settings' });
      await expect(
        backFromGoogle.getByText('Connected. Conversations labelled Cockpit arrive in this workspace’s Inbox within a minute.'),
      ).toBeVisible();
      await expect(backFromGoogle.getByText('Gmail · label Cockpit')).toBeVisible();
      await chooseRowAction(page, 'michael@example.com', 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: 'Yes, disconnect michael@example.com' }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();

      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
});
