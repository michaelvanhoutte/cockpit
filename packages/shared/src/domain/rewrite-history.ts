import { z } from 'zod';

/**
 * One attempt Cockpit made to rewrite a captured item's title and description,
 * from the moment it was queued through to its outcome ("See the history of
 * what Cockpit proposed for the Inbox's items", issue 444).
 *
 * The wire shape both the account-wide table (opened from the Inbox's own
 * menu) and an item's own table (opened from its row menu) read - the same
 * query either way, only the item filter differs.
 */
export const rewriteAttemptStatusSchema = z.enum(['pending', 'rewritten', 'left-as-is', 'failed']);
export type RewriteAttemptStatus = z.infer<typeof rewriteAttemptStatusSchema>;

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
