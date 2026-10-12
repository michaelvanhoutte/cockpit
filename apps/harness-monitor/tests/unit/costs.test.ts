import { describe, expect, it } from 'vitest';
import { firstDay, groupRows, median, parseQuery, queryString, type TotalRow } from '../../src/costs';

const row = (over: Partial<TotalRow>): TotalRow => ({
  day: '',
  branch: 'b/1',
  category: 'building',
  costMicros: 1_000_000,
  unpricedRequests: 0,
  lastAt: 0,
  prNumber: 1,
  title: 'T',
  state: 'MERGED',
  mergedAt: '2026-03-01T10:00:00Z',
  issue: null,
  engineer: 'alice',
  linesAdded: null,
  linesRemoved: null,
  openedAt: null,
  ciRounds: null,
  issueTitle: null,
  ...over,
});

describe('Harness Monitor', () => {
  describe('the costs page is asked for by its address', () => {
    it.each([
      { situation: 'nothing', query: '', expected: { period: '30d', engineer: null, category: null, group: 'pr', page: 1 } },
      {
        situation: 'every filter',
        query: 'period=all&engineer=alice&category=ci-reviews&group=day&page=3',
        expected: { period: 'all', engineer: 'alice', category: 'ci-reviews', group: 'day', page: 3 },
      },
      {
        situation: 'values it does not know',
        query: 'period=forever&category=lunch&group=colour&page=-2',
        expected: { period: '30d', engineer: null, category: null, group: 'pr', page: 1 },
      },
      {
        situation: 'names every object inherits',
        query: 'period=toString&category=constructor&group=__proto__',
        expected: { period: '30d', engineer: null, category: null, group: 'pr', page: 1 },
      },
    ])('$situation is read as the filters it names, or the default', ({ query, expected }) => {
      expect(parseQuery(new URLSearchParams(query))).toEqual(expected);
    });

    it('the same page has one address however it was spelled', () => {
      const spelled = parseQuery(new URLSearchParams('junk=1&group=pr&engineer=&period=30d&page=1'));

      expect(queryString(spelled)).toBe('');
      expect(queryString(spelled, { group: 'issue', page: 2 })).toBe('?group=issue&page=2');
    });
  });

  describe('a period is whole UTC days ending today', () => {
    it.each([
      { period: '7d', first: '2026-03-25' },
      { period: '30d', first: '2026-03-02' },
      { period: 'all', first: null },
    ] as const)('$period starts $first', ({ period, first }) => {
      expect(firstDay(period, Date.parse('2026-03-31T23:59:59Z'))).toBe(first);
    });
  });

  describe("each group's total is the sum of its requests", () => {
    it('rows of one pull request in different categories become one group with the split kept', () => {
      const groups = groupRows(
        [row({ category: 'building', costMicros: 2_000_000 }), row({ category: 'after-push', costMicros: 3_000_000, unpricedRequests: 2 })],
        'pr',
        null,
      );

      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ label: '#1 T', totalMicros: 5_000_000, unpricedRequests: 2 });
      expect(groups[0]!.byCategory.building).toBe(2_000_000);
      expect(groups[0]!.byCategory['after-push']).toBe(3_000_000);
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
});
