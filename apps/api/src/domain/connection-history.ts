/**
 * A connection's history, as the account's store writes it ("See when a pulled
 * connection was checked, and why it failed, from its row's History…", issue
 * 1140): one line per real event, consecutive alike checks folded on write -
 * the decision kept here so it is proven without a store.
 */

/** Why a check ran: on the connection's cadence, or soon after one that said there was more to do. */
export type CheckReason = 'scheduled' | 'follow-up';

/** How a check ended, as its line records it. */
export type CheckOutcome =
  | { outcome: 'worked' }
  | { outcome: 'failed'; message: string | null; messageCut: boolean };

/** The line a new check would fold into, as the store holds it. */
export interface LineAsHeld {
  outcome: 'worked' | 'failed';
  message: string | null;
  messageCut: boolean;
}

/** The most of a failure's message a line keeps, in UTF-8 bytes. */
export const MESSAGE_MOST_BYTES = 2048;

/**
 * The most lines *History…* reads, newest first. Nothing prunes the history,
 * and a source whose failures never repeat word for word writes a line every
 * check, so the read is capped rather than growing with the connection's age.
 */
export const HISTORY_MOST_LINES = 500;

/**
 * A failure's message as its line keeps it: at most 2 KB, cut on a character
 * rather than through one, and marked where it was cut; none where the source
 * said nothing.
 */
export function keptMessage(message: string): { message: string | null; messageCut: boolean } {
  if (message === '') return { message: null, messageCut: false };
  const encoder = new TextEncoder();
  if (encoder.encode(message).length <= MESSAGE_MOST_BYTES) return { message, messageCut: false };
  let kept = '';
  let bytes = 0;
  for (const character of message) {
    const size = encoder.encode(character).length;
    if (bytes + size > MESSAGE_MOST_BYTES) break;
    kept += character;
    bytes += size;
  }
  return { message: kept, messageCut: true };
}

/**
 * Whether a check that worked changed nothing. Every one does until the host
 * counts what a check brought in, closed and sent back ("Say what each check
 * of a connection brought in, closed and sent back", issue 1141).
 */
function isQuiet(line: { outcome: 'worked' | 'failed' }): boolean {
  return line.outcome === 'worked';
}

/**
 * What a check's end does to the history: extends the line before it where
 * both are quiet, or both failed with the same message; inserts a line of its
 * own otherwise.
 */
export function whatACheckWrites(previous: LineAsHeld | null, ended: CheckOutcome): 'extend' | 'insert' {
  if (previous === null) return 'insert';
  if (isQuiet(ended)) return isQuiet(previous) ? 'extend' : 'insert';
  if (ended.outcome !== 'failed' || previous.outcome !== 'failed') return 'insert';
  return previous.message === ended.message && previous.messageCut === ended.messageCut ? 'extend' : 'insert';
}
