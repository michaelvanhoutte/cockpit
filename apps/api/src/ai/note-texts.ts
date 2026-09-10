import { itemDescriptionSchema, itemTitleSchema } from '@cockpit/shared';
import { z } from 'zod';

/**
 * The texts Cockpit proposes for a captured note, and the reading of an
 * answer that decides whether they may be used at all ("Clean up a captured
 * note into a clear title and a fuller message", issue 296; "Offer the other
 * readings when a captured note says two things", issue 297).
 *
 * Pure and here rather than beside the call in `index.ts`, because this is the
 * half that decides something: every way an answer can be unusable ends in the
 * Item keeping the mechanical title capture gave it, and that is a branch worth
 * proving without a model in the room.
 */

/**
 * One other way the note could be read, in the model's own field names -
 * `message` rather than `description`, matching `NoteTexts` below. `index.ts`
 * is what translates a usable one onto the wire shape the Item's own form
 * uses (`ItemReading`, in `@cockpit/shared`).
 */
export interface ReadingCandidate {
  title: string;
  message: string;
  /** A few words saying what this reading takes the note to mean. */
  meaning: string;
}

/**
 * The Panel a note belongs on, in the model's own field names - matching
 * `ReadingCandidate` above ("Propose where a captured note belongs, without
 * filing it there", issue 298).
 */
export interface RoutingCandidate {
  panelId: string;
  reason: string;
}

/** What comes back, once it is known to be usable. */
export interface NoteTexts {
  /** The language the model named for itself before writing either text. */
  language: string;
  title: string;
  message: string;
  /** The other ways the note could be read, where the model genuinely found any. */
  readings: ReadingCandidate[];
  /** The Panel this note belongs on, or null where nothing was proposed. */
  panel: RoutingCandidate | null;
}

/**
 * The shape the main proposal's two texts have to be, in the words the fields
 * they land in already use: `set_title` and `set_description` are what a
 * person edits these two with, so a proposal that would not fit their schemas
 * is one the form could not have accepted either.
 *
 * `min(1)` on both because a proposal with nothing in it is not a proposal,
 * and because `itemTitleSchema` deliberately allows the empty string - a
 * person is allowed to clear a title, and Cockpit is not allowed to propose
 * that they should.
 *
 * **`readings` is deliberately not a field of this schema.** It is read
 * separately, below, and nothing about its shape can refuse the title and
 * message here: a note is cleaned up whether or not the rarer ask on the same
 * call came back usable, exactly as it was before that ask existed ("Offer
 * the other readings when a captured note says two things", issue 297).
 */
const answerSchema = z.object({
  language: z.string().trim().min(1),
  title: itemTitleSchema.refine((title) => title.length > 0, {
    message: 'a proposed title has to name the note',
  }),
  message: itemDescriptionSchema.min(1),
});

/**
 * The rules one reading has to obey, once the shape above says it has the
 * three fields at all.
 *
 * **The same rule the title above obeys, and the message may say nothing at
 * all.** A reading exists to offer a different title; where the note has
 * nothing more to add beyond that, an empty message is the honest answer, not
 * a discarded one - unlike the main proposal, which is the one reading
 * Cockpit is confident enough to write onto the Item unasked, and so has to
 * justify itself with more than a title alone.
 */
const readingSchema = z.object({
  title: itemTitleSchema.refine((title) => title.length > 0, {
    message: 'a reading has to name the note',
  }),
  message: itemDescriptionSchema,
  meaning: z.string().trim().min(1),
});

/**
 * The shape a panel proposal's two fields have to be, before it is even
 * checked against the ids the call actually offered - `readPanelCandidate`
 * below is where that second check happens, because it needs the list of
 * offered ids and a shape schema alone cannot carry one.
 */
const panelCandidateShape = z.object({
  panelId: z.string(),
  reason: z.string(),
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
 *
 * **Nothing about `readings` can discard the title and message.** The two are
 * read by `answerSchema` alone; `readings` is read afterwards, from the same
 * parsed object, and stands or falls entirely on its own - missing, not an
 * array, or holding something that is not even an object all read as "none
 * found" rather than as a reason to throw away an otherwise usable proposal.
 * The one thing this call is already relied on for must not become fragile
 * to the rarer thing riding along with it.
 *
 * **A reading that will not fit is dropped on its own, not sunk with the
 * others.** Each candidate in `readings` is checked against `readingSchema`
 * by itself, so one that would not fit the boxes it would land in is simply
 * not among them, and the readings that do fit are unaffected ("A reading
 * survives the same trip its title does", issue 297).
 *
 * **The panel is read the same way, and checked against `offeredPanelIds` on
 * top of its shape** ("Propose where a captured note belongs, without filing
 * it there", issue 298, "Never trust a panel id back") - an id the schema's
 * own `enum` should already have made impossible is checked again here rather
 * than assumed, exactly as `command-service.ts` checks a third time, freshly,
 * at the moment it would write. Anything that does not survive all of it - an
 * empty id, an id not offered, a reason left empty - reads as no proposal,
 * which is a real answer this call gives out loud on every note that does not
 * clearly belong anywhere.
 */
export function readProposal(raw: unknown, offeredPanelIds: readonly string[]): ProposalRead {
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

  const candidates =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).readings
      : undefined;
  const readings = (Array.isArray(candidates) ? candidates : []).flatMap((candidate) => {
    const usable = readingSchema.safeParse(candidate);
    return usable.success ? [usable.data] : [];
  });

  const panel =
    typeof parsed === 'object' && parsed !== null
      ? readPanelCandidate((parsed as Record<string, unknown>).panel, offeredPanelIds)
      : null;

  return { proposal: { ...read.data, readings, panel } };
}

/**
 * One panel proposal, checked against its shape and then against the ids this
 * call actually offered - the empty id, an id not offered, and a reason left
 * empty all read as "no proposal" rather than as a reason to throw away the
 * title and message riding beside it.
 */
function readPanelCandidate(
  raw: unknown,
  offeredPanelIds: readonly string[],
): RoutingCandidate | null {
  const read = panelCandidateShape.safeParse(raw);
  if (!read.success) return null;

  const panelId = read.data.panelId.trim();
  const reason = read.data.reason.trim();
  if (panelId === '' || reason === '') return null;
  if (!offeredPanelIds.includes(panelId)) return null;

  return { panelId, reason };
}
