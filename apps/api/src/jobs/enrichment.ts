import { z } from 'zod';
import type { Env } from '../env.js';
import {
  openAccount,
  AccountNotInRegisterError,
  NotFoundInAccountError,
} from '../accounts/index.js';
import { aiFor } from '../ai/index.js';

/**
 * Reading a captured note and proposing what to call it and what it said
 * ("Clean up a captured note into a clear title and a fuller message", issue
 * 296).
 *
 * A plain function calling `accounts/` and `ai/`; the queue is the adapter that
 * hands it a message (architecture, "Background jobs"), which is why nothing
 * here names a Cloudflare type and why every branch below is reachable in a
 * test that never opens a queue.
 */

/**
 * What is put on the queue when a note is captured.
 *
 * **An account and an item, and not the note itself.** Reading the note here
 * costs one call to a store that is warm anyway, and buys three things the
 * message could not: an item dismissed and erased in the meantime is found
 * before a model call is paid for, one whose texts have since been edited is
 * skipped for the same reason, and a note's words are not left sitting in a
 * queue as a second copy of something the account already holds.
 *
 * `kind` is what makes this queue able to carry the next job as well - the
 * connector pulls and reconciliation passes that "Background jobs" names - and
 * is what a message from before a deploy is refused by rather than
 * misinterpreted.
 */
export interface EnrichmentJob {
  kind: 'clean-up-a-note';
  accountName: string;
  itemId: string;
}

/**
 * A message is not a value from inside this program: it was written by a
 * previous version of this Worker and has been sitting on a queue, so it is
 * parsed like a request body rather than cast.
 */
export const enrichmentJobSchema = z.object({
  kind: z.literal('clean-up-a-note'),
  accountName: z.string().min(1),
  itemId: z.uuid(),
});

/**
 * Asks for a captured note to be cleaned up, without making the capture wait
 * for it or fail with it.
 *
 * **The only thing that enqueues one.** That is what decides what this feature
 * runs on: notes captured from this release onwards and nothing else. No sweep
 * exists and there is no backfill, so a title somebody wrote by hand before
 * this shipped is unreachable rather than merely skipped (issue 296, "What does
 * it run on?").
 *
 * **A queue that will not take the message loses the enrichment, not the
 * note.** Capture is the one thing in this product that may never fail for a
 * reason the person capturing cannot act on - it is what somebody does in a car
 * - and the Item is already written and already carries the mechanical title by
 * the time this runs. So the failure is logged and swallowed.
 */
export async function enqueueCleanUp(env: Env, accountName: string, itemId: string): Promise<void> {
  /**
   * **An environment that cannot read a note queues nothing**, rather than
   * queueing work its consumer will discard a moment later. That is local
   * development without a key, and it is every test in the suite - and the
   * queue round trip per capture is real: it cost the backend tiers a minute
   * and tipped two unrelated bulk cases past their timeouts before this line
   * existed. What says an environment is in that state is `/health`, not a log
   * line on every capture.
   *
   * The job asks the same question again, and that is not redundant: a key can
   * go away between here and there, and the job is entered from a queue rather
   * than only from here.
   */
  if (!env.ANTHROPIC_API_KEY) return;

  const job: EnrichmentJob = { kind: 'clean-up-a-note', accountName, itemId };
  try {
    await env.ENRICHMENT.send(job);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `item ${itemId} was captured but not queued for cleaning up: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

/**
 * Runs one job.
 *
 * **Every way this can decline is a return, and every way it can fail is a
 * throw**, because the two mean opposite things to the queue: a note nobody can
 * enrich must not be delivered again for ever, and a model that was rate-limited
 * must. So a missing key, a missing item, a note with nothing in it and a
 * proposal that will not validate all end here quietly with the Item keeping the
 * mechanical title capture wrote; only a call that failed is left to throw.
 */
export async function cleanUpACapturedNote(env: Env, job: EnrichmentJob): Promise<void> {
  const ai = aiFor(env);
  if (!ai) return say(job, 'nothing was enriched: this environment has no ANTHROPIC_API_KEY');

  let account;
  try {
    account = await openAccount(env, job.accountName);
  } catch (error) {
    // The account has left the register - somebody's access was taken away
    // while a note of theirs was queued. Nothing will make this job work, so it
    // declines rather than being redelivered until its retries run out.
    if (error instanceof AccountNotInRegisterError) {
      return say(job, 'nothing was enriched: the account is no longer in the register');
    }
    throw error;
  }

  const item = await account.item(job.itemId);
  // Not an error and not worth retrying: an item can be dismissed and erased
  // between capture and here, and an id that belongs to another account matches
  // no row because every query in the store filters on the account.
  if (!item) return say(job, 'nothing was enriched: no such item in this account');
  // Nothing to read. Only capture writes this column, and it writes what was
  // typed, so this is an Item that arrived by some other door.
  if (!item.capturedMessage) return say(job, 'nothing was enriched: the item has no captured note');
  // Somebody edited the title or the description while this was queued, so the
  // two texts are theirs. The store refuses the write for the same reason - this
  // is what stops a model call being paid for to be refused.
  if (item.textsSettledAt !== null) return say(job, 'nothing was proposed: the texts are already edited');

  const read = await ai.cleanUpNote(item.capturedMessage);
  if (!('proposal' in read)) return say(job, `nothing was proposed: ${read.discarded}`);

  try {
    await account.applyChange('propose_item_texts', {
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      // The Workspace the Item is in, which is the envelope's and not a
      // decision: an Item belonging to none is still in the one it was captured
      // from, and the store is what tells every other Workspace it changed.
      workspaceId: item.workspaceId,
      itemId: item.id,
      title: read.proposal.title,
      description: read.proposal.message,
    });
    // Which language it answered in, said out loud, because that is the rule
    // this prompt is most likely to break quietly and the only place a
    // deployment can be watched for it (issue 296, "The language rule needs a
    // structural answer").
    say(job, `proposed in ${read.proposal.language}`);
  } catch (error) {
    // The item went between the read above and this write. The same
    // not-worth-retrying case as above, arriving by the other door.
    if (error instanceof NotFoundInAccountError) {
      return say(job, 'nothing was written: the item went while the note was being read');
    }
    throw error;
  }
}

/** One line in the logs, saying which item and what happened to it. */
function say(job: EnrichmentJob, what: string): void {
  console.info(JSON.stringify({ level: 'info', message: `${what} (item ${job.itemId})` }));
}
