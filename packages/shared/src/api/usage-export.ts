import { z } from 'zod';

/**
 * What the operator's usage export reads ("Export a period's usage records as
 * CSV with pnpm usage:export", issue 918): one environment's records of paid
 * provider calls, a page at a time.
 */

/** The most records one page holds. */
export const USAGE_EXPORT_PAGE = 1000;

/** One paid provider call attempt, as the export reads it. */
export const usageRecordSchema = z.object({
  /** The row's own number, which is what the next page continues after. */
  id: z.number().int(),
  /** When the attempt started, ISO-8601 in UTC. */
  at: z.string(),
  operation: z.string(),
  promptVersion: z.string().nullable(),
  triggeredBy: z.string().nullable(),
  /** `null` where the call had no user to name. */
  userId: z.string().nullable(),
  /** Empty where the user is no longer there: their name is never kept past them. */
  userName: z.string(),
  provider: z.string(),
  model: z.string(),
  paidBy: z.string(),
  /** The workspace of the key that paid, where there is one. */
  paidByAccount: z.string().nullable(),
  /** The last 4 characters of the key that paid. */
  paidByKeyEnding: z.string().nullable(),
  outcome: z.enum(['ok', 'error', 'timed-out']),
  /** The HTTP status of a failed attempt, where it had one. */
  status: z.number().int().nullable(),
  durationMs: z.number().int(),
  tokensIn: z.number().int().nullable(),
  cacheRead: z.number().int().nullable(),
  cacheWrite: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  itemId: z.string().nullable(),
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

/** One page of records, oldest first. */
export const usageExportPageSchema = z.object({
  records: z.array(usageRecordSchema),
  /** What to ask `after` for the next page; `null` once this was the last. */
  next: z.number().int().nullable(),
});
export type UsageExportPage = z.infer<typeof usageExportPageSchema>;
