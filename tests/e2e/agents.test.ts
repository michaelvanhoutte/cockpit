import { randomUUID } from 'node:crypto';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import type { Page } from '@playwright/test';
import {
  capture,
  captureBox,
  dashboardBar,
  expect,
  closeTheFilterSheet,
  expectNoSidewaysScroll,
  fileOnto,
  inbox,
  itemRow,
  openFirstWorkspace,
  openSettings,
  closeSettings,
  pastCapture,
  press,
  test,
  uniqueTitle,
} from './support/app';

/**
 * Status ▸ the named state, from an open row menu. A mouse opens the submenu and
 * chooses with the keyboard: a mouse click on the choice lost the submenu under this
 * row's menu in this walk; a phone taps.
 */
async function chooseStatus(page: Page, state: string, isMobile: boolean): Promise<void> {
  await press(page.getByRole('menuitem', { name: /^Status/ }), isMobile);
  const choice = page.getByRole('menuitemradio', { name: state });
  if (isMobile) return press(choice, isMobile);
  await choice.focus();
  await page.keyboard.press('Enter');
}

/**
 * Captures an item and files it on Panel 1, leaving the dashboard showing it -
 * a phone's Inbox and dashboard are screens of their own.
 */
async function anItemOnPanel1(page: Page, title: string, isMobile: boolean): Promise<void> {
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
  await capture(page, title, isMobile);
  await fileOnto(page, title, 'Panel 1', isMobile);
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Dashboard 1' }), isMobile);
}

/**
 * F3, because only a real browser draws the shell, takes a real key press over
 * the page, and opens the row's menu and Settings over it ("Retire the agents'
 * dock and routines, keeping what each agent knew", issue 1165). What became of
 * each Agent is held against real stores one tier down
 * (apps/api/tests/integration/accounts/aged-store.test.ts), and a Run an Agent
 * started stays readable there too (agent-runs-retired.test.ts); this is only
 * that nothing of the dock is left for a person to meet.
 */
