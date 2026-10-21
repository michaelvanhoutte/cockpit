import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
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
/** The stub the stack runs, which stands in for Gmail's mailbox and Graph's as well as for Google's sign-in. */
const issuer = `http://127.0.0.1:${portsFor(root, { linked: isLinkedWorktree(root), env: process.env }).e2eIssuer}`;

/**
 * F3, a walk per connector: connecting leaves the application entirely, signs
 * in at a second server and comes back, which is the one thing no level below
 * a real browser can do at all. Everything the walk finds on the
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

/** Signs in, makes and opens a workspace of this walk's own, and opens Settings on its Connections. */
async function connectionsOfAWorkspaceOfItsOwn(page: Page, isMobile: boolean) {
  await openFirstWorkspace(page, isMobile);
  const workspace = uniqueTitle('Connected');
  await makeWorkspace(page, workspace, isMobile);
  await switchTo(page, workspace, isMobile);
  const window = await openSettings(page, 'Connections', isMobile);
  return { workspace, window };
}

/** Disconnects the one account every walk here connects, from the open Connections. */
async function disconnectMichael(page: Page, isMobile: boolean): Promise<void> {
  await chooseRowAction(page, 'michael@example.com', 'Disconnect', isMobile);
  await press(page.getByRole('button', { name: 'Yes, disconnect michael@example.com' }), isMobile);
  await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();
}

