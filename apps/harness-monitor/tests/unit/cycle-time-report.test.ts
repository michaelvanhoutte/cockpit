import { describe, expect, it } from 'vitest';
import {
  checkRows,
  costOf,
  cycleTimeAddress,
  filtered,
  hm,
  parseCycleTimeQuery,
  layOut,
  outline,
  outlineFigures,
  OUTLINE_SLOTS,
  values,
  words,
  type CycleTimeQuery,
  type Outline,
  type Pull,
} from '../../src/cycle-time-report';
import { STRIP_LAYOUT_SOURCE } from '../../src/cycle-time-strip';
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
  runningMs: minutes * MIN,
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

/**
 * A recorded pull request whose local checks are split by kind: `parts` minutes of code review, security review, test runs and browser pass, each as the session recorded it.
 * `waited` is the minutes any of them ran, a minute two shared counted once; it is all of them added up where none overlap.
 * The counted-once parts stored beside them are put all on the test runs, so a figure that read them would be wrong.
 */
const split = (number: number, parts: [number, number, number, number], over: Partial<Pull> = {}, waited?: number): Pull => {
  const [codeReview, securityReview, test, browser] = parts.map((m) => m * MIN) as [number, number, number, number];
  const local = waited === undefined ? codeReview + securityReview + test + browser : waited * MIN;
  return pull(number, {
    time: { localParts: { 'code-review': 0, 'security-review': 0, test: local, browser: 0 }, codingMs: 10 * MIN, localMs: local, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 16 * MIN + local },
    localReviews: { count: 2, ms: codeReview + securityReview, byKind: { 'code-review': { count: 1, ms: codeReview }, 'security-review': { count: 1, ms: securityReview } } },
    localRuns: { test: { count: 1, ms: test }, browser: { count: 1, ms: browser } },
    ...over,
  });
};
/** A recorded pull request with 7 minutes of local checks stored without their kinds. */
const notSplit = (number: number) =>
  pull(number, {
    time: { localParts: null, codingMs: 10 * MIN, localMs: 7 * MIN, ciMs: 5 * MIN, waitingToMergeMs: MIN, awayMs: 0, totalMs: 23 * MIN },
    localReviews: { count: 1, ms: 7 * MIN, byKind: null },
  });
