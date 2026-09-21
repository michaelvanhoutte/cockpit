import { describe, expect, it } from 'vitest';

import { renderBlock } from '../../../../scripts/lib/session-record.mjs';
import { buildModel, pullModel } from '../../src/model.js';

const MIN = 60_000;
const BASE = Date.UTC(2026, 8, 15, 9, 0);
/** A moment, as minutes past 09:00 on the 15th. */
const at = (minutes) => new Date(BASE + minutes * MIN).toISOString();

let nextId = 1;
/** A check run from minute `from` to minute `to` (`null` for one still running). */
const check = (name, from, to, conclusion = 'success', overrides = {}) => ({
  id: nextId++,
  name,
  suiteId: 1,
  status: to === null ? 'in_progress' : 'completed',
  conclusion: to === null ? null : conclusion,
  startedAt: at(from),
  completedAt: to === null ? null : at(to),
  ...overrides,
});
const commit = (sha, authoredAt, checks = [], parents = 1) => ({ sha, authoredAt: at(authoredAt), parents, checks });
const pull = (overrides = {}) => ({
  number: 1,
  title: 'A change',
  url: 'https://github.com/o/r/pull/1',
  createdAt: at(0),
  mergedAt: at(60),
  body: '',
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  commitCount: (overrides.commits ?? []).length,
  commits: [],
  ...overrides,
});

const minutes = (ms) => ms / MIN;

/** A record body, from marks given as minutes past 09:00. */
const recordBody = (marks) =>
  renderBlock(marks.map(([minute, phase, kind, level]) => ({ at: at(minute), phase, ...(kind ? { kind, level } : {}) })));

const NOW = new Date(BASE + 24 * 60 * MIN);

