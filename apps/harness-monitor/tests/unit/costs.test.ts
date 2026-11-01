import { describe, expect, it } from 'vitest';
import { addDays, weekStart } from '../../src/belgium';
import { dayChart, firstDay, shareChart, trends, groupRows, seriesOf, median, parseQuery, queryString, type TotalRow } from '../../src/costs';

const row = (over: Partial<TotalRow>): TotalRow => ({
  day: '',
  branch: 'b/1',
  category: '',
  series: 'building',
  costMicros: 1_000_000,
  unpricedRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
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
  issueTitle: null,
  issueParent: null,
  issueParentTitle: null,
  credited: 0,
  creditIssue: null,
  ...over,
});

describe('Harness Monitor', () => {
  describe('the costs page is asked for by its address', () => {
    describe('a day is asked for beside the period it was opened from', () => {
      it('a day and a period are both kept, and the address spells them one way', () => {
        const spelled = parseQuery(new URLSearchParams('group=pr&day=2026-10-24&period=7d&junk=1'));
        const reordered = parseQuery(new URLSearchParams('period=7d&day=2026-10-24&group=pr'));

        expect(spelled).toMatchObject({ day: '2026-10-24', period: '7d', group: 'pr' });
        expect(queryString(spelled)).toBe('?period=7d&day=2026-10-24&group=pr');
        expect(queryString(reordered)).toBe(queryString(spelled));
      });

      it.each([
        { situation: 'a date that is not on the calendar', day: '2026-02-30' },
        { situation: 'a month that does not exist', day: '2026-13-01' },
        { situation: 'words', day: 'abc' },
        { situation: 'a date with the wrong spelling', day: '24-10-2026' },
        { situation: 'nothing', day: '' },
      ])('$situation is ignored, and the period shows', ({ day }) => {
        const query = parseQuery(new URLSearchParams({ group: 'pr', period: '7d', day }));

        expect(query).toMatchObject({ day: null, period: '7d' });
        expect(queryString(query)).toBe('?period=7d&group=pr');
      });

      it('choosing each day as the rows drops the day and shows the period it was opened from', () => {
        const eachDay = parseQuery(new URLSearchParams('group=day&day=2026-10-24&period=90d'));

        expect(eachDay).toMatchObject({ day: null, period: '90d', group: 'day' });
        expect(queryString(eachDay)).toBe('?period=90d');
      });

      it('a day opens dearest first, and asking for the rows\' own order is kept in the address', () => {
        const dearest = parseQuery(new URLSearchParams('group=pr&day=2026-10-24'));
        const own = parseQuery(new URLSearchParams('group=pr&day=2026-10-24&sort=default'));

        expect(dearest.sort).toBe('total');
        expect(queryString(dearest)).toBe('?day=2026-10-24&group=pr');
        expect(own.sort).toBe('default');
        expect(queryString(own)).toBe('?day=2026-10-24&group=pr&sort=default');
        expect(parseQuery(new URLSearchParams('group=pr&sort=total')).sort).toBe('total');
        expect(parseQuery(new URLSearchParams('group=pr')).sort).toBe('default');
      });
    });

    describe('a range of days is asked for beside the period it was opened from', () => {
      it('a range and a period are both kept, and the address spells them one way whatever order they came in', () => {
        const spelled = parseQuery(new URLSearchParams('to=2026-10-04&junk=1&group=day&from=2026-09-15&period=all'));
        const reordered = parseQuery(new URLSearchParams('period=all&from=2026-09-15&to=2026-10-04'));

        expect(spelled).toMatchObject({ range: { from: '2026-09-15', to: '2026-10-04' }, period: 'all', group: 'day' });
        expect(queryString(spelled)).toBe('?period=all&from=2026-09-15&to=2026-10-04');
        expect(queryString(reordered)).toBe(queryString(spelled));
      });

      it.each([
        { situation: 'from equal to to', params: 'from=2026-10-04&to=2026-10-04' },
        { situation: 'from after to', params: 'from=2026-10-05&to=2026-10-04' },
        { situation: 'a from that is not on the calendar', params: 'from=2026-02-30&to=2026-10-04' },
        { situation: 'a to that is not on the calendar', params: 'from=2026-09-15&to=2026-13-01' },
        { situation: 'only from', params: 'from=2026-09-15' },
        { situation: 'only to', params: 'to=2026-10-04' },
        { situation: 'a range longer than ten years', params: 'from=1900-01-01&to=2026-10-04' },
      ])('$situation is ignored, and the period shows', ({ params }) => {
        const query = parseQuery(new URLSearchParams(`period=7d&${params}`));

        expect(query).toMatchObject({ range: null, period: '7d' });
        expect(queryString(query)).toBe('?period=7d');
      });

      it('a day opened from a range keeps the range, so each day returns to it and not to the period', () => {
        const day = parseQuery(new URLSearchParams('period=all&from=2026-09-15&to=2026-10-04&day=2026-09-20&group=pr'));

        expect(day).toMatchObject({ day: '2026-09-20', range: { from: '2026-09-15', to: '2026-10-04' } });
        expect(queryString(day)).toBe('?period=all&day=2026-09-20&from=2026-09-15&to=2026-10-04&group=pr');
        expect(queryString(day, { group: 'day', sort: 'default' })).toBe('?period=all&from=2026-09-15&to=2026-10-04');
      });
    });

    it.each([
      { situation: 'nothing', query: '', expected: { period: '30d', day: null, range: null, engineer: null, category: null, model: null, who: 'all', group: 'day', split: 'phase', sort: 'default', page: 1 } },
      {
        situation: 'every filter',
        query: 'period=all&engineer=alice&category=ci-reviews&model=claude-opus-5&who=subagents&group=pr&split=outcome&page=3',
        expected: { period: 'all', day: null, range: null, engineer: 'alice', category: 'ci-reviews', model: 'claude-opus-5', who: 'subagents', group: 'pr', split: 'outcome', sort: 'default', page: 3 },
      },
      {
        situation: 'values it does not know',
        query: 'period=forever&category=lunch&group=colour&split=colour&model=%20not%20a%20model&who=everyone&page=-2',
        expected: { period: '30d', day: null, range: null, engineer: null, category: null, model: null, who: 'all', group: 'day', split: 'phase', sort: 'default', page: 1 },
      },
      {
        situation: 'a colouring by engineer',
        query: 'split=engineer&group=pr',
        expected: { period: '30d', day: null, range: null, engineer: null, category: null, model: null, who: 'all', group: 'pr', split: 'engineer', sort: 'default', page: 1 },
      },
      {
        situation: 'names every object inherits',
        query: 'period=toString&category=constructor&group=__proto__&split=constructor&who=toString',
        expected: { period: '30d', day: null, range: null, engineer: null, category: null, model: null, who: 'all', group: 'day', split: 'phase', sort: 'default', page: 1 },
      },
    ])('$situation is read as the filters it names, or the default', ({ query, expected }) => {
      expect(parseQuery(new URLSearchParams(query))).toEqual(expected);
    });

    it.each([
      { situation: 'each engineer, coloured by engineer', query: 'group=engineer&split=engineer', group: 'engineer', split: 'phase' },
      { situation: 'each phase, coloured by phase', query: 'group=category&split=phase', group: 'category', split: 'engineer' },
      { situation: 'each phase, with no colouring named', query: 'group=category', group: 'category', split: 'engineer' },
      { situation: 'each engineer, coloured by model', query: 'group=engineer&split=model', group: 'engineer', split: 'model' },
      { situation: 'each phase, coloured by model', query: 'group=category&split=model', group: 'category', split: 'model' },
      { situation: 'each pull request, coloured by phase', query: 'group=pr&split=phase', group: 'pr', split: 'phase' },
      { situation: 'each day, coloured by engineer', query: 'group=day&split=engineer', group: 'day', split: 'engineer' },
      { situation: 'each issue, coloured by engineer', query: 'group=issue&split=engineer', group: 'issue', split: 'engineer' },
    ])('an address never colours the rows by what they already are: $situation', ({ query, group, split }) => {
      expect(parseQuery(new URLSearchParams(query))).toMatchObject({ group, split });
    });

    it.each([
      { situation: 'each engineer with an Engineer filter', query: 'group=engineer&engineer=alice', held: { engineer: null, category: null } },
      { situation: 'each phase with a Phase filter', query: 'group=category&category=building', held: { engineer: null, category: null } },
      { situation: 'each phase with an Engineer filter, which it does not repeat', query: 'group=category&engineer=alice', held: { engineer: 'alice', category: null } },
      { situation: 'each pull request with an Engineer filter', query: 'group=pr&engineer=alice&category=building', held: { engineer: 'alice', category: 'building' } },
    ])('an address never filters to what the rows already are: $situation holds $held', ({ query, held }) => {
      expect(parseQuery(new URLSearchParams(query))).toMatchObject(held);
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

  describe('a period is whole Belgian days ending today', () => {
    it.each([
      { period: '7d', now: '2026-10-31T23:59:59Z', first: '2026-10-26' },
      { period: '30d', now: '2026-10-31T23:59:59Z', first: '2026-10-03' },
      { period: 'all', now: '2026-10-31T23:59:59Z', first: null },
      { period: '7d', now: '2026-10-31T22:59:59Z', first: '2026-10-25' },
      { period: '7d', now: '2026-10-22T12:00:00Z', first: '2026-10-16' },
    ] as const)('$period at $now starts $first', ({ period, now, first }) => {
      expect(firstDay(period, Date.parse(now))).toBe(first);
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

    it('sorted by total, groups come biggest first, and equal totals are in name order', () => {
      const groups = groupRows(
        [row({ prNumber: 2, title: 'B', branch: 'b/2', costMicros: 1 }), row({ prNumber: 3, title: 'A', branch: 'b/3', costMicros: 1 }), row({ costMicros: 9 })],
        'pr',
        null,
        'total',
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

  describe('an issue row names the issue', () => {
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

    it.each([
      { situation: 'requests credited to one issue', credited: [11, 11], says: 'Issue #11' },
      { situation: 'requests credited to two issues', credited: [11, 12], says: 'several issues' },
      { situation: 'requests credited to a pull request that closes no issue', credited: [null], says: 'No issue' },
      { situation: 'requests credited to an issue and to a pull request that closes none', credited: [11, null], says: 'Issue #11' },
    ])('a branch with $situation says so once the credit is good through its newest request', ({ credited, says }) => {
      const rows = credited.map((creditIssue, i) => row({ prNumber: null, title: null, branch: 'b/x', lastAt: 10, series: `s${i}`, credited: 1, creditIssue }));

      const [group] = groupRows(rows, 'pr', 20);

      expect(group!.sub).toBe(says);
    });

    it('a branch with credited requests and a newer one the credit has not reached is linking', () => {
      const rows = [row({ prNumber: null, title: null, branch: 'b/x', lastAt: 10, credited: 1, creditIssue: 11 }), row({ prNumber: null, title: null, branch: 'b/x', lastAt: 30, series: 'later' })];

      const [group] = groupRows(rows, 'pr', 20);

      expect(group!.sub).toBe('linking…');
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

      expect(groups.map((g) => g.label)).toEqual(['2 Oct 2026', '1 Oct 2026']);
    });

    it('split by phase there is a line per phase with cost, and the total', () => {
      const chart = chartOf([day('2026-10-01', 'building', 2), day('2026-10-01', 'after-push', 1)], 'phase', null, '2026-10-01T12:00:00Z');

      expect(chart.lines.map((l) => [l.key, l.values])).toEqual([
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
      expect(chart.lines[0]!.values).toEqual([2, 0, 4]);
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
      expect(chart.lines[0]!.values).toEqual([2]);
    });

    it('with no cost there is nothing to chart', () => {
      expect(chartOf([], 'phase', null, '2026-10-01T12:00:00Z')).toEqual({ days: [], lines: [], total: [] });
    });
  });

  describe("Tokens per day draws each series' tokens summed per day, and a day without requests is zero", () => {
    /** A day's requests in one series: the four kinds of token, priced or not. */
    const tokens = (d: string, series: string, [input, output, cacheWrite, cacheRead]: number[]) =>
      row({ day: d, series, costMicros: 0, prNumber: null, title: null, branch: '', inputTokens: input!, outputTokens: output!, cacheCreationTokens: cacheWrite!, cacheReadTokens: cacheRead! });
    const groups = groupRows(
      [tokens('2026-10-01', 'building', [1, 2, 3, 4]), tokens('2026-10-01', 'after-push', [10, 0, 0, 20]), tokens('2026-10-03', 'building', [100, 0, 0, 0])],
      'day',
      null,
    );
    const chart = dayChart(groups, seriesOf('phase', {}), null, Date.parse('2026-10-03T12:00:00Z'), 'tokens');

    it.each([
      { situation: 'each series', line: 'building', expected: [10, 0, 100] },
      { situation: 'a series on one day of the two', line: 'after-push', expected: [30, 0, 0] },
    ])("$situation reads its four kinds summed on each day, the empty day a zero point", ({ line, expected }) => {
      expect(chart.days).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
      expect(chart.lines.find((l) => l.key === line)!.values).toEqual(expected);
    });

    it('the total line is each day\'s four kinds summed over every series', () => {
      expect(chart.total).toEqual([40, 0, 100]);
    });
  });

  describe('Share over time gives each colour its share of a bucket\'s dollars, in the trend charts\' buckets', () => {
    const NOW = Date.parse('2026-10-31T12:00:00Z');
    const spent = (d: string, series: string, dollars: number) => row({ day: d, series, costMicros: dollars * 1_000_000, prNumber: null, title: null, branch: '' });
    const sharesOf = (rows: TotalRow[], period: '7d' | '30d' | '90d' | 'all') => {
      const groups = groupRows(rows, 'day', null);
      const totals: Record<string, number> = {};
      for (const g of groups) for (const [k, v] of Object.entries(g.bySeries)) totals[k] = (totals[k] ?? 0) + v;
      return shareChart(groups, seriesOf('model', totals), period, NOW);
    };
    const valuesOf = (chart: ReturnType<typeof sharesOf>) => Object.fromEntries(chart.lines.map((l) => [l.key, l.values]));

    it('a day with three dollars on one model and one on another reads 75% and 25% over 30 days', () => {
      const chart = sharesOf([spent('2026-10-30', 'opus', 3), spent('2026-10-30', 'sonnet', 1)], '30d');

      expect(valuesOf(chart).opus!.at(-2)).toBe(75);
      expect(valuesOf(chart).sonnet!.at(-2)).toBe(25);
    });

    it("a week's share is of the week's summed dollars, not an average of its days' shares", () => {
      // Monday: all Opus, $1. Tuesday: all Sonnet, $9. An average of the days would say 50%; the week is 10% Opus.
      const chart = sharesOf([spent('2026-10-26', 'opus', 1), spent('2026-10-27', 'sonnet', 9)], '90d');

      expect(valuesOf(chart).opus!.at(-1)).toBe(10);
      expect(valuesOf(chart).sonnet!.at(-1)).toBe(90);
    });

    it('the shares of every bucket add to 100%', () => {
      const chart = sharesOf([spent('2026-10-28', 'opus', 3), spent('2026-10-28', 'sonnet', 2), spent('2026-10-28', 'haiku', 1), spent('2026-10-29', 'opus', 7)], '30d');
      const lines = Object.values(valuesOf(chart));

      for (let i = 0; i < chart.buckets.length; i++) {
        const sum = lines.reduce((acc, v) => acc + (v[i] ?? 0), 0);
        expect(sum === 0 || Math.abs(sum - 100) < 1e-9).toBe(true);
      }
    });

    it('a day with no dollars is a break in every line, not 0%', () => {
      const chart = sharesOf([spent('2026-10-28', 'opus', 3), spent('2026-10-30', 'opus', 1)], '7d');

      expect(valuesOf(chart).opus).toEqual([null, null, null, 100, null, 100, null]);
    });

    it('a colour with no dollars in the period has no line', () => {
      const chart = sharesOf([spent('2026-10-30', 'opus', 3), spent('2026-10-30', 'sonnet', 0)], '30d');

      expect(chart.lines.map((l) => l.key)).toEqual(['opus']);
    });

    describe('a range is shared over its own days, by day up to 30 and by week beyond', () => {
      const groups = groupRows([spent('2026-10-10', 'opus', 1), spent('2026-10-12', 'opus', 3)], 'day', null);
      const series = seriesOf('model', { opus: 4_000_000 });

      it('a 3-day range has one bucket per day, from its first day to its last', () => {
        const chart = shareChart(groups, series, 'all', NOW, { from: '2026-10-10', to: '2026-10-12' });

        expect(chart).toMatchObject({ weekly: false, buckets: ['2026-10-10', '2026-10-11', '2026-10-12'] });
      });

      it('a 30-day range is in days', () => {
        const chart = shareChart(groups, series, 'all', NOW, { from: '2026-09-15', to: '2026-10-14' });

        expect(chart.weekly).toBe(false);
        expect(chart.buckets).toHaveLength(30);
      });

      it('a 31-day range is in weeks from Monday', () => {
        const chart = shareChart(groups, series, '7d', NOW, { from: '2026-09-30', to: '2026-10-30' });

        expect(chart.weekly).toBe(true);
        expect(chart.buckets[0]).toBe(weekStart('2026-09-30'));
      });
    });

    describe('the buckets are the trend charts\' over the same range', () => {
      const rows = [spent('2026-10-05', 'opus', 1)];

      it('the last 30 days are one bucket per day, the same as the trend charts', () => {
        const chart = sharesOf(rows, '30d');

        expect(chart.weekly).toBe(false);
        expect(chart.buckets).toEqual(trends([], [], '30d', NOW).buckets);
      });

      it('the last 90 days are one bucket per week, each a Monday, the first holding the first day of the period', () => {
        const chart = sharesOf(rows, '90d');

        expect(chart.weekly).toBe(true);
        expect(chart.buckets).toEqual(trends([], [], '90d', NOW).buckets);
        expect(chart.buckets.every((b) => weekStart(b) === b)).toBe(true);
        expect(chart.buckets[0]! <= firstDay('90d', NOW)! && firstDay('90d', NOW)! < addDays(chart.buckets[0]!, 7)).toBe(true);
      });

      it('all time starts at the week of the earliest day on record', () => {
        const chart = sharesOf([spent('2026-09-23', 'opus', 1), spent('2026-10-05', 'opus', 1)], 'all');

        expect(chart.buckets[0]).toBe('2026-09-21');
        expect(chart.buckets).toEqual(trends([{ day: '2026-09-23', tokens: 1 }], [], 'all', NOW).buckets);
        expect(chart.buckets.at(-1)).toBe('2026-10-26');
      });
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

    describe("a range's per-day charts run over its own days, ending today where it would run past it", () => {
      it('a range ending after today draws to today', () => {
        const chart = dayChart(
          groupRows([row({ day: '2026-10-29', series: 'building', costMicros: 5, prNumber: null, title: null, branch: '' })], 'day', null),
          seriesOf('phase', { building: 5 }),
          '2026-10-28',
          NOW,
          'cost',
          '2026-11-05',
        );
        expect(chart.days).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
      });

      it('a range ending before today ends on its last day', () => {
        const chart = dayChart(
          groupRows([row({ day: '2026-10-29', series: 'building', costMicros: 5, prNumber: null, title: null, branch: '' })], 'day', null),
          seriesOf('phase', { building: 5 }),
          '2026-10-28',
          NOW,
          'cost',
          '2026-10-29',
        );

        expect(chart.days).toEqual(['2026-10-28', '2026-10-29']);
      });
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

    it('every phase but Unphased is drawn only from 21 Sep 2026, and Unphased after it only where it holds cost', () => {
      const t = trends(
        [],
        [pr('2026-09-17', 1_000, { unphased: 1, building: 2 }), pr('2026-09-22', 1_000, { unphased: 3, building: 4 })],
        '30d',
        Date.parse('2026-09-25T12:00:00Z'),
      );

      const line = (key: string) => Object.fromEntries(t.buckets.map((b, i) => [b, t.costPerThousandLines.find((l) => l.key === key)!.values[i]])) as Record<string, number | null>;
      expect(line('unphased')['2026-09-17']).toBe(1);
      expect(line('unphased')['2026-09-22']).toBe(3);
      expect(line('building')['2026-09-17']).toBeNull();
      expect(line('building')['2026-09-22']).toBe(4);
      expect(line('total')['2026-09-22']).toBe(7);
    });

    it('Unphased is not drawn for a bucket after 21 Sep 2026 that holds none, and the new phases are drawn from then on', () => {
      const t = trends(
        [],
        [pr('2026-09-17', 1_000, { unphased: 1 }), pr('2026-09-22', 1_000, { 'outside-process': 2, 'process-review': 3 })],
        '30d',
        Date.parse('2026-09-25T12:00:00Z'),
      );

      const line = (key: string) => Object.fromEntries(t.buckets.map((b, i) => [b, t.costPerThousandLines.find((l) => l.key === key)!.values[i]])) as Record<string, number | null>;
      expect(line('unphased')['2026-09-17']).toBe(1);
      expect(line('unphased')['2026-09-22']).toBeNull();
      expect(line('outside-process')['2026-09-17']).toBeNull();
      expect(line('outside-process')['2026-09-22']).toBe(2);
      expect(line('process-review')['2026-09-22']).toBe(3);
    });
  });

  describe('each grouping opens in its own order, and the Total header sorts it by total', () => {
    const merged = (n: number, at: string, over: Partial<TotalRow> = {}) =>
      row({ prNumber: n, title: `P${n}`, branch: `b/${n}`, state: 'MERGED', mergedAt: at, openedAt: '2026-09-01T00:00:00Z', ...over });
    const open = (n: number, at: string, over: Partial<TotalRow> = {}) =>
      row({ prNumber: n, title: `P${n}`, branch: `b/${n}`, state: 'OPEN', mergedAt: null, openedAt: at, ...over });
    const branch = (name: string, lastAt: number, over: Partial<TotalRow> = {}) =>
      row({ prNumber: null, title: null, state: null, mergedAt: null, branch: name, lastAt, ...over });
    const labels = (rows: TotalRow[], group: Parameters<typeof groupRows>[1], sort: 'default' | 'total' = 'default') => groupRows(rows, group, null, sort).map((g) => g.label);

    describe('by pull request, the newest comes first', () => {
      it.each([
        { situation: 'an open pull request comes before one merged today', rows: [merged(1, '2026-10-10T00:00:00Z'), open(2, '2026-10-01T00:00:00Z')], expected: ['#2 P2', '#1 P1'] },
        { situation: 'two open ones are newest opened first', rows: [open(1, '2026-10-01T00:00:00Z'), open(2, '2026-10-05T00:00:00Z')], expected: ['#2 P2', '#1 P1'] },
        { situation: 'two merged ones are latest merge first, whatever each cost', rows: [merged(1, '2026-10-01T00:00:00Z', { costMicros: 9 }), merged(2, '2026-10-05T00:00:00Z')], expected: ['#2 P2', '#1 P1'] },
        {
          situation: 'one closed unmerged sits among the merged by the day it opened',
          rows: [merged(1, '2026-10-01T00:00:00Z'), merged(2, '2026-10-09T00:00:00Z'), row({ prNumber: 3, title: 'P3', branch: 'b/3', state: 'CLOSED', mergedAt: null, openedAt: '2026-10-05T00:00:00Z' })],
          expected: ['#2 P2', '#3 P3', '#1 P1'],
        },
        { situation: 'a branch no pull request names is below every pull request, however dear', rows: [branch('b/x', 99, { costMicros: 99 }), merged(1, '2026-10-01T00:00:00Z')], expected: ['#1 P1', 'b/x'] },
        { situation: 'two such branches are newest activity first', rows: [branch('b/old', 1), branch('b/new', 2)], expected: ['b/new', 'b/old'] },
        { situation: 'No branch is last, below the branches', rows: [branch('', 99, { costMicros: 99 }), branch('b/x', 1)], expected: ['b/x', 'No branch'] },
      ])('$situation', ({ rows, expected }) => {
        expect(labels(rows, 'pr')).toEqual(expected);
      });
    });

    describe('by issue, an issue ranks by its newest pull request', () => {
      const onIssue = (issue: number, pr: TotalRow): TotalRow => ({ ...pr, issue, issueTitle: null });

      it.each([
        {
          situation: 'an issue whose older pull request is dearer, its newer the most recent of all, comes first',
          rows: [onIssue(1, merged(1, '2026-10-01T00:00:00Z', { costMicros: 9 })), onIssue(2, merged(2, '2026-10-02T00:00:00Z')), onIssue(1, merged(3, '2026-10-08T00:00:00Z'))],
          expected: ['#1', '#2'],
        },
        {
          situation: 'an issue with an open pull request comes before one with only merged ones',
          rows: [onIssue(1, merged(1, '2026-10-09T00:00:00Z')), onIssue(2, open(2, '2026-10-01T00:00:00Z'))],
          expected: ['#2', '#1'],
        },
        {
          situation: 'No issue and Unattributed come last, in that order, however dear',
          rows: [branch('b/x', 1, { costMicros: 99 }), merged(3, '2026-10-01T00:00:00Z', { costMicros: 50, issue: null }), onIssue(1, merged(1, '2026-10-01T00:00:00Z'))],
          expected: ['#1', 'No issue', 'Unattributed'],
        },
      ])('$situation', ({ rows, expected }) => {
        expect(labels(rows, 'issue')).toEqual(expected);
      });
    });

    it('by category the phases come in pipeline order, Unphased first, and an unspent one is not listed', () => {
      const phase = (category: string, costMicros: number) => row({ category, costMicros });

      expect(labels([phase('ci-reviews', 9), phase('building', 2), phase('scoping-planning', 1), phase('unphased', 3)], 'category')).toEqual([
        'Unphased',
        'Scoping & planning',
        'Building',
        'CI reviews',
      ]);
    });

    it('by category Outside the process comes after Unphased and Process review comes last, after CI reviews', () => {
      const phase = (category: string, costMicros: number) => row({ category, costMicros });

      expect(labels([phase('process-review', 1), phase('ci-reviews', 9), phase('scoping-planning', 1), phase('outside-process', 2), phase('unphased', 3)], 'category')).toEqual([
        'Unphased',
        'Outside the process',
        'Scoping & planning',
        'CI reviews',
        'Process review',
      ]);
    });

    describe('Unphased is a column and a legend entry only for a period that holds Unphased cost', () => {
      const phases = (totals: Record<string, number>) => seriesOf('phase', totals).map((s) => s.label);

      it.each([
        {
          situation: 'a period holding only the new phases has no Unphased',
          totals: { 'outside-process': 4, 'process-review': 1 },
          expected: ['Outside the process', 'Scoping & planning', 'Building', 'Local code review', 'Local security review', 'After push', 'CI reviews', 'Process review'],
        },
        {
          situation: 'a period holding Unphased cost shows it first',
          totals: { unphased: 2, 'outside-process': 4 },
          expected: ['Unphased', 'Outside the process', 'Scoping & planning', 'Building', 'Local code review', 'Local security review', 'After push', 'CI reviews', 'Process review'],
        },
        {
          situation: 'a period whose Unphased is Building before 21 Sep 2026 shows it first',
          totals: { unphased: 5, building: 2 },
          expected: ['Unphased', 'Outside the process', 'Scoping & planning', 'Building', 'Local code review', 'Local security review', 'After push', 'CI reviews', 'Process review'],
        },
        {
          situation: 'a period holding nothing has no Unphased',
          totals: {},
          expected: ['Outside the process', 'Scoping & planning', 'Building', 'Local code review', 'Local security review', 'After push', 'CI reviews', 'Process review'],
        },
      ])('$situation', ({ totals, expected }) => {
        expect(phases(totals)).toEqual(expected);
      });
    });

    describe('sorted by total, each grouping orders dearest first, ties by name', () => {
      it.each([
        {
          situation: 'by pull request, with the catch-alls placed by their total',
          group: 'pr' as const,
          rows: [open(1, '2026-10-09T00:00:00Z'), merged(2, '2026-10-01T00:00:00Z', { costMicros: 5_000_000 }), branch('', 1, { costMicros: 9_000_000 }), branch('b/x', 1, { costMicros: 2_000_000 })],
          expected: ['No branch', '#2 P2', 'b/x', '#1 P1'],
        },
        {
          situation: 'by day',
          group: 'day' as const,
          rows: [row({ day: '2026-10-03', costMicros: 1 }), row({ day: '2026-10-01', costMicros: 9 }), row({ day: '2026-10-02', costMicros: 5 })],
          expected: ['1 Oct 2026', '2 Oct 2026', '3 Oct 2026'],
        },
        {
          situation: 'by issue',
          group: 'issue' as const,
          rows: [{ ...merged(1, '2026-10-09T00:00:00Z'), issue: 1 }, { ...merged(2, '2026-10-01T00:00:00Z', { costMicros: 7_000_000 }), issue: 2 }],
          expected: ['#2', '#1'],
        },
        {
          situation: 'by category',
          group: 'category' as const,
          rows: [row({ category: 'scoping-planning', costMicros: 1 }), row({ category: 'ci-reviews', costMicros: 9 })],
          expected: ['CI reviews', 'Scoping & planning'],
        },
      ])('$situation', ({ group, rows, expected }) => {
        expect(labels(rows, group, 'total')).toEqual(expected);
      });
    });

    it('by engineer the order is by total whatever is asked', () => {
      const rows = [row({ engineer: 'alice', costMicros: 1 }), row({ prNumber: 2, engineer: 'bob', costMicros: 5 })];

      expect(labels(rows, 'engineer')).toEqual(['bob', 'alice']);
      expect(labels(rows, 'engineer', 'total')).toEqual(['bob', 'alice']);
    });

    describe('the order is carried by the address', () => {
      it('sorted by total is a different address from the default, so the edge cache keeps them apart', () => {
        expect(queryString(parseQuery(new URLSearchParams('group=pr')))).toBe('?group=pr');
        expect(queryString(parseQuery(new URLSearchParams('group=pr&sort=total')))).toBe('?group=pr&sort=total');
      });

      it.each([
        { situation: 'a value it does not know', query: 'group=pr&sort=bogus', expected: '?group=pr' },
        { situation: 'the default spelled out', query: 'group=pr&sort=default', expected: '?group=pr' },
        { situation: 'by engineer, which cannot be switched', query: 'group=engineer&sort=total', expected: '?group=engineer' },
      ])('$situation is the default order', ({ query, expected }) => {
        expect(queryString(parseQuery(new URLSearchParams(query)))).toBe(expected);
      });

      it('paging keeps the order, and a new grouping starts in its own', () => {
        const byTotal = parseQuery(new URLSearchParams('group=pr&sort=total'));

        expect(queryString(byTotal, { page: 2 })).toBe('?group=pr&sort=total&page=2');
        expect(queryString(byTotal, { sort: 'default' })).toBe('?group=pr');
        expect(queryString(byTotal, { group: 'engineer' })).toBe('?group=engineer');
      });
    });
  });

  describe('coloured by engineer, the engineers come dearest first and the requests no pull request claims come last', () => {
    it('a dearer Unattributed still comes after every engineer, and an unknown author is named "unknown"', () => {
      const colours = seriesOf('engineer', { '~unattributed': 9_000_000, alice: 1_000_000, bob: 3_000_000, '~unknown': 2_000_000, carol: 0 });

      expect(colours.map((c) => [c.key, c.label])).toEqual([
        ['bob', 'bob'],
        ['~unknown', 'unknown'],
        ['alice', 'alice'],
        ['~unattributed', 'Unattributed'],
      ]);
    });
  });
});
