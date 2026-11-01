import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, merged, micros, pullRequestFigures, send, spend, theBarePage, theExport, thePage, thePullRequest, theTrendPage, usage, whereItWent, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T12:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

/** The range 14 to 16 Oct 2026, with its parts: the day before, the first day, the last day and the day after. */
const RANGE = '?period=all&from=2026-10-14&to=2026-10-16';

/** A per-day chart's days, as its strips name them. */
const chartDays = (html: string, id: 'perday' | 'tokensperday') =>
  [...new RegExp(`aria-labelledby="${id}">.*?</section>`, 's').exec(html)![0].matchAll(/<rect [^>]*><title>(.*?)\n/g)].map((m) => m[1]!.split(' · ')[0]);

describe('Harness Monitor', () => {
  describe('a range zooms the whole costs page into its days, both ends included', () => {
    beforeEach(async () => {
      // One request the day before the range, on its first day, on its last day and the day after; the last two are after-push.
      await send([
        spend('before', 1, { branch: 'b/a', time: '2026-10-13T10:00:00Z' }),
        spend('first', 2, { branch: 'b/b', time: '2026-10-14T10:00:00Z' }),
        spend('middle', 3, { branch: 'b/b', time: '2026-10-15T10:00:00Z' }),
        spend('last', 4, { branch: 'b/b', category: 'after-push', time: '2026-10-16T10:00:00Z' }),
        spend('after', 8, { branch: 'b/c', category: 'after-push', time: '2026-10-17T10:00:00Z' }),
      ]);
      await linked(
        pullRequest({ number: 1, title: 'PR 1', headRefName: 'b/a', author: { login: 'alice' } }),
        pullRequest({ number: 2, title: 'PR 2', headRefName: 'b/b', author: { login: 'bob' } }),
        pullRequest({ number: 3, title: 'PR 3', headRefName: 'b/c', author: { login: 'carol' } }),
      );
    });

    it("the day before the first, the first, the last and the day after: only the two inside count, in the total and in each colour", async () => {
      const where = whereItWent(await thePage(`${RANGE}&group=pr`));

      expect(where.heading).toBe("Where 14 Oct to 16 Oct's $9.00 went, by phase");
      expect(where.bar).toContain('Building $5.00');
      expect(where.bar).toContain('After push $4.00');
    });

    it('each pull request holds only its spend inside the range, and one with spend only outside is no row', async () => {
      const rows = costRows(await thePage(`${RANGE}&group=pr`));

      expect(rows.map((r) => [r.label, r.total])).toEqual([['#2 PR 2', '$9.00']]);
    });

    it('each day has a point for every day from the first to the last, none outside, on both charts', async () => {
      const html = await theBarePage(RANGE);

      expect(chartDays(html, 'perday')).toEqual(['14 Oct 2026', '15 Oct 2026', '16 Oct 2026']);
      expect(chartDays(html, 'tokensperday')).toEqual(['14 Oct 2026', '15 Oct 2026', '16 Oct 2026']);
      expect(costRows(html).map((r) => r.label)).toEqual(['16 Oct 2026', '15 Oct 2026', '14 Oct 2026']);
    });

    it('an Only filter narrows inside the range', async () => {
      await send([spend('opus', 4, { branch: 'b/b', model: 'claude-opus-4-8', time: '2026-10-15T11:00:00Z' })]);

      const everyModel = whereItWent(await thePage(`${RANGE}&group=pr`));
      const sonnetOnly = whereItWent(await thePage(`${RANGE}&model=claude-sonnet-5&group=pr`));

      expect([micros(everyModel.heading), micros(sonnetOnly.heading)]).toEqual([19_000_000, 9_000_000]);
    });

    it('the period select lists the range first and chosen, and the heading names it', async () => {
      const html = await theBarePage(RANGE);

      expect(/<select[^>]*aria-label="Period"[^>]*>(.*?)<\/select>/s.exec(html)![1]).toMatch(/^<option value="range" selected>14 Oct 2026 – 16 Oct 2026<\/option>/);
      expect(whereItWent(html).heading).toBe("Where 14 Oct to 16 Oct's $9.00 went, by phase");
    });

    it('a range with no requests says so, and the period select still offers every period', async () => {
      const html = await theBarePage('?period=all&from=2026-09-01&to=2026-09-03');

      expect(html).toContain('Nothing in this period.');
      const options = [...(/<select[^>]*aria-label="Period"[^>]*>(.*?)<\/select>/s.exec(html)![1]!).matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1]);
      expect(options).toEqual(['1 Sept 2026 – 3 Sept 2026', 'the last 7 days', 'the last 30 days', 'the last 90 days', 'all time', 'Pick a day…']);
    });
  });

  describe('the Harness trend page ignores a range, as it ignores a day', () => {
    it('a range in its address draws the same page as its period alone', async () => {
      await send([
        usage('in', { time: '2026-10-15T10:00:00Z', sessionId: 'inside', branch: 'b/1', inputTokens: 70 }),
        usage('out', { time: '2026-10-17T10:00:00Z', sessionId: 'outside', branch: 'b/2', inputTokens: 90 }),
      ]);
      await merged(1, '2026-10-17T10:00:00Z', 1_000);

      expect(await theTrendPage(`?period=all&from=2026-10-14&to=2026-10-16`)).toBe(await theTrendPage('?period=all'));
    });
  });

  describe("a pull request's page shows its whole cost over the period, never the range it was reached from", () => {
    it('the total holds the spend outside the range too', async () => {
      await send([spend('before', 1, { branch: 'b/a', time: '2026-10-13T10:00:00Z' }), spend('inside', 2, { branch: 'b/a', time: '2026-10-15T10:00:00Z' })]);
      await linked(pullRequest({ number: 1, title: 'PR 1', headRefName: 'b/a', author: { login: 'alice' } }));

      const figures = pullRequestFigures(await (await thePullRequest(1, RANGE)).text());

      expect(figures.total).toBe('$3.00');
    });
  });

  describe("Export CSV on a range exports the requests between its first Belgian midnight and the midnight after its last day", () => {
    it('a minute before the first midnight is out, just after it is in, a minute before the closing midnight is in, and just after it is out', async () => {
      // 14 to 16 Oct 2026 is in summer time: it opens at 22:00 UTC on the 13th and closes at 22:00 UTC on the 16th.
      const times = ['2026-10-13T22:00:00.000Z', '2026-10-16T21:59:00.000Z'];
      await send([
        spend('before', 1, { time: '2026-10-13T21:59:00Z' }),
        spend('first', 2, { time: '2026-10-13T22:00:00Z' }),
        spend('last', 4, { time: '2026-10-16T21:59:00Z' }),
        spend('after', 8, { time: '2026-10-16T22:00:00Z' }),
      ]);

      const { rows } = await theExport(RANGE);

      expect(rows.map((r) => r[0])).toEqual(times);
    });

    it('a range ending on the day the clocks go back has its 25th hour in', async () => {
      await send([
        spend('midnight', 1, { time: '2026-10-23T22:00:00Z' }),
        spend('twenty-fifth-hour', 2, { time: '2026-10-25T22:30:00Z' }),
        spend('next', 4, { time: '2026-10-25T23:00:00Z' }),
        spend('before', 8, { time: '2026-10-23T21:59:59Z' }),
      ]);

      const { rows } = await theExport('?period=all&from=2026-10-24&to=2026-10-25');

      expect(rows.map((r) => r[0])).toEqual(['2026-10-23T22:00:00.000Z', '2026-10-25T22:30:00.000Z']);
    });
  });
});
