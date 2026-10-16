import { z } from 'zod';

/**
 * One line of a connection's history ("See when a pulled connection was
 * checked, and why it failed, from its row's History…", issue 1140): a check,
 * or `count` alike checks in a row folded into one, from `firstAt` to `lastAt`.
 *
 * - `reason` is why the line's first check ran - `scheduled` or `follow-up`
 *   today. A bare string, so a client built before another reason is added
 *   still parses the line, and says nothing of why.
 * - `message` is a failure's, as the source gave it and kept to 2 KB, with
 *   `messageCut` where it ran longer; null where it said nothing.
 */
export const connectionHistoryLineSchema = z.object({
  id: z.string(),
  outcome: z.enum(['worked', 'failed']),
  reason: z.string(),
  message: z.string().nullable(),
  messageCut: z.boolean(),
  count: z.number().int().min(1),
  firstAt: z.iso.datetime(),
  lastAt: z.iso.datetime(),
});
export type ConnectionHistoryLine = z.infer<typeof connectionHistoryLineSchema>;

/** A connection's history, newest line first. */
export const connectionHistorySchema = z.object({
  lines: connectionHistoryLineSchema.array(),
});
export type ConnectionHistory = z.infer<typeof connectionHistorySchema>;
