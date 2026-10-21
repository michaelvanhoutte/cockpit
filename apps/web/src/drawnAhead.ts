import type { Item, WorkspaceSnapshot } from '@cockpit/shared';
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
 * **Only what an Item row, a Panel or the form shows.** What a change also does
 * on the server - ending an Item's open run, withdrawing a proposal, recording
 * where it was filed - arrives with the next read.
 *
 * **A filing is the order it carries, written over the Panel's.** An order is the
 * Panel's whole arrangement afterwards, so drawing it is replacing the Panel's
 * filings with it; what a move takes the Item off is the Panels it names, else
 * every one.
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
    default:
      return snapshot;
  }
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
