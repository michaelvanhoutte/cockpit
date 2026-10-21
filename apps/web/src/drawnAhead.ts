import { FIRST_PANEL_NAME, type Dashboard, type Item, type WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from './api/queries';

/**
 * What the screen shows of a change the server has not answered yet ("Show an
 * Item or filing change the moment you make it", issue 1329).
 *
 * **The Workspace as the server sent it, with the change applied to a copy.**
 * The copy the tab holds, and the one it saves on the device, are never
 * written to: a read in flight would overwrite the change, and the device
 * would keep it unconfirmed. `changeQueue.ts` decides which changes are still
 * to be drawn; this decides what each one draws.
 *
 * **Only what an Item row, a Panel, the form or the Dashboard bar shows.** What a change also does
 * on the server - ending an Item's open run, withdrawing a proposal, recording
 * where it was filed - arrives with the next read.
 *
 * **A filing is the order it carries, written over the Panel's.** An order is the
 * Panel's whole arrangement afterwards, so drawing it is replacing the Panel's
 * filings with it; what a move takes the Item off is the Panels it names, else
 * every one.
 *
 * **A Dashboard change is drawn as the server will make it** ("Show a Dashboard
 * change the moment you make it", issue 1362): a new one at the end of the bar
 * with the Panel it arrives with, a deleted one gone with its Panels, Layout and
 * filings, and a rename the name rule would refuse drawn all the same until the
 * refusal puts the old name back.
 */
export function drawnAhead(snapshot: WorkspaceSnapshot, change: CommandArgs): WorkspaceSnapshot {
  switch (change.name) {
    case 'set_done':
      return withItem(snapshot, change.payload.itemId, {
        completedAt: change.payload.done ? change.payload.issuedAt : null,
      });
    case 'set_started':
      return withItem(snapshot, change.payload.itemId, {
        startedAt: change.payload.started ? change.payload.issuedAt : null,
      });
    case 'set_priority':
      return withItem(snapshot, change.payload.itemId, { priority: change.payload.priority });
    case 'set_due_date':
      return withItem(snapshot, change.payload.itemId, { dueDate: change.payload.dueDate });
    case 'set_title':
      return withItem(snapshot, change.payload.itemId, { title: change.payload.title });
    case 'set_description':
      return withItem(snapshot, change.payload.itemId, { description: change.payload.description });
    case 'set_next_action':
      return withItem(snapshot, change.payload.itemId, { nextAction: change.payload.nextAction });
    case 'set_dismissed':
      // The Workspace read holds open Items only, so a dismissed Item is simply absent.
      // Undoing one has no copy to draw it from and waits for the next read.
      return change.payload.dismissed
        ? { ...snapshot, items: snapshot.items.filter((item) => item.id !== change.payload.itemId) }
        : snapshot;
    case 'move_item_to_panel':
      return filedAhead(snapshot, change.payload, 'move');
    case 'add_item_to_panel':
      return filedAhead(snapshot, change.payload, 'add');
    case 'remove_item_from_panel':
      if (change.payload.workspaceId !== snapshot.workspace.id) return snapshot;
      return {
        ...snapshot,
        filings: snapshot.filings.filter(
          (filing) => !(filing.itemId === change.payload.itemId && filing.panelId === change.payload.panelId),
        ),
      };
    case 'add_dashboard':
      return dashboardAdded(snapshot, change.payload);
    case 'rename_dashboard':
      return onDashboards(snapshot, change.payload.workspaceId, (dashboards) =>
        dashboards.map((one) => (one.id === change.payload.dashboardId ? { ...one, name: change.payload.name } : one)),
      );
    case 'delete_dashboard':
      return dashboardDeleted(snapshot, change.payload);
    case 'reorder_dashboards':
      return onDashboards(snapshot, change.payload.workspaceId, (dashboards) => [
        ...change.payload.dashboardIds.flatMap((id) => dashboards.filter((one) => one.id === id)),
        // One the order never named, arrived since it was drawn: kept on the end rather than taken off the bar.
        ...dashboards.filter((one) => !change.payload.dashboardIds.includes(one.id)),
      ]);
    default:
      return snapshot;
  }
}

/** The Workspace's Dashboards rewritten, in the Workspace the change names and no other. */
function onDashboards(
  snapshot: WorkspaceSnapshot,
  workspaceId: string,
  rewrite: (dashboards: Dashboard[]) => Dashboard[],
): WorkspaceSnapshot {
  if (workspaceId !== snapshot.workspace.id) return snapshot;
  return { ...snapshot, dashboards: rewrite(snapshot.dashboards) };
}

/** A Dashboard at the end of the bar, with the one Panel of items every Dashboard arrives with. */
function dashboardAdded(
  snapshot: WorkspaceSnapshot,
  added: { workspaceId: string; dashboardId: string; panelId: string; name: string },
): WorkspaceSnapshot {
  if (added.workspaceId !== snapshot.workspace.id) return snapshot;
  if (snapshot.dashboards.some((one) => one.id === added.dashboardId)) return snapshot;
  const { tenantId } = snapshot.workspace;
  return {
    ...snapshot,
    dashboards: [...snapshot.dashboards, { id: added.dashboardId, tenantId, workspaceId: added.workspaceId, name: added.name }],
    panels: [
      ...snapshot.panels,
      {
        id: added.panelId,
        tenantId,
        dashboardId: added.dashboardId,
        name: FIRST_PANEL_NAME,
        kind: 'items',
        format: 'plain',
        body: '',
        readOnly: false,
        neverPropose: false,
        filter: null,
        sort: null,
        columns: null,
      },
    ],
  };
}

/**
 * A Dashboard gone, and its Panels, Layout and filings with it. **Not the last
 * one**: a Workspace without a Dashboard has no view, so the server refuses that
 * delete and nothing is drawn for it.
 */
function dashboardDeleted(
  snapshot: WorkspaceSnapshot,
  deleted: { workspaceId: string; dashboardId: string },
): WorkspaceSnapshot {
  if (deleted.workspaceId !== snapshot.workspace.id) return snapshot;
  if (snapshot.dashboards.length < 2 || !snapshot.dashboards.some((one) => one.id === deleted.dashboardId)) return snapshot;
  const gone = new Set(snapshot.panels.filter((panel) => panel.dashboardId === deleted.dashboardId).map((panel) => panel.id));
  return {
    ...snapshot,
    dashboards: snapshot.dashboards.filter((one) => one.id !== deleted.dashboardId),
    panels: snapshot.panels.filter((panel) => !gone.has(panel.id)),
    layouts: snapshot.layouts.filter((layout) => layout.dashboardId !== deleted.dashboardId),
    filings: snapshot.filings.filter((filing) => !gone.has(filing.panelId)),
  };
}

/**
 * An Item filed on a Panel, or - with no Panel - back in the Inbox.
 *
 * **Only in the Workspace the filing names**: an Item that belongs to none is
 * drawn in every Workspace's Inbox, and the others catch up with the read.
 */
function filedAhead(
  snapshot: WorkspaceSnapshot,
  filing: { workspaceId: string; itemId: string; panelId: string | null; order: string[]; fromPanelIds?: string[] | undefined },
  how: 'move' | 'add',
): WorkspaceSnapshot {
  if (filing.workspaceId !== snapshot.workspace.id) return snapshot;
  const item = snapshot.items.find((one) => one.id === filing.itemId);
  if (!item) return snapshot;
  const named = filing.panelId === null ? [] : (filing.fromPanelIds ?? []);
  const takenOff = (panelId: string) => how === 'move' && (named.length === 0 || named.includes(panelId));
  const kept = snapshot.filings.filter(
    (held) =>
      !(held.itemId === filing.itemId && takenOff(held.panelId)) && (filing.panelId === null || held.panelId !== filing.panelId),
  );
  const landed =
    filing.panelId === null
      ? []
      : filing.order.map((itemId, position) => ({ panelId: filing.panelId!, itemId, position }));
  const filed = { ...snapshot, filings: [...kept, ...landed] };
  // Filing is what settles which Workspace an Item belongs to.
  return item.workspaceDecided === false
    ? withItem(filed, item.id, { workspaceDecided: true, workspaceId: filing.workspaceId })
    : filed;
}

/** The changes `drawnAhead` draws something for, which are the ones kept drawn after their answer until a read covers them. */
export const DRAWN_AHEAD: ReadonlySet<CommandArgs['name']> = new Set([
  'move_item_to_panel',
  'add_item_to_panel',
  'remove_item_from_panel',
  'set_done',
  'set_started',
  'set_priority',
  'set_due_date',
  'set_title',
  'set_description',
  'set_next_action',
  'set_dismissed',
  'add_dashboard',
  'rename_dashboard',
  'delete_dashboard',
  'reorder_dashboards',
]);

/** The changes in the order they were made, each drawn over the one before. */
export function drawnOver(snapshot: WorkspaceSnapshot, changes: readonly CommandArgs[]): WorkspaceSnapshot {
  return changes.reduce(drawnAhead, snapshot);
}

function withItem(snapshot: WorkspaceSnapshot, itemId: string, fields: Partial<Item>): WorkspaceSnapshot {
  if (!snapshot.items.some((item) => item.id === itemId)) return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.map((item) => (item.id === itemId ? { ...item, ...fields } : item)),
  };
}
