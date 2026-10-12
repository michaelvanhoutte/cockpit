import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import { emptyTheDatabase, send, totals, usage } from './support';

beforeEach(emptyTheDatabase);

/** The nightly rebuild, run the way the platform runs it. */
async function runTheNightlyJob() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '20 3 * * *' }), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe('Harness Monitor', () => {
  describe('daily totals always equal the stored requests', () => {
    it('a stored batch appears in its day, split by category and model', async () => {
      await send([
        usage('r1', { category: 'building', model: 'm1', inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 }),
        usage('r2', { category: 'building', model: 'm1', inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40 }),
        usage('r3', { category: 'after-push', model: 'm1', inputTokens: 100 }),
        usage('r4', { category: 'building', model: 'm2', inputTokens: 1000 }),
      ]);

      expect(await totals()).toEqual([
        { day: '2026-10-01', category: 'after-push', model: 'm1', requests: 1, input_tokens: 100, output_tokens: 20, cache_creation_tokens: 30, cache_read_tokens: 40 },
        { day: '2026-10-01', category: 'building', model: 'm1', requests: 2, input_tokens: 11, output_tokens: 22, cache_creation_tokens: 33, cache_read_tokens: 44 },
        { day: '2026-10-01', category: 'building', model: 'm2', requests: 1, input_tokens: 1000, output_tokens: 20, cache_creation_tokens: 30, cache_read_tokens: 40 },
      ]);
    });

    it('a request just after midnight UTC is in the new day, not the old', async () => {
      await send([
        usage('before', { time: '2026-10-01T23:59:59Z' }),
        usage('after', { time: '2026-10-02T00:00:01Z' }),
        usage('elsewhere', { time: '2026-10-02T01:30:00+02:00' }),
      ]);

      expect((await totals()).map((t) => [t.day, t.requests])).toEqual([
        ['2026-10-01', 2],
        ['2026-10-02', 1],
      ]);
    });

    it('totals that have drifted from the rows are restored by the nightly rebuild', async () => {
      await send([usage('r1', { inputTokens: 7 }), usage('r2', { inputTokens: 5 })]);
      const honest = await totals();
      await env.DB.prepare('UPDATE daily_totals SET input_tokens = 9999').run();
      await env.DB.prepare("INSERT INTO daily_totals (day, category, model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens) VALUES ('2020-01-01', 'building', 'ghost', 1, 1, 1, 1, 1)").run();

      await runTheNightlyJob();

      expect(await totals()).toEqual(honest);
    });

    it('with no rows at all the nightly rebuild leaves no totals and does not fail', async () => {
      await env.DB.prepare("INSERT INTO daily_totals (day, category, model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens) VALUES ('2020-01-01', 'building', 'ghost', 1, 1, 1, 1, 1)").run();

      await runTheNightlyJob();

      expect(await totals()).toEqual([]);
    });
  });
});
