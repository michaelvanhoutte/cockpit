import { describe, expect, it } from 'vitest';
import { firstDay, groupRows, median, parseQuery, queryString, type TotalRow } from '../../src/costs';

const row = (over: Partial<TotalRow>): TotalRow => ({
  day: '',
  branch: 'b/1',
  category: '',
  series: 'building',
  costMicros: 1_000_000,
  unpricedRequests: 0,
  lastAt: 0,
  prNumber: 1,
  title: 'T',
  state: 'MERGED',
  mergedAt: '2026-10-01T10:00:00Z',
  issue: null,
  engineer: 'alice',
  ...over,
});

describe('Harness Monitor', () => {
  describe('the costs page is asked for by its address', () => {
    it.each([
      { situation: 'nothing', query: '', expected: { period: '30d', engineer: null, category: null, model: null, who: 'all', group: 'pr', split: 'phase', page: 1 } },
      {
        situation: 'every filter',
        query: 'period=all&engineer=alice&category=ci-reviews&model=claude-opus-5&who=subagents&group=day&split=outcome&page=3',
        expected: { period: 'all', engineer: 'alice', category: 'ci-reviews', model: 'claude-opus-5', who: 'subagents', group: 'day', split: 'outcome', page: 3 },
      },
      {
        situation: 'values it does not know',
        query: 'period=forever&category=lunch&group=colour&split=colour&model=%20not%20a%20model&who=everyone&page=-2',
        expected: { period: '30d', engineer: null, category: null, model: null, who: 'all', group: 'pr', split: 'phase', page: 1 },
      },
      {
        situation: 'names every object inherits',
        query: 'period=toString&category=constructor&group=__proto__&split=constructor&who=toString',
        expected: { period: '30d', engineer: null, category: null, model: null, who: 'all', group: 'pr', split: 'phase', page: 1 },
      },
    ])('$situation is read as the filters it names, or the default', ({ query, expected }) => {
      expect(parseQuery(new URLSearchParams(query))).toEqual(expected);
    });

    it('the same page has one address however it was spelled', () => {
      const spelled = parseQuery(new URLSearchParams('who=main&split=model&model=claude-opus-5&period=7d'));
      const reordered = parseQuery(new URLSearchParams('period=7d&model=claude-opus-5&split=model&who=main&junk=1'));

      expect(queryString(spelled)).toBe('?period=7d&model=claude-opus-5&who=main&split=model');
      expect(queryString(reordered)).toBe(queryString(spelled));
    });

    it('the defaults of the split and the filters are left out of the address', () => {
      const spelled = parseQuery(new URLSearchParams('split=phase&who=all&model='));

      expect(queryString(spelled)).toBe('');
      expect(queryString(spelled, { split: 'where', who: 'subagents' })).toBe('?who=subagents&split=where');
    });

    it('the same page has one address however it was spelled (period, group, page)', () => {
      const spelled = parseQuery(new URLSearchParams('junk=1&group=pr&engineer=&period=30d&page=1'));

      expect(queryString(spelled)).toBe('');
      expect(queryString(spelled, { group: 'issue', page: 2 })).toBe('?group=issue&page=2');
    });
  });

  describe('a period is whole UTC days ending today', () => {
    it.each([
      { period: '7d', first: '2026-10-25' },
      { period: '30d', first: '2026-10-02' },
      { period: 'all', first: null },
    ] as const)('$period starts $first', ({ period, first }) => {
      expect(firstDay(period, Date.parse('2026-10-31T23:59:59Z'))).toBe(first);
    });
  });

  describe("each group's total is the sum of its requests", () => {
    it('rows of one pull request in different categories become one group with the split kept', () => {
      const groups = groupRows(
        [row({ series: 'building', costMicros: 2_000_000 }), row({ series: 'after-push', costMicros: 3_000_000, unpricedRequests: 2 })],
        'pr',
        null,
      );

      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ label: '#1 T', totalMicros: 5_000_000, unpricedRequests: 2 });
      expect(groups[0]!.bySeries.building).toBe(2_000_000);
      expect(groups[0]!.bySeries['after-push']).toBe(3_000_000);
    });

    it('groups come biggest first, and equal totals are in name order', () => {
      const groups = groupRows(
        [row({ prNumber: 2, title: 'B', branch: 'b/2', costMicros: 1 }), row({ prNumber: 3, title: 'A', branch: 'b/3', costMicros: 1 }), row({ costMicros: 9 })],
        'pr',
        null,
      );

      expect(groups.map((g) => g.label)).toEqual(['#1 T', '#2 B', '#3 A']);
    });

    it('a pull request with no author is its own engineer, "unknown", apart from unattributed requests', () => {
      const groups = groupRows([row({ engineer: null }), row({ prNumber: null, branch: 'b/x', title: null })], 'engineer', null);

      expect(groups.map((g) => g.label).sort()).toEqual(['Unattributed', 'unknown']);
    });

    it('the median of an even count is the mean of the middle two', () => {
      expect([median([]), median([5]), median([1, 9, 3]), median([4, 1, 3, 2])]).toEqual([0, 5, 3, 3]);
    });
  });

  describe('a session without a link says why', () => {
    it.each([
      { situation: 'linking has never succeeded', lastAt: 10, success: null, branch: 'b/x', says: 'linking…' },
      { situation: 'the session is newer than the last success', lastAt: 20, success: 10, branch: 'b/x', says: 'linking…' },
      { situation: 'linking has caught up since the session', lastAt: 10, success: 20, branch: 'b/x', says: 'unattributed' },
      { situation: 'the session had no branch to link', lastAt: 20, success: 10, branch: '', says: 'unattributed' },
    ])('$situation: $says', ({ lastAt, success, branch, says }) => {
      const [group] = groupRows([row({ prNumber: null, title: null, branch, lastAt })], 'pr', success);

      expect(group!.sub).toBe(says);
    });
  });
});