async function putTheWorkspaceBack(page: Page, workspace: string, isMobile: boolean): Promise<void> {
  await closeSettings(page, isMobile);
  await deleteWorkspace(page, workspace, isMobile);
}
test.describe('Connector management', () => {
  // Settings is the pointer's, by decision: a phone has no way to it.
  test.skip(({ isMobile }) => !!isMobile, 'a phone has no Connections, only Appearance');

  test.describe('a source account connected to a workspace is listed there until it is disconnected', () => {
    test('connects one, lists it once however often it is connected, and disconnects it', async ({
      page,
      isMobile,
    }) => {
      const { workspace, window } = await connectionsOfAWorkspaceOfItsOwn(page, isMobile);
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
      // store keeps, seen here as what a person is shown. With something
      // connected, adding is Add connection, then the source, then its Connect
      // window (issue 1349).
      await press(back.getByRole('button', { name: 'Add connection' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Connect Microsoft Teams' }), isMobile);
      await press(page.getByRole('dialog', { name: 'Connect Microsoft Teams' }).getByRole('button', { name: 'Connect' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      await expect(page.getByRole('dialog').getByText('michael@example.com')).toHaveCount(1);

      await disconnectMichael(page, isMobile);

      // Reopened from scratch, which is the claim the issue makes about this
      // window: what it shows is what is stored, never what the last press
      // guessed.
      await closeSettings(page, isMobile);
      const again = await openSettings(page, 'Connections', isMobile);
      await expect(again.getByText(/Nothing connected yet/)).toBeVisible();
      await putTheWorkspaceBack(page, workspace, isMobile);
    });
  });

  test.describe('a connector that asks one question on connecting can have its answer changed later', () => {
    test('asks it before the sign-in, names the answer on the row, and changes it without signing in again', async ({
      page,
      isMobile,
    }) => {
      // ("Ask a connection's one choice on connecting, and change it later",
      // issue 942), against the fake pulled connector the stack registers beside
      // the registry's own (apps/api/tests/e2e-worker.ts): the one place the
      // question, the redirect that carries the answer and the stored row meet
      // in a browser. What is stored, refused and handed to the connector is
      // held below (apps/api/tests/integration/connectors/connection-choice.test.ts).
      const { workspace, window } = await connectionsOfAWorkspaceOfItsOwn(page, isMobile);
      await press(window.getByRole('button', { name: 'Connect Fake Pages' }), isMobile);
      const asked = page.getByRole('dialog', { name: 'Connect Fake Pages' });
      await expect(asked.getByRole('radio', { name: 'Starred pages' })).toBeChecked();
      await press(asked.getByText('Every page'), isMobile);
      await press(asked.getByRole('button', { name: 'Connect' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      const pagesBack = page.getByRole('dialog', { name: 'Settings' });
      await expect(pagesBack.getByText('Every page', { exact: true })).toBeVisible();

      await chooseRowAction(page, 'michael@example.com', 'Change…', isMobile);
      const changing = page.getByRole('dialog', { name: 'Change michael@example.com' });
      await expect(changing.getByRole('radio', { name: 'Every page' })).toBeChecked();
      await press(changing.getByText('Starred pages'), isMobile);
      await press(changing.getByRole('button', { name: 'Save' }), isMobile);
      await expect(changing).toHaveCount(0);
      await expect(pagesBack.getByText('Starred pages', { exact: true })).toBeVisible();

      await closeSettings(page, isMobile);
      const pagesAgain = await openSettings(page, 'Connections', isMobile);
      await expect(pagesAgain.getByText('Starred pages', { exact: true })).toBeVisible();
      await disconnectMichael(page, isMobile);
      await putTheWorkspaceBack(page, workspace, isMobile);
    });
  });

  test.describe('Gmail brings in the conversations labelled Cockpit, and Done takes the label off', () => {
    test('connects through the generic sign-in, lands them as Tasks, unlabels one done, and follows the star instead', async ({
      page,
      isMobile,
    }) => {
      // A registered connector like the rest ("Switch Gmail onto the generic
      // host, and take it out of the core", issue 944): its one question before
      // Google, which Cancel leaves without going anywhere, and then the same
      // trip out and back through the generic sign-in.
      const { workspace, window } = await connectionsOfAWorkspaceOfItsOwn(page, isMobile);
      await press(window.getByRole('button', { name: 'Connect Gmail' }), isMobile);
      const gmailAsked = page.getByRole('dialog', { name: 'Connect Gmail' });
      await expect(gmailAsked.getByRole('radio', { name: 'Labelled Cockpit' })).toBeChecked();
      await press(gmailAsked.getByRole('button', { name: 'Cancel' }), isMobile);
      await expect(gmailAsked).toHaveCount(0);
      await press(window.getByRole('button', { name: 'Connect Gmail' }), isMobile);
      await press(gmailAsked.getByRole('button', { name: 'Connect' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);

      const backFromGoogle = page.getByRole('dialog', { name: 'Settings' });
      await expect(backFromGoogle.getByText('Connected.')).toBeVisible();
      await expect(backFromGoogle.getByText('Labelled Cockpit', { exact: true })).toBeVisible();

      // The check connecting queued, run by the generic host, brings the
      // conversations labelled Cockpit in the stack's stand-in mailbox into
      // this workspace's Inbox: Tasks from Gmail, openable there - and the row
      // then says when it checked.
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
      await expect(checked.getByText('Labelled Cockpit', { exact: true })).toBeVisible();
      await expect(checked.getByText(/^Checked /)).toBeVisible();

      // Its history ("See when a pulled connection was checked, and why it
      // failed, from its row's History…", issue 1140): the checks it has had
      // worked, under Today, one of them naming the two conversations it
      // brought in and the one it sent back when Lunch was done (issue 1141),
      // and ‹ Connections goes back to the row. What each line says is held by
      // ManageConnections.test.tsx.
      await chooseRowAction(page, 'michael@example.com', 'History…', isMobile);
      const history = checked.getByRole('region', { name: 'History of michael@example.com' });
      await expect(
        history.getByRole('region', { name: 'Today' }).getByText(/^(Worked|Checked \d+ times, nothing new)$/).first(),
      ).toBeVisible();
      const today = history.getByRole('region', { name: 'Today' });
      await expect(today.getByText(/New: .*Quarterly figures for the board/)).toBeVisible();
      await expect(today.getByText(/New: .*Lunch on Thursday\?/)).toBeVisible();
      await expect(today.getByText('Sent back: Lunch on Thursday?')).toBeVisible();
      await press(history.getByRole('button', { name: '‹ Connections' }), isMobile);
      await expect(checked.getByText('Labelled Cockpit', { exact: true })).toBeVisible();

      // Switched to the star without signing in again: the row names it.
      await chooseRowAction(page, 'michael@example.com', 'Change…', isMobile);
      const following = page.getByRole('dialog', { name: 'Change michael@example.com' });
      await press(following.getByText('Starred (flagged in Outlook)'), isMobile);
      await press(following.getByRole('button', { name: 'Save' }), isMobile);
      await expect(following).toHaveCount(0);
      await expect(checked.getByText('Starred (flagged in Outlook)', { exact: true })).toBeVisible();

      await disconnectMichael(page, isMobile);
      await putTheWorkspaceBack(page, workspace, isMobile);
    });
  });

  test.describe('Gmail by star brings in the conversations starred after connecting', () => {
    test('lands a conversation starred once the first check has read the mailbox', async ({ page, isMobile }) => {
      // ("Connect Gmail by star, and bring in conversations starred from then
      // on", issue 822.) Starred once the first check has read where the
      // mailbox stands, so the star comes after it; connecting the same mailbox
      // again is what checks it now rather than five minutes out.
      const { workspace } = await connectionsOfAWorkspaceOfItsOwn(page, isMobile);
      const gmailAsked = page.getByRole('dialog', { name: 'Connect Gmail' });
      const askedOf = async (email: string) =>
        (await (await fetch(`${issuer}/gmail-stub/asked?email=${encodeURIComponent(email)}`)).json()) as string[];
      const connectByStar = async (connected: boolean) => {
        const settings = page.getByRole('dialog', { name: 'Settings' });
        if (connected) {
          await press(settings.getByRole('button', { name: 'Add connection' }), isMobile);
          await press(page.getByRole('menuitem', { name: 'Connect Gmail' }), isMobile);
        } else await press(settings.getByRole('button', { name: 'Connect Gmail' }), isMobile);
        await press(gmailAsked.getByText('Starred (flagged in Outlook)'), isMobile);
        await press(gmailAsked.getByRole('button', { name: 'Connect' }), isMobile);
        await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      };
      const askedBefore = (await askedOf('michael@example.com')).length;
      await connectByStar(false);
      const byStar = page.getByRole('dialog', { name: 'Settings' });
      await expect(byStar.getByText('Starred (flagged in Outlook)', { exact: true })).toBeVisible();
      await expect.poll(async () => (await askedOf('michael@example.com')).slice(askedBefore)).toContain('profile');
      await fetch(`${issuer}/gmail-stub/star?email=michael%40example.com&subject=Flagged%20in%20Outlook`, { method: 'POST' });
      await connectByStar(true);
      await closeSettings(page, isMobile);
      await expect(page.getByText('Flagged in Outlook')).toBeVisible();

      const starred = await openSettings(page, 'Connections', isMobile);
      await expect(starred.getByText('Starred (flagged in Outlook)', { exact: true })).toBeVisible();
      await expect(starred.getByText(/^Checked /)).toBeVisible();
      await disconnectMichael(page, isMobile);
      await putTheWorkspaceBack(page, workspace, isMobile);
    });
  });

  test.describe('Outlook brings in the messages flagged there, and Done completes the flag', () => {
    test('says what to know about the organisation, connects, lands them as Tasks and completes one done', async ({
      page,
      isMobile,
    }) => {
      // A registered connector like the rest ("Connect Outlook from Settings,
      // wherever the Microsoft client is set", issue 1048): its question, with
      // what to know about the organisation before leaving, and the trip out and
      // back through the same generic sign-in.
      const { workspace, window } = await connectionsOfAWorkspaceOfItsOwn(page, isMobile);
      await expect(window.getByText(/Your organisation may have to approve Cockpit first/)).toBeVisible();
      await press(window.getByRole('button', { name: 'Connect Outlook' }), isMobile);
      const outlookAsked = page.getByRole('dialog', { name: 'Connect Outlook' });
      await expect(outlookAsked.getByRole('radio', { name: 'Flagged' })).toBeChecked();
      // And whether it files by category (issue 1147): unticked to start, and
      // the answer given rides the sign-in to be the new connection's.
      const filesByCategory = outlookAsked.getByRole('checkbox', { name: 'File it on the panel named after its category' });
      await expect(filesByCategory).not.toBeChecked();
      await press(filesByCategory, isMobile);
      await press(outlookAsked.getByRole('button', { name: 'Connect' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      const backFromMicrosoft = page.getByRole('dialog', { name: 'Settings' });
      await expect(backFromMicrosoft.getByText('Connected.')).toBeVisible();
      await expect(backFromMicrosoft.getByText('Flagged', { exact: true })).toBeVisible();
      await expect(backFromMicrosoft.getByText('Files by category', { exact: true })).toBeVisible();

      // The check connecting queued brings the messages flagged in the stack's
      // stand-in Graph mailbox in as Tasks from Outlook, openable there; Done
      // on one completes its flag in that mailbox.
      await closeSettings(page, isMobile);
      await expect(page.getByText('Supplier contract to review')).toBeVisible();
      await expect(page.getByText(/Outlook · Anna Peeters/)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open in Outlook' }).first()).toBeVisible();

      const offsite = itemRow(page, 'Offsite dates for November');
      await press(offsite.getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: /^Status/ }), isMobile);
      await press(page.getByRole('menuitemradio', { name: 'Done' }), isMobile);
      await expect(offsite).toHaveCount(0);
      await expect
        .poll(async () => {
          const held = await fetch(`${issuer}/graph-stub/message?email=michael%40example.com&id=AAkALgStubLunch`);
          return ((await held.json()) as { flagStatus: string }).flagStatus;
        })
        .toBe('complete');

      const outlookChecked = await openSettings(page, 'Connections', isMobile);
      await expect(outlookChecked.getByText('Files by category', { exact: true })).toBeVisible();
      await expect(outlookChecked.getByText(/^Checked /)).toBeVisible();
      await disconnectMichael(page, isMobile);
      await putTheWorkspaceBack(page, workspace, isMobile);
    });
  });

  test.describe('a Gmail connection can file what it brings in on the Panel named after its label', () => {
    test('asks it on Connect, unticked, and the row says it files by label', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone has no Connections, only Appearance');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Files by label');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      // The same tick box Outlook's Connect asks, worded from Gmail's manifest
      // ("File Gmail conversations on the Panel named after their label", issue 1148).
      // The stand-in mailbox carries no label but Cockpit, so what lands on a
      // Panel is held below (apps/api/tests/integration/connectors/pulled-names.test.ts).
      const window = await openSettings(page, 'Connections', isMobile);
      await press(window.getByRole('button', { name: 'Connect Gmail' }), isMobile);
      const gmailAsked = page.getByRole('dialog', { name: 'Connect Gmail' });
      const filesByLabel = gmailAsked.getByRole('checkbox', { name: 'File it on the panel named after its label' });
      await expect(filesByLabel).not.toBeChecked();
      await press(filesByLabel, isMobile);
      await press(gmailAsked.getByRole('button', { name: 'Connect' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      await expect(page.getByRole('dialog', { name: 'Settings' }).getByText('Files by label', { exact: true })).toBeVisible();

      await chooseRowAction(page, 'michael@example.com', 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: 'Yes, disconnect michael@example.com' }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });

  test.describe('a phone is connected by typing back the code texted to it', () => {
    test('sends a code to a Belgian mobile, confirms the stand-in code, lists the phone with the number to text, and disconnects it', async ({
      page,
      isMobile,
    }) => {
      // "Connect a phone in Settings by confirming a code texted to it", issue
      // 1335: the one place the entry, the two requests and the stand-in
      // Verify (scripts/lib/stub-verify.mjs, which approves 123456) meet in a
      // browser. What is stored and refused is held by
      // apps/api/tests/integration/connectors/connecting-a-phone.test.ts, and
      // what the entry draws for each answer by ManageConnections.test.tsx.
      const { workspace, window } = await connectionsOfAWorkspaceOfItsOwn(page, isMobile);
      await press(window.getByRole('button', { name: 'Connect Text messages' }), isMobile);
      const asked = page.getByRole('dialog', { name: 'Connect a phone' });

      // A number that is not Belgian is said under the field and stays typed.
      await asked.getByLabel('Mobile number').fill('+31 6 12345678');
      await press(asked.getByRole('button', { name: 'Send code' }), isMobile);
      await expect(asked.getByRole('alert')).toContainText('Only Belgian mobile numbers');
      await expect(asked.getByLabel('Mobile number')).toHaveValue('+31 6 12345678');
      await expect(asked.getByLabel('Code')).toHaveCount(0);

      await asked.getByLabel('Mobile number').fill('0470 12 34 56');
      await press(asked.getByRole('button', { name: 'Send code' }), isMobile);
      await asked.getByLabel('Code').fill('123456');
      await press(asked.getByRole('button', { name: 'Confirm' }), isMobile);

      const connected = page.getByRole('dialog', { name: 'Connected' });
      await expect(connected.getByText(/\+32470123456 is connected\. Text \+32460000000/)).toBeVisible();
      await press(connected.getByRole('button', { name: 'Done' }), isMobile);
      const connections = page.getByRole('dialog', { name: 'Settings' });
      await expect(connections.getByText('+32470123456', { exact: true })).toBeVisible();
      await expect(connections.getByText('Text +32460000000 to add a note')).toBeVisible();

      await chooseRowAction(page, '+32470123456', 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: 'Yes, disconnect +32470123456' }), isMobile);
      await expect(connections.getByText(/Nothing connected yet/)).toBeVisible();
      await putTheWorkspaceBack(page, workspace, isMobile);
    });
  });

  test.describe('Check now brings a pulled connection’s next check forward and its line into the open history', () => {
    test('pressed at the head of the history, its Check now line appears without a reload', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone has no Connections, only Appearance');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Check now');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      // "Check a pulled connection now, from its row or its history", issue 1143:
      // only the alarm, the queue, the check and the stream together make the
      // line arrive. What the menu and the head offer is held by
      // ManageConnections.test.tsx, and the queueing by
      // apps/api/tests/integration/connectors/connection-check-now.test.ts.
      const window = await openSettings(page, 'Connections', isMobile);
      await press(window.getByRole('button', { name: 'Connect Gmail' }), isMobile);
      const gmailAsked = page.getByRole('dialog', { name: 'Connect Gmail' });
      await press(gmailAsked.getByRole('button', { name: 'Connect' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      const connections = page.getByRole('dialog', { name: 'Settings' });
      await expect(connections.getByText(/^Checked /)).toBeVisible();

      await chooseRowAction(page, 'michael@example.com', 'History…', isMobile);
      const history = connections.getByRole('region', { name: 'History of michael@example.com' });
      const today = history.getByRole('region', { name: 'Today' });
      await expect(today).toBeVisible();
      await expect(today.getByText(/Check now/)).toHaveCount(0);

      await press(history.getByRole('button', { name: 'Check now' }), isMobile);

      await expect(history.getByRole('status')).toHaveText('Checking michael@example.com now.');
      await expect(today.getByText(/Check now/)).toBeVisible();

      await press(history.getByRole('button', { name: '‹ Connections' }), isMobile);
      await chooseRowAction(page, 'michael@example.com', 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: 'Yes, disconnect michael@example.com' }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
});

