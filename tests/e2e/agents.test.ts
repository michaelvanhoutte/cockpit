import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ACCOUNT_WIDE, AGENT_COLORS } from '@cockpit/shared';
import type { Page } from '@playwright/test';
import { isLinkedWorktree, portsFor } from '../../scripts/lib/ports.mjs';
import {
  capture,
  captureBox,
  chooseRowAction,
  dashboardBar,
  deleteWorkspace,
  expect,
  closeTheFilterSheet,
  expectNoSidewaysScroll,
  fileOnto,
  inbox,
  itemRow,
  makeWorkspace,
  openFirstWorkspace,
  openSettings,
  closeSettings,
  pastCapture,
  press,
  switchTo,
  test,
  uniqueTitle,
  workspaceTab,
} from './support/app';

const root = resolve(__dirname, '..', '..');

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
/** The stub the stack runs, which stands in for Claude Code's routines as well as for sign-in. */
const issuer = `http://127.0.0.1:${portsFor(root, { linked: isLinkedWorktree(root), env: process.env }).e2eIssuer}`;

/** A minimal, valid 1x1 PNG, for the file an agent is sent a link to. */
const A_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** Where the stub stands in for a Claude Code routine, and the token it is fired with. */
const ROUTINE = { routineUrl: `${issuer}/v1/claude_code/routines/trig_e2e/fire`, token: 'e2e-token' };

/**
 * Signs in, makes a workspace of this walk's own and connects it to Claude
 * Code through the API, answering its name. Deleting the workspace puts the
 * connection back with it, for the reason connections.test.ts records.
 */
async function aWorkspaceConnectedToClaude(page: Page, isMobile: boolean): Promise<string> {
  await openFirstWorkspace(page, isMobile);
  const workspace = uniqueTitle('With Claude');
  await makeWorkspace(page, workspace, isMobile);
  await switchTo(page, workspace, isMobile);
  const workspaceId = (await workspaceTab(page, workspace).getAttribute('href'))!.split('/').at(-1)!;
  const connected = await page.request.post(`/v1/workspaces/${workspaceId}/connections/claude-code/connect`, {
    data: ROUTINE,
  });
  expect(connected.status()).toBe(200);
  return workspace;
}

/**
 * An agent that asks what to ask before it starts, made through the API since a
 * phone has no dock to make one in. Account-wide, so every walk deletes its own.
 */
async function anAgentThatAsks(page: Page): Promise<{ id: string; name: string }> {
  const agent = { id: randomUUID(), name: uniqueTitle('Ask about it') };
  const made = await page.request.post('/v1/commands/create_agent', {
    data: {
      commandId: randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: ACCOUNT_WIDE,
      agentId: agent.id,
      name: agent.name,
      color: AGENT_COLORS[0],
      engine: 'claude-code',
      message: '{prompt}\n\nAbout: {title}\n\n{description}\n\n{link}',
      asksForPrompt: true,
      startsInProgress: false,
    },
  });
  expect(made.status()).toBe(200);
  return agent;
}

async function deleteTheAgent(page: Page, agentId: string): Promise<void> {
  const unmade = await page.request.post('/v1/commands/delete_agent', {
    data: { commandId: randomUUID(), issuedAt: new Date().toISOString(), workspaceId: ACCOUNT_WIDE, agentId },
  });
  expect(unmade.status()).toBe(200);
}

/**
 * Captures an item and files it on Panel 1, leaving the dashboard showing it -
 * a phone's Inbox and dashboard are screens of their own. With a file, which
 * the session it starts is sent a link to ("Send an item's attachments along
 * when an agent starts", issue 573).
 */
async function anItemOnPanel1(
  page: Page,
  title: string,
  isMobile: boolean,
  { withAFile = false }: { withAFile?: boolean } = {},
): Promise<void> {
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
  await capture(page, title, isMobile);
  if (withAFile) {
    await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
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
  }
  await fileOnto(page, title, 'Panel 1', isMobile);
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Dashboard 1' }), isMobile);
}

/** Starts an agent from the row's own menu, the way a keyboard does and a phone must. */
async function startFromTheRowMenu(page: Page, title: string, agentName: string, isMobile: boolean): Promise<void> {
  await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
  await press(page.getByRole('menuitem', { name: `${agentName}…` }), isMobile);
}

