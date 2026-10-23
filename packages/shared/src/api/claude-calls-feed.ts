import { z } from 'zod';

/**
 * What the Harness Monitor reads of Cockpit's Claude calls ("Let the Harness
 * Monitor read Cockpit's Claude calls, without users, under a token of its
 * own", issue 1481): `GET /v1/usage-records?after=<row number>`, under the
 * `USAGE_READ_TOKEN` bearer token and nothing else.
 *
 * **The Monitor imports nothing from Cockpit**, so it validates this shape with
 * its own copy; this file is the one place the shape is written down, and a
 * field added or renamed here is a change to that copy too. Nothing about a
 * user, account, item, workspace or key is in it, and none can be added.
 */

/** The most rows one page holds. */
export const CLAUDE_CALLS_FEED_PAGE = 1000;

/** One call paid by Cockpit's Anthropic key, as the Monitor reads it. */
export const claudeCallSchema = z.object({
  /** Production's own number for the row, which the next page continues after. */
  id: z.number().int(),
  /** When the attempt started, ISO-8601 in UTC. */
  at: z.string(),
  /** Which system made the call: `production`, `staging`, `ci` or `local`. */
  environment: z.string(),
  /** The feature: the operation the call was made for, like `clean-up-a-note`. */
  feature: z.string(),
  promptVersion: z.string().nullable(),
  /** What started the call, like `captured-in-app`. */
  startedBy: z.string().nullable(),
  model: z.string(),
  outcome: z.enum(['ok', 'error', 'timed-out']),
  tokensIn: z.number().int().nullable(),
  cacheRead: z.number().int().nullable(),
  cacheWrite: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  /** US dollars; `null` where there is no price or no token count, never 0 for that. */
  costUsd: z.number().nullable(),
  /** The pull request and run of a CI call. */
  pullRequest: z.number().int().nullable(),
  runId: z.number().int().nullable(),
  /** The branch of a local call. */
  branch: z.string().nullable(),
});
export type ClaudeCall = z.infer<typeof claudeCallSchema>;

/** One page of calls, oldest first. */
export const claudeCallsPageSchema = z.object({
  calls: z.array(claudeCallSchema),
  /** Whether a row follows this page; if so, ask `after` the last row's `id`. */
  more: z.boolean(),
});
export type ClaudeCallsPage = z.infer<typeof claudeCallsPageSchema>;
