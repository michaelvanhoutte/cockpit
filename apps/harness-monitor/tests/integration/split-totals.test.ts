import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import { emptyTheDatabase, send, splitTokens, splitTotals, usage, withPrices } from './support';

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

    it('with the old per-branch table dropped by migration 0013, a batch still counts its rows and the nightly rebuild succeeds', async () => {
      const old = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_branch_totals'").all();
      expect(old.results).toEqual([]);

      await send(mixed());
      const written = await splitTotals();
      expect(written.reduce((sum, t) => sum + t.requests, 0)).toBe(5);

      await runTheNightlyJob();
      expect(await splitTotals()).toEqual(written);
    });

    it('with the old split table dropped by migration 0026, a batch still counts its rows and the nightly rebuild succeeds', async () => {
      const old = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_split_totals'").all();
      expect(old.results).toEqual([]);

      await send(mixed());
      const written = await splitTotals();
      expect(written.reduce((sum, t) => sum + t.requests, 0)).toBe(5);

      await runTheNightlyJob();
      expect(await splitTotals()).toEqual(written);
    });

    it('the nightly rebuild leaves the totals as writing the rows made them', async () => {
      await send(mixed());
      const written = await splitTotals();
      await env.DB.prepare('UPDATE daily_credited_totals SET requests = 99, cost_micros = 1').run();
      await env.DB.prepare(
        `INSERT INTO daily_credited_totals (day, branch, category, model, ran_where, subagent, credit_branch, requests, cost_micros, unpriced_requests,
           unpriced_input_tokens, unpriced_output_tokens, unpriced_cache_creation_tokens, unpriced_cache_read_tokens, last_at,
           input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
         VALUES ('2020-01-01', 'ghost', 'building', 'm', 'local', 0, '', 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0)`,
      ).run();

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

  describe("the split totals' tokens always equal the stored requests' tokens", () => {
    /** mixed()'s tokens at each key: input, output, cache write, cache read. */
    const mixedTokens = [
      ['', 'claude-opus-4-8', 1000, 20, 30, 40],
      ['claude/build-1', 'claude-sonnet-5-5', 10_001, 40, 60, 80],
      ['claude/build-1', 'claude-sonnet-5-5', 10, 20, 30, 40],
      ['claude/build-1', 'claude-sonnet-5-5', 100, 20, 30, 40],
    ];
    const zeroed = mixedTokens.map(([branch, model]) => [branch, model, 0, 0, 0, 0]);
    const forgetTheTokens = () => env.DB.prepare('UPDATE daily_credited_totals SET input_tokens = 0, output_tokens = 0, cache_creation_tokens = 0, cache_read_tokens = 0').run();

    it('a batch of requests on two branches and two models holds at each key the four kinds its requests carried', async () => {
      await send(mixed());

      expect(await splitTokens()).toEqual(mixedTokens);
    });

    it('the same request sent twice has its tokens counted once', async () => {
      await send(mixed());
      await send(mixed());

      expect(await splitTokens()).toEqual(mixedTokens);
    });

    it('the nightly rebuild after writes leaves the tokens as writing the rows made them', async () => {
      await send(mixed());
      await env.DB.prepare('UPDATE daily_credited_totals SET input_tokens = 99, cache_read_tokens = 1').run();

      await runTheNightlyJob();

      expect(await splitTokens()).toEqual(mixedTokens);
    });

    it('a split row the old code wrote after the migration, without tokens, is given its requests\' tokens by the rebuild', async () => {
      await send(mixed());
      await forgetTheTokens();
      expect(await splitTokens()).toEqual(zeroed);

      await runTheNightlyJob();

      expect(await splitTokens()).toEqual(mixedTokens);
    });
  });
});
