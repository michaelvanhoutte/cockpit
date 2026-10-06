import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ACCOUNT_WIDE, AGENT_COLORS } from '@cockpit/shared';
import { isLinkedWorktree, portsFor } from '../../scripts/lib/ports.mjs';
import {
  capture,
  chooseRowAction,
  dashboardBar,
  deleteWorkspace,
  expect,
  closeTheFilterSheet,
  expectNoSidewaysScroll,
  fileOnto,
  itemRow,
  makeWorkspace,
  openFirstWorkspace,
  openSettings,
  closeSettings,
  press,
  switchTo,
  test,
  uniqueTitle,
  workspaceTab,
} from './support/app';

const root = resolve(__dirname, '..', '..');
/** The stub the stack runs, which stands in for Claude Code's routines as well as for sign-in. */
const issuer = `http://127.0.0.1:${portsFor(root, { linked: isLinkedWorktree(root), env: process.env }).e2eIssuer}`;

/** A minimal, valid 1x1 PNG, for the file an agent is sent a link to. */
const A_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/**
 * F3, because none of this exists below a real browser: the dock is drawn at
 * the bottom of the shell, a tile's own menu opens by right-click, and A and
 * the gear toggle the dock itself - none of which a component test can drive
 * with a real keyboard event over the real page.
 *
 * It is not re-proving the naming or hiding rules, which
 * apps/api/tests/integration/http/agents.test.ts owns against a real store,
 * nor which tiles a given state draws, which
 * packages/shared/tests/unit/domain/agent.test.ts owns, nor the dock's own
 * wiring, which apps/web/tests/unit/components/AgentDock.test.tsx owns. One
 * walk for the capability, saying it works for a person - on the one device
 * it is offered on ("Keep your agents in a dock, and choose which each
 * dashboard shows", issue 570): hidden on a phone, where there is no drag.
 *
 * It makes an agent of its own, named uniquely, and deletes it again at the
 * end: every spec in a run shares one account (support/app.ts), and an agent
 * is account-wide, drawn in the dock of every workspace and dashboard a spec
 * after this one opens.
 */
