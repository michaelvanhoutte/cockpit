import { env } from 'cloudflare:test';

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
