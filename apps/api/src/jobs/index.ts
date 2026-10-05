import type { Message, MessageBatch, ScheduledController } from '@cloudflare/workers-types';
import type { Env } from '../env.js';
import { keepEveryAccountCheckingGmail, resetGuestAccount } from '../accounts/index.js';
import { purgeOldSignIns } from '../auth/sign-in-history.js';
import {
  cleanUpACapturedNote,
  enrichmentJobSchema,
  readWhatANoteMeans,
  reproposePanels,
  reproposeTexts,
  type EnrichmentJob,
} from './enrichment.js';

export {
  cleanUpACapturedNote,
  enqueueCleanUp,
  enqueueReadingItsMeaning,
  enqueueRepropose,
  enqueueReproposeTexts,
  enrichmentJobSchema,
  readWhatANoteMeans,
  reproposePanels,
  reproposeTexts,
} from './enrichment.js';
export type {
  EnrichmentJob,
  CleanUpJob,
  ReadWhatItMeansJob,
  ReproposePanelsJob,
  ReproposeTextsJob,
} from './enrichment.js';
export { CannotReadMeaningError, readWhatTheseNotesMean } from './backfill-meanings.js';
export type { BatchRead } from './backfill-meanings.js';

/**
 * Background jobs (architecture, "Background jobs"): plain functions calling
 * domain/ and accounts/; the queue and cron are adapters.
 *
 * **Everything Cron Triggers run, once a night.** `wrangler.jsonc` declares a
 * single schedule, so there is nothing to dispatch on: every nightly job runs
 * on every tick, each caught on its own so that one failing costs only itself.
 * Connector sync cadences, reconciliation passes and the dead-man's-switch
 * watchdog (architecture, "Observability") dispatch from here too, added as
 * their own issues build them.
 *
 * **It queues nothing.** The nightly filing summary that once did is gone
 * ("Drop the nightly filing summary, keep the sentence you wrote", issue 392);
 * what runs is the guest reset, the sign-in history purge, and re-arming any
 * Gmail check that was lost with each Gmail connection's full reconcile
 * started again - each idempotent, so a tick run twice changes nothing the
 * first did not.
 */
export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  void controller;
  await resetTheGuestAccount(env);
  await purgeTheOldSignIns(env);
  await keepCheckingGmail(env);
}

/**
 * Every account holding a Gmail connection has its check armed again where it
 * was lost ("Bring in the conversations already labelled Cockpit as tasks",
 * issue 725) - one account failing is logged inside, and the rest go on.
 */
async function keepCheckingGmail(env: Env): Promise<void> {
  try {
    await keepEveryAccountCheckingGmail(env);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `Gmail checks were not looked at tonight: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

/**
 * The sign-in history is kept 12 months and the nightly run removes the rest
 * ("Record every sign-in, with guest activity, for 12 months", issue 653).
 * Caught on its own like the reset beside it: one failing costs only itself,
 * and the next night removes what this one left.
 */
async function purgeTheOldSignIns(env: Env): Promise<void> {
  try {
    await purgeOldSignIns(env, new Date());
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `old sign-in history was not removed tonight: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

/**
 * The nightly half of the guest reset; `pnpm guest:reset` is the other, and
 * both are `resetGuestAccount`. An environment with no guest account - staging
 * - is not a failure, so it passes without a word.
 */
async function resetTheGuestAccount(env: Env): Promise<void> {
  try {
    await resetGuestAccount(env);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `the guest account was not reset tonight, and holds what it held: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
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
 *
 * **Several refreshes of one Workspace's panels, or of one account's texts,
 * are not collapsed here.** Each carries the ask it was queued for, and every
 * one but the latest finds itself superseded once it runs and does nothing
 * (`src/jobs/debounce.ts`) - across the whole debounce window rather than
 * only within one batch ("Debounce the settle-triggered repropose fan-out
 * across a real time window", issue 582).
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
        message: `job ${job.data.kind}, ${describe(job.data)}, will be tried again: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
    /**
     * **After a minute, not at once.** Cloudflare's own default delay is zero,
     * so a bare `retry()` redelivers immediately - and the thing most likely to
     * bring a job here is a rate limit, which three instant redeliveries burn
     * inside the same window that caused them. Nothing is enriched and the
     * message is then dropped, there being no dead-letter queue, which is the
     * one outcome the SDK's own `maxRetries: 1` was capped for
     * (`ai/index.ts`): the queue is the retry that is supposed to wait.
     *
     * Chosen here rather than as `retry_delay` in wrangler.jsonc, so the delay
     * sits beside the reason for it and there is one number rather than one per
     * environment.
     */
    message.retry({ delaySeconds: 60 });
  }
}

/** Which job a message is, dispatched on the discriminant `kind` names. */
function run(env: Env, job: EnrichmentJob): Promise<void> {
  switch (job.kind) {
    case 'clean-up-a-note':
      return cleanUpACapturedNote(env, job);
    case 're-propose-panels':
      return reproposePanels(env, job);
    case 'read-what-a-note-means':
      return readWhatANoteMeans(env, job);
    case 're-propose-texts':
      return reproposeTexts(env, job);
  }
}

/** What a job is about, for the retry log line above - the one thing a job's own `kind` does not say. */
function describe(job: EnrichmentJob): string {
  switch (job.kind) {
    case 'clean-up-a-note':
    case 'read-what-a-note-means':
      return `item ${job.itemId}`;
    case 're-propose-panels':
      return `workspace ${job.workspaceId}`;
    case 're-propose-texts':
      return `account ${job.accountName}`;
  }
}
