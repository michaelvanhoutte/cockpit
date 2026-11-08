import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { isLinkedWorktree, portsFor } from '../../scripts/lib/ports.mjs';
import {
  chooseRowAction,
  closeSettings,
  deleteWorkspace,
  expect,
  itemRow,
  makeWorkspace,
  openFirstWorkspace,
  openSettings,
  press,
  switchTo,
  test,
  uniqueTitle,
} from './support/app';
import { giveToTheInbox } from './support/arrange';

const root = resolve(__dirname, '..', '..');
/** The stub the stack runs, which stands in for Gmail's mailbox as well as for Google's sign-in. */
const issuer = `http://127.0.0.1:${portsFor(root, { linked: isLinkedWorktree(root), env: process.env }).e2eIssuer}`;
const MAILBOX = 'michael@example.com';

/**
 * F3: a Gmail conversation starred after connecting is one Item whose row says
 * who wrote last, and whose status follows ("A Gmail starred conversation is
 * one Item whose status follows who wrote last", issue 1705). Only the sign-in,
 * the check, the store and the row together make the line appear. The line's
 * wording is apps/web/tests/unit/conversationLine.test.ts's; which message is a
 * turn, the Gmail connector's own tests'; what a turn does to the status,
 * apps/api/tests/unit/domain/conversations.test.ts's.
 *
 * **It makes its own workspace and puts it back**, as connections.test.ts does.
 */

/** Something done in the stand-in mailbox, as a person does it in Gmail: answers what the stub says it made. */
async function inGmail(what: 'star' | 'reply' | 'linkedin', query: Record<string, string>): Promise<{ thread: string; message: string }> {
  const answer = await fetch(`${issuer}/gmail-stub/${what}?${new URLSearchParams({ email: MAILBOX, ...query })}`, { method: 'POST' });
  return (await answer.json()) as { thread: string; message: string };
}

/** Every call the mailbox was asked, oldest first. */
async function askedOfGmail(): Promise<string[]> {
  return (await (await fetch(`${issuer}/gmail-stub/asked?email=${encodeURIComponent(MAILBOX)}`)).json()) as string[];
}

/**
 * The connection checked once more after what the mailbox just took: *Check
 * now*, through the route the row's own menu sends, until a check starts that
 * reads the history again - one already running may have read it before.
 */
async function checkedAgain(page: Page): Promise<void> {
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const listed = (await (await page.request.get(`/v1/workspaces/${workspaceId}/connections`)).json()) as {
    sourceAccounts: { id: string; connectorId: string }[];
  };
  const gmail = listed.sourceAccounts.find((one) => one.connectorId === 'gmail')!;
  const before = (await askedOfGmail()).length;
  await expect
    .poll(async () => {
      const pressed = await page.request.post(`/v1/workspaces/${workspaceId}/connections/${gmail.id}/check-now`);
      return ((await pressed.json()) as { status: string }).status;
    })
    .not.toBe('running');
  await expect.poll(async () => (await askedOfGmail()).slice(before).some((call) => call.startsWith('history'))).toBe(true);
}

/** Something done in the stand-in Outlook mailbox, as a person does it there: answers what the stub says it made. */
async function inOutlook(what: 'flag' | 'reply', query: Record<string, string>): Promise<{ id: string; conversation: string }> {
  const answer = await fetch(`${issuer}/graph-stub/${what}?${new URLSearchParams({ email: MAILBOX, ...query })}`, { method: 'POST' });
  return (await answer.json()) as { id: string; conversation: string };
}

async function askedOfOutlook(): Promise<string[]> {
  return (await (await fetch(`${issuer}/graph-stub/asked?email=${encodeURIComponent(MAILBOX)}`)).json()) as string[];
}

/** The Outlook connection checked once more after what the mailbox just took: *Check now* until a check starts that lists Deleted Items again. */
async function outlookCheckedAgain(page: Page): Promise<void> {
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const listed = (await (await page.request.get(`/v1/workspaces/${workspaceId}/connections`)).json()) as {
    sourceAccounts: { id: string; connectorId: string }[];
  };
  const outlook = listed.sourceAccounts.find((one) => one.connectorId === 'outlook')!;
  const before = (await askedOfOutlook()).length;
  await expect
    .poll(async () => {
      const pressed = await page.request.post(`/v1/workspaces/${workspaceId}/connections/${outlook.id}/check-now`);
      return ((await pressed.json()) as { status: string }).status;
    })
    .not.toBe('running');
  await expect.poll(async () => (await askedOfOutlook()).slice(before).includes('GET mailFolders/deleteditems')).toBe(true);
}