test.describe('Agents', () => {
  test.describe('an agent is made, edited, hidden, shown and deleted from the dock', () => {
    test('offers it from the dock, and the dock only, and hides on a phone', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);

      if (isMobile) {
        await expect(page.getByRole('toolbar', { name: 'Agents' })).toHaveCount(0);
        await expectNoSidewaysScroll(page);
        return;
      }

      const dock = page.getByRole('toolbar', { name: 'Agents' });
      await expect(dock).toBeVisible();

      const name = uniqueTitle('Scope it');
      await press(dock.getByRole('button', { name: '+ New agent' }), isMobile);
      await page.getByLabel('Name of the agent').fill(name);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(dock.getByRole('button', { name })).toBeVisible();

      // A name another agent already has is refused, and the form stays open.
      await press(dock.getByRole('button', { name: '+ New agent' }), isMobile);
      await page.getByLabel('Name of the agent').fill(name);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(page.getByRole('alert')).toHaveText(`an agent called ${name} already exists`);
      await press(page.getByRole('button', { name: 'Cancel' }), isMobile);

      // Edited from the tile's own menu.
      const renamed = uniqueTitle('Scope it well');
      await dock.getByRole('button', { name }).click({ button: 'right' });
      await press(page.getByRole('menuitem', { name: 'Edit…' }), isMobile);
      await expect(page.getByLabel('Name of the agent')).toHaveValue(name);
      await page.getByLabel('Name of the agent').fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(dock.getByRole('button', { name: renamed })).toBeVisible();

      // Hidden on this dashboard from the tile's own menu; the dock's own
      // "…" says so and offers it back.
      await dock.getByRole('button', { name: renamed }).click({ button: 'right' });
      await press(page.getByRole('menuitem', { name: 'Hide on this dashboard' }), isMobile);
      await expect(dock.getByRole('button', { name: renamed })).toHaveCount(0);

      // "1 hidden here" is on the bar itself too, from here on - its own
      // assertion is below, once the menu that would make the two ambiguous
      // is closed again.
      await expect(page.getByText('1 hidden here')).toBeVisible();

      const dockMenu = dock.getByRole('button', { name: 'What is hidden here' });
      await press(dockMenu, isMobile);
      const menu = page.getByRole('menu');
      await expect(menu.getByText('1 hidden here')).toBeVisible();
      await press(menu.getByRole('menuitem', { name: `Show ${renamed}` }), isMobile);
      await expect(dock.getByRole('button', { name: renamed })).toBeVisible();

      // The dock hides from its own control and the strip it leaves brings it
      // back; A toggles either way.
      await dock.getByRole('button', { name: 'Hide the agents’ dock' }).click();
      await expect(dock).toHaveCount(0);
      await page.getByRole('button', { name: 'Show the agents’ dock' }).click();
      await expect(dock).toBeVisible();
      await page.keyboard.press('a');
      await expect(dock).toHaveCount(0);
      await page.keyboard.press('a');
      await expect(dock).toBeVisible();

      // Deleted, asked first, from the tile's own menu.
      await dock.getByRole('button', { name: renamed }).click({ button: 'right' });
      await press(page.getByRole('menuitem', { name: 'Delete…' }), isMobile);
      await expect(page.getByText(`Delete ${renamed}?`)).toBeVisible();
      await press(page.getByRole('button', { name: `Yes, delete ${renamed}` }), isMobile);
      await expect(dock.getByRole('button', { name: renamed })).toHaveCount(0);

      await expectNoSidewaysScroll(page);
    });
  });

  /**
   * F3, because the drag is the browser's own: a tile carried off the dock,
   * rows outlined while it is in the air, the dashboard scrolling under it,
   * and a drop that starts Claude - none of which exists below a real page
   * ("Drop an agent on an item to start a Claude Code session on it", issue
   * 571). What a start records and refuses is
   * apps/api/tests/integration/http/agent-runs.test.ts's; what a row draws
   * and sends is apps/web/tests/unit/components/ItemRow.test.tsx's.
   *
   * **The scroll here is the capability, not the proof of Cockpit's own
   * scrolling**: Chromium scrolls a native drag itself, so this passes with
   * that switched off. That an agent's drag asks for it is
   * apps/web/tests/unit/dragScroll.test.ts's.
   *
   * **Claude is the stub's stand-in routine** (scripts/lib/stub-issuer.mjs),
   * which the stack fires in place of Anthropic's - so no walk starts a real
   * session, and what it was sent can be read back - including the link to
   * the Item's file, opened here signed out, which is the only proof the
   * link's address reaches the Worker through the app's own origin ("Send an
   * item's attachments along when an agent starts", issue 573).
   *
   * A phone has no dock and no drag, so it starts an agent from the row's own
   * menu, the way a keyboard does - and has no dock to make one in, so the
   * agent that asks what to ask is made through the API, on both. It makes its
   * own workspace, and puts it and its connection back, for the reason
   * connections.test.ts records.
   */
  test.describe('an agent dropped on a dashboard row starts Claude on it', () => {
    test('outlines the rows that take it, starts it where it is dropped, and ends when the agent finishes', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      const asking = uniqueTitle('Ask about it');
      const askingId = randomUUID();
      const made = await page.request.post('/v1/commands/create_agent', {
        data: {
          commandId: randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId: ACCOUNT_WIDE,
          agentId: askingId,
          name: asking,
          color: AGENT_COLORS[0],
          engine: 'claude-code',
          message: '{prompt}\n\nAbout: {title}\n\n{description}\n\n{link}',
          asksForPrompt: true,
          startsInProgress: false,
        },
      });
      expect(made.status()).toBe(200);
      const workspace = uniqueTitle('With Claude');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const routine = { routineUrl: `${issuer}/v1/claude_code/routines/trig_e2e/fire`, token: 'e2e-token' };
      if (isMobile) {
        // Settings is the pointer's, by decision, so a phone connects the way
        // the form does and walks everything after it.
        const workspaceId = (await workspaceTab(page, workspace).getAttribute('href'))!.split('/').at(-1)!;
        const connected = await page.request.post(`/v1/workspaces/${workspaceId}/connections/claude-code/connect`, {
          data: routine,
        });
        expect(connected.status()).toBe(200);
      } else {
        const settings = await openSettings(page, 'Agent settings', isMobile);
        await press(settings.getByRole('button', { name: 'Connect Claude Code' }), isMobile);
        await page.getByLabel('Routine trigger URL').fill(routine.routineUrl);
        await page.getByLabel('Routine token').fill(routine.token);
        await press(page.getByRole('button', { name: 'Connect', exact: true }), isMobile);
        await expect(settings.getByText(/last worked/)).toBeVisible();
        await closeSettings(page, isMobile);
      }

      const asked = uniqueTitle('Chase the invoice');
      // A phone's Inbox is a screen of its own, reached from this workspace.
      if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      await capture(page, asked, isMobile);
      // A file on it, which the session gets a link to (issue 573).
      await press(itemRow(page, asked).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open' }), isMobile);
      const uploaded = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /\/v1\/items\/[^/]+\/attachments$/.test(response.url()),
      );
      await page.getByRole('dialog').getByLabel('Files to attach').setInputFiles({
        name: 'invoice.png',
        mimeType: 'image/png',
        buffer: A_PNG,
      });
      expect((await uploaded).status()).toBe(201);
      await press(page.getByRole('dialog').getByRole('button', { name: 'Cancel' }), isMobile);
      await fileOnto(page, asked, 'Panel 1', isMobile);
      const onTheDashboard = () => page.locator('[data-drag-scroll="dashboard"]');
      const agent = uniqueTitle('Scope it');

      if (isMobile) {
        await press(dashboardBar(page).getByRole('link', { name: 'Dashboard 1' }), isMobile);
        await press(itemRow(page, asked).getByRole('button', { name: 'Item actions' }), isMobile);
        await press(page.getByRole('menuitem', { name: `${asking}…` }), isMobile);
      } else {
        const dock = page.getByRole('toolbar', { name: 'Agents' });
        await press(dock.getByRole('button', { name: '+ New agent' }), isMobile);
        await page.getByLabel('Name of the agent').fill(agent);
        await press(page.getByRole('button', { name: 'Save' }), isMobile);
        await expect(dock.getByRole('button', { name: agent })).toBeVisible();
        await expect(dock.getByText('Drag an agent onto an item to start it.')).toBeVisible();

        // One row left in the Inbox, and one filed on a panel below the fold
        // of a dashboard too short to show it.
        const unfiled = uniqueTitle('Still in the Inbox');
        await capture(page, unfiled, isMobile);
        const far = uniqueTitle('Far down');
        await page.setViewportSize({ width: 1280, height: 560 });
        for (const name of [uniqueTitle('B'), uniqueTitle('C'), uniqueTitle('D'), uniqueTitle('E'), far]) {
          await press(page.getByRole('button', { name: '+ Panel' }), isMobile);
          await page.getByLabel('Name of the new panel').fill(name);
          await page.getByLabel('Name of the new panel').press('Enter');
          await expect(page.getByRole('region', { name })).toBeAttached();
        }
        const deep = uniqueTitle('Scope the rollout');
        await capture(page, deep, isMobile);
        await fileOnto(page, deep, far, isMobile);
        const farRow = page.getByRole('region', { name: far }).getByRole('listitem').filter({ hasText: deep });
        // Inside the dashboard's own box rather than the window, since the
        // dock covers the bottom of the window.
        const seen = () =>
          farRow.evaluate((el) => {
            const at = el.getBoundingClientRect();
            const box = document.querySelector('[data-drag-scroll="dashboard"]')!.getBoundingClientRect();
            return at.top >= box.top && at.bottom <= box.bottom;
          });
        expect(await seen(), 'the far row was on screen before the drag').toBe(false);

        // Carried off the dock by hand, `page.mouse` rather than `dragTo`, for
        // the reason filing.test.ts's own edge walk gives: `dragTo` scrolls
        // its target into view itself.
        const tile = await dock.getByRole('button', { name: agent }).boundingBox();
        const over = await onTheDashboard().boundingBox();
        if (!tile || !over) throw new Error('the tile or the dashboard is not on screen');
        await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
        await page.mouse.down();
        await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 8 });
        await expect(itemRow(page, asked)).toHaveAttribute('data-takes-agent', '');
        await expect(itemRow(page, unfiled)).not.toHaveAttribute('data-takes-agent', '');
        for (let held = 0; held < 100 && !(await seen()); held += 1) {
          await page.mouse.move(over.x + over.width - 30, over.y + over.height - 6 + (held % 2));
          await page.waitForTimeout(60);
        }
        expect(await seen(), 'the far row never scrolled into view').toBe(true);
        const at = await farRow.boundingBox();
        if (!at) throw new Error('the far row is not on screen');
        // At the row's right end, out from under the undo toast that the filing
        // above leaves at the bottom centre: with the Panel list taking the
        // dashboard's right edge, the row's middle sits behind the toast.
        await page.mouse.move(at.x + at.width - 30, at.y + at.height / 2, { steps: 8 });
        // Only the row under the pointer is lit; every other row that takes it is merely tinted.
        await expect(farRow).toHaveAttribute('data-agent-target', '');
        await expect(itemRow(page, asked)).not.toHaveAttribute('data-agent-target', '');
        await page.mouse.up();

        const chip = farRow.getByRole('link', { name: `${agent} · Claude is working ↗` });
        await expect(chip).toHaveAttribute('href', /\/claude-code\/session\/session_stub_/);
        await expect(itemRow(page, unfiled).getByText(/Claude/)).toHaveCount(0);

        // Agent finished: Done - the Item is done, so it leaves the panel.
        await press(farRow.getByRole('button', { name: 'Item actions' }), isMobile);
        await press(page.getByRole('menuitem', { name: 'Agent finished: Done' }), isMobile);
        await expect(farRow).toHaveCount(0);

        // Back to a window the connections list fits in, for putting things back.
        await page.setViewportSize({ width: 1280, height: 720 });
        // The agent that asks what to ask before it starts.
        await dock.getByText(asking, { exact: true }).dragTo(itemRow(page, asked));
      }

      const box = page.getByRole('dialog', { name: `About “${asked}”` });
      await expect(box).toBeVisible();
      await box.getByLabel('What to ask Claude').fill('Who do we chase first?');
      await press(box.getByRole('button', { name: 'Send to Claude' }), isMobile);
      await expect(
        itemRow(page, asked).getByRole('link', { name: `${asking} · Claude is working ↗` }),
      ).toBeVisible();
      const fired = (await (await fetch(`${issuer}/claude-code/fired`)).json()) as { text: string }[];
      const sent = fired.find((one) => one.text.includes('Who do we chase first?') && one.text.includes(asked));
      expect(sent).toBeDefined();
      // Its file's link opens without the browser's sign-in: this is Node's own fetch.
      const link = sent!.text.match(/- invoice\.png: (\S+)/)?.[1];
      expect(link, 'the message links the item’s file').toBeDefined();
      const opened = await fetch(link!);
      expect(opened.status).toBe(200);
      expect(Buffer.from(await opened.arrayBuffer()).equals(A_PNG)).toBe(true);

      // The session's hooks say it is waiting on you, then working again
      // ("See on the item when Claude is waiting on you", issue 572) - posted
      // exactly as the connection's form tells the repository to post them.
      // The form is in Settings, which a phone does not have.
      if (!isMobile) {
        await openSettings(page, 'Agent settings', isMobile);
        await chooseRowAction(page, 'Claude Code', 'Edit…', isMobile);
        const snippet = page.getByLabel('Hooks for .claude/settings.json');
        await expect(page.getByText('No hook has arrived yet.')).toBeVisible();
        const hook = JSON.parse((await snippet.textContent())!).hooks.Stop[0].hooks[0] as {
          url: string;
          headers: { Authorization: string };
        };
        await press(page.getByRole('button', { name: 'Cancel' }), isMobile);
        await closeSettings(page, isMobile);
        const session = (await itemRow(page, asked).getByRole('link', { name: /Claude is working/ }).getAttribute('href'))!
          .split('/')
          .at(-1)!;
        const report = async (hook_event_name: string) => {
          const res = await fetch(hook.url, {
            method: 'POST',
            headers: { authorization: hook.headers.Authorization, 'content-type': 'application/json' },
            body: JSON.stringify({ session_id: session, hook_event_name }),
          });
          expect(res.status).toBe(204);
        };
        await report('Stop');
        await expect(itemRow(page, asked).getByRole('link', { name: `${asking} · Claude is waiting on you ↗` })).toBeVisible();
        // The dock's total, not the tile's own count, which is read out the same way.
        if (!isMobile) await expect(page.getByRole('toolbar', { name: 'Agents' }).getByRole('status')).toHaveText('1 waiting on you');
        await report('UserPromptSubmit');
        await expect(itemRow(page, asked).getByRole('link', { name: `${asking} · Claude is working ↗` })).toBeVisible();
        await expect(page.getByText(/waiting on you/)).toHaveCount(0);
      }

      // The dashboard filter's Agent running toggle shows this row, and lets it
      // go the moment the run is over, until × clears it.
      await press(page.getByRole('button', { name: 'Filter this dashboard' }), isMobile);
      await press(page.getByRole('button', { name: 'Agent running' }), isMobile);
      // A phone's filter is a sheet over the page, which hides the rows from a role query until it is closed.
      if (isMobile) await closeTheFilterSheet(page);
      await expect(itemRow(page, asked)).toBeVisible();

      // Agent finished: Still to do - the chip goes, and the row stays unless filtered.
      await press(itemRow(page, asked).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Agent finished: Still to do' }), isMobile);
      await expect(itemRow(page, asked)).toHaveCount(0);
      await press(page.getByRole('button', { name: 'Clear the filter', exact: true }), isMobile);
      await expect(itemRow(page, asked).getByText(/Claude is working/)).toHaveCount(0);
      await expect(itemRow(page, asked)).toBeVisible();
      // The bar stays open after ×, so the funnel closes it; a phone's summary went with the ×.
      if (!isMobile) await press(page.getByRole('button', { name: 'Clear the filter and close it' }), isMobile);

      await expectNoSidewaysScroll(page);
      if (!isMobile) {
        const dock = page.getByRole('toolbar', { name: 'Agents' });
        await dock.getByRole('button', { name: agent }).click({ button: 'right' });
        await press(page.getByRole('menuitem', { name: 'Delete…' }), isMobile);
        await press(page.getByRole('button', { name: `Yes, delete ${agent}` }), isMobile);
      }
      const unmade = await page.request.post('/v1/commands/delete_agent', {
        data: {
          commandId: randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId: ACCOUNT_WIDE,
          agentId: askingId,
        },
      });
      expect(unmade.status()).toBe(200);
      if (!isMobile) {
        await openSettings(page, 'Agent settings', isMobile);
        // The form says when the hooks above last arrived.
        await chooseRowAction(page, 'Claude Code', 'Edit…', isMobile);
        await expect(page.getByText(/^A hook last arrived /)).toBeVisible();
        await press(page.getByRole('button', { name: 'Cancel' }), isMobile);
        await chooseRowAction(page, 'Claude Code', 'Disconnect', isMobile);
        await press(page.getByRole('button', { name: 'Yes, disconnect Claude Code' }), isMobile);
        await closeSettings(page, isMobile);
      }
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
});
