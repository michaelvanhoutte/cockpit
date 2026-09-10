import { z } from 'zod';

/**
 * What a Workspace's own filing-pattern summary is made of ("Show what the
 * system learned, in a sentence you can correct", issue 301): a plain-English
 * summary a nightly job writes, and a correction a person writes over it.
 *
 * **Two independently-owned halves**, matching `schema.ts`'s
 * `workspaceRoutingSummary` table: the summary is the system's own account of
 * what it learned from the decision history, and the correction is the
 * person's own word against it — never the other way rewritten. Editing one
 * never touches the other.
 */

/**
 * The most a correction holds — a sentence or two, not an essay. Generous
 * rather than tight: what fits is a product decision, not a storage one, the
 * same reasoning `workspaceNameSchema`'s own cap carries, and this is read by
 * a model on every future proposal for the Workspace, so an unbounded one
 * would grow the size of every call it rides along with.
 */
export const ROUTING_SUMMARY_CORRECTION_LIMIT = 2_000;

/**
 * Trimmed and capped, like every other free-typed sentence this app stores;
 * refused rather than cut where it runs over, since repairing input is where
 * bypasses live (architecture.md §4.4, "the write side... a span of zero or
 * over a whole row... is refused rather than clamped"). The empty string is
 * what `set_routing_summary_correction` clears a correction with — there is
 * no third state between "never set" and "set to nothing".
 */
export const routingSummaryCorrectionSchema = z.string().trim().max(ROUTING_SUMMARY_CORRECTION_LIMIT);

/**
 * A Workspace's summary and correction, as the snapshot reads them back.
 * Absent (the whole object null) where no row exists yet — a Workspace with
 * no decision history and no correction ever written, which is every
 * Workspace's starting condition.
 */
export const routingSummarySchema = z.object({
  /** Null until the first nightly run finds any decision history to summarize. */
  summary: z.string().nullable(),
  summaryGeneratedAt: z.iso.datetime().nullable(),
  /** Null until a person writes one, and null again once they clear it. */
  correction: z.string().nullable(),
  correctionSetAt: z.iso.datetime().nullable(),
});
export type RoutingSummary = z.infer<typeof routingSummarySchema>;
