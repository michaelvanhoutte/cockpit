import { beforeEach, describe, expect, it } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, micros, send, spend, theExport, thePage, whereItWent, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});

describe('Harness Monitor', () => {
  describe('an opened day counts only what was spent on that day', () => {
    beforeEach(async () => {
      // Bob's pull request spends on the 23rd and again on the 24th; Alice's only on the 24th; Carol's only on the 25th.
      await send([
        spend('1', 5, { branch: 'b/bob', time: '2026-10-23T10:00:00Z' }),
        spend('2', 3, { branch: 'b/bob', time: '2026-10-24T10:00:00Z' }),
        spend('3', 4, { branch: 'b/alice', time: '2026-10-24T11:00:00Z' }),
        spend('4', 1, { branch: 'b/alice', time: '2026-10-24T12:00:00Z' }),
        spend('5', 9, { branch: 'b/carol', time: '2026-10-25T10:00:00Z' }),
      ]);
      await linked(
        pullRequest({ number: 1, title: 'PR 1', headRefName: 'b/alice', author: { login: 'alice' } }),
        pullRequest({ number: 2, title: 'PR 2', headRefName: 'b/bob', author: { login: 'bob' } }),
        pullRequest({ number: 3, title: 'PR 3', headRefName: 'b/carol', author: { login: 'carol' } }),
      );
    });

    it('each pull request and the total hold that day\'s spend, dearest first, without the earlier day\'s part', async () => {
      const html = await thePage('?period=all&day=2026-10-24');

      expect(costRows(html).map((r) => [r.label, r.total])).toEqual([
        ['#1 PR 1', '$5.00'],
        ['#2 PR 2', '$3.00'],
      ]);
      expect(whereItWent(html).heading).toBe("Where 24 Oct's $8.00 went, by phase");
    });

    it('a day with no spend is the page\'s empty state, with no rows', async () => {
      const html = await thePage('?period=all&day=2026-10-22');

      expect(costRows(html)).toEqual([]);
      expect(html).toContain('Nothing in this period.');
    });

    it('the same day with the rows set to each engineer is one row per engineer holding that day\'s spend, dearest first', async () => {
      const html = await thePage('?period=all&day=2026-10-24&group=engineer');

      expect(costRows(html).map((r) => [r.label, r.total])).toEqual([
        ['alice', '$5.00'],
        ['bob', '$3.00'],
      ]);
    });

    it('a day inside a period holds the same figures whichever period it was opened from', async () => {
      const html = await Promise.all(['7d', '90d', 'all'].map((period) => thePage(`?period=${period}&day=2026-10-24`)));

      for (const page of html) expect(micros(whereItWent(page).heading)).toBe(8_000_000);
    });

    it('a date that is no day shows the period it came with', async () => {
      const html = await thePage('?period=all&day=2026-02-30');

      expect(micros(whereItWent(html).heading)).toBe(22_000_000);
      expect(whereItWent(html).heading).toBe("Where the period's $22.00 went, by phase");
    });
  });

  describe('Export CSV on a day exports that day\'s requests, cut at Belgian midnights', () => {
    it.each([
      { situation: 'a day in summer time, which ends at 22:00 UTC', day: '2026-10-24', times: ['2026-10-23T22:00:00.000Z', '2026-10-24T21:59:59.000Z'], next: '2026-10-24T22:00:00.000Z', before: '2026-10-23T21:59:59.000Z' },
      { situation: 'a day in winter time, which ends at 23:00 UTC', day: '2026-11-10', times: ['2026-11-09T23:00:00.000Z', '2026-11-10T22:59:59.000Z'], next: '2026-11-10T23:00:00.000Z', before: '2026-11-09T22:59:59.000Z' },
    ])('$situation: 23:59 on the day is in and 00:00 the next is out', async ({ day, times, next, before }) => {
      await send([
        spend('before', 1, { time: before }),
        spend('first', 2, { time: times[0] }),
        spend('last', 4, { time: times[1] }),
        spend('after', 8, { time: next }),
      ]);

      const { rows } = await theExport(`?period=all&day=${day}`);

      expect(rows.map((r) => r[0])).toEqual(times);
    });

    it('the day the clocks go back, 25 Oct 2026, has 25 hours, and a request in the last is in', async () => {
      await send([
        spend('midnight', 1, { time: '2026-10-24T22:00:00Z' }),
        spend('twenty-fifth-hour', 2, { time: '2026-10-25T22:30:00Z' }),
        spend('next', 4, { time: '2026-10-25T23:00:00Z' }),
        spend('before', 8, { time: '2026-10-24T21:59:59Z' }),
      ]);

      const { rows } = await theExport('?period=all&day=2026-10-25');

      expect(rows.map((r) => r[0])).toEqual(['2026-10-24T22:00:00.000Z', '2026-10-25T22:30:00.000Z']);
    });

    it('a day keeps the filters the page has', async () => {
      await send([
        spend('a', 1, { category: 'building', time: '2026-10-24T10:00:00Z' }),
        spend('b', 2, { category: 'after-push', time: '2026-10-24T11:00:00Z' }),
        spend('c', 4, { category: 'building', time: '2026-10-25T10:00:00Z' }),
      ]);

      const { rows } = await theExport('?period=all&day=2026-10-24&category=building');

      expect(rows.map((r) => [r[0], r[6]])).toEqual([['2026-10-24T10:00:00.000Z', 'building']]);
    });
  });
});
