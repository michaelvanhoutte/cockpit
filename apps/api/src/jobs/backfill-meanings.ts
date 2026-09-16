import type { Env } from '../env.js';
import { openAccount } from '../accounts/index.js';
import {
  asFarAsItReads,
  embeddingsFor,
  EMBEDDING_MODEL,
  type EmbeddingService,
} from '../embeddings/index.js';
import { whatAnItemSays } from '../domain/duplicates.js';

/**
 * Reading the notes that were already in the Inbox when duplicate flagging
 * shipped ("Give every item already there a vector", issue 409).
 *
 * **An operator command rather than a change to the store.** A change that has
 * shipped may never be edited (`docs/deployment.md`, "Migrations and rollback")
 * and this one has to stay re-runnable: it is how a run that stopped is
 * finished, and how notes captured under an older release are repaired.
 *
 * A plain function calling `accounts/` and `embeddings/`, the same shape as
 * `enrichment.ts` beside it; the adapter here is the operator's route rather
 * than the queue (architecture, "Background jobs").
 *
 * **One bounded batch per call, walked by a cursor.** The command asks again
 * from where the last answer stopped, so no single call can run for ever, the
 * command can say how far it got, and a run interrupted between two calls costs
 * nothing but the batch it was in the middle of - which is what makes this
 * resumable by construction rather than by a checkpoint.
 */

/** What one batch did. */
export interface BatchRead {
  /** Items given a reading, and paired against the rest of the account. */
  read: string[];
  /** Items with nothing written on them, which are counted and never dropped. */
  couldNotBeRead: string[];
  /** The last Item this batch looked at, which is where the next one starts. */
  lastLooked: string | null;
  /** Whether there may be more after `lastLooked`. */
  more: boolean;
}

/** This environment has nothing to read meaning with, so there is nothing to backfill. */
export class CannotReadMeaningError extends Error {
  constructor() {
    super('this environment cannot read what a note means');
    this.name = 'CannotReadMeaningError';
  }
}

/**
 * Reads one batch of an account's unread open Items and works out their pairs.
 *
 * **A blank Item is tombstoned, not merely skipped.** `whatAnItemSays` answering
 * null means an Item that once had a reading may still hold one now - its two
 * texts were emptied since - and the stale reading, and every pair built on it,
 * has to go the same way a captured note's own re-read makes it go
 * (`readWhatANoteMeans`, enrichment.ts): forgotten, not left standing over words
 * nobody can see any more.
 *
 * **Every reading the batch needs is one call where the model allows it** -
 * Workers AI takes a whole array of texts already, so a batch of a hundred
 * notes is a hundred notes' worth of latency saved, not a hundred round trips.
 * A batch call that fails falls back to one call per text (`readEachOrFallBack`
 * below), so the one text the model cannot read costs only itself rather than
 * every reading paid for alongside it.
 */
export async function readWhatTheseNotesMean(
  env: Env,
  accountName: string,
  { after, limit }: { after: string | null; limit: number },
): Promise<BatchRead> {
  const embeddings = embeddingsFor(env);
  if (!embeddings) throw new CannotReadMeaningError();

  const account = await openAccount(env, accountName);
  const candidates = await account.itemsToRead(EMBEDDING_MODEL, after, limit);
  if (candidates.length === 0) {
    return { read: [], couldNotBeRead: [], lastLooked: after, more: false };
  }

  const toRead: { itemId: string; text: string }[] = [];
  const couldNotBeRead: string[] = [];
  for (const candidate of candidates) {
    // An Item whose Title and Description are both empty or only whitespace
    // is not a note that means something obscure - it is a note with nothing
    // in it, and asking the model about it spends a call to be told so. It
    // keeps its place in the walk and is counted rather than passed over in
    // silence, the same rule `readWhatANoteMeans` (enrichment.ts) applies.
    const said = whatAnItemSays(candidate);
    if (!said) {
      couldNotBeRead.push(candidate.id);
      continue;
    }
    toRead.push({ itemId: candidate.id, text: asFarAsItReads(said) });
  }

  for (const itemId of couldNotBeRead) {
    await account.forgetWhatAnItemMeans(itemId);
  }

  const { readings, failure } = await readEachOrFallBack(embeddings, toRead);

  // What was read lands before the failure is reported, the same promise a
  // single reading already keeps: the calls already paid for are not spent
  // twice by the next run just because one text among them could not be read.
  const { remembered } = await account.rememberWhatTheseItemsMean(EMBEDDING_MODEL, readings);
  if (failure) throw failure;

  const lastLooked = candidates[candidates.length - 1]!.id;
  say(
    accountName,
    `read ${remembered.length}, ${couldNotBeRead.length} with nothing written on them, up to item ${lastLooked}`,
  );
  return {
    read: remembered,
    couldNotBeRead,
    lastLooked,
    // A short batch is the end of the walk. A full one may or may not be, and
    // asking again for an empty answer is one cheap query against being told
    // the run finished when it had not.
    more: candidates.length === limit,
  };
}

/**
 * Every text's reading, one call for the whole batch where the model answers
 * it - falling back to one call per text only once that call has failed, so
 * the ordinary run never pays the price of isolating a failure that did not
 * happen. The fallback stops at the first text that also fails there: past
 * that point nothing says whether the model itself is unavailable, and
 * reading on would spend calls with no better a chance of landing.
 */
async function readEachOrFallBack(
  embeddings: EmbeddingService,
  toRead: readonly { itemId: string; text: string }[],
): Promise<{ readings: { itemId: string; reading: number[] }[]; failure?: Error }> {
  if (toRead.length === 0) return { readings: [] };
  try {
    const meanings = await embeddings.readMeanings(toRead.map((one) => one.text));
    return { readings: toRead.map((one, at) => ({ itemId: one.itemId, reading: meanings[at]! })) };
  } catch {
    // Fall through to one at a time below.
  }
  const readings: { itemId: string; reading: number[] }[] = [];
  for (const one of toRead) {
    try {
      readings.push({ itemId: one.itemId, reading: await embeddings.readMeaning(one.text) });
    } catch (error) {
      return { readings, failure: error instanceof Error ? error : new Error(String(error)) };
    }
  }
  return { readings };
}

/** One line in the logs, saying which account and what happened to it. */
function say(accountName: string, what: string): void {
  console.info(
    JSON.stringify({ level: 'info', message: `backfilling what notes mean: ${what} (${accountName})` }),
  );
}
