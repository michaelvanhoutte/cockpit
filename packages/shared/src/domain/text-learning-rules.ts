/**
 * The length a title is written towards - shared with the prompt
 * (`clean-up-a-note.v8.ts`, which re-exports it) so the guidance line built
 * from it can never read a different number than the one actually sent to
 * the model.
 */
export const TITLE_TARGET = 50;

/**
 * The sentences the note-cleanup prompt is built from, each a named constant
 * `clean-up-a-note.v8.ts` imports and interpolates into the spot in the system
 * prompt it occupies.
 *
 * **Named constants, not an array read by position.** A reorder, insertion or
 * deletion of an array silently rebinds an unrelated sentence to a prompt slot,
 * or interpolates `undefined` into a live model call, with nothing at compile
 * time able to catch it. A named export can only ever bind to the name a caller
 * asked for; deleting one is a compile error at every import site.
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
 * How many texts Cockpit has proposed and this account has looked at, and how
 * many of those were corrected - the same ratio `deriveWhatStood`
 * (`apps/api/src/domain/text-corrections.ts`) hands the prompt, rendered in
 * one place so the prompt can never say it two different ways.
 */
export function textLearningRatioSentence(proposedTotal: number, correctedTotal: number): string {
  return `${correctedTotal} of ${proposedTotal} proposed texts were corrected; the rest stood unchanged.`;
}
