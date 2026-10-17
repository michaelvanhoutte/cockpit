import type { env as testEnv } from 'cloudflare:test';
import type { EnrichmentJob, ProposeForClaudeJob } from '../src/jobs/enrichment.js';

/**
 * Every proposal for Claude the Worker queues, held instead of delivered
 * ("Propose what to do with each item before you look", issue 1161).
 *
 * **Held for every file, by `no-model.ts`**, because nobody waits for one: a
 * capture, its clean-up, an edit and a filing each queue one, and delivered on
 * the real queue it ran into the next case, against a store that case had
 * already emptied and a model that case had stubbed. The cases about
 * proposals deliver them with `proposeWhatWasHeld`, once what queued them has
 * finished.
 */
export const heldProposals: ProposeForClaudeJob[] = [];

/** Puts the hold on `env`'s queue, letting every other job through to the real one. */
export function holdProposalsForClaude(env: typeof testEnv): void {
  const queue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob, options?: QueueSendOptions) => {
      if (body.kind === 'propose-for-claude') {
        heldProposals.push(body);
        return;
      }
      await queue.send(body, options);
    },
    sendBatch: async (messages: Iterable<MessageSendRequest<EnrichmentJob>>, options?: QueueSendBatchOptions) => {
      await queue.sendBatch(messages, options);
    },
  } as unknown as typeof env.ENRICHMENT;
}

/**
 * Delivers every proposal held so far through the real consumer, in the order
 * they were queued - so an ask a later one took the place of does nothing, as
 * on the real queue once its window has passed.
 */
export async function proposeWhatWasHeld(env: typeof testEnv): Promise<void> {
  const { handleQueue } = await import('../src/jobs/index.js');
  for (const job of heldProposals.splice(0)) {
    const batch = {
      queue: 'cockpit-enrichment',
      messages: [{ id: crypto.randomUUID(), timestamp: new Date(), body: job, attempts: 1, ack: () => {}, retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    };
    await handleQueue(batch as unknown as Parameters<typeof handleQueue>[0], env);
  }
}
