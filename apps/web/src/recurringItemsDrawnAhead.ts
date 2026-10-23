import type { CommandPayload, RecurringItem, RecurringItemList } from '@cockpit/shared';
import type { Drawn } from './drawnAhead';

/**
 * What the Recurring items modal shows of a change the server has not answered
 * yet, or has answered and no read of the list has landed since ("Make, change
 * and delete recurring items from the Recurring items modal", issue 1449).
 *
 * **The list as the server sent it, with the change applied to a copy**, as
 * `connectionsDrawnAhead.ts` does for connections: the held list is never written
 * to, so a read in flight cannot flip the screen back. It lives in the modal's
 * own chunk, since nothing else draws a recurring item.
 *
 * - **Made:** a row, once - a read that already holds it is not drawn twice.
 * - **Written:** the row, whole, as the form sent it.
 * - **Deleted:** the row is gone.
 *
 * Only the recurring items of the Workspace the change names are touched. **What
 * the server decides is not predicted**: a *Next on* or a Panel it refuses is
 * drawn all the same until the refusal puts the row back.
 */

type Content = CommandPayload<'create_recurring_item'>;

/** A recurring item as the server will read it back after this command. */
const itemOf = (made: Content): RecurringItem => ({
  id: made.seriesId,
  workspaceId: made.workspaceId,
  title: made.title,
  description: made.description,
  priority: made.priority,
  panelIds: made.panelIds,
  frequency: made.repeat.frequency,
  nextOn: made.repeat.nextOn,
  dueAfterDays: made.repeat.dueAfterDays,
});

export function recurringItemsDrawnOver(
  workspaceId: string,
): (list: RecurringItemList, changes: readonly Drawn[]) => RecurringItemList {
  return (list, changes) =>
    changes.reduce<RecurringItemList>((held, change) => {
      switch (change.name) {
        case 'create_recurring_item':
          return change.payload.workspaceId !== workspaceId || held.recurringItems.some((one) => one.id === change.payload.seriesId)
            ? held
            : { recurringItems: [...held.recurringItems, itemOf(change.payload)] };
        case 'write_recurring_item':
          return change.payload.workspaceId !== workspaceId
            ? held
            : { recurringItems: held.recurringItems.map((one) => (one.id === change.payload.seriesId ? itemOf(change.payload) : one)) };
        case 'delete_recurring_item':
          return change.payload.workspaceId !== workspaceId
            ? held
            : { recurringItems: held.recurringItems.filter((one) => one.id !== change.payload.seriesId) };
        default:
          return held;
      }
    }, list);
}
