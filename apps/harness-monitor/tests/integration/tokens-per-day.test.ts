import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, send, spend, theBarePage, usage, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A request carrying exactly these tokens: input, output, cache write, cache read. */
const tokens = (requestId: string, [input, output, cacheWrite, cacheRead]: number[], over: Record<string, unknown> = {}) =>
  usage(requestId, { inputTokens: input, outputTokens: output, cacheCreationTokens: cacheWrite, cacheReadTokens: cacheRead, ...over });

/** The Tokens per day chart alone. */
const tokensPerDay = (html: string) => /<section class="panel" aria-labelledby="tokensperday">.*?<\/section>/s.exec(html)?.[0] ?? null;

/** What Over time's table says of each day: its total, then Input, Output, Cache write and Cache read. */
const days = async (query: string) => costRows(await theBarePage(`?period=all${query}`)).map((r) => [r.label, r.total, ...r.tokens]);

describe('Harness Monitor', () => {
  describe("a day's tokens on the costs page are its kept requests' tokens, by kind", () => {
    it('a day with requests on two models reads Input, Output, Cache write and Cache read summed over both', async () => {
      await send([tokens('a', [1000, 200, 30, 4], { model: 'claude-sonnet-5' }), tokens('b', [2000, 100, 20, 1], { model: 'claude-opus-4-8' })]);

      expect((await days('')).map(([label, , ...kinds]) => [label, ...kinds])).toEqual([['1 Oct 2026', '3,000', '300', '50', '5']]);
    });

    it("the Engineer filter keeps only the engineer's pull requests' tokens", async () => {
      await send([tokens('a', [1000, 0, 0, 0], { branch: 'b/alice' }), tokens('b', [20, 0, 0, 0], { branch: 'b/bob' }), tokens('u', [300, 0, 0, 0], { branch: 'b/nobody' })]);
      await linked(
        pullRequest({ number: 1, title: 'Alice’s', headRefName: 'b/alice', author: { login: 'alice' } }),
        pullRequest({ number: 2, title: 'Bob’s', headRefName: 'b/bob', author: { login: 'bob' } }),
      );

      expect((await days('&engineer=bob')).map((d) => d[2])).toEqual(['20']);
      expect((await days('&engineer=~unattributed')).map((d) => d[2])).toEqual(['300']);
    });

    it("Requests: subagents keeps only subagent requests' tokens", async () => {
      await send([tokens('main', [1000, 0, 0, 0], { subagent: false }), tokens('sub', [0, 70, 0, 0], { subagent: true })]);

      expect((await days('&who=subagents')).map(([, , ...kinds]) => kinds)).toEqual([['0', '70', '0', '0']]);
    });

    it('an unpriced request has its tokens counted and its dollars still left out', async () => {
      await send([spend('paid', 1), tokens('unpriced', [10, 20, 30, 40], { model: 'no-such-model' })]);

      const [day] = costRows(await theBarePage('?period=all'));

      expect([day!.total, day!.unpriced, ...day!.tokens]).toEqual(['$1.00', '+ 1 unpriced', '500k', '20', '30', '40']);
    });

    it('a day above two billion cache-read tokens reads exactly, as 2.xxB', async () => {
      await send([tokens('huge', [0, 0, 0, 2_345_000_000])]);

      expect((await days('')).map((d) => d.at(-1))).toEqual(['2.35B']);
    });
  });

  describe('Tokens per day is drawn on Over time alone, under Cost per day', () => {
    it('Over time split by phase draws it after Cost per day, a line per phase with tokens and a dashed total, each point titled with its tokens', async () => {
      await send([tokens('a', [10_000, 2000, 0, 0], { category: 'building' }), tokens('b', [0, 0, 0, 500], { category: 'after-push', model: 'no-such-model' })]);
      // Today is the requests' day, so the range is that one day.
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T12:00:00Z') });

      const html = await theBarePage('?period=all');
      const chart = tokensPerDay(html)!;

      expect(html.indexOf('id="tokensperday"')).toBeGreaterThan(html.indexOf('id="perday"'));
      expect(html.indexOf('id="tokensperday"')).toBeLessThan(html.indexOf('aria-label="Cost by day"'));
      expect(chart).toContain('<h2 id="tokensperday">Tokens per day</h2>');
      expect([...chart.matchAll(/<g data-line="([^"]*)">/g)].map((m) => m[1])).toEqual(['building', 'after-push', 'total']);
      expect(/<g data-line="total"><polyline[^>]* stroke-dasharray="6 4"/.test(chart)).toBe(true);
      expect([...chart.matchAll(/<title>(.*?)<\/title>/g)].map((m) => m[1])).toEqual(['Building · 1 Oct 2026 · 12k tokens', 'After push · 1 Oct 2026 · 500 tokens', 'Total · 1 Oct 2026 · 13k tokens']);
    });

    it('split by model, a model with tokens and no price has its line, which Cost per day does not draw', async () => {
      await send([spend('paid', 1, { model: 'claude-sonnet-5' }), tokens('unpriced', [10, 20, 30, 40], { model: 'no-such-model' })]);

      const html = await theBarePage('?period=all&split=model');
      const lines = (section: string) => [...section.matchAll(/<g data-line="([^"]*)">/g)].map((m) => m[1]);

      expect(lines(tokensPerDay(html)!)).toEqual(['claude-sonnet-5', 'no-such-model', 'total']);
      expect(lines(/<section class="panel" aria-labelledby="perday">.*?<\/section>/s.exec(html)![0])).toEqual(['claude-sonnet-5', 'total']);
    });

    it('grouped by pull request there is no Tokens per day and no token column in the table', async () => {
      await send([tokens('a', [10_000, 0, 0, 0])]);

      const html = await theBarePage('?period=all&group=pr');

      expect(tokensPerDay(html)).toBeNull();
      expect(html).not.toContain('<th scope="col" class="num">Cache read</th>');
      expect(costRows(html).map((r) => r.tokens)).toEqual([[]]);
    });

    it('with nothing in the period there is no Tokens per day, and the table says nothing is in the period', async () => {
      const html = await theBarePage('?period=all');

      expect(tokensPerDay(html)).toBeNull();
      expect(html).toContain('Nothing in this period.');
    });
  });
});
