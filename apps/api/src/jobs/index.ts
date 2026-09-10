import type { Message, MessageBatch, ScheduledController } from '@cloudflare/workers-types';
import type { Env } from '../env.js';
import { cleanUpACapturedNote, enrichmentJobSchema, reproposePanels, type EnrichmentJob } from './enrichment.js';

export { cleanUpACapturedNote, enqueueCleanUp, enqueueRepropose, enrichmentJobSchema, reproposePanels } from './enrichment.js';
export type { EnrichmentJob, CleanUpJob, ReproposePanelsJob } from './enrichment.js';

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
 *
 * **A `re-propose-panels` message is deduplicated against its own batch
 * first.** Filing several items in quick succession queues one of these per
 * settle, but a refresh reads whatever is unsettled *when it runs* - so two
 * for the same account and Workspace landing in the same batch would redo
 * the identical read and write it twice for nothing new ("Re-propose the
 * rest of the inbox the moment you file one", issue 300, "several at once
 * should fire one refresh, not one per item"). `max_batch_timeout` is one
 * second (wrangler.jsonc) precisely so a burst of filings has a real chance
 * of landing in one batch; a second burst outside that window still gets its
 * own refresh, which is the honest limit rather than a bug.
 */
export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const messages = dedupeReproposals(batch.messages);
  await Promise.all(messages.map((message) => workThrough(message, env)));
}

/**
 * Keeps the first `re-propose-panels` message per account-and-Workspace in
 * this batch, acknowledging the rest unread rather than letting them queue a
 * second, redundant refresh - every other kind passes through untouched.
 * Reads `message.body` loosely, ahead of `enrichmentJobSchema`'s own parse in
 * `workThrough`: a body this cannot make sense of is simply not deduplicated,
 * and reaches the real parse exactly as it would have otherwise.
 */
function dedupeReproposals(messages: readonly Message<unknown>[]): Message<unknown>[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const body = message.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      (body as Record<string, unknown>).kind !== 're-propose-panels'
    ) {
      return true;
    }
    const { accountName, workspaceId } = body as Record<string, unknown>;
    if (typeof accountName !== 'string' || typeof workspaceId !== 'string') return true;

    const key = `${accountName}:${workspaceId}`;
    if (seen.has(key)) {
      message.ack();
      return false;
    }
    seen.add(key);
    return true;
  });
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
  }
}

/** What a job is about, for the retry log line above - the one thing a job's own `kind` does not say. */
function describe(job: EnrichmentJob): string {
  switch (job.kind) {
    case 'clean-up-a-note':
      return `item ${job.itemId}`;
    case 're-propose-panels':
      return `workspace ${job.workspaceId}`;
  }
}
