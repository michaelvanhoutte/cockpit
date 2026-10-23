import { z } from 'zod';
import { captureTimeZoneSchema, itemDescriptionSchema, itemTitleSchema, prioritySchema } from './item.js';
import { repeatRuleSchema } from './series.js';

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
 * Why a recurring item is refused, in the words the person is told beside the
 * field. The screen tells them apart by these, so the words are one definition.
 */
export const RECURRING_REFUSALS = {
  nextOnPassed: 'Next on cannot be before today.',
  panelGone: 'A Panel it files on is no longer in this Workspace.',
  gone: 'That recurring item is no longer there.',
  alreadyMade: 'That recurring item is already made.',
} as const;
