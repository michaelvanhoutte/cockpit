import { describe, expect, it } from 'vitest';
import {
  checkRows,
  costOf,
  cycleTimeAddress,
  filtered,
  hm,
  parseCycleTimeQuery,
  seriesOf,
  splitTotals,
  values,
  type CycleTimeQuery,
  type Pull,
} from '../../src/cycle-time-report';
import type { CycleTimeCheck, CycleTimeRound } from '../../src/cycle-time-store';

const MIN = 60_000;

const check = (name: string, minutes: number, over: Partial<CycleTimeCheck> = {}): CycleTimeCheck => ({
  name,
  attempt: 1,
  heldMs: minutes * MIN,
  last: false,
  failure: null,
  flukeMs: null,
  queuedMs: null,
  failedSteps: [],
  failedFiles: [],
  ...over,
});

/** A round of `checks`, the last of which finished it. */
const round = (checks: CycleTimeCheck[], over: Partial<CycleTimeRound> = {}): CycleTimeRound => ({
  index: 0,
  sha: 'b'.repeat(40),
  pushedAt: '2026-10-20T10:00:00.000Z',
  endedAt: '2026-10-20T10:05:00.000Z',
  ms: 5 * MIN,
  red: false,
  commits: 1,
  queueNotRecorded: false,
  failed: checks.filter((c) => c.failure === 'red').map((c) => c.name),
  last: checks.at(-1)?.name ?? null,
  checks,
  ...over,
});

/** A recorded pull request: 10 minutes of writing, 5 of local checks, a 5 minute round, a minute waiting to merge. */
const pull = (number: number, over: Partial<Pull> = {}): Pull => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  mergedAt: '2026-10-20T12:00:00.000Z',
  base: 'main',
  head: null,
  landing: false,
  size: { additions: 30, deletions: 10, files: 3, commits: 2, mainMerges: 0 },
  start: { at: '2026-10-20T11:39:00.000Z', from: 'session-record' },
  recorded: true,
  time: { codingMs: 10 * MIN, localMs: 5 * MIN, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 21 * MIN },
  balance: { codingMs: 10 * MIN, harnessMs: 10 * MIN, rounds: 1, ratio: 1 },
  localReviews: { count: 1, ms: 5 * MIN, byKind: { 'code-review': { count: 1, ms: 5 * MIN }, 'security-review': { count: 0, ms: 0 } } },
  localRuns: { test: null, browser: null },
  runnerMs: 0,
  cancelled: { superseded: { runs: 0, ms: 0 }, other: { runs: 0, ms: 0 } },
  flukes: [],
  rounds: [round([check('Test', 5, { last: true })])],
  ...over,
});

/** A pull request nobody wrote a session record for. */
const unrecorded = (number: number, over: Partial<Pull> = {}) =>
  pull(number, {
    recorded: false,
    time: { codingMs: null, localMs: null, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 21 * MIN },
    balance: null,
    localReviews: null,
    ...over,
  });

const phases = (p: Pull) => values(p, 'phase');
const added = (v: Record<string, number | null>) => Object.values(v).reduce<number>((a, b) => a + (b ?? 0), 0);