/** Answers the agent's question about the item, and waits for the run to show on its row. */
async function sendTheQuestion(
  page: Page,
  title: string,
  agentName: string,
  question: string,
  isMobile: boolean,
): Promise<void> {
  const box = page.getByRole('dialog', { name: `About “${title}”` });
  await expect(box).toBeVisible();
  await box.getByLabel('What to ask Claude').fill(question);
  await press(box.getByRole('button', { name: 'Send to Claude' }), isMobile);
  await expect(itemRow(page, title).getByRole('link', { name: `${agentName} · Claude is working ↗` })).toBeVisible();
}

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
    test('outlines the rows that take it, scrolls to the one it is dropped on, and starts Claude there', async ({
      page,
      isMobile,
    }) => {
      // A phone has no dock and no drag.
      test.skip(isMobile, 'a phone has no dock to drag from');
      const workspace = await aWorkspaceConnectedToClaude(page, isMobile);
      const asked = uniqueTitle('Chase the invoice');
      await anItemOnPanel1(page, asked, isMobile);

      const agent = uniqueTitle('Scope it');
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
      for (const name of [uniqueTitle('B'), uniqueTitle('C'), uniqueTitle('D'), uniqueTitle('E'), far]) {
        await press(page.getByRole('button', { name: '+ Panel' }), isMobile);
        await page.getByLabel('Name of the new panel').fill(name);
        await page.getByLabel('Name of the new panel').press('Enter');
        await expect(page.getByRole('region', { name })).toBeAttached();
      }
      const deep = uniqueTitle('Scope the rollout');
      await capture(page, deep, isMobile);
      // Filed before the window is made short: in a short one the undo bar the
      // filing above left sits over the Move dialog's last panels.
      await fileOnto(page, deep, far, isMobile);
      await page.setViewportSize({ width: 1280, height: 560 });
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
      const over = await page.locator('[data-drag-scroll="dashboard"]').boundingBox();
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
      // A second, short move inside the row: the drag's last event on the way
      // in can be a leave from where it came, which the next over undoes.
      await page.mouse.move(at.x + at.width - 40, at.y + at.height / 2 + 3, { steps: 2 });
      // Only the row under the pointer is lit; every other row that takes it is merely tinted.
      await expect(farRow).toHaveAttribute('data-agent-target', '');
      await expect(itemRow(page, asked)).not.toHaveAttribute('data-agent-target', '');
      await page.mouse.up();

      const chip = farRow.getByRole('link', { name: `${agent} · Claude is working ↗` });
      await expect(chip).toHaveAttribute('href', /\/claude-code\/session\/session_stub_/);
      await expect(itemRow(page, unfiled).getByText(/Claude/)).toHaveCount(0);

      // The row's menu offers the session and no separate Agent finished.
      await press(farRow.getByRole('button', { name: 'Item actions' }), isMobile);
      await expect(page.getByRole('menuitem', { name: 'Open the Claude session ↗' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /Agent finished/ })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // ✓ is the only control: the Item is done, so it leaves the panel with
      // its chip, and Undo brings the row back with the chip and session link.
      await farRow.hover();
      await farRow.getByRole('button', { name: 'Mark done' }).click();
      await expect(farRow).toHaveCount(0);
      await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('href', /\/claude-code\/session\/session_stub_/);

      await page.setViewportSize({ width: 1280, height: 720 });
      await expectNoSidewaysScroll(page);
      await dock.getByRole('button', { name: agent }).click({ button: 'right' });
      await press(page.getByRole('menuitem', { name: 'Delete…' }), isMobile);
      await press(page.getByRole('button', { name: `Yes, delete ${agent}` }), isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });

    test('asks what to ask before it starts, and sends the item’s file along', async ({ page, isMobile }) => {
      const workspace = await aWorkspaceConnectedToClaude(page, isMobile);
      const asking = await anAgentThatAsks(page);
      const asked = uniqueTitle('Chase the invoice');
      await anItemOnPanel1(page, asked, isMobile, { withAFile: true });
      // Dropped from the dock at a desk; a phone has no dock, so it starts from
      // the row's own menu, the way a keyboard does.
      if (isMobile) {
        await startFromTheRowMenu(page, asked, asking.name, isMobile);
      } else {
        await page.getByRole('toolbar', { name: 'Agents' }).getByText(asking.name, { exact: true }).dragTo(itemRow(page, asked));
      }
      await sendTheQuestion(page, asked, asking.name, 'Who do we chase first?', isMobile);

      const fired = (await (await fetch(`${issuer}/claude-code/fired`)).json()) as { text: string }[];
      const sent = fired.find((one) => one.text.includes('Who do we chase first?') && one.text.includes(asked));
      expect(sent).toBeDefined();
      // Its file's link opens without the browser's sign-in: this is Node's own fetch.
      const link = sent!.text.match(/- invoice\.png: (\S+)/)?.[1];
      expect(link, 'the message links the item’s file').toBeDefined();
      const opened = await fetch(link!);
      expect(opened.status).toBe(200);
      expect(Buffer.from(await opened.arrayBuffer()).equals(A_PNG)).toBe(true);

      await deleteTheAgent(page, asking.id);
      await deleteWorkspace(page, workspace, isMobile);
    });

    test('says on the row when Claude is waiting on you, from the session’s own hooks', async ({
      page,
      isMobile,
    }) => {
      // The hooks are posted exactly as the connection's form tells the
      // repository to post them ("See on the item when Claude is waiting on
      // you", issue 572), and the form is in Settings, which a phone does not have.
      test.skip(isMobile, 'a phone has no Settings');
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle('With Claude');
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      // Connected through the form, the way a person at a desk does.
      const settings = await openSettings(page, 'Agent settings', isMobile);
      await press(settings.getByRole('button', { name: 'Connect Claude Code' }), isMobile);
      await page.getByLabel('Routine trigger URL').fill(ROUTINE.routineUrl);
      await page.getByLabel('Routine token').fill(ROUTINE.token);
      await press(page.getByRole('button', { name: 'Connect', exact: true }), isMobile);
      await expect(settings.getByText(/last worked/)).toBeVisible();
      await chooseRowAction(page, 'Claude Code', 'Edit…', isMobile);
      const snippet = page.getByLabel('Hooks for .claude/settings.json');
      await expect(page.getByText('No hook has arrived yet.')).toBeVisible();
      const hook = JSON.parse((await snippet.textContent())!).hooks.Stop[0].hooks[0] as {
        url: string;
        headers: { Authorization: string };
      };
      await press(page.getByRole('button', { name: 'Cancel' }), isMobile);
      await closeSettings(page, isMobile);

      const asking = await anAgentThatAsks(page);
      const asked = uniqueTitle('Chase the invoice');
      await anItemOnPanel1(page, asked, isMobile);
      await startFromTheRowMenu(page, asked, asking.name, isMobile);
      await sendTheQuestion(page, asked, asking.name, 'Who do we chase first?', isMobile);
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
      await expect(itemRow(page, asked).getByRole('link', { name: `${asking.name} · Claude is waiting on you ↗` })).toBeVisible();
      // The dock's total, not the tile's own count, which is read out the same way.
      await expect(page.getByRole('toolbar', { name: 'Agents' }).getByRole('status')).toHaveText('1 waiting on you');
      await report('UserPromptSubmit');
      await expect(itemRow(page, asked).getByRole('link', { name: `${asking.name} · Claude is working ↗` })).toBeVisible();
      await expect(page.getByText(/waiting on you/)).toHaveCount(0);

      // The form says when the hooks above last arrived, and disconnects.
      await openSettings(page, 'Agent settings', isMobile);
      await chooseRowAction(page, 'Claude Code', 'Edit…', isMobile);
      await expect(page.getByText(/^A hook last arrived /)).toBeVisible();
      await press(page.getByRole('button', { name: 'Cancel' }), isMobile);
      await chooseRowAction(page, 'Claude Code', 'Disconnect', isMobile);
      await press(page.getByRole('button', { name: 'Yes, disconnect Claude Code' }), isMobile);
      await closeSettings(page, isMobile);
      await deleteTheAgent(page, asking.id);
      await deleteWorkspace(page, workspace, isMobile);
    });

    test('is found by the Agent running filter until a status of To do ends its run', async ({
      page,
      isMobile,
    }) => {
      const workspace = await aWorkspaceConnectedToClaude(page, isMobile);
      const asking = await anAgentThatAsks(page);
      const asked = uniqueTitle('Chase the invoice');
      await anItemOnPanel1(page, asked, isMobile);
      await startFromTheRowMenu(page, asked, asking.name, isMobile);
      await sendTheQuestion(page, asked, asking.name, 'Who do we chase first?', isMobile);

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
      await expect(itemRow(page, asked).getByRole('link', { name: /Claude is working/ })).toBeVisible();
      await press(itemRow(page, asked).getByRole('button', { name: 'Item actions' }), isMobile);
      await chooseStatus(page, 'To do', isMobile);
      await expect(itemRow(page, asked)).toHaveCount(0);
      await press(page.getByRole('button', { name: 'Clear the filter', exact: true }), isMobile);
      await expect(itemRow(page, asked).getByText(/Claude is working/)).toHaveCount(0);
      await expect(itemRow(page, asked)).toBeVisible();
      // The bar stays open after ×, so the funnel closes it; a phone's summary went with the ×.
      if (!isMobile) await press(page.getByRole('button', { name: 'Clear the filter and close it' }), isMobile);
      await expectNoSidewaysScroll(page);

      await deleteTheAgent(page, asking.id);
      await deleteWorkspace(page, workspace, isMobile);
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
