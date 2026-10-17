/**
 * A connection's history, as the account's store writes it ("See when a pulled
 * connection was checked, and why it failed, from its row's History…", issue
 * 1140): one line per real event, consecutive alike checks folded on write -
 * the decision kept here so it is proven without a store.
 */
import { HISTORY_KEPT_DAYS } from '@cockpit/shared';
import type { NameOutcome } from './filing-by-name.js';

/**
 * Why a line was written: a check on the connection's cadence, soon after one
 * that said there was more to do, because a person pressed *Check now* (issue
 * 1143) - or, for a connection the source pushes to, a `delivery` it made
 * ("See what each Teams save became, in its connection's history", issue 1144).
 */
export type CheckReason = 'scheduled' | 'follow-up' | 'check-now' | 'delivery';

/** What a check did, by Item id: brought in, closed, sent back to the source, refused by it for good. */
export interface CheckDid {
  broughtIn: string[];
  closed: string[];
  sentBack: string[];
  refused: string[];
  /** How many source ids the check's complete listing held (issue 1196); absent where it saw none. Not something done, so `didAnything` ignores it. */
  listed?: number;
  /** What each name read on a message did (issue 1197), per Item; only names new or changed since the last report. A message with none adds nothing. */
  named?: NamedOn[];
}

/** One Item's names that a check read, each with what it did. */
export interface NamedOn {
  itemId: string;
  names: NameOutcome[];
}

/** The kinds of thing a check did, each a list of Item ids. */
export type DidKind = Exclude<keyof CheckDid, 'listed' | 'named'>;

/** What a line stores of the names a check read: the exact count of messages, and the first by Item id. */
export interface NamedKept {
  count: number;
  messages: NamedOn[];
}

/** What a line stores of what its check did: `named` is absent on a line from before issue 1197. */
export type DidStored = Record<DidKind, DidKept> & { named?: NamedKept };

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
 * The most lines *History…* reads, newest first. The history is kept 30 days
 * (`HISTORY_KEPT_DAYS`), and a source whose failures never repeat word for word
 * writes a line every check - 288 a day - so the read is capped as well.
 */
export const HISTORY_MOST_LINES = 500;

/**
 * The moment before which a line is past keeping, `HISTORY_KEPT_DAYS` before
 * `now` ("Keep a connection's history 30 days, and fold a quiet past day into
 * one line", issue 1145): its end decides,
 * so a folded line begun before it and ended after it is kept whole.
 */
export function historyKeptFrom(now: Date): string {
  return new Date(now.getTime() - HISTORY_KEPT_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

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
  return did.broughtIn.length + did.closed.length + did.sentBack.length + did.refused.length > 0 || namedKept(did) !== null;
}

/**
 * The messages whose names a check read, each Item once with its names in
 * order, the first `NAMED_MOST_ITEMS` kept and the count exact; null where it
 * read none - a message with no name adds nothing (issue 1197).
 */
function namedKept(did: CheckDid): NamedKept | null {
  const byItem = new Map<string, NameOutcome[]>();
  for (const { itemId, names } of did.named ?? []) {
    if (names.length === 0) continue;
    byItem.set(itemId, [...(byItem.get(itemId) ?? []), ...names]);
  }
  if (byItem.size === 0) return null;
  return {
    count: byItem.size,
    messages: [...byItem].slice(0, NAMED_MOST_ITEMS).map(([itemId, names]) => ({ itemId, names })),
  };
}

/**
 * What a line stores of what its check did ("Say what each check of a
 * connection brought in, closed and sent back", issue 1141): each kind's exact
 * count and its first Items, each Item once; null where it did nothing.
 */
export function keptDid(did: CheckDid): DidStored | null {
  if (!didAnything(did)) return null;
  const kept = (ids: readonly string[]): DidKept => {
    const once = [...new Set(ids)];
    return { count: once.length, ids: once.slice(0, NAMED_MOST_ITEMS) };
  };
  const named = namedKept(did);
  return {
    broughtIn: kept(did.broughtIn),
    closed: kept(did.closed),
    sentBack: kept(did.sentBack),
    refused: kept(did.refused),
    ...(named ? { named } : {}),
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
 * A delivery (issue 1144) is one save and always did something, so it never
 * folds; a failed one folds like any failure, since Teams redelivers a click
 * it got no 200 for and a failing connection would otherwise write a line each time.
 */
export function whatACheckWrites(previous: LineAsHeld | null, ended: CheckOutcome): 'extend' | 'insert' {
  if (previous === null || ended.did || previous.did) return 'insert';
  if (ended.reason === 'check-now' || previous.reason === 'check-now') return 'insert';
  if (isQuiet(ended)) return isQuiet(previous) ? 'extend' : 'insert';
  if (ended.outcome !== 'failed' || previous.outcome !== 'failed') return 'insert';
  const alike = previous.status === ended.status && previous.message === ended.message;
  return alike && previous.messageCut === ended.messageCut ? 'extend' : 'insert';
}