describe('Harness Monitor', () => {
  describe("Split by Phase adds up exactly to a pull request's start to merge", () => {
    it.each([
      { situation: 'a recorded pull request', p: pull(1) },
      { situation: 'one away for a night between two rounds', p: pull(2, { time: { codingMs: 10 * MIN, localMs: 5 * MIN, ciMs: 5 * MIN, waitingToMergeMs: 0, awayMs: 600 * MIN, totalMs: 620 * MIN } }) },
      { situation: 'one with no session record, whose writing is the time left', p: unrecorded(3) },
      { situation: 'one no check ran on', p: pull(4, { balance: null, rounds: [], time: { codingMs: null, localMs: null, ciMs: 0, waitingToMergeMs: null, awayMs: 0, totalMs: 40 * MIN } }) },
    ])('$situation', ({ p }) => {
      expect(added(phases(p))).toBe(p.time.totalMs);
    });

    it('reads the five phases of a recorded pull request as the record has them', () => {
      expect(phases(pull(1))).toEqual({ writing: 10 * MIN, local: 5 * MIN, ci: 5 * MIN, waiting: MIN, away: 0 });
    });
  });

  describe('a pull request with no session record says its local time is not recorded, never 0', () => {
    it.each([
      { situation: 'by phase', split: 'phase' as const, notRecorded: ['local'] },
      { situation: 'by harness', split: 'harness' as const, notRecorded: ['code-review', 'security-review', 'reviews', 'test', 'browser'] },
    ])('$situation', ({ split, notRecorded }) => {
      const v = values(unrecorded(1), split);

      for (const key of notRecorded) expect(v[key]).toBeNull();
      expect(v.ci).toBe(5 * MIN);
    });
  });

  describe('Split by Harness counts kinds that ran at once in each, and says by how much the columns exceed the harness total', () => {
    // A 15 minute review and a 15 minute test run that overlapped by 10 minutes: 20 minutes of local time, and 5 of CI.
    const overlapping = pull(1, {
      balance: { codingMs: 10 * MIN, harnessMs: 25 * MIN, rounds: 1, ratio: 2.5 },
      time: { codingMs: 10 * MIN, localMs: 20 * MIN, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 36 * MIN },
      localReviews: { count: 1, ms: 15 * MIN, byKind: { 'code-review': { count: 1, ms: 15 * MIN }, 'security-review': { count: 0, ms: 0 } } },
      localRuns: { test: { count: 1, ms: 15 * MIN }, browser: null },
    });

    it('counts both in full and the overlap as the overshoot', () => {
      const { byKey, all, union } = splitTotals([overlapping], 'harness');

      expect(byKey.get('code-review')).toBe(15 * MIN);
      expect(byKey.get('test')).toBe(15 * MIN);
      expect(union).toBe(25 * MIN);
      expect(all - union).toBe(10 * MIN);
    });

    it('draws code review and security review as their own series, each in full where two reviews ran at once', () => {
      // A 10 minute code review and a 4 minute security review inside it: 10 minutes of local time.
      const together = pull(1, {
        balance: { codingMs: 10 * MIN, harnessMs: 15 * MIN, rounds: 1, ratio: 1.5 },
        time: { codingMs: 10 * MIN, localMs: 10 * MIN, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 26 * MIN },
        localReviews: { count: 2, ms: 10 * MIN, byKind: { 'code-review': { count: 1, ms: 10 * MIN }, 'security-review': { count: 1, ms: 4 * MIN } } },
      });

      const { byKey, all, union } = splitTotals([together], 'harness');

      expect([byKey.get('code-review'), byKey.get('security-review'), byKey.has('reviews')]).toEqual([10 * MIN, 4 * MIN, false]);
      expect(all - union).toBe(4 * MIN);
    });

    it('has no overshoot when nothing ran at once', () => {
      const { all, union } = splitTotals([pull(1)], 'harness');

      expect(all - union).toBe(0);
    });
  });

  describe('a pull request stored with its reviews combined only has them drawn as one figure, named as such', () => {
    const combined = pull(1, { localReviews: { count: 2, ms: 8 * MIN, byKind: null }, time: { codingMs: 10 * MIN, localMs: 8 * MIN, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 24 * MIN }, balance: { codingMs: 10 * MIN, harnessMs: 13 * MIN, rounds: 1, ratio: 1.3 } });

    it('puts the one figure under the combined series and none under either kind', () => {
      expect(values(combined, 'harness')).toMatchObject({ 'code-review': 0, 'security-review': 0, reviews: 8 * MIN });
    });

    it('draws the combined series only for a list that holds such a pull request', () => {
      expect(seriesOf([combined], 'harness').map((s) => s.key)).toEqual(['ci', 'code-review', 'security-review', 'reviews', 'test', 'browser']);
      expect(seriesOf([pull(2)], 'harness').map((s) => s.key)).toEqual(['ci', 'code-review', 'security-review', 'test', 'browser']);
      expect(seriesOf([combined, pull(2)], 'phase').map((s) => s.key)).toEqual(['writing', 'local', 'ci', 'waiting', 'away']);
    });
  });

  describe('the Check tab gives each check the rounds it held, the rounds it finished last, its minutes held, its red rounds, its flukes and its median queue', () => {
    // Five rounds of E2E (F3) beside Test: E2E finishes last in three, Test in two; E2E is red once and has a fluke once.
    const e2e = (minutes: number, last: boolean, over: Partial<CycleTimeCheck> = {}) => check('E2E (F3)', minutes, { last, ...over });
    const test = (minutes: number, last: boolean, over: Partial<CycleTimeCheck> = {}) => check('Test', minutes, { last, ...over });
    const pulls = [
      pull(1, { rounds: [round([test(3, false), e2e(8, true)]), round([test(3, false, { queuedMs: 4 * MIN }), e2e(9, true, { failure: 'red' })], { red: true })] }),
      pull(2, { rounds: [round([e2e(10, false, { failure: 'fluke', flukeMs: 6 * MIN }), e2e(4, false), test(7, true)]), round([e2e(6, false), test(5, true, { queuedMs: 8 * MIN })]), round([test(2, false), e2e(7, true)])] }),
    ];

    it('E2E finishing last in 3 of 5 rounds held 5 and finished last 3', () => {
      const e = checkRows(pulls).rows.find((r) => r.name === 'E2E (F3)')!;

      expect(e).toMatchObject({ held: 5, last: 3, red: 1, redPulls: [1], flukes: 1 });
      // A round's time is the check's attempts added up: 8, 9, 10 + 4, 6, 7.
      expect(e.ms).toBe((8 + 9 + 14 + 6 + 7) * MIN);
      expect(e.median).toBe(8 * MIN);
    });

    it("reads a check's median queue from the rounds that recorded one, and not recorded where none did", () => {
      const rows = checkRows(pulls).rows;

      expect(rows.find((r) => r.name === 'Test')!.queue).toBe(6 * MIN);
      expect(rows.find((r) => r.name === 'E2E (F3)')!.queue).toBeNull();
    });

    it('lists the check holding the most minutes first, including one CI does not run today', () => {
      const withOther = [pull(3, { rounds: [round([check('Brand new check', 50, { last: true })])] }), ...pulls];

      const { rows } = checkRows(withOther);

      expect(rows.map((r) => r.name)).toEqual(['Brand new check', 'E2E (F3)', 'Test']);
    });
  });

  describe('Split by Check keeps the time of a check CI does not run today, drawn together as Other checks', () => {
    const withNew = pull(1, { rounds: [round([check('E2E (F3)', 9), check('Brand new', 7, { last: true }), check('Another', 2)])] });

    it('adds the unknown checks up under one series beside the known ones', () => {
      expect(values(withNew, 'check')).toEqual({ 'E2E (F3)': 9 * MIN, other: 9 * MIN });
      expect(splitTotals([withNew], 'check').all).toBe(18 * MIN);
    });

    it('draws that series only for a list that holds such a pull request', () => {
      expect(seriesOf([withNew], 'check').map((s) => s.key)).toContain('other');
      expect(seriesOf([pull(2)], 'check').map((s) => s.key)).not.toContain('other');
    });
  });

  describe('Merged, Size and Rounds keep only matching pull requests', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    const q = (over: Partial<CycleTimeQuery>): CycleTimeQuery => ({ period: 'all', size: null, outcome: null, group: 'day', split: 'phase', ...over });
    const at = (day: string) => `${day}T12:00:00.000Z`;
    const pulls = [
      pull(1, { mergedAt: at('2026-10-22') }),
      pull(2, { mergedAt: at('2026-10-20'), size: { additions: 600, deletions: 20, files: 9, commits: 4, mainMerges: 0 } }),
      pull(3, { mergedAt: at('2026-10-15'), rounds: [round([check('Test', 5, { last: true, failure: 'red' })], { red: true }), round([check('Test', 5, { last: true })])] }),
      pull(4, { mergedAt: at('2026-10-22'), landing: true }),
    ];
    const numbers = (query: CycleTimeQuery) => filtered(pulls, query, now).list.map((p) => p.number);

    it.each([
      { situation: 'Last 3 days keeps those merged in the three Belgian days up to today', query: q({ period: '3d' }), expected: [1, 2] },
      { situation: 'Last 7 days leaves out the one merged a week earlier', query: q({ period: '7d' }), expected: [1, 2] },
      { situation: 'Everything held keeps all, a feature branch landing apart', query: q({}), expected: [1, 2, 3] },
      { situation: 'Size: 500 to 1,499 lines keeps only that size', query: q({ size: 'm' }), expected: [2] },
      { situation: 'Rounds: had a red round keeps only those', query: q({ outcome: 'red' }), expected: [3] },
      { situation: 'Rounds: merged on its first round leaves out one that had a red round', query: q({ outcome: 'green' }), expected: [1, 2] },
      { situation: 'a size and a period together keep what matches both', query: q({ period: '3d', size: 'xs' }), expected: [1] },
    ])('$situation', ({ query, expected }) => {
      expect(numbers(query)).toEqual(expected);
    });

    it('compares a period with the one just before it, under the same size and rounds', () => {
      expect(filtered(pulls, q({ period: '7d' }), now).previous.map((p) => p.number)).toEqual([3]);
      expect(filtered(pulls, q({ period: '7d', size: 'm' }), now).previous).toEqual([]);
      expect(filtered(pulls, q({ period: 'all' }), now).previous).toEqual([]);
    });
  });

  describe('a pull request with no Claude Code request recorded has no cost, never $0.00', () => {
    it.each([
      { situation: 'one the Monitor holds nothing for', costs: new Map(), expected: null },
      { situation: 'one linked with no request', costs: new Map([[1, { micros: 0, requests: 0, unpricedRequests: 0, issue: 5 }]]), expected: null },
      { situation: 'one with $4.20 of requests', costs: new Map([[1, { micros: 4_200_000, requests: 9, unpricedRequests: 0, issue: 5 }]]), expected: 4_200_000 },
    ])('$situation', ({ costs, expected }) => {
      expect(costOf(costs, pull(1))?.micros ?? null).toBe(expected);
    });
  });

  describe('the address holds the view, and an unrecognised one falls back to the default', () => {
    it('leaves the defaults out, so one view has one address', () => {
      const q = parseCycleTimeQuery(new URLSearchParams('period=all&size=&outcome=&group=day&split=phase'));

      expect(cycleTimeAddress(q)).toBe('/cycle-time');
      expect(cycleTimeAddress(q, { group: 'check', outcome: 'red' })).toBe('/cycle-time?outcome=red&group=check');
    });

    it('falls back for a period, size, rounds, tab or split it does not know', () => {
      const q = parseCycleTimeQuery(new URLSearchParams('period=1y&size=huge&outcome=never&group=nope&split=nothing'));

      expect(cycleTimeAddress(q)).toBe('/cycle-time');
    });
  });

  describe('a duration reads as a person says it', () => {
    it.each([
      { ms: 45_000, text: '45s' },
      { ms: 12 * MIN, text: '12m' },
      { ms: 65 * MIN, text: '1h 05m' },
      { ms: 0, text: '0m' },
      { ms: 59_600, text: '1m' },
    ])('$ms ms reads $text', ({ ms, text }) => {
      expect(hm(ms)).toBe(text);
    });
  });
});
