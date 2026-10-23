import type { BrowserContext, Page } from '@playwright/test';
import {
  addressOf,
  expect,
  inbox,
  MICHAEL,
  openInbox,
  press,
  STARTING_WORKSPACE,
  test,
  uniqueTitle,
  closeSettings,
  openSettings,
} from './support/app';

/**
 * F3, and the one walk this capability gets: an app connecting to Cockpit and
 * capturing through it, with everything real between them - the stub issuer
 * standing in for Google, the consent page, the code exchange, `/mcp`, and the
 * Item in the Inbox ("Connect Claude to Cockpit, and capture an item from it",
 * issue 599). Who may consent, as whom an app acts and what a capture writes
 * are proved below this, in apps/api/tests/integration/http/connected-apps.test.ts;
 * what this alone can show is that a browser gets through the pages between
 * them, signing in on the way, and that the row then says which app it was -
 * and, from the settings window ("See the apps connected to your Cockpit, and
 * disconnect one", issue 600), that the app is listed there, and that
 * disconnecting it cuts it off while its Item stays.
 *
 * **The app is played by the walk itself**, registering and trading its code
 * over HTTP the way Claude Code does, because there is no Claude to drive. Its
 * redirect address is answered locally, so nothing on the internet is reached.
 */
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** Connects Claude as the app does - registering, signing in, consenting, trading the code - and answers its access token. */
async function connectClaude(page: Page, context: BrowserContext, isMobile: boolean): Promise<{ token: string }> {
  const registered = await page.request.post('/oauth/register', {
    data: {
      client_name: 'Claude',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(registered.status()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = Buffer.from(digest).toString('base64url');
  // The app's own address is somewhere this walk never goes: the browser
  // is sent there with the code, and the code is all the walk needs.
  await context.route((url) => url.href.startsWith(CALLBACK), (route) => route.abort());

  // Not signed in: through the issuer standing in for Google, and back on
  // the consent page rather than in the app.
  await page.goto(
    `/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: 'walk',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`,
  );
  await press(page.getByRole('link', { name: addressOf(MICHAEL), exact: true }), isMobile);
  await expect(page.getByRole('heading', { name: 'Allow Claude to create items in your Cockpit?' })).toBeVisible();
  const sentBack = page.waitForRequest((request) => request.url().startsWith(CALLBACK));
  await press(page.getByRole('button', { name: 'Allow' }), isMobile);
  const code = new URL((await sentBack).url()).searchParams.get('code');
  expect(code).toBeTruthy();

  const traded = await page.request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    },
  });
  expect(traded.status()).toBe(200);
  const { access_token: token } = (await traded.json()) as { access_token: string };
  return { token };
}

test.describe('MCP connections', () => {
  test.describe('an app somebody allows captures into their Inbox, and the item says which app it was', () => {
    test('connects Claude through sign-in and the consent page, its capture shows in the Inbox as from Claude, and the row follows what Claude reports on it', async ({
      page,
      context,
      isMobile,
    }) => {
      const { token } = await connectClaude(page, context, isMobile);

      const said = uniqueTitle('Pick up the dry cleaning');
      const called = await page.request.post('/mcp', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
        data: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'create_item', arguments: { message: said, workspace: STARTING_WORKSPACE } },
        },
      });
      expect(called.status()).toBe(200);
      const { result } = (await called.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      expect(result.isError ?? false).toBe(false);
      expect(result.content[0]!.text).toContain(said);

      await openInbox(page, isMobile);
      const row = inbox(page).getByRole('listitem').filter({ hasText: said });
      await expect(row).toBeVisible();
      await expect(row.getByText(/Claude/)).toBeVisible();

      // A phone has no Send to Claude entry, and its Settings has no window.
      if (isMobile) return;

      // The same app reports on a Run sent from that row ("Follow on the row
      // what Claude reports back", issue 1160), the test standing in for Claude.
      // The stages, refusals and links' rules are proved in
      // apps/api/tests/integration/http/connected-apps.test.ts and the chip's
      // wording in apps/web/tests/unit/agentRunChip.test.ts; what only a browser
      // shows is the row changing without a reload and the arrow opening the result.
      await press(row.getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Send to Claude…' }), isMobile);
      const review = page.getByRole('dialog', { name: `Send “${said}” to Claude` });
      // The prompt names the Run, as it does for Claude. The window fills it in
      // once the Item's files have loaded, so wait for the closing before reading.
      const naming = /report back to Cockpit through its connection, naming this run: (\S+)/;
      await expect(review.getByLabel('Prompt')).toHaveValue(naming);
      const named = naming.exec(await review.getByLabel('Prompt').inputValue());
      if (!named) throw new Error('The prompt does not name the run it was sent as.');
      const runId = named[1]!;
      await press(review.getByRole('button', { name: /Open in Cowork/ }), isMobile);
      await expect(row.getByText('Sent to Cowork')).toBeVisible();

      const report = async (args: Record<string, string>) => {
        const answer = await page.request.post('/mcp', {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
          data: {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'report_run', arguments: { run: runId, ...args } },
          },
        });
        expect(answer.status()).toBe(200);
        const reported = (await answer.json()) as { result: { isError?: boolean } };
        expect(reported.result.isError ?? false).toBe(false);
      };

      await report({ stage: 'on_it', session_url: 'https://claude.ai/code/session_01WALK' });
      await expect(row.getByRole('link', { name: 'Cowork is on it ↗' })).toHaveAttribute(
        'href',
        'https://claude.ai/code/session_01WALK',
      );

      await report({ stage: 'ready', result_url: 'https://example.com/the-draft', note: 'Two drafts, A and B' });
      const ready = row.getByRole('link', { name: 'Ready ↗' });
      await expect(ready).toHaveAttribute('href', 'https://example.com/the-draft');
      await expect(ready).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(ready).toHaveAttribute('title', 'Opens example.com - Two drafts, A and B');

      const window = await openSettings(page, 'Connected apps', isMobile);
      await expect(window.getByText(new URL(page.url()).origin + '/mcp')).toBeVisible();
      const listed = window.getByRole('listitem').filter({ hasText: 'Claude' });
      await expect(listed).toContainText(/last captured/);

      await press(listed.getByRole('button', { name: 'Actions for Claude' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Disconnect' }), isMobile);
      await press(page.getByRole('button', { name: 'Yes, disconnect Claude' }), isMobile);
      await expect(window.getByText('No connected apps')).toBeVisible();

      // Cut off at once, and what it captured is still there.
      const refused = await page.request.post('/mcp', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
        data: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });
      expect(refused.status()).toBe(401);
      await closeSettings(page, isMobile);
      await expect(row).toBeVisible();
    });
  });
});
