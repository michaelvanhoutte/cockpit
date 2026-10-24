import { describe, expect, it } from 'vitest';
import {
  checkRows,
  costOf,
  cycleTimeAddress,
  filtered,
  hm,
  parseCycleTimeQuery,
  outline,
  values,
  type CycleTimeQuery,
  type Outline,
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
  time: { localParts: null, codingMs:10 * MIN, localMs: 5 * MIN, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 21 * MIN },
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
    time: { localParts: null, codingMs:null, localMs: null, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 21 * MIN },
    balance: null,
    localReviews: null,
    ...over,
  });

const phases = (p: Pull) => values(p);
const added = (v: Record<string, number | null>) => Object.values(v).reduce<number>((a, b) => a + (b ?? 0), 0);

/** A recorded pull request whose local checks are split by kind: `parts` minutes of code review, security review, test runs and browser pass. */
const split = (number: number, parts: [number, number, number, number], over: Partial<Pull> = {}): Pull => {
  const [codeReview, securityReview, test, browser] = parts.map((m) => m * MIN) as [number, number, number, number];
  const local = codeReview + securityReview + test + browser;
  return pull(number, {
    time: { localParts: { 'code-review': codeReview, 'security-review': securityReview, test, browser }, codingMs: 10 * MIN, localMs: local, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 16 * MIN + local },
    ...over,
  });
};
/** A recorded pull request with 7 minutes of local checks stored without their kinds. */
const notSplit = (number: number) => pull(number, { time: { localParts: null, codingMs: 10 * MIN, localMs: 7 * MIN, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 23 * MIN } });
const row = (o: Outline, key: string) => o.rows.find((r) => r.key === key)!;
const end = (r: { left: number; width: number }) => r.left + r.width;

