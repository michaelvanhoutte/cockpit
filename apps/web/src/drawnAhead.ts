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
 * **Only the fields an Item row or its form shows.** What a change also does on
 * the server - ending an Item's open run, settling its Workspace, withdrawing a
 * proposal - arrives with the next read.
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
    default:
      return snapshot;
  }
}

/** The changes `drawnAhead` draws something for, which are the ones kept drawn after their answer until a read covers them. */
export const DRAWN_AHEAD: ReadonlySet<CommandArgs['name']> = new Set([
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
