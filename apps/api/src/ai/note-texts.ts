import { itemDescriptionSchema, itemTitleSchema } from '@cockpit/shared';
import { z } from 'zod';

/**
 * The two texts Cockpit proposes for a captured note, and the reading of an
 * answer that decides whether they may be used at all ("Clean up a captured
 * note into a clear title and a fuller message", issue 296).
 *
 * Pure and here rather than beside the call in `index.ts`, because this is the
 * half that decides something: every way an answer can be unusable ends in the
 * Item keeping the mechanical title capture gave it, and that is a branch worth
 * proving without a model in the room.
 */

/** What comes back, once it is known to be usable. */
export interface NoteTexts {
  /** The language the model named for itself before writing either text. */
  language: string;
  title: string;
  message: string;
}

/**
 * The shape an answer has to have, in the words the fields it lands in already
 * use: `set_title` and `set_description` are what a person edits these two
 * with, so a proposal that would not fit their schemas is one the form could
 * not have accepted either.
 *
 * `min(1)` on both texts because a proposal with nothing in it is not a
 * proposal, and because `itemTitleSchema` deliberately allows the empty string
 * - a person is allowed to clear a title, and Cockpit is not allowed to
 * propose that they should.
 */
const answerSchema = z.object({
  language: z.string().trim().min(1),
  title: itemTitleSchema.refine((title) => title.length > 0, {
    message: 'a proposed title has to name the note',
  }),
  message: itemDescriptionSchema.min(1),
});

/**
 * Either the proposal, or why there is not one.
 *
 * A reason rather than a bare null: every one of these means the Item silently
 * keeps its mechanical title, so the only place the difference between "the
 * model refused", "the answer was not JSON" and "the title was too long" can be
 * seen is the logs.
 */
export type ProposalRead = { proposal: NoteTexts } | { discarded: string };

/**
 * Reads what came back, and refuses it rather than repairing it.
 *
 * **Nothing here trims, cuts or fills in.** Repairing a model's answer would
 * make the one rule that outranks the rest unenforceable: a title cut to 200
 * characters is still whatever the model decided to say, and the point of
 * validating is to be able to fall back to the text capture wrote, which is
 * known to contain only what was typed.
 */
export function readProposal(raw: unknown): ProposalRead {
  if (typeof raw !== 'string') return { discarded: 'the answer carried no text' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { discarded: 'the answer was not JSON' };
  }

  const read = answerSchema.safeParse(parsed);
  if (!read.success) {
    return { discarded: `the answer was not a proposal: ${read.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
  }
  return { proposal: read.data };
}