const row = (o: Outline, key: string) => o.rows.find((r) => r.key === key)!;
const end = (r: { left: number; width: number }) => r.left + r.width;
/** A phase's or part's minutes, which are never null in a case that reads them. */
const inMinutes = (o: Outline, key: string) => row(o, key).ms! / MIN;

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

  describe("the outline's phases are time waited and add up to start to merge, and a phase's parts are time spent and add up to the time spent it names", () => {
    // 9 minutes of local checks split 4 / 1 / 3 / 1, and 12 of them split 2 / 2 / 6 / 2; each with a round of Test then E2E (F3).
    const a = split(1, [4, 1, 3, 1], { rounds: [round([check('Test', 2), check('E2E (F3)', 3, { last: true })])] });
    const b = split(2, [2, 2, 6, 2], { rounds: [round([check('Test', 1), check('E2E (F3)', 4, { last: true })])] });
    const spentOf = (o: Outline, phase: string) => o.rows.filter((r) => r.part && r.phase === phase).reduce((total, r) => total + r.ms!, 0);

    it.each([
      { situation: 'pull requests all split by kind', list: [a, b] },
      { situation: 'one among them not split by kind', list: [a, b, notSplit(3)] },
    ])('$situation', ({ list }) => {
      const o = outline(list);
      const phasesOf = o.rows.filter((r) => !r.part);

      expect(phasesOf.reduce((total, r) => total + r.ms!, 0)).toBe(o.total);
      expect(o.total).toBe(list.reduce((total, p) => total + p.time.totalMs, 0));
      for (const phase of phasesOf.filter((r) => r.key === 'local' || r.key === 'ci')) expect(row(o, phase.key).spent).toEqual({ ms: spentOf(o, phase.key), overlap: spentOf(o, phase.key) > phase.ms! });
    });

    it('counts a minute a code review and a test run shared once in Local checks waited and in full for each, so its time spent is more', () => {
      // A code review of 10 minutes and a test run of 12 overlapping it by 10: 12 minutes waited, 22 spent.
      const o = outline([split(1, [10, 0, 12, 0], {}, 12)]);

      expect(inMinutes(o, 'local')).toBe(12);
      expect(inMinutes(o, 'code-review')).toBe(10);
      expect(inMinutes(o, 'test')).toBe(12);
      expect(row(o, 'local').spent).toEqual({ ms: 22 * MIN, overlap: true });
    });

    it('keeps the minutes of a browser pass run wholly inside a test run, not 0', () => {
      const o = outline([split(1, [0, 0, 10, 3], {}, 10)]);

      expect(inMinutes(o, 'browser')).toBe(3);
      expect(inMinutes(o, 'test')).toBe(10);
      expect(inMinutes(o, 'local')).toBe(10);
    });

    it("adds E2E's shards up as its time spent, more than the CI rounds waited, and says the phase's parts ran side by side", () => {
      // Four shards of 10 minutes each in a round that held the pull request 12 minutes.
      const shards = [1, 2, 3, 4].map((n) => check('E2E (F3)', 12, { attempt: n, runningMs: 10 * MIN, last: n === 4 }));
      const o = outline([pull(1, { rounds: [round(shards, { ms: 12 * MIN })], time: { ...pull(1).time, ciMs: 12 * MIN, totalMs: 28 * MIN } })]);

      expect(inMinutes(o, 'check:E2E (F3)')).toBe(40);
      expect(inMinutes(o, 'ci')).toBe(12);
      expect(row(o, 'ci').spent).toEqual({ ms: 40 * MIN, overlap: true });
    });

    it('does not say side by side where the parts took less time than the wait', () => {
      // A check that queued for most of the minutes it held the round.
      const o = outline([pull(1, { rounds: [round([check('Test', 5, { runningMs: 2 * MIN, last: true })])] })]);

      expect(row(o, 'ci').spent).toEqual({ ms: 2 * MIN, overlap: false });
    });

    it('puts the local minutes of a pull request not split by kind in Not split by kind, grey, after the four kinds, as time spent', () => {
      const o = outline([a, notSplit(3)]);

      expect(o.rows.filter((r) => r.part && r.phase === 'local').map((r) => [r.label, r.ms! / MIN, r.other])).toEqual([
        ['Code review', 4, false],
        ['Security review', 1, false],
        ['Test runs', 3, false],
        ['Browser pass', 1, false],
        ['Not split by kind', 7, true],
      ]);
      expect(row(o, 'local').spent).toEqual({ ms: 16 * MIN, overlap: false });
      expect(o.unsplit).toBe(1);
    });

    it("decides a pull request is not split from its reviews having no per-kind split, never from the counted-once parts", () => {
      const kinds = split(3, [4, 1, 0, 0]);
      const noKinds = pull(4, { ...notSplit(4), time: { ...notSplit(4).time, localParts: { 'code-review': 7 * MIN, 'security-review': 0, test: 0, browser: 0 } } });
      const o = outline([{ ...kinds, time: { ...kinds.time, localParts: null } }, noKinds]);

      expect(inMinutes(o, 'code-review')).toBe(4);
      expect(inMinutes(o, 'not-split')).toBe(7);
      expect(o.unsplit).toBe(1);
    });

    it('reads a pull request with no reviews recorded as split, its review kinds 0 and its test runs and browser pass from the runs', () => {
      const runsOnly = pull(3, { localReviews: null, localRuns: { test: { count: 1, ms: 3 * MIN }, browser: { count: 1, ms: MIN } }, time: { ...pull(3).time, localMs: 4 * MIN } });
      const o = outline([runsOnly]);

      expect(o.rows.filter((r) => r.part && r.phase === 'local').map((r) => [r.label, r.ms! / MIN])).toEqual([['Test runs', 3], ['Browser pass', 1]]);
      expect(o.unsplit).toBe(0);
    });

    it('leaves Not split by kind out where every pull request is split, and counts none for one with no session record', () => {
      expect(outline([a, b]).rows.map((r) => r.key)).not.toContain('not-split');
      expect(outline([a, unrecorded(3)]).unsplit).toBe(0);
    });

    it('counts none unsplit for a pull request with no local minutes, since no Not split by kind row is drawn for it', () => {
      const none = pull(3, { time: { ...notSplit(3).time, localMs: 0, totalMs: 16 * MIN } });

      expect(outline([none]).unsplit).toBe(0);
      expect(outline([none]).rows.map((r) => r.key)).not.toContain('not-split');
    });

    it("reads a phase's share as of start to merge and a part's as of its phase's time spent, so a phase's parts add up to 100%", () => {
      const o = outline([a]);

      // Start to merge is 25 minutes: local checks waited 9 of them, code review 4 of the 9 spent.
      expect(row(o, 'local').share).toBeCloseTo(9 / 25);
      expect(row(o, 'code-review').share).toBeCloseTo(4 / 9);
      expect(row(o, 'check:E2E (F3)').share).toBeCloseTo(3 / 5);
      for (const phase of ['local', 'ci']) expect(o.rows.filter((r) => r.part && r.phase === phase).reduce((total, r) => total + r.share!, 0)).toBeCloseTo(1);
    });

    it('takes a share of a phase whose parts overlap from the time spent, not the time waited', () => {
      const o = outline([split(1, [10, 0, 12, 0], {}, 12)]);

      expect(row(o, 'test').share).toBeCloseTo(12 / 22);
    });

    it('opens CI rounds into its checks, those CI does not run today drawn together as Other checks, grey', () => {
      const o = outline([pull(1, { rounds: [round([check('E2E (F3)', 9), check('Brand new', 7), check('Another', 2, { last: true })])] })]);

      expect(o.rows.filter((r) => r.part && r.phase === 'ci').map((r) => [r.label, r.ms! / MIN, r.other])).toEqual([
        ['E2E (F3)', 9, false],
        ['Other checks', 9, true],
      ]);
    });

    it('adds a check up over every round and attempt it ran in', () => {
      const o = outline([pull(1, { rounds: [round([check('Test', 3, { runningMs: 2 * MIN })]), round([check('Test', 4, { runningMs: 3 * MIN, attempt: 2 })])] })]);

      expect(inMinutes(o, 'check:Test')).toBe(5);
    });

    it('leaves a row with no minutes out', () => {
      expect(outline([pull(1)]).rows.map((r) => r.label)).toEqual(['Writing', 'Local checks', 'Code review', 'CI rounds', 'Test', 'Waiting to merge']);
    });
  });

  describe('a check with an attempt whose running time is not recorded has its time spent not recorded, never a short sum', () => {
    const noRunning = check('Test', 5, { runningMs: null });
    const known = check('E2E (F3)', 5, { runningMs: 4 * MIN, last: true });
    const o = outline([pull(1, { rounds: [round([noRunning, known])] }), pull(2, { rounds: [round([check('Test', 5, { runningMs: 5 * MIN, last: true })])] })]);

    it('draws that check as not recorded, with no minutes and no share', () => {
      expect(row(o, 'check:Test')).toMatchObject({ ms: null, share: null, width: 0 });
    });

    it("leaves the phase's time spent and every share in it not recorded, and keeps a check that is recorded in full", () => {
      expect(row(o, 'ci').spent).toEqual({ ms: null, overlap: false });
      expect(row(o, 'check:E2E (F3)')).toMatchObject({ ms: 4 * MIN, share: null });
    });

    it('leaves the phase waited as it is', () => {
      expect(inMinutes(o, 'ci')).toBe(10);
    });

    it('counts the pull requests it affects, one for each however many of its checks are not recorded', () => {
      expect(o.noRunning).toBe(1);
      expect(outline([pull(1, { rounds: [round([noRunning, check('E2E (F3)', 5, { runningMs: null, last: true })])] })]).noRunning).toBe(1);
    });

    it('stays not recorded on average as it does added up', () => {
      const slot = OUTLINE_SLOTS.findIndex((s) => s.key === 'check:Test');

      expect(outlineFigures([pull(1, { rounds: [round([noRunning])] })], 3)[slot]).toBeNull();
    });
  });

  describe("each part's bar starts where its phase starts at its own length on the one scale, and the wait's end is marked", () => {
    // Local checks wait 9 minutes of 25; CI rounds wait 5.
    const o = outline([split(1, [4, 1, 3, 1], { rounds: [round([check('Test', 2), check('E2E (F3)', 3, { last: true })])] })]);

    it("starts every part where its phase starts, not where the part before it ends", () => {
      for (const key of ['code-review', 'security-review', 'test', 'browser']) expect(row(o, key).left).toBeCloseTo(row(o, 'local').left);
      for (const key of ['check:E2E (F3)', 'check:Test']) expect(row(o, key).left).toBeCloseTo(row(o, 'ci').left);
    });

    it('gives a part its own length on the scale, ending inside its phase where it is shorter than the wait', () => {
      expect(row(o, 'code-review').width).toBeCloseTo(4 / 25);
      expect(end(row(o, 'code-review'))).toBeLessThan(end(row(o, 'local')));
    });

    it('carries the phase as the stretch behind a part, whose end is where the dashed line goes', () => {
      expect(row(o, 'code-review').stretch).toEqual({ left: row(o, 'local').left, width: row(o, 'local').width });
    });

    it('runs a part longer than its phase waited past the phase', () => {
      // Four shards of 10 minutes in a round that held 12.
      const shards = [1, 2, 3, 4].map((n) => check('E2E (F3)', 12, { attempt: n, runningMs: 10 * MIN, last: n === 4 }));
      const wide = outline([pull(1, { rounds: [round(shards, { ms: 12 * MIN })], time: { ...pull(1).time, ciMs: 12 * MIN, totalMs: 28 * MIN } })]);
      const e2e = row(wide, 'check:E2E (F3)');

      expect(end(e2e)).toBeGreaterThan(end(row(wide, 'ci')));
      expect(end(e2e)).toBeLessThanOrEqual(1 + 1e-9);
    });

    it("draws a part longer than the rest of the scale to the scale's end, its minutes still in full", () => {
      // 5 of 10 minutes waited on CI at the end of the scale, then a check that ran 60.
      const long = outline([pull(1, { rounds: [round([check('Test', 5, { runningMs: 60 * MIN, last: true })])], time: { ...pull(1).time, totalMs: 21 * MIN } })]);
      const test = row(long, 'check:Test');

      expect(end(test)).toBeCloseTo(1);
      expect(test.ms).toBe(60 * MIN);
      expect(words(test).amount).toBe('1h 00m spent');
    });

    it('lays the phases end to end from 0 to 1', () => {
      const top = o.rows.filter((r) => !r.part);

      expect(top[0]!.left).toBe(0);
      expect(end(top.at(-1)!)).toBeCloseTo(1);
      for (let i = 1; i < top.length; i++) expect(top[i]!.left).toBeCloseTo(end(top[i - 1]!));
    });
  });

  describe('a row says what it is: a phase its time waited with its time spent under its name, a part its time spent', () => {
    const o = outline([split(1, [10, 0, 12, 0], {}, 12)]);

    it.each([
      { situation: 'a phase without parts', key: 'writing', spent: null, amount: '10m' },
      { situation: 'a phase with parts that ran side by side', key: 'local', spent: '22m spent side by side', amount: '12m waited' },
      { situation: 'a phase with parts that did not', key: 'ci', spent: '5m spent', amount: '5m waited' },
      { situation: 'a part', key: 'code-review', spent: null, amount: '10m spent' },
    ])('$situation', ({ key, spent, amount }) => {
      expect(words(row(o, key))).toEqual({ spent, amount });
    });

    it('says a part not recorded is not recorded, and its phase has no time spent to name', () => {
      const none = outline([pull(1, { rounds: [round([check('Test', 5, { runningMs: null, last: true })])] })]);

      expect(words(row(none, 'check:Test'))).toEqual({ spent: null, amount: 'not recorded' });
      expect(words(row(none, 'ci'))).toEqual({ spent: 'time spent not recorded', amount: '5m waited' });
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

    it.each([
      { situation: 'each size with a Size filter', address: 'group=size&size=l&outcome=red', expected: '/cycle-time?outcome=red&group=size' },
      { situation: 'each pull request with a Size filter', address: 'group=pr&size=l&outcome=red', expected: '/cycle-time?size=l&outcome=red&group=pr' },
      { situation: 'each check with a Size filter', address: 'group=check&size=l', expected: '/cycle-time?size=l&group=check' },
    ])('an address never filters to what the rows already are: $situation', ({ address, expected }) => {
      expect(cycleTimeAddress(parseCycleTimeQuery(new URLSearchParams(address)))).toBe(expected);
    });

    it.each(['harness', 'check', 'phase', 'nothing'])('ignores split=%s, so an old link opens the one view', (value) => {
      const q = parseCycleTimeQuery(new URLSearchParams(`period=7d&group=pr&split=${value}`));

      expect(cycleTimeAddress(q)).toBe('/cycle-time?period=7d&group=pr');
    });
  });

  describe("a table row's strip is laid out in the browser exactly as Where the time went is on the page", () => {
    // The strip's script draws from the figures a row carries, so its arithmetic is a second copy of the page's: held to it here, over every kind of row.
    const browser = new Function(`${STRIP_LAYOUT_SOURCE}; return { hm, layOut, words };`)() as {
      hm: (ms: number) => string;
      layOut: (slots: unknown[], figures: (number | null)[]) => { total: number; rows: { slot: number; ms: number | null; share: number | null; left: number; width: number; spent: { ms: number | null; overlap: boolean } | null; stretch: { left: number; width: number } | null }[] };
      words: (part: number, row: unknown) => { spent: string | null; amount: string };
    };
    const slots = OUTLINE_SLOTS.map((s) => [s.label, s.part ? 1 : 0, s.other ? 1 : 0, 'colour']);
    const a = split(1, [4, 1, 3, 1], { rounds: [round([check('Test', 2), check('E2E (F3)', 3, { last: true })])] });
    const b = split(2, [2, 2, 6, 2], { rounds: [round([check('Test', 1), check('Brand new', 4, { last: true })])] });
    // Four shards of an hour in a round that held 12 minutes, the last of them cut off at the end of the scale; and a check whose running time was never stored.
    const shards = [1, 2, 3, 4].map((n) => check('E2E (F3)', 12, { attempt: n, runningMs: 60 * MIN, last: n === 4 }));
    const past = pull(6, { rounds: [round(shards, { ms: 12 * MIN })], time: { ...pull(6).time, ciMs: 12 * MIN, totalMs: 28 * MIN } });
    const unstored = pull(7, { rounds: [round([check('Test', 5, { runningMs: null, last: true })])] });

    it.each([
      { situation: 'one pull request split by kind', list: [a], per: 1 },
      { situation: 'two added up', list: [a, b], per: 1 },
      { situation: 'two on average', list: [a, b], per: 2 },
      { situation: 'one among them not split by kind', list: [a, notSplit(3)], per: 2 },
      { situation: 'parts that ran past the end of the scale', list: [past], per: 1 },
      { situation: 'a check whose running time is not recorded, added up and on average', list: [a, unstored], per: 2 },
      { situation: 'two overlapping kinds, whose time spent is more than the wait', list: [split(8, [10, 0, 12, 0], {}, 12)], per: 1 },
      { situation: 'one with no session record', list: [a, unrecorded(4)], per: 1 },
      { situation: 'one with nothing to open', list: [pull(5, { balance: null, rounds: [], time: { localParts: null, codingMs: null, localMs: null, ciMs: 0, waitingToMergeMs: null, awayMs: 0, totalMs: 40 * MIN } })], per: 1 },
    ])('$situation gives the same rows, bars and shares', ({ list, per }) => {
      const figures = outlineFigures(list, per).map((n) => (n === null ? null : Math.round(n)));
      const page = layOut(figures);
      const drawn = browser.layOut(slots, figures);

      expect(drawn.total).toBe(page.total);
      expect(drawn.rows.map((r) => OUTLINE_SLOTS[r.slot]!.key)).toEqual(page.rows.map((r) => r.key));
      for (const [i, r] of drawn.rows.entries()) {
        const want = page.rows[i]!;
        expect([r.ms, r.share, r.left, r.width]).toEqual([want.ms, want.share, want.left, want.width]);
        expect(r.stretch).toEqual(want.stretch);
        expect(r.spent).toEqual(want.spent);
        expect(browser.words(OUTLINE_SLOTS[r.slot]!.part ? 1 : 0, r)).toEqual(words(want));
      }
    });

    it('reads a duration as the page does', () => {
      for (const ms of [0, 45_000, 59_400, 59_600, 12 * MIN, 65 * MIN, 25 * 60 * MIN + 29 * MIN]) expect(browser.hm(ms)).toBe(hm(ms));
    });

    it('lays out the same rows as the outline of the pull requests it was cut from', () => {
      expect(layOut(outlineFigures([a, b])).rows).toEqual(outline([a, b]).rows);
    });

    it("divides a row's minutes by its pull requests where it is an average, and by one where it is added up", () => {
      const slot = OUTLINE_SLOTS.findIndex((s) => s.key === 'writing');

      expect(outlineFigures([a, b], 2)[slot]).toBe(10 * MIN);
      expect(outlineFigures([a, b])[slot]).toBe(20 * MIN);
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
