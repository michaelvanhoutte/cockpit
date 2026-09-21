import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { isLinkedWorktree, portsFor } from '../../scripts/lib/ports.mjs';
import {
  chooseRowAction,
  chooseTabAction,
  captureBox,
  deleteWorkspace,
  expect,
  itemRow,
  makeWorkspace,
  dashboardBar,
  openFirstWorkspace,
  press,
  switchTo,
  test,
  uniqueTitle,
  workspaceTab,
} from './support/app';

/**
 * F3, and the one walk this capability gets: what a person can do with an Item
 * that came from Teams exists only in a browser - a link that has to open a
 * second tab and leave this one exactly as it was, beside a row whose own
 * clicks, drags and swipes it must not disturb ("Open an Item at its source",
 * issue 487). Everything short of that is F1, in
 * apps/web/tests/unit/components/ItemRow.test.tsx and ItemForm.test.tsx.
 *
 * **The Item is saved the way Teams saves one**: a channel token minted by the
 * stub the stack runs (scripts/lib/stub-issuer.mjs) and posted at the real
 * ingress, since there is no Teams to press "Save to Cockpit" in
 * (apps/api/tests/integration/http/teams-ingress.test.ts is the ceiling on the
 * saving itself). The account it names is the one this walk connects, through
 * the same stub, which is what makes the call one the application accepts.
 *
 * **It makes its own workspace and puts it back**, disconnecting first, for the
 * reason connections.test.ts records.
 */
const root = resolve(__dirname, '..', '..');
const issuer = `http://127.0.0.1:${portsFor(root, { linked: isLinkedWorktree(root), env: process.env }).e2eIssuer}`;

/** The stub's own tenant and the person it signs in as (scripts/lib/stub-issuer.mjs). */
const TENANT = 'cockpit-local-tenant';
const PERSON = 'stub|michael@example.com';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';
const MESSAGE_LINK = 'https://teams.microsoft.com/l/message/19:walk@thread.v2';

async function saveFromTeams(page: Page, said: string): Promise<void> {
  const minted = await page.request.get(
    `${issuer}/botframework/token?${new URLSearchParams({ aud: 'cockpit-e2e-bot', serviceUrl: SERVICE_URL })}`,
  );
  const { token } = (await minted.json()) as { token: string };
  const messageId = String(Date.now());
  const answer = await page.request.post('/ingress/teams/messages', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      type: 'invoke',
      id: `f:${messageId}`,
      name: 'composeExtension/submitAction',
      serviceUrl: SERVICE_URL,
      channelId: 'msteams',
      from: { id: '29:1abc', name: 'Michael', aadObjectId: PERSON },
      conversation: { id: '19:walk@thread.v2', conversationType: 'groupChat', tenantId: TENANT },
      channelData: { tenant: { id: TENANT } },
      value: {
        commandId: 'saveToCockpit',
        commandContext: 'message',
        messagePayload: {
          id: messageId,
          createdDateTime: '2026-09-15T09:20:00.000Z',
          linkToMessage: `${MESSAGE_LINK}/${messageId}?tenantId=${TENANT}`,
          body: { contentType: 'html', content: `<div>${said}</div>` },
          from: { user: { id: '29:2def', displayName: 'Grace Hopper' } },
        },
      },
    },
  });
  expect(answer.status()).toBe(200);
}

test.describe('Capture', () => {
  test.describe('an item that came from somewhere else can be opened where it came from, and says where that is', () => {
    test('opens a message saved from Teams at its source from its row, its menu and its form', async ({
      page,
      context,
      isMobile,
    }) => {
      // Nothing on the internet is reached: the original is answered locally, so
      // what is asserted is that a second tab was opened at the right address.
      await context.route('https://teams.microsoft.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: 'the original message' }),
      );
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('Sourced');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      await chooseTabAction(page, workspaceTab(page, workspace), 'Manage connections…', isMobile);
      await press(page.getByRole('dialog').getByRole('button', { name: 'Connect' }), isMobile);
      await press(page.getByRole('link', { name: 'michael@example.com', exact: true }), isMobile);
      await expect(page.getByRole('dialog').getByText('michael@example.com')).toBeVisible();
      await press(page.getByRole('button', { name: 'Done' }), isMobile);

      // On a phone the Inbox is a tab of its own, reached from the workspace this
      // walk is already in - which is why this is not `openInbox`, that goes to
      // the first workspace.
      if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      await expect(captureBox(page)).toBeVisible();
      const said = uniqueTitle('Review the plan');
      await saveFromTeams(page, said);
      const row = itemRow(page, said);
      await expect(row).toBeVisible();
      await expect(row.getByText(/Grace Hopper/)).toBeVisible();

      // From the row: a second tab at the original, and this one untouched -
      // nothing picked, no form opened.
      const fromRow = context.waitForEvent('page');
      await press(row.getByRole('link', { name: 'Open in Microsoft Teams' }), isMobile);
      const opened = await fromRow;
      await expect(opened).toHaveURL(new RegExp(`^${MESSAGE_LINK}`));
      await opened.close();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // From the menu, the same, and the form it also has an Open for stays shut.
      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      const fromMenu = context.waitForEvent('page');
      await press(page.getByRole('menuitem', { name: 'Open in Microsoft Teams' }), isMobile);
      const openedAgain = await fromMenu;
      await expect(openedAgain).toHaveURL(new RegExp(`^${MESSAGE_LINK}`));
      await openedAgain.close();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // From the form: says where it is from and offers the same way back.
      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open', exact: true }), isMobile);
      const form = page.getByRole('dialog');
      await expect(form.getByText(/From Microsoft Teams - Grace Hopper/)).toBeVisible();
      const fromForm = context.waitForEvent('page');
      await press(form.getByRole('link', { name: 'Open in Microsoft Teams' }), isMobile);
      const openedLast = await fromForm;
      await expect(openedLast).toHaveURL(new RegExp(`^${MESSAGE_LINK}`));
      await openedLast.close();
      await expect(form).toBeVisible();
      await press(form.getByRole('button', { name: 'Cancel' }), isMobile);

      await chooseTabAction(page, workspaceTab(page, workspace), 'Manage connections…', isMobile);
      await chooseRowAction(page, 'michael@example.com', 'Disconnect', isMobile);
      await press(
        page.getByRole('button', { name: 'Yes, disconnect michael@example.com' }),
        isMobile,
      );
      await press(page.getByRole('button', { name: 'Done' }), isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
});
