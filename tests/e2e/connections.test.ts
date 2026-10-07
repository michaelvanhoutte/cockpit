import { resolve } from 'node:path';
import { isLinkedWorktree, portsFor } from '../../scripts/lib/ports.mjs';
import {
  chooseRowAction,
  closeSettings,
  openSettings,
  deleteWorkspace,
  expect,
  itemRow,
  makeWorkspace,
  openFirstWorkspace,
  press,
  switchTo,
  test,
  uniqueTitle,
} from './support/app';

const root = resolve(__dirname, '..', '..');
/** The stub the stack runs, which stands in for Gmail's mailbox as well as for Google's sign-in. */
const issuer = `http://127.0.0.1:${portsFor(root, { linked: isLinkedWorktree(root), env: process.env }).e2eIssuer}`;

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
      await expect(backFromGoogle.getByText(/^Gmail · label Cockpit/)).toBeVisible();

      // The check connecting started brings the conversations labelled Cockpit
      // in the stack's stand-in mailbox into this workspace's Inbox ("Bring in
      // the conversations already labelled Cockpit as tasks", issue 725): Tasks
      // from Gmail, openable there - and the row then says when it checked.
      await closeSettings(page, isMobile);
      await expect(page.getByText('Quarterly figures for the board')).toBeVisible();
      await expect(page.getByText('Lunch on Thursday?')).toBeVisible();
      await expect(page.getByText(/Gmail · Anna Peeters/)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open in Gmail' }).first()).toBeVisible();

      // Done on one takes it off the list, and within seconds the label off
      // its conversation in that mailbox ("Take the Cockpit label off in Gmail
      // when its task is done in Cockpit", issue 728).
      const lunch = itemRow(page, 'Lunch on Thursday?');
      await press(lunch.getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: /^Status/ }), isMobile);
      await press(page.getByRole('menuitemradio', { name: 'Done' }), isMobile);
      await expect(lunch).toHaveCount(0);
      await expect
        .poll(async () => {
          const held = await fetch(`${issuer}/gmail-stub/thread?email=michael%40example.com&thread=18f0a1b2c3d4e5f2`);
          return ((await held.json()) as { labelled: boolean }).labelled;
        })
        .toBe(false);

      const checked = await openSettings(page, 'Connections', isMobile);
      await expect(checked.getByText(/^Gmail · label Cockpit · last checked /)).toBeVisible();

      // Switched to the star without signing in again ("Change what a Gmail
      // connection follows, without reconnecting", issue 824): the row names it.
      await chooseRowAction(page, 'michael@example.com', 'Change what’s followed…', isMobile);
      const following = page.getByRole('dialog', { name: 'What michael@example.com follows' });
      await press(following.getByText('Starred (flagged in Outlook)'), isMobile);
      await press(following.getByRole('button', { name: 'Save' }), isMobile);
      await expect(following).toHaveCount(0);
      await expect(checked.getByText(/^Gmail · starred/)).toBeVisible();

      await chooseRowAction(page, 'michael@example.com', 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: 'Yes, disconnect michael@example.com' }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();

      // By star ("Connect Gmail by star, and bring in conversations starred
      // from then on", issue 822): the steps drop creating the label, and a
      // conversation starred after connecting becomes a Task.
      const askedOf = async (email: string) =>
        (await (await fetch(`${issuer}/gmail-stub/asked?email=${encodeURIComponent(email)}`)).json()) as string[];
      const askedBefore = (await askedOf('michael@example.com')).length;
      await press(page.getByRole('dialog').getByRole('button', { name: 'Connect Gmail' }), isMobile);
      const byStar = page.getByRole('dialog', { name: /^Connect Gmail to / });
      await press(byStar.getByText('Starred (flagged in Outlook)'), isMobile);
      await expect(byStar.getByText(/Create a label called Cockpit/)).toHaveCount(0);
      await press(byStar.getByRole('button', { name: 'Sign in with Google' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      const backByStar = page.getByRole('dialog', { name: 'Settings' });
      await expect(backByStar.getByText(/^Connected\. Conversations you star or flag from now on/)).toBeVisible();
      await expect(backByStar.getByText(/^Gmail · starred/)).toBeVisible();

      // Starred once the check connecting started has read where the mailbox
      // stands, so the star comes after it. The next check is five minutes
      // out; connecting a second mailbox checks every connection at once.
      await expect.poll(async () => (await askedOf('michael@example.com')).slice(askedBefore)).toContain('profile');
      await fetch(`${issuer}/gmail-stub/star?email=michael%40example.com&subject=Flagged%20in%20Outlook`, { method: 'POST' });
      await press(backByStar.getByRole('button', { name: 'Connect Gmail' }), isMobile);
      await press(page.getByRole('button', { name: 'Sign in with Google' }), isMobile);
      await press(page.getByRole('link', { name: 'ada@example.com', exact: true }), isMobile);
      await closeSettings(page, isMobile);
      await expect(page.getByText('Flagged in Outlook')).toBeVisible();

      const starred = await openSettings(page, 'Connections', isMobile);
      await expect(starred.getByText(/^Gmail · starred · last checked /)).toBeVisible();
      for (const address of ['michael@example.com', 'ada@example.com']) {
        await chooseRowAction(page, address, 'Disconnect', isMobile);
        await press(page.getByRole('button', { name: `Yes, disconnect ${address}` }), isMobile);
      }
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();

      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
});