test.describe('Agents', () => {
  test.describe('the agents’ dock and Agent settings are gone, and a row hands its item to Claude', () => {
    test('draws no dock, does nothing on A, lists no Agent settings, and offers Send to Claude… and no Agent on a row', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      const title = uniqueTitle('Plan the offsite');
      await anItemOnPanel1(page, title, isMobile);
      const dock = page.getByRole('toolbar', { name: 'Agents' });
      const strip = page.getByRole('button', { name: 'Show the agents’ dock' });

      await expect(itemRow(page, title)).toBeVisible();
      await expect(dock).toHaveCount(0);
      await expect(strip).toHaveCount(0);
      if (!isMobile) {
        // A used to hide and show the dock; now it does nothing at all.
        await page.locator('body').press('a');
        await expect(dock).toHaveCount(0);
        await expect(strip).toHaveCount(0);
      }

      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await expect(page.getByRole('menuitem', { name: /^Status/ })).toBeVisible();
      // A phone has no Send to Claude…: `claude://` has no app to open there.
      await expect(page.getByRole('menuitem', { name: 'Send to Claude…' })).toHaveCount(isMobile ? 0 : 1);
      await expect(page.getByRole('menuitem', { name: /Agent/ })).toHaveCount(0);
      await page.keyboard.press('Escape');

      if (!isMobile) {
        const settings = await openSettings(page, 'Connections', isMobile);
        await expect(settings.getByRole('button', { name: 'MCP', exact: true })).toBeVisible();
        await expect(settings.getByRole('button', { name: 'Agent settings' })).toHaveCount(0);
        await closeSettings(page, isMobile);
      }

      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: /^Dismiss/ }), isMobile);
      await expect(itemRow(page, title)).toHaveCount(0);
    });
  });

  test.describe('an item Claude is on is found by the Agent running filter until its Status ends the run', () => {
    test('is found by the Agent running filter until a status of To do ends its run', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      const asked = uniqueTitle('Chase the invoice');
      await anItemOnPanel1(page, asked, isMobile);
      // Sent through the command the window sends, since a phone has no window
      // to send it from; what Open sends is the walk below's.
      const itemId = await itemRow(page, asked).getAttribute('data-item-id');
      expect(itemId).not.toBeNull();
      const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
      const sent = await page.request.post('/v1/commands/send_item_to_claude', {
        data: {
          commandId: randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          runId: randomUUID(),
          itemId,
          destination: 'cowork',
          folder: '',
        },
      });
      expect(sent.status()).toBe(200);
      await expect(itemRow(page, asked).getByText('Sent to Cowork')).toBeVisible();

      // The dashboard filter's Agent running toggle shows this row, and lets it
      // go the moment the run is over, until × clears it.
      await press(page.getByRole('button', { name: 'Filter this dashboard' }), isMobile);
      await press(page.getByRole('button', { name: 'Agent running' }), isMobile);
      // A phone's filter is a sheet over the page, which hides the rows from a role query until it is closed.
      if (isMobile) await closeTheFilterSheet(page);
      await expect(itemRow(page, asked)).toBeVisible();

      // In progress leaves the run open; To do ends it - the chip goes, and the row stays unless filtered.
      await press(itemRow(page, asked).getByRole('button', { name: 'Item actions' }), isMobile);
      await chooseStatus(page, 'In progress', isMobile);
      await expect(itemRow(page, asked).getByText('Sent to Cowork')).toBeVisible();
      await press(itemRow(page, asked).getByRole('button', { name: 'Item actions' }), isMobile);
      await chooseStatus(page, 'To do', isMobile);
      await expect(itemRow(page, asked)).toHaveCount(0);
      await press(page.getByRole('button', { name: 'Clear the filter', exact: true }), isMobile);
      await expect(itemRow(page, asked).getByText('Sent to Cowork')).toHaveCount(0);
      await expect(itemRow(page, asked)).toBeVisible();
      // The bar stays open after ×, so the funnel closes it; a phone's summary went with the ×.
      if (!isMobile) await press(page.getByRole('button', { name: 'Clear the filter and close it' }), isMobile);
      await expectNoSidewaysScroll(page);

      await press(itemRow(page, asked).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: /^Dismiss/ }), isMobile);
      await expect(itemRow(page, asked)).toHaveCount(0);
    });
  });

  test.describe('an item is sent to Claude from its row, and the row says it went', () => {
    // F3, because the menu entry, the window over the screen and the chip are
    // drawn only in a real browser. The address, the prompt and the Run's rules
    // are not re-proved here: they are claude-send.test.ts's and
    // claude-sends.test.ts's. Opening Claude's desktop app is outside the
    // browser, so the walk stops at the chip.
    test('offers Send to Claude… at a desk, opens the window, sends the edited prompt, and shows Sent to Cowork; a phone has no entry', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      // A phone's Inbox is a screen of its own, reached from this workspace.
      if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      const title = uniqueTitle('Pay the invoice');
      await capture(page, title, isMobile);

      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      if (isMobile) {
        await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Send to Claude…' })).toHaveCount(0);
        await page.keyboard.press('Escape');
        return;
      }

      await press(page.getByRole('menuitem', { name: 'Send to Claude…' }), isMobile);
      const review = page.getByRole('dialog', { name: `Send “${title}” to Claude` });
      await expect(review).toBeVisible();
      const prompt = review.getByLabel('Prompt');
      await expect(prompt).toHaveValue(new RegExp(`^${title}`));
      await prompt.fill(`${title}\n\nWho do we pay first?`);
      await review.getByLabel('Folder').fill('C:\\GitHub\\Cockpit');

      // Open records the Run first; the `claude://` navigation after it has no app to open here.
      const sent = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /\/v1\/commands\/send_item_to_claude$/.test(response.url()),
      );
      await press(review.getByRole('button', { name: /Open in Cowork/ }), isMobile);
      expect((await sent).status()).toBe(200);

      await expect(review).toHaveCount(0);
      await expect(itemRow(page, title).getByText('Sent to Cowork')).toBeVisible();
      // Claude is on it, so the row offers no second send.
      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await expect(page.getByRole('menuitem', { name: 'Send to Claude…' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // Dismiss ends the Run, as it ends any.
      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: /^Dismiss/ }), isMobile);
      await expect(itemRow(page, title)).toHaveCount(0);
    });
  });

  test.describe('a remembered sentence is changed from the window that used it', () => {
    /**
     * The guest, for the reason the walk below it is. This stack has no model, so
     * no proposal is ever made with a sentence: the one response that says so is
     * the snapshot, with the model's part (a proposal naming the sentence) put
     * into it at the network boundary, as a third party is. Everything else is
     * real: the sentence is kept through its command, listed, reworded and read
     * back through Settings. That the window names it and opens Settings on it is
     * apps/web/tests/unit/components/SendToClaudeWindow.test.tsx; that a reworded or
     * deleted sentence changes what is proposed is
     * apps/api/tests/integration/http/remembered-sentences-manage.test.ts.
     */
    test('goes from the window to the sentence in Settings, rewords it, and comes back to the window', async ({ page, isMobile }) => {
      test.skip(isMobile, 'Settings on a phone holds Appearance alone');
      const title = 'Look into a cheaper energy tariff';
      const sentenceId = randomUUID();
      await page.route('**/v1/workspaces/*/snapshot*', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { items?: { title: string; claudeProposals: { learnedFrom?: string[] }[] | null }[] };
        for (const item of body.items ?? []) {
          if (item.title === title) item.claudeProposals = (item.claudeProposals ?? []).map((one) => ({ ...one, learnedFrom: [sentenceId] }));
        }
        await route.fulfill({ response, json: body });
      });
      await page.goto('/signin');
      await press(page.getByRole('link', { name: 'Continue as guest' }), isMobile);
      await dashboardBar(page).or(captureBox(page)).first().waitFor({ state: 'visible' });
      await pastCapture(page, isMobile);
      await expect(inbox(page)).toBeVisible();
      const kept = await page.request.post('/v1/commands/remember_sentence', {
        data: {
          commandId: randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId: ACCOUNT_WIDE,
          sentenceId,
          sentence: 'Replies: Dutch, short.',
          action: 'reply to a mail',
          sourceKind: 'gmail',
        },
      });
      expect(kept.status()).toBe(200);

      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Send to Claude…' }), isMobile);
      const review = page.getByRole('dialog', { name: `Send “${title}” to Claude` });
      await expect(review.getByText('Replies: Dutch, short.')).toBeVisible();
      await press(review.getByRole('button', { name: 'Change “Replies: Dutch, short.”' }), isMobile);

      // Settings is over the window, on the sentence, ready to reword.
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await expect(settings.getByRole('heading', { name: 'What Cockpit remembers', exact: true })).toBeVisible();
      const box = settings.getByLabel('Sentence');
      await expect(box).toHaveValue('Replies: Dutch, short.');
      await box.fill('Replies: Dutch, short, signed M.');
      const reworded = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /\/v1\/commands\/edit_remembered_sentence$/.test(response.url()),
      );
      await press(settings.getByRole('button', { name: 'Save' }), isMobile);
      expect((await reworded).status()).toBe(200);
      await expect(settings.getByText('Replies: Dutch, short, signed M.')).toBeVisible();

      await closeSettings(page, isMobile);
      await expect(review).toBeVisible();
      await expect(review.getByText('Replies: Dutch, short, signed M.')).toBeVisible();
    });
  });

  test.describe('an edit to a proposal is offered back as a sentence to remember', () => {
    /**
     * The guest, because its Items carry proposals from the start and this
     * stack has no model to make any (scripts/e2e-stack.mjs); the sentence is the
     * stack's stand-in, since what the real model offers is held one tier down.
     */
    test('opens Claude, then offers the sentence, and keeps it on Remember', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone has no Send to Claude…');
      await page.goto('/signin');
      await press(page.getByRole('link', { name: 'Continue as guest' }), isMobile);
      await dashboardBar(page).or(captureBox(page)).first().waitFor({ state: 'visible' });
      await pastCapture(page, isMobile);
      await expect(inbox(page)).toBeVisible();

      const title = 'Look into a cheaper energy tariff';
      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Send to Claude…' }), isMobile);
      const review = page.getByRole('dialog', { name: `Send “${title}” to Claude` });
      const prompt = review.getByLabel('Prompt');
      await expect(prompt).toHaveValue(/Compare their offer/);
      await prompt.fill('Vergelijk de tarieven kort, in het Nederlands.');

      await press(review.getByRole('button', { name: /Open in Cowork/ }), isMobile);

      // The window stays for the offer, which arrives with its own answer.
      const sentence = review.getByLabel('Remember this?');
      await expect(sentence).toHaveValue('Replies: Dutch, short, signed Michael.');
      const kept = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /\/v1\/commands\/remember_sentence$/.test(response.url()),
      );
      await press(review.getByRole('button', { name: 'Remember' }), isMobile);
      expect((await kept).status()).toBe(200);
      await expect(review).toHaveCount(0);
    });
  });
});
