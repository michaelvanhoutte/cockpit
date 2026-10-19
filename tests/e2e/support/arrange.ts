import { randomUUID } from 'node:crypto';

import { expect, type Page } from '@playwright/test';
import type { PanelKind } from '@cockpit/shared';

/**
 * Arrangement for the F3 walks: the state a walk needs, put there through the
 * commands API as the person the page is signed in as, so that the walk spends
 * its time on the behaviour its title names rather than on reaching it.
 *
 * **These send what the browser itself sends**, to the same routes, and
 * `page.request` carries the page's cookies, so the rows belong to the
 * workspace the page is on and to nobody else. Each command is sent once, with
 * an id of its own: whether a repeat is applied twice is the API's concern,
 * held at its own level.
 *
 * **Arrange, then open the page.** A page opened afterwards reads the rows; one
 * already open learns of them only through the live-updates stream, which is
 * that area's own concern - so a walk reloads after arranging.
 *
 * **Not for Capture's own walks**, which capture through the UI because that is
 * what they prove (`scripts/lib/e2e-conventions.mjs`).
 */

/** A panel given to a dashboard, and the items it holds, top to bottom. */
export type ArrangedPanel = { id: string; name: string; itemIds: string[] };

/** A dashboard given to the workspace, with the panels it was given. */
export type ArrangedDashboard = { id: string; name: string; panels: ArrangedPanel[] };

/** A panel to give: its name, or its name and what it holds. */
export type PanelToGive = string | { name: string; kind: PanelKind };

/** The workspace the page is on, read off its address (`/w/<workspace>/...`). */
function workspaceOf(page: Page): string {
  const found = new URL(page.url()).pathname.match(/^\/w\/([^/]+)/);
  if (!found) throw new Error(`arrange from a page that is in a workspace, not at ${page.url()}`);
  return found[1]!;
}

/** One command, sent once with a fresh id, failing the walk by name if the API refuses it. */
export async function arrange(page: Page, command: string, data: Record<string, unknown>): Promise<void> {
  const sent = await page.request.post(`/v1/commands/${command}`, {
    data: { commandId: randomUUID(), issuedAt: new Date().toISOString(), workspaceId: workspaceOf(page), ...data },
  });
  expect(sent.ok(), `${command} from outside failed: ${sent.status()} ${await sent.text()}`).toBe(true);
}

/** A workspace given to the account: the id the commands name it by, and its name. */
export type ArrangedWorkspace = { id: string; name: string };

/**
 * A workspace of this name, after the ones the account has, with the dashboard
 * and panel every workspace arrives with. The page stays where it was: reload,
 * then `switchTo` it.
 */
export async function giveAWorkspace(page: Page, name: string): Promise<ArrangedWorkspace> {
  const workspace: ArrangedWorkspace = { id: randomUUID(), name };
  await arrange(page, 'create_workspace', { workspaceId: workspace.id, panelId: randomUUID(), name });
  return workspace;
}

/**
 * Items captured into the workspace the page is on - or the one given - one
 * after the other so the Inbox shows them in the order given. Returns their ids.
 */
export async function giveToTheInbox(
  page: Page,
  titles: string[],
  workspace: ArrangedWorkspace | undefined = undefined,
): Promise<string[]> {
  const ids: string[] = [];
  for (const message of titles) {
    const itemId = randomUUID();
    await arrange(page, 'capture_item', { itemId, message, ...(workspace && { workspaceId: workspace.id }) });
    ids.push(itemId);
  }
  return ids;
}

/**
 * A dashboard of this name with a panel for each name given, in that order -
 * after the one every dashboard arrives with, as one made from the bar has.
 */
export async function giveADashboard(page: Page, name: string, panelNames: string[] = []): Promise<ArrangedDashboard> {
  const { dashboard } = await addDashboard(page, name);
  for (const panelName of panelNames) await giveAPanel(page, dashboard, panelName);
  return dashboard;
}

/**
 * A dashboard of this name holding only the panels given, **with the one it
 * arrives with taken back off** - for a walk whose expectations are about the
 * panels it puts there itself, where a `Panel 1` at their head would be in the
 * way of every one. That a dashboard arrives with a panel at all is walked in
 * dashboards.test.ts.
 */
export async function giveAnEmptyDashboard(
  page: Page,
  name: string,
  panels: PanelToGive[] = [],
): Promise<ArrangedDashboard> {
  const { dashboard, arrivedWith } = await addDashboard(page, name);
  await arrange(page, 'delete_panel', { panelId: arrivedWith });
  for (const panel of panels) {
    if (typeof panel === 'string') await giveAPanel(page, dashboard, panel);
    else await giveAPanel(page, dashboard, panel.name, panel.kind);
  }
  return dashboard;
}

/** One more panel on a dashboard, of the kind given (items unless said), after the ones it has. */
export async function giveAPanel(
  page: Page,
  dashboard: ArrangedDashboard,
  name: string,
  kind: PanelKind = 'items',
): Promise<ArrangedPanel> {
  const panel: ArrangedPanel = { id: randomUUID(), name, itemIds: [] };
  await arrange(page, 'add_panel', { dashboardId: dashboard.id, panelId: panel.id, name, kind });
  dashboard.panels.push(panel);
  return panel;
}

async function addDashboard(
  page: Page,
  name: string,
): Promise<{ dashboard: ArrangedDashboard; arrivedWith: string }> {
  const dashboard: ArrangedDashboard = { id: randomUUID(), name, panels: [] };
  const arrivedWith = randomUUID();
  await arrange(page, 'add_dashboard', { dashboardId: dashboard.id, panelId: arrivedWith, name });
  return { dashboard, arrivedWith };
}

/**
 * Items captured and filed onto a panel, below any it already holds, in the
 * order given. The panel remembers its order, because each filing names the
 * whole order of the panel it lands on.
 */
export async function giveToAPanel(page: Page, panel: ArrangedPanel, titles: string[]): Promise<void> {
  for (const itemId of await giveToTheInbox(page, titles)) {
    panel.itemIds.push(itemId);
    await arrange(page, 'add_item_to_panel', { itemId, panelId: panel.id, order: [...panel.itemIds] });
  }
}
