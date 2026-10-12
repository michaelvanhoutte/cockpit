import { describe, expect, it } from 'vitest';
import { dayChart, firstDay, groupRows, seriesOf, median, parseQuery, queryString, type TotalRow } from '../../src/costs';

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
  linesAdded: null,
  linesRemoved: null,
  openedAt: null,
  ciRounds: null,
  localRounds: null,
  findings: null,
  issueTitle: null,
  ...over,
});

describe('Harness Monitor', () => {
  describe('the costs page is asked for by its address', () => {
    it.each([
      { situation: 'nothing', query: '', expected: { period: '30d', engineer: null, category: null, model: null, who: 'all', group: 'day', split: 'phase', page: 1 } },
      {
        situation: 'every filter',
        query: 'period=all&engineer=alice&category=ci-reviews&model=claude-opus-5&who=subagents&group=pr&split=outcome&page=3',
        expected: { period: 'all', engineer: 'alice', category: 'ci-reviews', model: 'claude-opus-5', who: 'subagents', group: 'pr', split: 'outcome', page: 3 },
      },
      {
        situation: 'values it does not know',
        query: 'period=forever&category=lunch&group=colour&split=colour&model=%20not%20a%20model&who=everyone&page=-2',
        expected: { period: '30d', engineer: null, category: null, model: null, who: 'all', group: 'day', split: 'phase', page: 1 },
      },
      {
        situation: 'names every object inherits',
        query: 'period=toString&category=constructor&group=__proto__&split=constructor&who=toString',
        expected: { period: '30d', engineer: null, category: null, model: null, who: 'all', group: 'day', split: 'phase', page: 1 },
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
      const spelled = parseQuery(new URLSearchParams('junk=1&group=day&engineer=&period=30d&page=1'));

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

  describe('a pull request row says how long it was open, and an issue row names the issue', () => {
    it.each([
      { situation: 'under an hour', opened: '2026-03-01T10:00:00Z', merged: '2026-03-01T10:45:59Z', says: '45m' },
      { situation: 'under a day', opened: '2026-03-01T10:00:00Z', merged: '2026-03-01T15:10:00Z', says: '5h 10m' },
      { situation: 'days', opened: '2026-03-01T10:00:00Z', merged: '2026-03-03T14:30:00Z', says: '2d 4h' },
    ])('open $situation reads $says', ({ opened, merged, says }) => {
      const [group] = groupRows([row({ openedAt: opened, mergedAt: merged })], 'pr', null);

      expect(group!.openToMerged).toBe(says);
    });

    it.each([
      { situation: 'not merged', over: { openedAt: '2026-03-01T10:00:00Z', mergedAt: null } },
      { situation: 'its opening unread', over: { openedAt: null } },
    ])('a pull request $situation has no open → merged time', ({ over }) => {
      const [group] = groupRows([row(over)], 'pr', null);

      expect(group!.openToMerged).toBeNull();
    });

    it.each([
      { situation: 'with a stored title', title: 'Show costs', label: '#5 Show costs' },
      { situation: 'with no title yet', title: null, label: '#5' },
    ])('an issue $situation reads "$label"', ({ title, label }) => {
      const [group] = groupRows([row({ issue: 5, issueTitle: title })], 'issue', null);

      expect(group!.label).toBe(label);
    });

    it('an issue takes its title from whichever of its pull requests has it', () => {
      const groups = groupRows([row({ issue: 5, issueTitle: null }), row({ prNumber: 2, branch: 'b/2', issue: 5, issueTitle: 'Show costs' })], 'issue', null);

      expect(groups.map((g) => g.label)).toEqual(['#5 Show costs']);
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

  describe('Over time lists the newest day first and charts every day of the range', () => {
    const day = (d: string, series: string, micros: number) => row({ day: d, series, costMicros: micros, prNumber: null, title: null, branch: '' });
    const chartOf = (rows: TotalRow[], split: 'phase' | 'model', first: string | null, now: string) => {
      const groups = groupRows(rows, 'day', null);
      const totals: Record<string, number> = {};
      for (const g of groups) for (const [k, v] of Object.entries(g.bySeries)) totals[k] = (totals[k] ?? 0) + v;
      return dayChart(groups, seriesOf(split, totals), first, Date.parse(now));
    };

    it('a newer day that cost less sits above an older one that cost more', () => {
      const groups = groupRows([day('2026-10-01', 'building', 9), day('2026-10-02', 'building', 1)], 'day', null);

      expect(groups.map((g) => g.label)).toEqual(['2026-10-02', '2026-10-01']);
    });

    it('split by phase there is a line per phase with cost, and the total', () => {
      const chart = chartOf([day('2026-10-01', 'building', 2), day('2026-10-01', 'after-push', 1)], 'phase', null, '2026-10-01T12:00:00Z');

      expect(chart.lines.map((l) => [l.key, l.micros])).toEqual([
        ['building', [2]],
        ['after-push', [1]],
      ]);
      expect(chart.total).toEqual([3]);
    });

    it('split by model there is a line per model', () => {
      const chart = chartOf([day('2026-10-01', 'claude-a', 2), day('2026-10-01', 'claude-b', 5)], 'model', null, '2026-10-01T12:00:00Z');

      expect(chart.lines.map((l) => l.key)).toEqual(['claude-b', 'claude-a']);
    });

    it('a day with no cost between two that have some is a zero, not a gap', () => {
      const chart = chartOf([day('2026-10-01', 'building', 2), day('2026-10-03', 'building', 4)], 'phase', null, '2026-10-03T12:00:00Z');

      expect(chart.days).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
      expect(chart.lines[0]!.micros).toEqual([2, 0, 4]);
      expect(chart.total).toEqual([2, 0, 4]);
    });

    it('the range runs from the first day of the period to today, so leading and trailing days are zeros', () => {
      const chart = chartOf([day('2026-10-02', 'building', 2)], 'phase', '2026-10-01', '2026-10-03T12:00:00Z');

      expect(chart.days).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
      expect(chart.total).toEqual([0, 2, 0]);
    });

    it('a single day is one point and no error', () => {
      const chart = chartOf([day('2026-10-01', 'building', 2)], 'phase', null, '2026-10-01T12:00:00Z');

      expect(chart.days).toEqual(['2026-10-01']);
      expect(chart.lines[0]!.micros).toEqual([2]);
    });

    it('with no cost there is nothing to chart', () => {
      expect(chartOf([], 'phase', null, '2026-10-01T12:00:00Z')).toEqual({ days: [], lines: [], total: [] });
    });
  });
});
