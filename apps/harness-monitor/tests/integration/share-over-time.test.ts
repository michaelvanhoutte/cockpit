import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { emptyTheDatabase, send, spend, theBarePage, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => {
  vi.useRealTimers();
});

/** The share chart's panel alone; '' where the page draws none. */
const shareChart = (html: string) => /<section class="panel" id="share".*?<\/section>\s*<\/div>\s*<\/section>/s.exec(html)?.[0] ?? '';
/** Each line of the chart as its points read, keyed by the line ("week of 5 Oct 2026 · 76%" as "5 Oct 2026 · 76%"). */
const lines = (html: string): Record<string, string[]> =>
  Object.fromEntries(
    [...shareChart(html).matchAll(/<g data-line="([^"]*)">(.*?)<\/g>/gs)].map(([, key, body]) => [
      key!,
      [...body!.matchAll(/<title>(.*?)<\/title>/g)].map((t) => t[1]!.split(' · ').slice(1).join(' · ').replace('week of ', '')),
    ]),
  );
const title = (html: string) => /<h2 id="share-band">(.*?)<\/h2>/.exec(shareChart(html))?.[1] ?? null;

describe('Harness Monitor', () => {
  describe('Share per day or week shows how the dollars were split, over time, on Over time', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
    });

    it('is drawn last before the By day table, under Tokens per day, at its own address', async () => {
      await send([spend('a', 3, { model: 'claude-sonnet-5' })]);

      const html = await theBarePage('?period=all&split=model');

      expect(title(html)).toBe('Share per week, by model');
      expect(html.indexOf('id="share"')).toBeGreaterThan(html.indexOf('id="tokensperday"'));
      expect(html.indexOf('id="share"')).toBeLessThan(html.indexOf('aria-label="Cost by day"'));
    });

    it.each([
      { period: '7d', word: 'day', note: 'Of each day&rsquo;s dollars' },
      { period: '30d', word: 'day', note: 'Of each day&rsquo;s dollars' },
      { period: '90d', word: 'week', note: 'Of each week&rsquo;s dollars, from Monday' },
      { period: 'all', word: 'week', note: 'Of each week&rsquo;s dollars, from Monday' },
    ])('over $period it is titled per $word and noted "$note"', async ({ period, word, note }) => {
      await send([spend('a', 3, { model: 'claude-sonnet-5', time: '2026-10-29T10:00:00Z' })]);

      const html = await theBarePage(`?period=${period}&split=model`);

      expect(title(html)).toBe(`Share per ${word}, by model`);
      expect(shareChart(html)).toContain(note);
    });

    it('the title follows "coloured by"', async () => {
      await send([spend('a', 3, { category: 'building', time: '2026-10-29T10:00:00Z' })]);

      expect(title(await theBarePage('?period=30d&split=phase'))).toBe('Share per day, by phase');
    });

    it('over 90 days a model reads its share of each week, point by point', async () => {
      // Week of 5 Oct: Sonnet $1 on one day and Opus $3 (1.2 at its price) on the next; week of 12 Oct: Sonnet alone.
      await send([
        spend('w1a', 1, { model: 'claude-sonnet-5', time: '2026-10-06T10:00:00Z' }),
        spend('w1b', 1.2, { model: 'claude-opus-4-8', time: '2026-10-07T10:00:00Z' }),
        spend('w2', 2, { model: 'claude-sonnet-5', time: '2026-10-13T10:00:00Z' }),
      ]);

      const shown = lines(await theBarePage('?period=90d&split=model'));

      expect(shown['claude-sonnet-5']!.filter((p) => p.startsWith('5 Oct') || p.startsWith('12 Oct'))).toEqual(['5 Oct 2026 · 25%', '12 Oct 2026 · 100%']);
      expect(shown['claude-opus-4-8']!.filter((p) => p.startsWith('5 Oct'))).toEqual(['5 Oct 2026 · 75%']);
    });

    it('a day with no dollars is a gap in the lines, not a point at 0%', async () => {
      await send([spend('a', 2, { model: 'claude-sonnet-5', time: '2026-10-29T10:00:00Z' }), spend('b', 2, { model: 'claude-sonnet-5', time: '2026-10-31T10:00:00Z' })]);

      const points = lines(await theBarePage('?period=7d&split=model'))['claude-sonnet-5']!;

      expect(points.map((p) => p.split(' · ')[0])).toEqual(['29 Oct 2026', '31 Oct 2026']);
    });

    it('the Phase filter leaves the one phase, as the bar does', async () => {
      await send([spend('a', 3, { category: 'building', time: '2026-10-29T10:00:00Z' }), spend('b', 1, { category: 'after-push', time: '2026-10-29T10:00:00Z' })]);

      const shown = lines(await theBarePage('?period=30d&split=phase&category=building'));

      expect(Object.keys(shown)).toEqual(['building']);
    });

    it("an Engineer filter makes the shares of that engineer's dollars only", async () => {
      await send([
        spend('a', 3, { branch: 'b/alice', model: 'claude-sonnet-5', time: '2026-10-29T10:00:00Z' }),
        spend('b', 1, { branch: 'b/bob', model: 'claude-opus-4-8', time: '2026-10-29T10:00:00Z' }),
      ]);
      // The linking job runs on the real clock; the page's today is fixed again after it.
      vi.useRealTimers();
      await linked(
        pullRequest({ number: 1, title: 'Alice', headRefName: 'b/alice', author: { login: 'alice' } }),
        pullRequest({ number: 2, title: 'Bob', headRefName: 'b/bob', author: { login: 'bob' } }),
      );
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });

      const shown = lines(await theBarePage('?period=30d&split=model&engineer=bob'));

      expect(shown).toEqual({ 'claude-opus-4-8': ['29 Oct 2026 · 100%'] });
    });

    it("a Model filter makes the shares of that model's dollars only", async () => {
      await send([spend('a', 3, { model: 'claude-sonnet-5', time: '2026-10-29T10:00:00Z' }), spend('b', 1, { model: 'claude-opus-4-8', time: '2026-10-29T10:00:00Z' })]);

      const shown = lines(await theBarePage('?period=30d&split=model&model=claude-sonnet-5'));

      expect(shown).toEqual({ 'claude-sonnet-5': ['29 Oct 2026 · 100%'] });
    });

    it.each([
      { situation: 'each pull request', query: '?group=pr&period=30d&split=model' },
      { situation: 'each issue', query: '?group=issue&period=30d&split=model' },
      { situation: 'each engineer', query: '?group=engineer&period=30d&split=model' },
      { situation: 'each phase', query: '?group=category&period=30d&split=model' },
    ])('is not drawn for $situation', async ({ query }) => {
      await send([spend('a', 3, { model: 'claude-sonnet-5', time: '2026-10-29T10:00:00Z' })]);

      expect(await theBarePage(query)).not.toContain('id="share"');
    });

    it('is not drawn when no request is in the period', async () => {
      await send([spend('old', 3, { time: '2026-08-01T10:00:00Z' })]);

      expect(await theBarePage('?period=30d&split=model')).not.toContain('id="share"');
    });
  });
});
