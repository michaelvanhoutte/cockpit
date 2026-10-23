import { z } from 'zod';
import { commandEnvelopeSchema } from './commands.js';
import { captureTimeZoneSchema, itemDescriptionSchema, itemTitleSchema, prioritySchema } from './domain/item.js';
import { repeatRuleSchema } from './domain/series.js';

export { RECURRING_REFUSALS } from './recurring-refusals.js';

/**
 * Recurring items as the Recurring items modal reads and writes them ("Make,
 * change and delete recurring items from the Recurring items modal", issue
 * 1449). **Reached as `@cockpit/shared/recurring-items`, and left out of the
 * package's index** (the types only are re-exported): everything the index
 * reaches is in the initial bundle, and the modal and the Worker are the only
 * readers of any of this (`bundle:budget`).
 */

/**
 * A recurring item as the Recurring items modal reads it ("Make, change and
 * delete recurring items from the Recurring items modal", issue 1449): a running
 * series with what each copy is made from. `description` is empty where it has
 * none, and `panelIds` are the Panels each copy is filed on that are still live
 * in its Workspace, top first - none is the Inbox.
 */
export const recurringItemSchema = repeatRuleSchema.extend({
  id: z.uuid(),
  workspaceId: z.string(),
  title: z.string(),
  description: z.string(),
  priority: prioritySchema.nullable(),
  panelIds: z.array(z.uuid()),
});
export type RecurringItem = z.infer<typeof recurringItemSchema>;

/** The Workspace's recurring items, soonest *Next on* first. */
export const recurringItemListSchema = z.object({ recurringItems: z.array(recurringItemSchema) });
export type RecurringItemList = z.infer<typeof recurringItemListSchema>;

/** What a recurring item is made, or written whole, from: the same in both commands. */
export const recurringItemContentSchema = z.object({
  title: itemTitleSchema.refine((title) => title.length > 0, { message: 'A recurring item needs a title' }),
  description: itemDescriptionSchema,
  priority: prioritySchema.nullable(),
  panelIds: z.array(z.uuid()).max(50),
  repeat: repeatRuleSchema.extend({ timeZone: captureTimeZoneSchema }),
});

/**
 * create_recurring_item / write_recurring_item / delete_recurring_item - a
 * recurring item made, written whole and deleted from the Recurring items modal.
 * **`seriesId` is the recurring item's id**, made up by the tab so it is drawn
 * before the server answers; `workspaceId` is the Workspace it belongs to, which
 * a write never moves. **A write is the whole of it**: its texts, priority, the
 * Panels each copy is filed on and its rule, the later of two tabs' winning. A
 * *Next on* before today on `repeat.timeZone`'s calendar, or a Panel that is not
 * live in the Workspace, is refused with its reason (`RECURRING_REFUSALS`).
 * Deleting is the stop a series already has: its copies keep naming it and no
 * more are made.
 */
export const createRecurringItemSchema = commandEnvelopeSchema.extend({
  seriesId: z.uuid(),
  ...recurringItemContentSchema.shape,
});
export type CreateRecurringItemCommand = z.infer<typeof createRecurringItemSchema>;

export const writeRecurringItemSchema = commandEnvelopeSchema.extend({
  seriesId: z.uuid(),
  ...recurringItemContentSchema.shape,
});
export type WriteRecurringItemCommand = z.infer<typeof writeRecurringItemSchema>;

export const deleteRecurringItemSchema = commandEnvelopeSchema.extend({
  seriesId: z.uuid(),
});
export type DeleteRecurringItemCommand = z.infer<typeof deleteRecurringItemSchema>;

/**
 * The commands only this modal sends, from its own chunk with a sender of its
 * own, so neither their schemas nor a sender for each are in what every tab
 * loads. They have an endpoint like any other.
 */
export const windowCommandSchemas = {
  create_recurring_item: createRecurringItemSchema,
  write_recurring_item: writeRecurringItemSchema,
  delete_recurring_item: deleteRecurringItemSchema,
} as const;
