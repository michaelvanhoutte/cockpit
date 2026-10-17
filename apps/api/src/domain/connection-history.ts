/**
 * A connection's history, as the account's store writes it ("See when a pulled
 * connection was checked, and why it failed, from its row's History…", issue
 * 1140): one line per real event, consecutive alike checks folded on write -
 * the decision kept here so it is proven without a store.
 */

/**
 * Why a check ran: on the connection's cadence, soon after one that said there
 * was more to do, or because a person pressed *Check now* (issue 1143).
 */
export type CheckReason = 'scheduled' | 'follow-up' | 'check-now';

/** What a check did, by Item id: brought in, closed, sent back to the source, refused by it for good. */
export interface CheckDid {
  broughtIn: string[];
  closed: string[];
  sentBack: string[];
  refused: string[];
}

/** How a check ended, as its line records it. */
export type CheckEnded =
  | { outcome: 'worked' }
  | { outcome: 'failed'; message: string | null; messageCut: boolean; status: number | null };

/** How a check ended, and whether it did anything. */
export type CheckOutcome = CheckEnded & { did: boolean; reason: CheckReason };

/** The line a new check would fold into, as the store holds it. */
export interface LineAsHeld {
  /** Why the line's first check ran. */
  reason: CheckReason;
  outcome: 'worked' | 'failed';
  message: string | null;
  messageCut: boolean;
  /** The HTTP status the source answered a failure with (issue 1142); null where it gave none, or the line worked. */
  status: number | null;
  /** Whether the line's check did anything - such a line is a line of its own. */
  did: boolean;
}

/** What a line stores of one kind of what a check did: the exact count, and the first Items by id. */
export interface DidKept {
  count: number;
  ids: string[];
}

/** The most Item ids a line keeps of one kind; the count stays exact beyond it. */
export const NAMED_MOST_ITEMS = 50;

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

/** Whether a check did anything at all, by what the host counted. */
export function didAnything(did: CheckDid): boolean {
  return did.broughtIn.length + did.closed.length + did.sentBack.length + did.refused.length > 0;
}

/**
 * What a line stores of what its check did ("Say what each check of a
 * connection brought in, closed and sent back", issue 1141): each kind's exact
 * count and its first Items, each Item once; null where it did nothing.
 */
export function keptDid(did: CheckDid): Record<keyof CheckDid, DidKept> | null {
  if (!didAnything(did)) return null;
  const kept = (ids: readonly string[]): DidKept => {
    const once = [...new Set(ids)];
    return { count: once.length, ids: once.slice(0, NAMED_MOST_ITEMS) };
  };
  return {
    broughtIn: kept(did.broughtIn),
    closed: kept(did.closed),
    sentBack: kept(did.sentBack),
    refused: kept(did.refused),
  };
}

/** Whether a check that worked changed nothing - only such a check is quiet. */
function isQuiet(line: { outcome: 'worked' | 'failed'; did: boolean }): boolean {
  return line.outcome === 'worked' && !line.did;
}

/**
 * What a check's end does to the history: extends the line before it where
 * both are quiet, or both failed with the same status and message and neither
 * did anything; inserts a line of its own otherwise - a check that did anything is
 * never folded, and never extended. Nor is a *Check now* (issue 1143): a person
 * pressed it to see its line, which a later quiet check would bury in a count.
 */
export function whatACheckWrites(previous: LineAsHeld | null, ended: CheckOutcome): 'extend' | 'insert' {
  if (previous === null || ended.did || previous.did) return 'insert';
  if (ended.reason === 'check-now' || previous.reason === 'check-now') return 'insert';
  if (isQuiet(ended)) return isQuiet(previous) ? 'extend' : 'insert';
  if (ended.outcome !== 'failed' || previous.outcome !== 'failed') return 'insert';
  const alike = previous.status === ended.status && previous.message === ended.message;
  return alike && previous.messageCut === ended.messageCut ? 'extend' : 'insert';
}
