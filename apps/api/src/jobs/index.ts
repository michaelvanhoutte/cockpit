import type { Message, MessageBatch, ScheduledController } from '@cloudflare/workers-types';
import type { Env } from '../env.js';
import { cleanUpACapturedNote, enrichmentJobSchema, type EnrichmentJob } from './enrichment.js';

export { cleanUpACapturedNote, enqueueCleanUp, enrichmentJobSchema } from './enrichment.js';
export type { EnrichmentJob } from './enrichment.js';

/**
 * Background jobs (architecture, "Background jobs"): plain functions calling
 * domain/ and accounts/; the queue and cron are adapters. Cron Triggers get
 * enabled in wrangler.jsonc when the first connector sync lands; the queue is
 * wired there already, for the enrichment below.
 */
export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  void controller;
  void env;
  // Connector sync cadences, reconciliation passes, and the dead-man's-switch
  // watchdog (architecture, "Observability") are dispatched from here.
}

/**
 * Everything on the enrichment queue, one message at a time.
 *
 * **Acknowledged and retried per message, not per batch.** Throwing out of here
 * would put every other message in the batch back on the queue along with the
 * one that failed, so a single rate-limited call would re-run notes that had
 * already been written - and `propose_item_texts` refusing the second write is
 * a guard, not a licence to spend the model call twice.
 *
 * **A message that is not a job it recognises is dropped, not retried.** It can
 * only have been written by a version of this Worker that is no longer
 * deployed, and no number of redeliveries will make this one understand it.
 *
 * **The batch is worked through at once, not one after another.** Every job in
 * it waits seconds on a model, and the jobs are independent - different items,
 * and the account's own store serialises the writes itself - so a batch of five
 * taken in turn is half a minute of a consumer doing nothing but waiting. Each
 * message still decides its own outcome inside its own callback, which is what
 * keeps the acknowledgement per message rather than per batch.
 */
export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map((message) => workThrough(message, env)));
}

async function workThrough(message: Message<unknown>, env: Env): Promise<void> {
  const job = enrichmentJobSchema.safeParse(message.body);
  if (!job.success) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `a queued job was not one this version knows: ${job.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      }),
    );
    message.ack();
    return;
  }

  try {
    await run(env, job.data);
    message.ack();
  } catch (error) {
    // Worth trying again: everything the job itself decides ends in a return,
    // so what reaches here is a call that failed - a model that was
    // rate-limited, a store that could not be brought up to date.
    console.error(
      JSON.stringify({
        level: 'error',
        message: `job ${job.data.kind} for item ${job.data.itemId} will be tried again: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
    message.retry();
  }
}

/** Which job a message is. One kind today; the discriminant is what makes a second one additive. */
function run(env: Env, job: EnrichmentJob): Promise<void> {
  switch (job.kind) {
    case 'clean-up-a-note':
      return cleanUpACapturedNote(env, job);
  }
}
