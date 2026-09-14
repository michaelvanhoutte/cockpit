import { z } from 'zod';

/**
 * The account-scoped box an account writes its own rules for how Cockpit
 * writes a title and a message ("Show what Cockpit is told, and say how you
 * want it changed", issue 398; `docs/text-learning.md`, "Where you see it,
 * and change it").
 *
 * **Rendered ahead of everything else in the prompt** - why, in
 * `renderTextLearningRules` (`apps/api/src/ai/prompts/clean-up-a-note.v7.ts`),
 * which is what actually puts it there; this file only carries the shape and
 * the cap, the same split `routing-summary.ts` makes for the Workspace-scoped
 * correction beside it.
 *
 * **A different table from `workspace_routing_summary`, not a migration of
 * it.** That correction is an instruction about filing, scoped to one
 * Workspace; this is an instruction about writing, scoped to the whole
 * account - carrying one across would put a sentence about Panels at the
 * head of a prompt section about prose. The Workspace correction stays where
 * it is until "Drop the workspace routing summary table" (issue 401) removes
 * it.
 */

/**
 * The most the rules box holds - generous rather than tight, the same
 * reasoning `ROUTING_SUMMARY_CORRECTION_LIMIT` carries: what fits is a
 * product decision, not a storage one, and this is read by a model on every
 * future proposal for the account, so an unbounded one would grow the size
 * of every call it rides along with.
 */
export const TEXT_LEARNING_RULES_LIMIT = 2_000;

/**
 * Trimmed and capped, like every other free-typed sentence this app stores;
 * refused rather than cut where it runs over (architecture.md, "`packages/
 * shared`: schema and command rationale" - "the write side... is refused
 * rather than clamped"). The empty string is what `set_text_learning_rules`
 * clears the box with - there is no third state between "never written" and
 * "written as nothing".
 */
export const textLearningRulesSchema = z.string().trim().max(TEXT_LEARNING_RULES_LIMIT);

/**
 * The length a title is written towards - shared with the prompt
 * (`clean-up-a-note.v7.ts`, which re-exports it) so the guidance line built
 * from it can never read a different number than the one actually sent to
 * the model.
 */
export const TITLE_TARGET = 50;

/**
 * What Cockpit is told, read back in plain English, one named sentence at a
 * time ("Show what Cockpit is told, and say how you want it changed", issue
 * 398, "What Cockpit is told"). `clean-up-a-note.v7.ts` imports each of these
 * by name and interpolates it into the exact spot in the system prompt it
 * already occupied, so what the window shows can never read differently from
 * what the model is actually asked - the property this issue's own "the
 * guidance and the prompt" test case holds it to.
 *
 * **Named constants, not an array read by position.** An early version of
 * this shipped as a plain `string[]`, destructured by index in the prompt
 * file - which let a reorder, insertion, or deletion here silently rebind an
 * unrelated sentence to a prompt slot, or interpolate `undefined` into a live
 * model call, with nothing at compile time or in the unit tests (which only
 * assert substring presence) able to catch it. A named export can only ever
 * bind to the name a caller actually asked for; deleting one is a compile
 * error at every import site instead of a silent runtime string.
 *
 * Read-only on the window: some of these lines are load-bearing for the
 * shape of the answer, and editing them breaks the feature rather than
 * restyling it. The rules box beside it is where a disagreement is written
 * instead.
 */
export const GUIDANCE_NO_INVENTION = 'You may not add anything the note does not contain.';
export const GUIDANCE_NO_HEDGE =
  "Where the note refers to something it never states - a document, a person, a decision, a deadline - leave it exactly as the note left it: do not choose one, and do not say that the note never says which.";
export const GUIDANCE_NO_TALKING_ABOUT_THE_NOTE = 'Neither text talks about the note.';
export const GUIDANCE_TITLE_NAMES_THE_WORK =
  'The title names the work in the fewest words that could only be this note.';
export const GUIDANCE_TITLE_LENGTH_TARGET = `Keep it to ${TITLE_TARGET} characters or fewer, and go well under that wherever the note carries less - a title is never padded out to reach a length.`;
export const GUIDANCE_MESSAGE_PURPOSE =
  'The message says what to do about the note, written out in full sentences so it makes sense again in two weeks.';
export const GUIDANCE_LANGUAGE_ANSWER = 'Then write the title and the message in that language.';
export const GUIDANCE_NEVER_TRANSLATE =
  'Never translate a note into another language, whatever language the examples below are in.';

/**
 * The order the window draws the guidance in. Built from the named constants
 * above rather than the other way around, so nothing ever reads this array
 * by position - reordering, inserting into, or trimming it changes only what
 * the window shows, never what a prompt import resolves to.
 */
export const TEXT_LEARNING_GUIDANCE: readonly string[] = [
  GUIDANCE_NO_INVENTION,
  GUIDANCE_NO_HEDGE,
  GUIDANCE_NO_TALKING_ABOUT_THE_NOTE,
  GUIDANCE_TITLE_NAMES_THE_WORK,
  GUIDANCE_TITLE_LENGTH_TARGET,
  GUIDANCE_MESSAGE_PURPOSE,
  GUIDANCE_LANGUAGE_ANSWER,
  GUIDANCE_NEVER_TRANSLATE,
];

/**
 * How many texts Cockpit has proposed and this account has looked at, and how
 * many of those were corrected - the same ratio `deriveWhatStood`
 * (`apps/api/src/domain/text-corrections.ts`) hands the prompt, rendered in
 * one place so the window and the prompt can never say it two different ways.
 */
export function textLearningRatioSentence(proposedTotal: number, correctedTotal: number): string {
  return `${correctedTotal} of ${proposedTotal} proposed texts were corrected; the rest stood unchanged.`;
}

/**
 * What the window reads: the box itself, and the ratio the prompt reads
 * beside it ("How it is doing" - `docs/text-learning.md`, "The rules"). The
 * built-in guidance is not part of this - it never changes at runtime, so it
 * ships as `TEXT_LEARNING_GUIDANCE` above rather than a round trip.
 */
export const textLearningStatusSchema = z.object({
  /** Null until the account writes one, and null again once it is cleared. */
  rules: z.string().nullable(),
  rulesSetAt: z.iso.datetime().nullable(),
  proposedTotal: z.number().int().nonnegative(),
  correctedTotal: z.number().int().nonnegative(),
});
export type TextLearningStatus = z.infer<typeof textLearningStatusSchema>;
