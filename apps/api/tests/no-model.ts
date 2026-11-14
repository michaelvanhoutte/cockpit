import { beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { heldProposals, holdWhatNobodyWaitsFor } from './held-proposals.js';

/**
 * No model, in any tier this config drives.
 *
 * `ANTHROPIC_API_KEY` and `EMBEDDINGS_STAND_IN` are pinned empty where the
 * bindings are declared (vitest.config.ts) because both are values; the Workers
 * AI binding is an object the runtime puts there, so taking it away has to
 * happen inside the worker - which is what a setup file is. Without it every
 * capture in the suite queues a reading and the consumer spends a real call
 * against the real service.
 *
 * A case that wants a reading puts one back on `env` and answers it itself, the
 * same way a case that wants a Claude answer sets the key and fakes the network
 * under it.
 */
Reflect.deleteProperty(env as unknown as Record<string, unknown>, 'AI');

/**
 * Nor a proposal for Claude that nobody asked to see: each is held, even where
 * a case sets a key, and a case about them delivers them (`held-proposals.ts`).
 * Each case starts with none held, so it delivers only what it queued. A
 * guest's delayed arrivals are dropped there too.
 */
holdWhatNobodyWaitsFor(env);
beforeEach(() => {
  heldProposals.length = 0;
});
