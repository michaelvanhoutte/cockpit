import { randomUUID } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

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

/**
 * Items captured into the workspace the page is on, one after the other so the
 * Inbox shows them in the order given. Returns their ids.
 */
export async function giveToTheInbox(page: Page, titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const message of titles) {
    const itemId = randomUUID();
    await arrange(page, 'capture_item', { itemId, message });
    ids.push(itemId);
  }
  return ids;
}

/**
 * A dashboard of this name with a panel for each name given, in that order -
 * after the one every dashboard arrives with, as one made from the bar has.
 */
export async function giveADashboard(page: Page, name: string, panelNames: string[] = []): Promise<ArrangedDashboard> {
  const dashboard: ArrangedDashboard = { id: randomUUID(), name, panels: [] };
  await arrange(page, 'add_dashboard', { dashboardId: dashboard.id, panelId: randomUUID(), name });
  for (const panelName of panelNames) {
    const panel: ArrangedPanel = { id: randomUUID(), name: panelName, itemIds: [] };
    await arrange(page, 'add_panel', { dashboardId: dashboard.id, panelId: panel.id, name: panelName });
    dashboard.panels.push(panel);
  }
  return dashboard;
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