describe('Lead time', () => {
  describe("each merged pull request's time is split into the parts it spent", () => {
    it('answers before the first push, each round, the fixing between them and the wait to merge', () => {
      const model = pullModel(
        pull({
          mergedAt: at(40),
          commits: [
            commit('a', 0, [check('Checks', 2, 5), check('Test', 3, 12)]),
            commit('b', 20, [check('Checks', 25, 28), check('Test', 26, 35)]),
          ],
        }),
      );
      expect(minutes(model.beforeFirstPushMs)).toBe(2);
      expect(model.rounds.map((round) => minutes(round.ms))).toEqual([10, 10]);
      expect(model.fixingMs.map(minutes)).toEqual([13]);
      expect(minutes(model.waitingToMergeMs)).toBe(5);
      expect(model.awayMs).toEqual([]);
    });

    it('answers before the first push as zero, never negative, where the first commit is dated after it', () => {
      const model = pullModel(pull({ commits: [commit('a', 10, [check('Test', 2, 12)])] }));
      expect(model.beforeFirstPushMs).toBe(0);
    });

    it('gives a commit no check ran on to the next push, not a round of its own', () => {
      const model = pullModel(pull({ commits: [commit('a', 0), commit('b', 1, [check('Test', 2, 12)])] }));
      expect(model.rounds).toHaveLength(1);
      expect(model.rounds[0].commits).toBe(2);
      expect(model.size.commits).toBe(2);
    });

    it('counts a gap of over three hours as away, not as fixing', () => {
      const model = pullModel(
        pull({
          mergedAt: at(230),
          commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 20, [check('Test', 212, 222)])],
        }),
      );
      expect(model.fixingMs).toEqual([]);
      expect(model.awayMs.map(minutes)).toEqual([200]);
      // The wait to merge is short, so it stays a wait and not more time away.
      expect(minutes(model.waitingToMergeMs)).toBe(8);
    });

    it('answers no waiting to merge where it merged straight after the last round', () => {
      const model = pullModel(pull({ mergedAt: at(12), commits: [commit('a', 0, [check('Test', 2, 12)])] }));
      expect(model.waitingToMergeMs).toBe(0);
    });

    it('counts a branch that absorbed two merges of main as two', () => {
      const model = pullModel(
        pull({ commits: [commit('a', 0, [check('Test', 2, 12)]), commit('m1', 20, [], 2), commit('m2', 30, [], 2), commit('b', 40, [check('Test', 41, 50)])] }),
      );
      expect(model.size.mainMerges).toBe(2);
    });
  });

  describe('a round runs from a push to the last check that ran finishing', () => {
    it('counts two checks in flight together once', () => {
      const [round] = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 8), check('E2E (F3)', 3, 12)])] })).rounds;
      expect(round.held.map(({ name, ms }) => [name, minutes(ms)])).toEqual([
        ['Test', 6],
        ['E2E (F3)', 4],
      ]);
      expect(minutes(round.ms)).toBe(10);
    });

    it('does not count a check that was skipped as in flight', () => {
      const [round] = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 12), check('Publish', 2, 50, 'skipped')])] })).rounds;
      expect(round.held.map((held) => held.name)).toEqual(['Test']);
      expect(minutes(round.ms)).toBe(10);
    });

    it('keeps a check the next push cancelled in flight until then, and ends the round at that push', () => {
      // The cancellation is recorded after the push that caused it.
      const [first] = pullModel(
        pull({ commits: [commit('a', 0, [check('Test', 2, 24, 'cancelled')]), commit('b', 20, [check('Test', 20, 30)])] }),
      ).rounds;
      expect(minutes(first.ms)).toBe(18);
      expect(first.endedAt).toBe(at(20));
    });

    it('answers no round for a commit whose every check was skipped', () => {
      const model = pullModel(pull({ commits: [commit('a', 0, [check('Publish', 2, 2, 'skipped'), check('Stability', 2, 2, 'skipped')])] }));
      expect(model.rounds).toEqual([]);
      expect(model.beforeFirstPushMs).toBeNull();
      expect(model.waitingToMergeMs).toBeNull();
    });

    it.each([
      { situation: 'a review check ran', checks: [check('Test', 2, 12), check('claude-review', 2, 10)], kind: 'ready' },
      { situation: 'the security review ran', checks: [check('Test', 2, 12), check('Security review', 2, 9)], kind: 'ready' },
      { situation: 'the review checks were skipped', checks: [check('Test', 2, 12), check('claude-review', 2, 2, 'skipped')], kind: 'draft' },
      { situation: 'no review check was on the commit', checks: [check('Test', 2, 12)], kind: 'draft' },
    ])('calls a round ready or draft by whether the reviews ran: $situation', ({ checks, kind }) => {
      expect(pullModel(pull({ commits: [commit('a', 0, checks)] })).rounds[0].kind).toBe(kind);
    });
  });

  describe('a round says what held it', () => {
    it('names the review as last where the tests finish first and it finishes later', () => {
      const [round] = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 10), check('claude-review', 3, 14)])] })).rounds;
      expect(round.last).toBe('claude-review');
      expect(round.held.map(({ name, ms }) => [name, minutes(ms)])).toEqual([
        ['Test', 8],
        ['claude-review', 4],
      ]);
    });

    it('makes the round red, naming the check, where one failed', () => {
      const [round] = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 10, 'failure'), check('Lint', 2, 4)])] })).rounds;
      expect(round.red).toBe(true);
      expect(round.failed).toEqual(['Test']);
    });

    it('counts a conclusion it does not recognise as neither a pass nor a fail, and names it', () => {
      const [round] = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 10, 'mystery-verdict')])] })).rounds;
      expect(round.red).toBe(false);
      expect(round.failed).toEqual([]);
      expect(round.unrecognised).toEqual([{ name: 'Test', conclusion: 'mystery-verdict' }]);
    });
  });

  describe('a fluke is not a red round', () => {
    it('finds a check that failed and then passed on the same commit, and how long its re-run took', () => {
      const model = pullModel(
        pull({ commits: [commit('a', 0, [check('Test', 2, 8), check('E2E (F3)', 2, 10, 'failure'), check('E2E (F3)', 12, 25)])] }),
      );
      expect(model.flukes.map(({ name, ms }) => [name, minutes(ms)])).toEqual([['E2E (F3)', 15]]);
      expect(model.rounds[0].red).toBe(false);
      expect(minutes(model.rounds[0].ms)).toBe(23);
    });

    it('calls it a red round, not a fluke, where the code changed and the next push passed', () => {
      const model = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 10, 'failure')]), commit('b', 20, [check('Test', 21, 30)])] }));
      expect(model.rounds.map((round) => round.red)).toEqual([true, false]);
      expect(model.flukes).toEqual([]);
    });

    it('calls a check that failed and never passed on its commit red, not a fluke', () => {
      const model = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 10, 'failure'), check('Test', 12, 20, 'failure')])] }));
      expect(model.rounds[0].red).toBe(true);
      expect(model.flukes).toEqual([]);
    });

    it('calls a check red whose failure was followed only by a re-run cancelled before it finished', () => {
      const model = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 10, 'failure'), check('Test', 12, 14, 'cancelled')])] }));
      expect(model.rounds[0].red).toBe(true);
      expect(model.flukes).toEqual([]);
    });

    it('does not call a check that passed and then failed on its commit a fluke, only red', () => {
      const model = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 10), check('Test', 12, 20, 'failure')])] }));
      expect(model.flukes).toEqual([]);
      expect(model.rounds[0].red).toBe(true);
    });

    it('does not call a check that passed twice on its commit a fluke', () => {
      const model = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 10), check('Test', 12, 20)])] }));
      expect(model.flukes).toEqual([]);
      expect(model.rounds[0].red).toBe(false);
    });

    it('does not read two jobs that share a name in different workflows as one check re-run', () => {
      // Two workflows each have a `What changed`; one failing beside the other passing is two checks.
      const model = pullModel(
        pull({ commits: [commit('a', 0, [check('What changed', 2, 4, 'failure', { suiteId: 1 }), check('What changed', 3, 5, 'success', { suiteId: 2 })])] }),
      );
      expect(model.flukes).toEqual([]);
      expect(model.rounds[0].red).toBe(true);
    });
  });

  describe('time that was not recorded reads as not recorded', () => {
    const commits = [commit('a', 30, [check('Test', 32, 42)])];

    it('starts a pull request with no session record at its first commit, and says so', () => {
      const model = pullModel(pull({ commits }));
      expect(model.recorded).toBe(false);
      expect(model.start).toEqual({ at: at(30), from: 'first-commit' });
      expect(model.localReviews).toBeNull();
      expect(model.notes.join(' ')).toContain('No session record');
    });

    it("starts a pull request with a record at the session's start, and counts and times its local reviews", () => {
      const model = pullModel(
        pull({
          commits,
          body: recordBody([
            [0, 'start'],
            [5, 'scoped'],
            [20, 'built'],
            [21, 'review-start', 'code-review', 'high'],
            [27, 'review-end', 'code-review', 'high'],
            [28, 'review-start', 'security-review', 'high'],
            [30, 'review-end', 'security-review', 'high'],
            [31, 'pushed'],
          ]),
        }),
      );
      expect(model.recorded).toBe(true);
      expect(model.start).toEqual({ at: at(0), from: 'session-record' });
      expect(minutes(model.beforeFirstPushMs)).toBe(32);
      expect(model.localReviews.count).toBe(2);
      expect(minutes(model.localReviews.ms)).toBe(8);
      expect(model.notRecorded).toEqual([]);
    });

    it('reads the rest of a record that is missing one phase, and says which it lacks', () => {
      const model = pullModel(
        pull({
          commits,
          body: recordBody([
            [0, 'start'],
            [21, 'review-start', 'code-review', 'high'],
            [27, 'review-end', 'code-review', 'high'],
            [31, 'pushed'],
          ]),
        }),
      );
      expect(model.notRecorded).toEqual(['scoped', 'built']);
      expect(model.start.from).toBe('session-record');
      expect(model.localReviews.count).toBe(1);
    });

    it('does not read a review whose end was never marked as a review it can time', () => {
      const model = pullModel(pull({ commits, body: recordBody([[0, 'start'], [21, 'review-start', 'code-review', 'high']]) }));
      expect(model.localReviews).toBeNull();
      expect(model.notRecorded).toContain('review-end');
    });

    it("ignores a record whose start is after the first commit, and says so", () => {
      const model = pullModel(pull({ commits, body: recordBody([[45, 'start'], [46, 'pushed']]) }));
      expect(model.start).toEqual({ at: at(30), from: 'first-commit' });
      expect(model.notes.join(' ')).toContain('start is after');
    });

    it('treats a body whose record markers do not pair as having no record, and says so', () => {
      const model = pullModel(pull({ commits, body: '<!-- session-record:start -->\n- 2026-09-15T09:00:00.000Z start' }));
      expect(model.recorded).toBe(false);
      expect(model.start.from).toBe('first-commit');
      expect(model.notes.join(' ')).toContain('could not be read');
    });
  });

  describe('a figure carries the number of pull requests behind it', () => {
    /** A pull request merged `merged` minutes past 09:00, with rounds of `round` minutes. */
    const finished = (number, merged, round, overrides = {}) =>
      pull({
        number,
        createdAt: at(merged - 40),
        mergedAt: at(merged),
        commits: [commit(`c${number}`, merged - 40, [check('Test', merged - 30, merged - 30 + round)])],
        ...overrides,
      });
    const build = (pulls, windows = [7]) =>
      buildModel({ pulls, now: NOW, requestedDays: Math.max(...windows), coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows });

    it('answers one pull request in a window as both its median and its p90', () => {
      const [window] = build([finished(1, 60, 10)]).windows;
      expect(window.parts.round).toEqual({ median: 10 * MIN, p90: 10 * MIN, count: 1, pulls: 1 });
      expect(window.parts.beforeFirstPush.pulls).toBe(1);
    });

    it('counts the rounds behind a figure separately from the pull requests they came from', () => {
      const two = pull({ commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 20, [check('Test', 21, 25)])] });
      const [window] = build([two]).windows;
      expect(window.parts.round).toMatchObject({ count: 2, pulls: 1 });
    });

    it('reads no pull requests in a window as no data, never as zero', () => {
      const [window] = build([]).windows;
      expect(window.pulls.total).toBe(0);
      expect(Object.values(window.parts).every((part) => part === null)).toBe(true);
      expect(window.rounds).toBeNull();
      expect(window.flukes).toBeNull();
    });

    it('answers each window from the pull requests merged inside it', () => {
      const old = finished(1, -10 * 24 * 60, 30);
      const recent = finished(2, 60, 10);
      const [week, fortnight] = build([old, recent], [7, 14]).windows;
      expect(week.parts.round.count).toBe(1);
      expect(fortnight.parts.round).toMatchObject({ count: 2, pulls: 2, median: 20 * MIN });
    });

    it('leaves the pull requests with no record out of the figures that need one, with the count', () => {
      const recorded = finished(1, 60, 10, {
        body: recordBody([[0, 'start'], [10, 'review-start', 'code-review', 'low'], [14, 'review-end', 'code-review', 'low']]),
      });
      const [window] = build([recorded, finished(2, 90, 10)]).windows;
      expect(window.pulls).toEqual({ total: 2, withRecord: 1, withoutRecord: 1 });
      expect(window.localReviews.ms).toMatchObject({ median: 4 * MIN, pulls: 1 });
      expect(window.localReviews.count).toMatchObject({ median: 1, pulls: 1 });
      // Every pull request has a first commit, so the parts that do not need a record still cover both.
      expect(window.parts.round.pulls).toBe(2);
    });

    it('reads a window that no pull request reviewed locally as no data', () => {
      const [window] = build([finished(1, 60, 10)]).windows;
      expect(window.localReviews).toEqual({ count: null, ms: null });
    });

    it('leaves a pull request closed without merging out of every figure', () => {
      const model = build([finished(1, 60, 10), finished(2, 90, 10, { mergedAt: null })]);
      expect(model.pulls.map((each) => each.number)).toEqual([1]);
      expect(model.windows[0].pulls.total).toBe(1);
      expect(model.coverage.pulls).toBe(1);
    });

    it('says a window is partial where the fetch did not read back to its start', () => {
      const model = buildModel({
        pulls: [finished(1, 60, 10)],
        now: NOW,
        requestedDays: 14,
        coveredSince: new Date(NOW.getTime() - 9 * 24 * 60 * MIN),
        truncated: true,
        repo: 'o/r',
        windows: [7, 14],
      });
      const [week, fortnight] = model.windows;
      expect(week.partial).toBe(false);
      expect(fortnight.partial).toBe(true);
      expect(fortnight.actualDays).toBeCloseTo(9);
      expect(model.coverage).toMatchObject({ partial: true, truncated: true });
      expect(model.coverage.actualDays).toBeCloseTo(9);
    });
  });

  describe('a window says what held its rounds and how many ran long', () => {
    const build = (pulls) =>
      buildModel({ pulls, now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] });
    const merged = (overrides) => pull({ createdAt: at(-10), mergedAt: at(120), ...overrides });

    it('gives each kind of check the minutes it held, the runs behind them and the rounds it finished last', () => {
      const model = build([
        merged({
          commits: [
            commit('a', 0, [check('Test', 2, 8), check('E2E (F3)', 3, 12)]),
            commit('b', 30, [check('Test', 31, 36), check('claude-review', 31, 45), check('Security review', 31, 40)]),
          ],
        }),
      ]);
      const { harness } = model.windows[0];
      expect(harness.rounds).toBe(2);
      expect(harness.kinds.checks).toEqual({ ms: 15 * MIN, runs: 3, last: 1 });
      expect(harness.kinds['security-review']).toEqual({ ms: 4 * MIN, runs: 1, last: 0 });
      expect(harness.kinds['code-review']).toEqual({ ms: 5 * MIN, runs: 1, last: 1 });
    });

    it('reads no pull requests in the window as no harness figures, not as a harness that held nothing', () => {
      expect(build([]).windows[0].harness).toBeNull();
    });

    it('reads pull requests no check ran on as no harness figures, not as a harness that held nothing', () => {
      const [window] = build([merged({ commits: [commit('a', 0)] })]).windows;
      expect(window.pulls.total).toBe(1);
      expect(window.harness).toBeNull();
    });

    it('counts the rounds that ran past ten minutes, and how many rounds each pull request took', () => {
      const model = build([
        merged({ number: 1, commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 30, [check('Test', 31, 42)])] }),
        merged({ number: 2, commits: [commit('c', 0, [check('Test', 2, 22)])] }),
      ]);
      const { rounds } = model.windows[0];
      // Exactly ten minutes is not past ten minutes.
      expect(rounds.overTenMinutes).toBe(2);
      expect(rounds.perPull).toMatchObject({ median: 1.5, count: 2, pulls: 2 });
    });

    it('leaves a pull request no check ran on out of the rounds it took, rather than counting it as taking none', () => {
      const model = build([merged({ number: 1, commits: [commit('a', 0)] }), merged({ number: 2, commits: [commit('b', 0, [check('Test', 2, 12)])] })]);
      expect(model.windows[0].rounds.perPull).toMatchObject({ count: 1, pulls: 1 });
    });

    it('says how long a review held anyone up beside how long it ran, since a review beside the tests holds nobody until they finish', () => {
      const [pullModelled] = build([
        merged({ commits: [commit('a', 0, [check('Test', 2, 12), check('claude-review', 2, 20), check('Security review', 2, 8)])] }),
      ]).pulls;
      expect(minutes(pullModelled.reviews['code-review'].ms)).toBe(18);
      expect(minutes(pullModelled.reviews['code-review'].heldMs)).toBe(8);
      // It finished before the tests did, so it held the round for none of it.
      expect(pullModelled.reviews['security-review']).toMatchObject({ runs: 1, heldMs: 6 * MIN });
    });
  });
});
