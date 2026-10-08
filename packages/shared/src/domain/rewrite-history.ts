import { z } from 'zod';

/**
 * One attempt Cockpit made to refine a captured item's title, description and
 * suggested Panel, from the moment it was queued through to its outcome ("See
 * the history of what Cockpit proposed for the Inbox's items", issue 444;
 * "Rename Rewrite history to Smart refinements, and show each field's
 * change", issue 614). The person reads these as *what Cockpit changed*
 * (issue 690).
 *
 * The wire shape both the account-wide table (opened from the Inbox's own
 * menu) and an item's own tab (on its form) read - the same query either way,
 * only the item filter differs. The table, route and type
 * names keep "rewrite history": renaming them buys the person nothing.
 */
export const rewriteAttemptStatusSchema = z.enum(['pending', 'rewritten', 'left-as-is', 'failed']);
export type RewriteAttemptStatus = z.infer<typeof rewriteAttemptStatusSchema>;

/**
 * Which fields a refinement looks at, fixed by what set it off: a capture
 * looks at all three, a refresh after you file another item at the suggested
 * Panel alone. `texts` is a re-read after you edited another item, which
 * nothing queues any more (issue 887); the rows it left stay readable.
 */
export const refinementScopeSchema = z.enum(['texts-and-panel', 'texts', 'panel']);
export type RefinementScope = z.infer<typeof refinementScopeSchema>;

/**
 * A suggested Panel as a refinement saw it. `name` and `dashboardName` are
 * both null where that Panel, or the Dashboard it sat on, has since been
 * deleted; both are joined live when read, never stored.
 */
export const suggestedPanelSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  dashboardName: z.string().nullable(),
});
export type SuggestedPanel = z.infer<typeof suggestedPanelSchema>;

export const rewriteHistoryEntrySchema = z.object({
  id: z.string(),
  itemId: z.uuid(),
  titleBefore: z.string(),
  /** Null until the attempt succeeds. */
  titleAfter: z.string().nullable(),
  descriptionBefore: z.string().nullable(),
  descriptionAfter: z.string().nullable(),
  /** The Panel this same read proposed, by name - null where none was, or where the Panel named has since gone. */
  proposedPanelName: z.string().nullable(),
  status: rewriteAttemptStatusSchema,
  /** Why, in words meant to be read - the reason a left-as-is or a failed attempt names, or what a rewritten one answered in. */
  message: z.string().nullable(),
  attemptedAt: z.iso.datetime(),
  /** Null on a row recorded before this was (issue 614), which records neither this nor `suggestedPanelBefore`. */
  looksAt: refinementScopeSchema.nullable(),
  /** The item's suggested Panel when the refinement was queued; null where it had none, or where `looksAt` is null. */
  suggestedPanelBefore: suggestedPanelSchema.nullable(),
  /** The suggested Panel the item carried once the refinement settled; null where it carried none. */
  suggestedPanelAfter: suggestedPanelSchema.nullable(),
});
export type RewriteHistoryEntry = z.infer<typeof rewriteHistoryEntrySchema>;

export const rewriteHistoryResponseSchema = z.object({
  entries: rewriteHistoryEntrySchema.array(),
});
export type RewriteHistoryResponse = z.infer<typeof rewriteHistoryResponseSchema>;

/**
 * The account-wide table's cap - the issue's own open question ("pick a
 * reasonable number at build time; nothing in this codebase paginates a list
 * like this yet"), set to `RECENTLY_CAPTURED_LIMIT`'s own number
 * (apps/api/src/accounts/repo.ts) for the same reason that one gives: enough
 * to be useful, small enough that the call this feeds stays the same size
 * whatever the account holds.
 */
export const REWRITE_HISTORY_LIMIT = 20;
