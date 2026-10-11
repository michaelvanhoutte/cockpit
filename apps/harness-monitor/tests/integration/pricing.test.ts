import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dollars,
  emptyTheDatabase,
  pricing,
  recordedFile,
  runTheDailyJob,
  send,
  theFileAnswers,
  costRows,
  thePage,
  usage,
} from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.unstubAllGlobals());

/** The recorded file with one more model on it, copied from a recorded entry. */
const withModel = (name: string, rates: Record<string, unknown> = {}) => ({
  ...recordedFile,
  [name]: { ...recordedFile['claude-sonnet-5'], ...rates },
});

// On the recorded file claude-sonnet-5 is $2 in, $10 out, $0.20 cache read, $2.50 cache write, per million tokens.
const aMillionInAndATenthOut = { inputTokens: 1_000_000, outputTokens: 100_000, cacheCreationTokens: 0, cacheReadTokens: 0 };
const THREE_DOLLARS = 3_000_000;

describe('Harness Monitor', () => {
  describe('a model with no price is never counted as free', () => {
    beforeEach(async () => {
      theFileAnswers(recordedFile);
      await runTheDailyJob();
    });

    const storedRequests = () =>
      send([
        usage('paid', { model: 'claude-sonnet-5', ...aMillionInAndATenthOut }),
        usage('waiting-1', { model: 'claude-future-1', branch: 'claude/build-7', inputTokens: 500, outputTokens: 70, cacheCreationTokens: 3, cacheReadTokens: 2 }),
        usage('waiting-2', { model: 'claude-future-1', branch: 'claude/build-8', inputTokens: 500, outputTokens: 30, cacheCreationTokens: 0, cacheReadTokens: 0 }),
        usage('waiting-3', { model: 'claude-future-1', branch: 'claude/build-8' }),
      ]);

    it('a request for an unpriced model is stored without a cost, out of the dollar totals and named in the warning', async () => {
      await storedRequests();

      expect((await pricing()).map((p) => [p.request_id, p.cost_micros])).toEqual([
        ['paid', THREE_DOLLARS],
        ['waiting-1', null],
        ['waiting-2', null],
        ['waiting-3', null],
      ]);
      expect(await dollars()).toEqual({ micros: THREE_DOLLARS, unpriced: 3 });
      const page = await thePage('?period=all');
      expect(page).toContain('Tokens with no price');
      // model, requests, input, output, cache write, cache read, and two distinct branches
      expect(page).toContain('<tr><td>claude-future-1</td><td>3</td><td>1,010</td><td>120</td><td>33</td><td>42</td><td>2</td></tr>');
      expect(costRows(page).map((r) => [r.label, r.total, r.unpriced])).toEqual([
        ['claude/build-1', '$3.00', null],
        ['claude/build-7', '$0.00', '+ 1 unpriced'],
        ['claude/build-8', '$0.00', '+ 2 unpriced'],
      ]);
    });

    it('when the list gains that model the daily job prices the waiting rows and the warning goes', async () => {
      await storedRequests();

      theFileAnswers(withModel('claude-future-1'));
      await runTheDailyJob();

      expect(await pricing()).toEqual([
        { request_id: 'paid', cost_micros: THREE_DOLLARS, price_basis: 'arrival' },
        // 500 in at $2, 70 out at $10, 3 written at $2.50, 2 read at $0.20, per million tokens
        { request_id: 'waiting-1', cost_micros: Math.round(500 * 2 + 70 * 10 + 3 * 2.5 + 2 * 0.2), price_basis: 'daily-job' },
        { request_id: 'waiting-2', cost_micros: 500 * 2 + 30 * 10, price_basis: 'daily-job' },
        { request_id: 'waiting-3', cost_micros: 10 * 2 + 20 * 10 + 30 * 2.5 + 40 * 0.2, price_basis: 'daily-job' },
      ]);
      expect(await dollars()).toEqual({ micros: THREE_DOLLARS + 1708 + 1300 + 303, unpriced: 0 });
      expect(await thePage()).not.toContain('Tokens with no price');
    });

    it('when the list changes a rate, requests already priced keep their cost', async () => {
      await storedRequests();
      const before = await dollars();

      theFileAnswers(withModel('claude-sonnet-5', { input_cost_per_token: 0.00001 }));
      await runTheDailyJob();

      expect((await pricing()).find((p) => p.request_id === 'paid')!.cost_micros).toBe(THREE_DOLLARS);
      expect(await dollars()).toEqual(before);
    });

    it('a request for a model priced only for some kinds of token waits rather than costing nothing', async () => {
      theFileAnswers(withModel('claude-partial', { cache_read_input_token_cost: undefined }));
      await runTheDailyJob();

      await send([
        usage('reads', { model: 'claude-partial', cacheReadTokens: 5 }),
        usage('no-reads', { model: 'claude-partial', cacheReadTokens: 0 }),
      ]);

      expect((await pricing()).map((p) => [p.request_id, p.cost_micros === null])).toEqual([
        ['no-reads', false],
        ['reads', true],
      ]);
    });
  });

  describe('a failed price fetch keeps the last good list', () => {
    const goodListFetchedHoursAgo = async (hours: number) => {
      theFileAnswers(recordedFile);
      await runTheDailyJob();
      await env.DB.prepare('UPDATE price_list SET fetched_at = ?')
        .bind(Date.now() - hours * 3_600_000)
        .run();
    };

    it.each([
      { situation: 'the fetch is refused', answer: new Response('down', { status: 503 }), why: 'LiteLLM answered 503' },
      {
        situation: 'the network is unreachable',
        answer: () => {
          throw new TypeError('network lost');
        },
        why: 'network lost',
      },
      { situation: 'the file is not JSON', answer: new Response('<html>oops</html>'), why: 'The fetch failed' },
      { situation: 'the file is an empty list', answer: {}, why: 'not a price list' },
      { situation: 'the file has nothing we price', answer: { 'gpt-4o': { litellm_provider: 'openai' } }, why: 'not a price list' },
    ])('$situation: prices are unchanged and the page says how old the list is', async ({ answer, why }) => {
      await goodListFetchedHoursAgo(5);

      theFileAnswers(answer);
      await runTheDailyJob();

      await send([usage('after', { model: 'claude-sonnet-5', ...aMillionInAndATenthOut })]);
      expect((await pricing())[0]!.cost_micros).toBe(THREE_DOLLARS);
      const page = await thePage();
      expect(page).toContain('Price list fetched 5 hours ago');
      expect(page).toContain(why);
      expect(page).toContain('the last good list is still in use');
    });

    it('a list that has never been fetched says so, and nothing is priced from it', async () => {
      theFileAnswers(new Response('down', { status: 503 }));
      await runTheDailyJob();

      await send([usage('first', { model: 'claude-sonnet-5' })]);

      expect((await pricing())[0]!.cost_micros).toBeNull();
      expect(await thePage()).toContain('No price list has been fetched yet');
    });

    it('a successful fetch after a failure clears the failure from the page', async () => {
      await goodListFetchedHoursAgo(5);
      theFileAnswers(new Response('down', { status: 503 }));
      await runTheDailyJob();

      theFileAnswers(recordedFile);
      await runTheDailyJob();

      const page = await thePage();
      expect(page).toContain('Price list fetched 0 minutes ago');
      expect(page).not.toContain('failed');
    });
  });

  describe('history is priced at upload and says so', () => {
    it('an uploaded row is priced from the list current at upload and marked; a hook row is marked as priced on arrival', async () => {
      theFileAnswers(recordedFile);
      await runTheDailyJob();

      await send([
        usage('uploaded', { source: 'upload', model: 'claude-sonnet-5', ...aMillionInAndATenthOut }),
        usage('hooked', { source: 'hook', model: 'claude-sonnet-5', ...aMillionInAndATenthOut }),
      ]);
      theFileAnswers(withModel('claude-sonnet-5', { input_cost_per_token: 0.00001 }));
      await runTheDailyJob();

      expect(await pricing()).toEqual([
        { request_id: 'hooked', cost_micros: THREE_DOLLARS, price_basis: 'arrival' },
        { request_id: 'uploaded', cost_micros: THREE_DOLLARS, price_basis: 'upload' },
      ]);
    });

    it('an uploaded row for an unpriced model waits, and is marked as priced by the daily job once it is', async () => {
      theFileAnswers(recordedFile);
      await runTheDailyJob();
      await send([usage('old', { source: 'upload', model: 'claude-future-1' })]);

      theFileAnswers(withModel('claude-future-1'));
      await runTheDailyJob();

      expect((await pricing())[0]!.price_basis).toBe('daily-job');
    });
  });

  describe('daily totals always equal the stored requests', () => {
    it('the nightly rebuild keeps the dollars and the unpriced count the rows add up to', async () => {
      theFileAnswers(recordedFile);
      await runTheDailyJob();
      await send([
        usage('paid', { model: 'claude-sonnet-5', ...aMillionInAndATenthOut }),
        usage('waiting', { model: 'claude-future-1' }),
      ]);
      const honest = await dollars();
      await env.DB.prepare('UPDATE daily_totals SET cost_micros = 1, unpriced_requests = 9').run();

      await runTheDailyJob();

      expect(await dollars()).toEqual(honest);
      expect(honest).toEqual({ micros: THREE_DOLLARS, unpriced: 1 });
    });
  });
});
