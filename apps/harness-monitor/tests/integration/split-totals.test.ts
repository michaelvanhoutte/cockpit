import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { inject } from 'vitest';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import { emptyTheDatabase, send, spend, splitTotals, usage, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});

/** The nightly rebuild, run the way the platform runs it. */
async function runTheNightlyJob() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '20 3 * * *' }), env, ctx);
  await waitOnExecutionContext(ctx);
}

/** Local and Actions, main agent and subagent, on two branches and two models. */
const mixed = () => [
  usage('r1', { inputTokens: 1, ranWhere: 'local', subagent: false }),
  usage('r2', { inputTokens: 10, ranWhere: 'local', subagent: true }),
  usage('r3', { inputTokens: 100, ranWhere: 'actions', subagent: false, category: 'ci-reviews' }),
  usage('r4', { inputTokens: 1000, ranWhere: 'cloud', subagent: false, model: 'claude-opus-4-8', branch: null }),
  usage('r5', { inputTokens: 10_000, ranWhere: 'local', subagent: false }),
];

describe('Harness Monitor', () => {
  describe('the totals by where a request ran and by main session or subagent always equal the stored requests', () => {
    it('a batch mixing places and agents is held at each of their keys', async () => {
      await send(mixed());

      expect((await splitTotals()).map((t) => [t.branch, t.category, t.model, t.ran_where, t.subagent, t.requests])).toEqual([
        ['', 'building', 'claude-opus-4-8', 'cloud', 0, 1],
        ['claude/build-1', 'building', 'claude-sonnet-5-5', 'local', 0, 2],
        ['claude/build-1', 'building', 'claude-sonnet-5-5', 'local', 1, 1],
        ['claude/build-1', 'ci-reviews', 'claude-sonnet-5-5', 'actions', 0, 1],
      ]);
    });

    it('the nightly rebuild leaves the totals as writing the rows made them', async () => {
      await send(mixed());
      const written = await splitTotals();
      await env.DB.prepare('UPDATE daily_split_totals SET requests = 99, cost_micros = 1').run();
      await env.DB.prepare("INSERT INTO daily_split_totals VALUES ('2020-01-01', 'ghost', 'building', 'm', 'local', 0, 1, 1, 0, 0, 0, 0, 0, 1)").run();

      await runTheNightlyJob();

      expect(await splitTotals()).toEqual(written);
    });

    it('the migration over rows already stored builds the totals a rebuild would', async () => {
      await send([
        spend('p1', 3, { ranWhere: 'actions', subagent: true }),
        ...mixed(),
        usage('unpriced', { model: 'no-such-model', branch: 'b/x' }),
        usage('old', { time: '2026-09-20T12:00:00Z' }),
      ]);
      const written = await splitTotals();
      expect(written.some((t) => t.category === 'unphased')).toBe(true);
      await env.DB.prepare('DROP TABLE daily_split_totals').run();
      const migration = inject('migrations').find((m) => m.name.startsWith('0009_split_totals'))!;

      for (const query of migration.queries) await env.DB.prepare(query).run();

      expect(await splitTotals()).toEqual(written);
      await runTheNightlyJob();
      expect(await splitTotals()).toEqual(written);
    });

    it('the same request sent twice is counted once', async () => {
      await send(mixed());
      const once = await splitTotals();

      await send(mixed());

      expect(await splitTotals()).toEqual(once);
    });
  });
});
