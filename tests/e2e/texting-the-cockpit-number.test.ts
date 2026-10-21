import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { isLinkedWorktree, portsFor } from '../../scripts/lib/ports.mjs';
import { dashboardBar, expect, inbox, itemRow, openFirstWorkspace, press, test, uniqueTitle } from './support/app';

/**
 * F3, and the one walk this capability gets: a text posted to the real
 * ingress of the running stack shows in the Inbox as a Text message, and
 * the same text delivered again adds nothing ("Text the Cockpit number and the
 * note lands in the Inbox", issue 1336). What is stored, refused and logged is
 * held by apps/api/tests/integration/http/texting-the-cockpit-number.test.ts,
 * how a signature is judged by the connector's own L1, and how a row and the
 * form name the source with no sender by ItemRow.test.tsx and ItemForm.test.tsx.
 *
 * **The text is delivered the way Twilio delivers it**: a form post signed
 * with the stack's auth token (scripts/e2e-stack.mjs), straight at the API,
 * since a signature is over the address that was called and not over a proxy's.
 * The phone is connected through the same two requests Settings sends, which is
 * arrangement here - Settings' own walk is connections.test.ts - and
 * disconnected afterwards and its texts moved into the workspace looked at, so
 * the stack is as it was found: a text waiting in every Inbox would otherwise
 * count in a workspace another spec makes.
 */
const root = resolve(__dirname, '..', '..');
const api = `http://127.0.0.1:${portsFor(root, { linked: isLinkedWorktree(root), env: process.env }).e2eApi}`;
const TOKEN = 'no-secret-is-needed-to-talk-to-the-stub';
const COCKPIT_NUMBER = '+32460000000';
/** The stand-in Verify approves this code (scripts/lib/stub-verify.mjs). */
const THE_CODE = '123456';

/** A Belgian mobile of this run's own, so two projects connecting phones at once never share one. */
function aPhone(): string {
  return `+324${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

function workspaceOf(page: Page): string {
  const found = new URL(page.url()).pathname.match(/^\/w\/([^/]+)/);
  if (!found) throw new Error(`start from a page that is in a workspace, not at ${page.url()}`);
  return found[1]!;
}

/** Connecting a phone the way Settings does: ask for a code, type it back. */
async function connectPhone(page: Page, workspaceId: string, number: string): Promise<void> {
  const sent = await page.request.post(`/v1/workspaces/${workspaceId}/connections/twilio/phone/code`, { data: { number } });
  expect(sent.ok(), `sending a code failed: ${sent.status()} ${await sent.text()}`).toBe(true);
  const confirmed = await page.request.post(`/v1/workspaces/${workspaceId}/connections/twilio/phone/confirm`, {
    data: { number, code: THE_CODE },
  });
  expect(confirmed.ok(), `confirming the code failed: ${confirmed.status()} ${await confirmed.text()}`).toBe(true);
}

async function disconnectPhones(page: Page, workspaceId: string): Promise<void> {
  const listed = await page.request.get(`/v1/workspaces/${workspaceId}/connections`);
  const { sourceAccounts } = (await listed.json()) as { sourceAccounts: { id: string; connectorId: string }[] };
  for (const account of sourceAccounts.filter((one) => one.connectorId === 'twilio')) {
    await page.request.post('/v1/commands/disconnect_source_account', {
      data: { commandId: randomUUID(), issuedAt: new Date().toISOString(), workspaceId, sourceAccountId: account.id },
    });
  }
}

/**
 * Moves each text this walk captured into the workspace being looked at. A text
 * waits in every Inbox of the one account all specs share until it is filed, and
 * would count in a workspace another spec has just made ("There is nothing in
 * it"). One that never arrived is left be.
 */
async function putTheTextsAway(page: Page, titles: string[], isMobile: boolean): Promise<void> {
  for (const title of titles) {
    const row = itemRow(page, title);
    if ((await row.count()) === 0) continue;
    await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
    await press(page.getByRole('menuitem', { name: 'Move to this workspace' }), isMobile);
    await expect(row).toHaveCount(1);
  }
}

/** A text as Twilio delivers it, signed with the stack's token over the address it was sent to. */
async function text(page: Page, params: Record<string, string>, signed = true): Promise<number> {
  const address = `${api}/ingress/twilio/sms`;
  const signature = createHmac('sha1', TOKEN)
    .update(address + Object.keys(params).sort().map((name) => name + params[name]).join(''))
    .digest('base64');
  const answer = await page.request.post(address, {
    form: params,
    headers: signed ? { 'x-twilio-signature': signature } : {},
  });
  return answer.status();
}

test.describe('Capture', () => {
  test.describe('a text sent to the Cockpit number appears in the Inbox', () => {
    test('shows a text from a connected phone as a Text message, once however often it is delivered, and not an unsigned one', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      const workspaceId = workspaceOf(page);
      const phone = aPhone();
      await connectPhone(page, workspaceId, phone);
      const said = uniqueTitle('Call the plumber');
      const next = uniqueTitle('Book the dentist');

      try {
        // On a phone the Inbox is a screen of its own, reached from the workspace.
        if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
        await expect(inbox(page)).toBeVisible();

        const delivery = { MessageSid: `SM${randomUUID().replaceAll('-', '')}`, From: phone, To: COCKPIT_NUMBER, Body: said };
        expect(await text(page, delivery)).toBe(200);
        const row = itemRow(page, said);
        await expect(row).toBeVisible();
        await expect(row.getByText('Text message', { exact: true })).toBeVisible();

        // The same text again, then one more behind it: when the second has landed the repeat has had its chance.
        expect(await text(page, delivery)).toBe(200);
        expect(await text(page, { ...delivery, MessageSid: `SM${randomUUID().replaceAll('-', '')}`, Body: next })).toBe(200);
        await expect(itemRow(page, next)).toBeVisible();
        await expect(row).toHaveCount(1);

        // Nothing signed, nothing heard.
        const unsigned = uniqueTitle('Never signed');
        expect(await text(page, { ...delivery, MessageSid: `SM${randomUUID().replaceAll('-', '')}`, Body: unsigned }, false)).toBe(403);
        await expect(itemRow(page, unsigned)).toHaveCount(0);

        // The form says where it is from, with nothing hanging after it.
        await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
        await press(page.getByRole('menuitem', { name: 'Open', exact: true }), isMobile);
        await expect(page.getByRole('dialog').getByText(/^From Text message$/)).toBeVisible();
        await press(page.getByRole('dialog').getByRole('button', { name: 'Cancel' }), isMobile);
      } finally {
        await putTheTextsAway(page, [said, next], isMobile);
        await disconnectPhones(page, workspaceId);
      }
    });
  });
});
