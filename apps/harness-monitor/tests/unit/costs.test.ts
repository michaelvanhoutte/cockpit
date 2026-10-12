import { describe, expect, it } from 'vitest';
import { compare, topChanges, windowFigures, windowsOf, dayChart, firstDay, trends, groupRows, seriesOf, median, parseQuery, queryString, type TotalRow } from '../../src/costs';

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

  describe("each trend chart's value per bucket is its median or ratio over that bucket", () => {
    const NOW = Date.parse('2026-10-31T12:00:00Z');
    const pr = (day: string, lines: number | null, costByPhase: Record<string, number>) => ({ day, lines, costByPhase });

    it('the last 30 days are bucketed by day, the last 7 as well', () => {
      expect(trends([], [], '30d', NOW).buckets).toHaveLength(30);
      expect(trends([], [], '7d', NOW).buckets).toEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
    });

    it('the last 90 days and all time are bucketed by week, each starting on a Monday', () => {
      const ninety = trends([], [], '90d', NOW);
      const all = trends([{ day: '2026-09-23', tokens: 1 }], [], 'all', NOW);

      expect(ninety.weekly).toBe(true);
      expect(ninety.buckets[0]).toBe('2026-08-03');
      expect(ninety.buckets.every((b) => new Date(b).getUTCDay() === 1)).toBe(true);
      expect(all.buckets).toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    });

    it('starting context and size are medians of the sessions and pull requests in the bucket', () => {
      const t = trends(
        [{ day: '2026-10-30', tokens: 100 }, { day: '2026-10-30', tokens: 300 }, { day: '2026-10-30', tokens: 200 }, { day: '2026-10-31', tokens: 50 }],
        [pr('2026-10-30', 10, {}), pr('2026-10-30', 30, {}), pr('2026-10-30', 20, {}), pr('2026-10-30', null, {})],
        '7d',
        NOW,
      );

      expect(t.startingContext.slice(-2)).toEqual([200, 50]);
      expect(t.prSize.slice(-2)).toEqual([20, null]);
    });

    it('cost per 1,000 lines is the merged pull requests cost over their lines, overall and per phase', () => {
      const t = trends([], [pr('2026-10-30', 1_000, { building: 3_000_000, 'after-push': 1_000_000 }), pr('2026-10-30', 3_000, { building: 4_000_000 })], '7d', NOW);

      const byKey = Object.fromEntries(t.costPerThousandLines.map((l) => [l.key, l.values.at(-2)]));
      expect(byKey).toEqual({ total: 2_000_000, building: 1_750_000, 'after-push': 250_000 });
    });

    it('a merged pull request with no counted lines is left out of the ratio, cost and lines alike', () => {
      const t = trends([], [pr('2026-10-30', 1_000, { building: 2_000_000 }), pr('2026-10-30', 0, { building: 50_000_000 }), pr('2026-10-30', null, { building: 50_000_000 })], '7d', NOW);

      expect(t.costPerThousandLines[0]!.values.at(-2)).toBe(2_000_000);
    });

    it('a bucket with no merged pull request has no point, rather than zero', () => {
      const t = trends([{ day: '2026-10-29', tokens: 1 }], [pr('2026-10-29', 10, { building: 1 })], '7d', NOW);

      expect(t.prSize).toEqual([null, null, null, null, 10, null, null]);
      expect(t.startingContext).toEqual([null, null, null, null, 1, null, null]);
      expect(t.costPerThousandLines[0]!.values).toEqual([null, null, null, null, 100, null, null]);
    });

    it('Unphased is drawn only before 21 Sep 2026 and every other phase only from then on', () => {
      const t = trends(
        [],
        [pr('2026-09-17', 1_000, { unphased: 1, building: 2 }), pr('2026-09-22', 1_000, { unphased: 3, building: 4 })],
        '30d',
        Date.parse('2026-09-25T12:00:00Z'),
      );

      const line = (key: string) => Object.fromEntries(t.buckets.map((b, i) => [b, t.costPerThousandLines.find((l) => l.key === key)!.values[i]])) as Record<string, number | null>;
      expect(line('unphased')['2026-09-17']).toBe(1);
      expect(line('unphased')['2026-09-22']).toBeNull();
      expect(line('building')['2026-09-17']).toBeNull();
      expect(line('building')['2026-09-22']).toBe(4);
      expect(line('total')['2026-09-22']).toBe(7);
    });
  });

  describe("a period's drivers are computed for both windows, and a ratio with nothing to divide by is a dash", () => {
    const pr = (lines: number | null, costMicros: number) => ({ day: '2026-10-01', lines, costByPhase: { building: costMicros } });
    const none = { phase: {}, model: {}, where: {}, outcome: {} };
    const driversOf = (current: ReturnType<typeof windowFigures>, previous: ReturnType<typeof windowFigures>) =>
      Object.fromEntries(compare(current, previous, { current: { from: 'a', to: 'b' }, previous: { from: 'c', to: 'd' } }).drivers.map((d) => [d.key, [d.current, d.previous]]));

    it('merged pull requests with lines give their count, cost per pull request, lines per pull request and cost per 1,000 lines', () => {
      const current = windowFigures({ ...none, phase: { building: 10_000_000 } }, [{ day: 'x', tokens: 100 }, { day: 'x', tokens: 300 }], [pr(1_000, 4_000_000), pr(3_000, 6_000_000)]);
      const previous = windowFigures(none, [], [pr(500, 1_000_000)]);

      expect(driversOf(current, previous)).toEqual({
        merged: [2, 1],
        'cost-per-pr': [5_000_000, 1_000_000],
        'lines-per-pr': [2_000, 500],
        'cost-per-line': [2_500_000, 2_000_000],
        'starting-context': [200, null],
      });
    });

    it('lines per pull request is the median, so one very large pull request does not swing it', () => {
      const current = windowFigures(none, [], [pr(100, 1_000_000), pr(200, 1_000_000), pr(50_000, 1_000_000)]);

      expect(driversOf(current, windowFigures(none, [], []))['lines-per-pr']).toEqual([200, null]);
    });

    it('a window with no merged pull request has a dash for each ratio, not zero or infinity', () => {
      const empty = windowFigures(none, [], []);
      const unsized = windowFigures(none, [], [pr(null, 1_000_000)]);

      expect(driversOf(empty, unsized)).toEqual({
        merged: [0, 1],
        'cost-per-pr': [null, 1_000_000],
        'lines-per-pr': [null, null],
        'cost-per-line': [null, null],
        'starting-context': [null, null],
      });
    });

    it('the starting context is the median of each window', () => {
      const tokens = (...values: number[]) => windowFigures(none, values.map((t) => ({ day: 'x', tokens: t })), []);

      expect(driversOf(tokens(10, 30, 20), tokens(7, 9))['starting-context']).toEqual([20, 8]);
    });
  });

  describe('the change card compares the period with the one before it, of the same length', () => {
    const NOW = Date.parse('2026-10-31T12:00:00Z');

    it.each([
      { situation: 'the last 7 days', period: '7d' as const, expected: { current: { from: '2026-10-25', to: '2026-10-31' }, previous: { from: '2026-10-18', to: '2026-10-24' } } },
      { situation: 'the last 30 days', period: '30d' as const, expected: { current: { from: '2026-10-02', to: '2026-10-31' }, previous: { from: '2026-09-02', to: '2026-10-01' } } },
      { situation: 'all time', period: 'all' as const, expected: null },
    ])('$situation', ({ period, expected }) => {
      expect(windowsOf(period, NOW)).toEqual(expected);
    });

    it('the change is in dollars and percent, and only dollars when the period before had no cost', () => {
      const windows = { current: { from: 'a', to: 'b' }, previous: { from: 'c', to: 'd' } };
      const cost = (micros: number) => windowFigures({ phase: { building: micros }, model: {}, where: {}, outcome: {} }, [], []);

      const grown = compare(cost(15_000_000), cost(10_000_000), windows);
      const fresh = compare(cost(3_000_000), cost(0), windows);

      expect([grown.changeMicros, grown.changePercent]).toEqual([5_000_000, 50]);
      expect([fresh.changeMicros, fresh.changePercent]).toEqual([3_000_000, null]);
    });
  });

  describe('each dimension lists its four largest changes by size, telling increases from decreases', () => {
    it('five models changed: the four largest by size, whichever way they went', () => {
      const current = { a: 10_000_000, b: 1_000_000, c: 6_000_000, d: 2_000_000, e: 9_000_000 };
      const previous = { a: 1_000_000, b: 9_000_000, c: 5_000_000, d: 1_000_000, e: 8_000_000 };

      const changes = topChanges('model', current, previous);

      expect(changes.map((c) => [c.key, c.changeMicros])).toEqual([['a', 9_000_000], ['b', -8_000_000], ['c', 1_000_000], ['d', 1_000_000]]);
    });

    it('a series only in the previous period is a decrease, and one only in this period an increase', () => {
      const changes = topChanges('model', { new: 3_000_000 }, { gone: 4_000_000 });

      expect(changes.map((c) => [c.key, c.changeMicros])).toEqual([['gone', -4_000_000], ['new', 3_000_000]]);
    });

    it('a change under 50 cents is left out, and one of exactly 50 cents is kept', () => {
      const changes = topChanges('where', { local: 1_499_999, cloud: 2_500_000 }, { local: 1_000_000, cloud: 2_000_000 });

      expect(changes.map((c) => c.key)).toEqual(['cloud']);
    });

    it('nothing changed gives no changes to list', () => {
      expect(topChanges('outcome', { merged: 5_000_000 }, { merged: 5_000_000 })).toEqual([]);
    });

    it('a series is named as the page names it', () => {
      expect(topChanges('phase', { building: 3_000_000 }, {})[0]!.label).toBe('Building');
    });
  });
});