describe('Harness Monitor', () => {
  describe("a pull request's phases add up exactly to its start to merge", () => {
    it.each([
      { situation: 'a recorded pull request', p: pull(1) },
      { situation: 'one away for a night between two rounds', p: pull(2, { time: { localParts: null, codingMs: 10 * MIN, localMs: 5 * MIN, ciMs: 5 * MIN, waitingToMergeMs: 0, awayMs: 600 * MIN, totalMs: 620 * MIN } }) },
      { situation: 'one with no session record, whose writing is the time left', p: unrecorded(3) },
      { situation: 'one no check ran on', p: pull(4, { balance: null, rounds: [], time: { localParts: null, codingMs: null, localMs: null, ciMs: 0, waitingToMergeMs: null, awayMs: 0, totalMs: 40 * MIN } }) },
    ])('$situation', ({ p }) => {
      expect(added(phases(p))).toBe(p.time.totalMs);
    });

    it('reads the five phases of a recorded pull request as the record has them', () => {
      expect(phases(pull(1))).toEqual({ writing: 10 * MIN, local: 5 * MIN, ci: 5 * MIN, waiting: MIN, away: 0 });
    });

    it('says a pull request with no session record has no local checks recorded, never 0', () => {
      expect(phases(unrecorded(1)).local).toBeNull();
      expect(phases(unrecorded(1)).ci).toBe(5 * MIN);
    });
  });

  describe("the outline's phases add up to start to merge, and each opened phase's parts add up to the phase", () => {
    // 9 minutes of local checks split 4 / 1 / 3 / 1, and 12 of them split 2 / 2 / 6 / 2; each with a round of Test then E2E (F3).
    const a = split(1, [4, 1, 3, 1], { rounds: [round([check('Test', 2), check('E2E (F3)', 3, { last: true })])] });
    const b = split(2, [2, 2, 6, 2], { rounds: [round([check('Test', 1), check('E2E (F3)', 4, { last: true })])] });

    it.each([
      { situation: 'pull requests all split by kind', list: [a, b] },
      { situation: 'one among them not split by kind', list: [a, b, notSplit(3)] },
    ])('$situation', ({ list }) => {
      const o = outline(list);
      const sumOf = (rows: typeof o.rows) => rows.reduce((total, r) => total + r.ms, 0);
      const phasesOf = o.rows.filter((r) => !r.part);

      expect(sumOf(phasesOf)).toBe(o.total);
      expect(o.total).toBe(list.reduce((total, p) => total + p.time.totalMs, 0));
      for (const phase of phasesOf.filter((r) => r.key === 'local' || r.key === 'ci')) expect(sumOf(o.rows.filter((r) => r.part && r.phase === phase.key))).toBe(phase.ms);
    });

    it('puts the local minutes of a pull request not split by kind in Not split by kind, grey, after the four kinds', () => {
      const o = outline([a, notSplit(3)]);

      expect(o.rows.filter((r) => r.part && r.phase === 'local').map((r) => [r.label, r.ms / MIN, r.other])).toEqual([
        ['Code review', 4, false],
        ['Security review', 1, false],
        ['Test runs', 3, false],
        ['Browser pass', 1, false],
        ['Not split by kind', 7, true],
      ]);
      expect(o.unsplit).toBe(1);
    });

    it('leaves Not split by kind out where every pull request is split, and counts none for one with no session record', () => {
      expect(outline([a, b]).rows.map((r) => r.key)).not.toContain('not-split');
      expect(outline([a, unrecorded(3)]).unsplit).toBe(0);
    });

    it("reads a phase's share as of start to merge and a part's as of its phase", () => {
      const o = outline([a]);

      // Start to merge is 25 minutes: local checks 9 of them, code review 4 of those.
      expect(row(o, 'local').share).toBeCloseTo(9 / 25);
      expect(row(o, 'code-review').share).toBeCloseTo(4 / 9);
      expect(row(o, 'check:E2E (F3)').share).toBeCloseTo(3 / 5);
    });

    it('opens CI rounds into its checks, those CI does not run today drawn together as Other checks, grey', () => {
      const o = outline([pull(1, { rounds: [round([check('E2E (F3)', 9), check('Brand new', 7), check('Another', 2, { last: true })])] })]);

      expect(o.rows.filter((r) => r.part && r.phase === 'ci').map((r) => [r.label, r.ms / MIN, r.other])).toEqual([
        ['E2E (F3)', 9, false],
        ['Other checks', 9, true],
      ]);
    });

    it('leaves out a row with no minutes', () => {
      expect(outline([pull(1)]).rows.map((r) => r.label)).toEqual(['Writing', 'Local checks', 'Not split by kind', 'CI rounds', 'Test', 'Waiting to merge']);
    });
  });

  describe("each part's bar sits inside its phase's stretch on the one scale", () => {
    const o = outline([split(1, [4, 1, 3, 1], { rounds: [round([check('Test', 2), check('E2E (F3)', 3, { last: true })])] })]);

    it('starts the first kind where Local checks starts, and each next one where the one before ends', () => {
      expect(row(o, 'code-review').left).toBeCloseTo(row(o, 'local').left);
      expect(row(o, 'security-review').left).toBeCloseTo(end(row(o, 'code-review')));
      expect(row(o, 'browser').left).toBeCloseTo(end(row(o, 'test')));
    });

    it('ends the last kind and the last check where their phase ends, and carries the phase as the stretch behind it', () => {
      expect(end(row(o, 'browser'))).toBeCloseTo(end(row(o, 'local')));
      // Checks are drawn in the order CI runs them: E2E (F3) first, then Test.
      expect(row(o, 'check:E2E (F3)').left).toBeCloseTo(row(o, 'ci').left);
      expect(row(o, 'check:Test').left).toBeCloseTo(end(row(o, 'check:E2E (F3)')));
      expect(end(row(o, 'check:Test'))).toBeCloseTo(end(row(o, 'ci')));
      expect(row(o, 'code-review').stretch).toEqual({ left: row(o, 'local').left, width: row(o, 'local').width });
    });

    it('lays the phases end to end from 0 to 1', () => {
      const top = o.rows.filter((r) => !r.part);

      expect(top[0]!.left).toBe(0);
      expect(end(top.at(-1)!)).toBeCloseTo(1);
      for (let i = 1; i < top.length; i++) expect(top[i]!.left).toBeCloseTo(end(top[i - 1]!));
    });
  });

  describe('a pull request with no session record has no local checks to open, and says so rather than drawing 0', () => {
    it('draws the phases it has minutes for and none for local checks', () => {
      expect(outline([unrecorded(1)]).rows.map((r) => r.key)).toEqual(['writing', 'ci', 'check:Test', 'waiting']);
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

  describe('Merged, Size and Rounds keep only matching pull requests', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    const q = (over: Partial<CycleTimeQuery>): CycleTimeQuery => ({ period: 'all', size: null, outcome: null, group: 'day', ...over });
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
      { situation: 'one linked with no request', costs: new Map([[1, { micros: 0, requests: 0, unpricedRequests: 0, issue: 5, issueTitle: null }]]), expected: null },
      { situation: 'one with $4.20 of requests', costs: new Map([[1, { micros: 4_200_000, requests: 9, unpricedRequests: 0, issue: 5, issueTitle: null }]]), expected: 4_200_000 },
    ])('$situation', ({ costs, expected }) => {
      expect(costOf(costs, pull(1))?.micros ?? null).toBe(expected);
    });
  });

  describe('the address holds the view, and an unrecognised one falls back to the default', () => {
    it('leaves the defaults out, so one view has one address', () => {
      const q = parseCycleTimeQuery(new URLSearchParams('period=all&size=&outcome=&group=day'));

      expect(cycleTimeAddress(q)).toBe('/cycle-time');
      expect(cycleTimeAddress(q, { group: 'check', outcome: 'red' })).toBe('/cycle-time?outcome=red&group=check');
    });

    it('falls back for a period, size, rounds or tab it does not know, and leaves out a split an old link carries', () => {
      const q = parseCycleTimeQuery(new URLSearchParams('period=1y&size=huge&outcome=never&group=nope'));

      expect(cycleTimeAddress(q)).toBe('/cycle-time');
    });

    it.each(['harness', 'check', 'phase', 'nothing'])('ignores split=%s, so an old link opens the one view', (value) => {
      const q = parseCycleTimeQuery(new URLSearchParams(`period=7d&group=pr&split=${value}`));

      expect(cycleTimeAddress(q)).toBe('/cycle-time?period=7d&group=pr');
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
