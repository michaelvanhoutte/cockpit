import { z } from 'zod';

/**
 * What a Workspace's own sentence about where its notes belong is made of
 * ("Show what the system learned, in a sentence you can correct", issue 301).
 *
 * **One half, where there were two.** A nightly job wrote a generated summary
 * beside this and nothing ever read it back, so it is gone ("Drop the nightly
 * filing summary, keep the sentence you wrote", issue 392). What a person
 * writes is the half that was always doing the work — it is read into every
 * clean-up call for the Workspace, ranked above the decision history itself.
 *
 * **The columns behind the generated half are still there and simply unread**,
 * per expand-then-contract; dropping them is its own step, once the
 * account-scoped rules block replaces this table (`docs/text-learning.md`,
 * "Build order").
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
 * A Workspace's correction, as the snapshot reads it back. Absent (the whole
 * object null) where no row exists yet, which is every Workspace's starting
 * condition — and, since the generated half stopped being written, the state
 * of every Workspace nobody has written a sentence for.
 */
export const routingSummarySchema = z.object({
  /** Null until a person writes one, and null again once they clear it. */
  correction: z.string().nullable(),
  correctionSetAt: z.iso.datetime().nullable(),
});
export type RoutingSummary = z.infer<typeof routingSummarySchema>;
