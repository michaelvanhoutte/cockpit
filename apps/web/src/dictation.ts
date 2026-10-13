/**
 * What dictation says and how its words join a note, shared by the two views
 * that record ("Dictate a note in Capture", issue 714, moved from the browser's
 * speech engine to recording and Whisper by "Dictate in Capture with Whisper
 * instead of the browser's speech engine", issue 1037). Recording itself is
 * `recording.ts`; the engine this file once drove is gone, with no fallback.
 */

/** What a person is told when dictation cannot run, per the way the microphone refused. */
export const DICTATION_BLOCKED = 'Dictation needs the microphone, which is blocked for this site.';
export const DICTATION_NO_MICROPHONE = 'No microphone was found to dictate with.';
export const DICTATION_FAILED = 'Dictation could not start.';

/** A phrase added to a note: after a space, unless the note is empty or already ends in whitespace. */
export function appendPhrase(note: string, phrase: string): string {
  const said = phrase.trim();
  if (!said) return note;
  if (!note.trim()) return said;
  return /\s$/.test(note) ? `${note}${said}` : `${note} ${said}`;
}