/** Connect on the Gmail card, picking the star, and wait until the first check has read where the mailbox stands - what is starred after is brought in. */
async function connectedByStar(page: Page, isMobile: boolean): Promise<void> {
  const window = await openSettings(page, 'Connections', isMobile);
  await press(window.getByRole('button', { name: 'Connect Gmail' }), isMobile);
  const asked = page.getByRole('dialog', { name: 'Connect Gmail' });
  await press(asked.getByText('Starred (flagged in Outlook)'), isMobile);
  await press(asked.getByRole('button', { name: 'Connect' }), isMobile);
  const askedBefore = (await askedOfGmail()).length;
  await press(page.getByRole('link', { name: MAILBOX, exact: true }), isMobile);
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByText(/^Checked /)).toBeVisible();
  await expect.poll(async () => (await askedOfGmail()).slice(askedBefore)).toContain('profile');
  await closeSettings(page, isMobile);
}

test.describe('Triage', () => {
  test.describe('a followed Gmail conversation’s row says who wrote last, and its status follows', () => {
    test('reads Steven replied on his reply, To do, then You wrote with Waiting since on yours, and opens the conversation', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'a phone has no Connections, only Appearance');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Followed');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      await connectedByStar(page, isMobile);

      const purpose = uniqueTitle('Dinner with Steven');
      const { thread } = await inGmail('star', { subject: purpose, text: 'Shall we have dinner one of these weeks?' });
      await checkedAgain(page);
      const row = itemRow(page, purpose);
      await expect(row).toBeVisible();

      // Steven answers, starred or not: the row says so, and the Item is to do.
      await inGmail('reply', { thread, from: 'Steven Noels <steven@example.com>', text: 'Thursday is tricky, how about Friday?' });
      await checkedAgain(page);
      await expect(row.getByText('Gmail · Steven replied just now')).toBeVisible();
      await expect(row.getByText('Gmail · Steven replied just now')).toHaveAttribute('title', 'Steven Noels: Thursday is tricky, how about Friday?');
      await expect(row.getByText(/^Waiting since/)).toHaveCount(0);
      const open = row.getByRole('link', { name: 'Open the latest email in Gmail' });
      await expect(open).toHaveAttribute('href', new RegExp(`#all/${thread}$`));

      // Its form shows the conversation under the description ("Show the conversation an Item follows in its form", issue 1706).
      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open', exact: true }), isMobile);
      const conversation = page.getByRole('region', { name: 'Conversation' });
      await expect(conversation).toBeVisible();
      await expect(conversation.getByText(/Steven replied/)).toBeVisible();
      await expect(conversation.getByText('“Thursday is tricky, how about Friday?”')).toBeVisible();
      await expect(conversation.getByRole('link', { name: 'Open the latest email in Gmail' })).toHaveAttribute('href', new RegExp(`#all/${thread}$`));
      await page.keyboard.press('Escape');
      await expect(conversation).toBeHidden();

      // Your reply arrives: the same row, now waiting for his.
      await inGmail('reply', { thread, sent: '' });
      await checkedAgain(page);
      await expect(row.getByText('Gmail · You wrote just now')).toBeVisible();
      await expect(row.getByText(/^Waiting since/)).toBeVisible();

      await openSettings(page, 'Connections', isMobile);
      await chooseRowAction(page, MAILBOX, 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: `Yes, disconnect ${MAILBOX}` }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });

  test.describe('Email… opens the draft it made in a new tab, and the row says the draft is started', () => {
    test('opens a tab at the mailbox’s draft and reads Gmail · Draft started, In progress', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone has no Connections, only Appearance');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Emailed');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      await connectedByStar(page, isMobile);
      // The draft's own page is Gmail's, which no walk may reach: answered here, so only its address is checked.
      await page.context().route('https://mail.google.com/**', (route) => route.fulfill({ body: 'the draft' }));

      const purpose = uniqueTitle('Plan a dinner with Steven Noels');
      await giveToTheInbox(page, [purpose]);
      const row = itemRow(page, purpose);
      await expect(row).toBeVisible();
      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      const [tab] = await Promise.all([page.waitForEvent('popup'), press(page.getByRole('menuitem', { name: 'Email…' }), isMobile)]);

      await expect(tab).toHaveURL(/#drafts\?compose=draft-\d+$/);
      await expect(row.getByText('Gmail · Draft started')).toBeVisible();
      await expect(row.getByText('In progress')).toBeVisible();
      const drafts = (await (await fetch(`${issuer}/gmail-stub/drafts?email=${encodeURIComponent(MAILBOX)}`)).json()) as { subject: string }[];
      expect(drafts.map((one) => one.subject)).toContain(purpose);
      await tab.close();

      await openSettings(page, 'Connections', isMobile);
      await chooseRowAction(page, MAILBOX, 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: `Yes, disconnect ${MAILBOX}` }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });

  test.describe('a followed LinkedIn conversation’s row says LinkedIn, and opens LinkedIn', () => {
    test('reads LinkedIn · Steven wrote, then replied on a later notification, opens linkedin.com, and offers no Email…', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'a phone has no Connections, only Appearance');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('LinkedIn');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      await connectedByStar(page, isMobile);

      // A LinkedIn message notification, starred: the Item follows the LinkedIn conversation, not the email.
      const subject = uniqueTitle('Steven Noels sent you a message');
      const conversation = '2-ZmFrZS1lMmUtdGhyZWFk';
      const { message } = await inGmail('linkedin', { subject, text: 'Shall we have dinner on Thursday?', conversation });
      await inGmail('star', { message });
      await checkedAgain(page);
      const row = itemRow(page, subject);
      await expect(row.getByText('LinkedIn · Steven wrote just now')).toBeVisible();
      await expect(row.getByRole('link', { name: 'Open the conversation in LinkedIn' })).toHaveAttribute(
        'href',
        `https://www.linkedin.com/messaging/thread/${conversation}/`,
      );
      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /^Email/ })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // Another notification about it, in a Gmail conversation of its own and not starred: still Steven's turn on this row.
      await inGmail('linkedin', { subject: uniqueTitle('Another notification'), text: 'Friday works too.', conversation });
      await checkedAgain(page);
      await expect(row.getByText('LinkedIn · Steven replied just now')).toBeVisible();
      await expect(row.getByText('LinkedIn · Steven replied just now')).toHaveAttribute('title', 'Steven Noels: Friday works too.');

      // Its form opens LinkedIn too, and counts nothing it cannot see.
      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open', exact: true }), isMobile);
      const section = page.getByRole('region', { name: 'Conversation' });
      await expect(section.getByText('LinkedIn', { exact: true })).toBeVisible();
      await expect(section.getByRole('link', { name: 'Open the conversation in LinkedIn' })).toHaveAttribute(
        'href',
        `https://www.linkedin.com/messaging/thread/${conversation}/`,
      );
      await expect(section.getByText('With Steven Noels')).toBeVisible();
      await expect(section.getByText(/emails?/)).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(section).toBeHidden();

      await openSettings(page, 'Connections', isMobile);
      await chooseRowAction(page, MAILBOX, 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: `Yes, disconnect ${MAILBOX}` }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
  test.describe('a followed Outlook conversation’s row says who wrote last, and a reply turns it To do', () => {
    test('reads Outlook · Anna wrote, then Steven replied, with the status To do, and opens the latest message', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone has no Connections, only Appearance');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Followed in Outlook');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const window = await openSettings(page, 'Connections', isMobile);
      await press(window.getByRole('button', { name: 'Connect Outlook' }), isMobile);
      const asked = page.getByRole('dialog', { name: 'Connect Outlook' });
      await expect(asked.getByRole('radio', { name: 'Flagged' })).toBeChecked();
      await press(asked.getByRole('button', { name: 'Connect' }), isMobile);
      await press(page.getByRole('link', { name: MAILBOX, exact: true }), isMobile);
      await expect(page.getByRole('dialog', { name: 'Settings' }).getByText(/^Checked /)).toBeVisible();
      await closeSettings(page, isMobile);

      // A message flagged after connecting: one Item for its conversation.
      const purpose = uniqueTitle('Dinner with Steven');
      const { conversation, id } = await inOutlook('flag', { subject: purpose, text: 'Shall we have dinner one of these weeks?' });
      await outlookCheckedAgain(page);
      const row = itemRow(page, purpose);
      await expect(row.getByText('Outlook · Anna wrote just now')).toBeVisible();

      // Steven answers, flagged or not: the row says so, and the Item is to do.
      await inOutlook('reply', { conversation, from: 'Steven Noels <steven@example.com>', text: 'Thursday is tricky, how about Friday?' });
      await outlookCheckedAgain(page);
      await expect(row.getByText('Outlook · Steven replied just now')).toBeVisible();
      await expect(row.getByText('Outlook · Steven replied just now')).toHaveAttribute('title', 'Steven Noels: Thursday is tricky, how about Friday?');
      await expect(row.getByText(/^Waiting since/)).toHaveCount(0);
      await expect(row.getByRole('link', { name: 'Open the latest email in Outlook' })).toBeVisible();

      // Your reply, sent from the mailbox: waiting for his.
      await inOutlook('reply', { conversation, sent: '' });
      await outlookCheckedAgain(page);
      await expect(row.getByText('Outlook · You wrote just now')).toBeVisible();
      await expect(row.getByText(/^Waiting since/)).toBeVisible();

      // Done completes the flag in the mailbox.
      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: /^Status/ }), isMobile);
      await press(page.getByRole('menuitemradio', { name: 'Done' }), isMobile);
      await expect(row).toHaveCount(0);
      await expect
        .poll(async () => ((await (await fetch(`${issuer}/graph-stub/message?email=${encodeURIComponent(MAILBOX)}&id=${id}`)).json()) as { flagStatus: string }).flagStatus)
        .toBe('complete');

      await openSettings(page, 'Connections', isMobile);
      await chooseRowAction(page, MAILBOX, 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: `Yes, disconnect ${MAILBOX}` }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });

  test.describe('Email… with an Outlook connection opens the draft it made in a new tab, and the row follows the draft', () => {
    test('opens a tab at the mailbox’s draft and reads Outlook · Draft started, then Waiting for reply once the draft is sent', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone has no Connections, only Appearance');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Emailed in Outlook');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const window = await openSettings(page, 'Connections', isMobile);
      await press(window.getByRole('button', { name: 'Connect Outlook' }), isMobile);
      const asked = page.getByRole('dialog', { name: 'Connect Outlook' });
      await expect(asked.getByRole('radio', { name: 'Flagged' })).toBeChecked();
      await press(asked.getByRole('button', { name: 'Connect' }), isMobile);
      await press(page.getByRole('link', { name: MAILBOX, exact: true }), isMobile);
      await expect(page.getByRole('dialog', { name: 'Settings' }).getByText(/^Checked /)).toBeVisible();
      await closeSettings(page, isMobile);
      // The draft's own page is Outlook's, which no walk may reach: answered here, so only its address is checked.
      await page.context().route('https://outlook.office365.com/**', (route) => route.fulfill({ body: 'the draft' }));

      const purpose = uniqueTitle('Plan a dinner with Steven Noels');
      await giveToTheInbox(page, [purpose]);
      const row = itemRow(page, purpose);
      await expect(row).toBeVisible();
      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      const [tab] = await Promise.all([page.waitForEvent('popup'), press(page.getByRole('menuitem', { name: 'Email…' }), isMobile)]);

      await expect(tab).toHaveURL(/ItemID=AAkALgStubDraft\d+/);
      await expect(row.getByText('Outlook · Draft started')).toBeVisible();
      await expect(row.getByText('In progress')).toBeVisible();
      const drafts = (await (await fetch(`${issuer}/graph-stub/drafts?email=${encodeURIComponent(MAILBOX)}`)).json()) as { id: string; subject: string }[];
      const draft = drafts.find((one) => one.subject === purpose);
      expect(draft).toBeDefined();
      await tab.close();

      // The draft sent from Outlook: waiting for his reply.
      await fetch(`${issuer}/graph-stub/send-draft?email=${encodeURIComponent(MAILBOX)}&id=${draft!.id}`, { method: 'POST' });
      await outlookCheckedAgain(page);
      await expect(row.getByText('Outlook · You wrote just now')).toBeVisible();
      await expect(row.getByText(/^Waiting since/)).toBeVisible();

      await openSettings(page, 'Connections', isMobile);
      await chooseRowAction(page, MAILBOX, 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: `Yes, disconnect ${MAILBOX}` }), isMobile);
      await expect(page.getByRole('dialog').getByText(/Nothing connected yet/)).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
});
