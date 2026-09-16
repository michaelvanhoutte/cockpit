import type { Env } from '../env.js';
import { openAccount } from '../accounts/index.js';
import {
  asFarAsItReads,
  embeddingsFor,
  EMBEDDING_MODEL,
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
  /** Items dealt with between being picked up and being written - not a failure. */
  wentAway: string[];
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
 * **A reading that fails throws, and what was already read is written first.**
 * The model is the one thing here that is worth trying again, and the calls
 * already paid for in this batch would otherwise be spent twice - so they land,
 * and the command reports where it stopped.
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
    return { read: [], couldNotBeRead: [], wentAway: [], lastLooked: after, more: false };
  }

  const readings: { itemId: string; reading: number[] }[] = [];
  const couldNotBeRead: string[] = [];
  try {
    for (const candidate of candidates) {
      // An Item whose Title and Description are both empty or only whitespace
      // is not a note that means something obscure - it is a note with nothing
      // in it, and asking the model about it spends a call to be told so. It
      // keeps its place in the walk and is counted rather than passed over in
      // silence, the same rule the job that reads a captured note applies
      // (`readWhatANoteMeans`, enrichment.ts).
      const said = whatAnItemSays(candidate);
      if (!said) {
        couldNotBeRead.push(candidate.id);
        continue;
      }
      readings.push({ itemId: candidate.id, reading: await embeddings.readMeaning(asFarAsItReads(said)) });
    }
  } catch (error) {
    await account.rememberWhatTheseItemsMean(EMBEDDING_MODEL, readings);
    throw error;
  }

  const { remembered } = await account.rememberWhatTheseItemsMean(EMBEDDING_MODEL, readings);
  const written = new Set(remembered);
  const lastLooked = candidates[candidates.length - 1]!.id;
  say(
    accountName,
    `read ${remembered.length}, ${couldNotBeRead.length} with nothing written on them, up to item ${lastLooked}`,
  );
  return {
    read: remembered,
    couldNotBeRead,
    wentAway: readings.map((one) => one.itemId).filter((itemId) => !written.has(itemId)),
    lastLooked,
    // A short batch is the end of the walk. A full one may or may not be, and
    // asking again for an empty answer is one cheap query against being told
    // the run finished when it had not.
    more: candidates.length === limit,
  };
}

/** One line in the logs, saying which account and what happened to it. */
function say(accountName: string, what: string): void {
  console.info(
    JSON.stringify({ level: 'info', message: `backfilling what notes mean: ${what} (${accountName})` }),
  );
}
