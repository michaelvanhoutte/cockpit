import { z } from 'zod';

/**
 * Reading the model's answer for a Workspace's filing-pattern summary ("Show
 * what the system learned, in a sentence you can correct", issue 301). Pure,
 * for the same reason `note-texts.ts` beside it is: every way the answer can
 * be unusable is a branch worth proving without a model in the room.
 */

/** Either the summary, or why there is not one. */
export type SummaryRead = { summary: string } | { discarded: string };

/**
 * The shape the answer has to be: one plain-English paragraph and nothing
 * else. `min(1)` because an empty summary is not a summary - the job simply
 * does not call this at all where there is no history to read
 * (`jobs/enrichment.ts`'s `summarizeWorkspace`), so an empty answer here
 * means the model declined to say anything useful about a history it was
 * given, which is exactly as unusable as no answer at all.
 */
const answerSchema = z.object({
  summary: z.string().trim().min(1),
});

/**
 * Reads what came back, and refuses it rather than repairing it - the same
 * rule `readProposal` in `note-texts.ts` follows, and for the same reason: a
 * summary that has been trimmed or filled in by this code is no longer an
 * honest account of what the model actually said.
 */
export function readSummary(raw: unknown): SummaryRead {
  if (typeof raw !== 'string') return { discarded: 'the answer carried no text' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { discarded: 'the answer was not JSON' };
  }

  const read = answerSchema.safeParse(parsed);
  if (!read.success) {
    return {
      discarded: `the answer was not a summary: ${read.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  return { summary: read.data.summary };
}
