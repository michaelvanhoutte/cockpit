import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, send, spend, thePage, whereItWent, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rows = async (query: string) => costRows(await thePage(query)).map((r) => [r.label, r.total]);

describe('Harness Monitor', () => {
  describe('filters narrow every figure on the page', () => {
    it('a period keeps only requests inside it, in the bar and the table alike', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      await send([
        spend('old', 8, { time: '2026-09-22T10:00:00Z', branch: 'b/old' }),
        spend('month', 4, { time: '2026-10-05T10:00:00Z', branch: 'b/month' }),
        spend('week', 2, { time: '2026-10-25T10:00:00Z', branch: 'b/week' }),
        spend('today', 1, { time: '2026-10-31T09:00:00Z', branch: 'b/today' }),
      ]);

      const figures = async (period: string) => {
        const html = await thePage(`?period=${period}`);
        return { heading: whereItWent(html).heading, table: costRows(html).map((r) => r.label) };
      };

      expect(await figures('7d')).toEqual({ heading: "Where the period's $3.00 went", table: ['b/week', 'b/today'] });
      expect(await figures('30d')).toEqual({ heading: "Where the period's $7.00 went", table: ['b/month', 'b/week', 'b/today'] });
      expect(await figures('all')).toEqual({ heading: "Where the period's $15.00 went", table: ['b/old', 'b/month', 'b/week', 'b/today'] });
    });

    it('with no period chosen it is the last 30 days', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
      await send([spend('old', 8, { time: '2026-09-22T10:00:00Z' }), spend('recent', 1, { time: '2026-10-10T10:00:00Z' })]);

      expect(await rows('')).toEqual([['claude/build-1', '$1.00']]);
    });

    it('an engineer keeps only the requests of their pull requests, and so does the bar', async () => {
      await send([
        spend('a', 5, { branch: 'b/alice', category: 'building' }),
        spend('b', 2, { branch: 'b/bob', category: 'after-push' }),
        spend('u', 1, { branch: 'b/nobody', category: 'building' }),
      ]);
      await linked(
        pullRequest({ number: 1, title: 'Alice’s', headRefName: 'b/alice', author: { login: 'alice' } }),
        pullRequest({ number: 2, title: 'Bob’s', headRefName: 'b/bob', author: { login: 'bob' } }),
      );

      const html = await thePage('?period=all&engineer=bob');

      expect(costRows(html).map((r) => [r.label, r.total])).toEqual([['#2 Bob’s', '$2.00']]);
      expect(whereItWent(html).heading).toBe("Where the period's $2.00 went");
      expect(whereItWent(html).bar).toContain('After push $2.00');
      expect(whereItWent(html).bar).toContain('Building $0.00');
      expect(await rows('?period=all&engineer=~unattributed')).toEqual([['b/nobody', '$1.00']]);
      expect(await rows('?period=all&engineer=alice&group=engineer')).toEqual([['alice', '$5.00']]);
      expect(await rows('?period=all&engineer=bob&group=day')).toEqual([['2026-10-01', '$2.00']]);
    });

    it('a category keeps only its requests, and the bar shows it alone', async () => {
      await send([
        spend('a', 5, { branch: 'b/1', category: 'building' }),
        spend('b', 2, { branch: 'b/1', category: 'after-push' }),
        spend('c', 3, { branch: 'b/2', category: 'after-push' }),
      ]);

      const html = await thePage('?period=all&category=after-push');

      expect(costRows(html).map((r) => [r.label, r.total, ...r.categories])).toEqual([
        ['b/2', '$3.00', '—', '—', '—', '—', '—', '$3.00', '—'],
        ['b/1', '$2.00', '—', '—', '—', '—', '—', '$2.00', '—'],
      ]);
      expect(whereItWent(html)).toEqual({ heading: "Where the period's $5.00 went", bar: 'After push $5.00' });
    });

    it('the filters combine, and an address with nonsense in it falls back to the defaults', async () => {
      await send([spend('a', 5, { branch: 'b/alice', category: 'building' }), spend('b', 2, { branch: 'b/alice', category: 'after-push' })]);
      await linked(pullRequest({ number: 1, title: 'Mine', headRefName: 'b/alice', author: { login: 'alice' } }));

      expect(await rows('?period=all&engineer=alice&category=building')).toEqual([['#1 Mine', '$5.00']]);
      expect(await rows('?period=all&engineer=bob&category=building')).toEqual([]);
      expect(await rows('?period=all&group=nonsense&category=nonsense')).toEqual([['#1 Mine', '$7.00']]);
    });
  });
});
