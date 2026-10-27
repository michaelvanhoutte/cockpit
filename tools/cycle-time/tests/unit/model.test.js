import { describe, expect, it } from 'vitest';

import { renderBlock } from '../../../../scripts/lib/session-record.mjs';
import { buildModel, matchArtifact, pullModel } from '../../src/model.js';

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
const sum = (values) => values.reduce((total, value) => total + value, 0);

/** A record body, from marks given as minutes past 09:00. */
const recordBody = (marks) =>
  renderBlock(marks.map(([minute, phase, kind, level]) => ({ at: at(minute), phase, ...(kind ? { kind, level } : {}) })));

const NOW = new Date(BASE + 24 * 60 * MIN);

describe('Cycle time', () => {
  describe('a pull request into a feature branch is counted, and a landing of one is not', () => {
    const unit = (number) => pull({ number, base: 'feature/find-items-1238', head: `unit-${number}`, mergedAt: at(60), commits: [commit('a', 0, [check('Test', 2, 12)])] });
    const landing = pull({ number: 9, base: 'main', head: 'feature/find-items-1238', mergedAt: at(300), commits: [commit('a', 0, [check('Test', 2, 12)])] });
    const build = (pulls) => buildModel({ pulls, now: NOW, requestedDays: 14, coveredSince: new Date(BASE - 14 * 86_400_000), repo: 'o/r' });

    it('keeps the base and head of each, and marks only a feature branch into the trunk as a landing', () => {
      const model = build([pull({ number: 1 }), unit(2), landing]);
      expect(model.pulls.map((each) => [each.number, each.base, each.landing])).toEqual([
        [9, 'main', true],
        [1, 'main', false],
        [2, 'feature/find-items-1238', false],
      ]);
    });

    it('reads a pull request with no base as into the trunk', () => {
      expect(pullModel(pull())).toMatchObject({ base: 'main', head: null, landing: false });
    });

    it('computes every window figure without the landing', () => {
      const withLanding = build([pull({ number: 1 }), unit(2), landing]);
      const without = build([pull({ number: 1 }), unit(2)]);
      expect(withLanding.windows).toEqual(without.windows);
      expect(withLanding.windows[0].pulls.total).toBe(2);
      expect(withLanding.windows[0].parts.total.median).toBe(60 * MIN);
    });

    it('does not read a pull request from a feature branch into another feature branch as a landing', () => {
      const nested = pull({ number: 3, base: 'feature/a', head: 'feature/b' });
      expect(build([nested]).pulls[0].landing).toBe(false);
    });
  });

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

  });

  describe('the remote reviews are gone: a check named for one is an ordinary check', () => {
    it.each([
      { situation: 'a check named claude-review', name: 'claude-review' },
      { situation: 'a check named Security review', name: 'Security review' },
    ])('counts $situation under tests and checks, and gives its round no ready or draft kind', ({ name }) => {
      const model = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 12), check(name, 2, 10)])] }));
      expect(model.rounds[0]).not.toHaveProperty('kind');
      expect(Object.keys(model.harness.kinds)).toEqual(['checks']);
      expect(model.harness.kinds.checks).toEqual({ ms: 10 * MIN, runs: 2, last: 1 });
    });

    it('gives a window no figure for ready or draft rounds', () => {
      const [window] = buildModel({
        pulls: [pull({ commits: [commit('a', 0, [check('Test', 2, 12), check('claude-review', 2, 10)])] })],
        now: NOW,
        requestedDays: 7,
        coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN),
        repo: 'o/r',
        windows: [7],
      }).windows;
      expect(window.parts).not.toHaveProperty('readyRound');
      expect(window.parts).not.toHaveProperty('draftRound');
      expect(window.rounds).not.toHaveProperty('ready');
    });
  });

  describe('a round says what held it', () => {
    it('names the check that finishes last, where the tests finish first and it finishes later', () => {
      const [round] = pullModel(pull({ commits: [commit('a', 0, [check('Test', 2, 10), check('E2E (F3)', 3, 14)])] })).rounds;
      expect(round.last).toBe('E2E (F3)');
      expect(round.held.map(({ name, ms }) => [name, minutes(ms)])).toEqual([
        ['Test', 8],
        ['E2E (F3)', 4],
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

    it('answers one pull request in a window as both its median and its p95', () => {
      const [window] = build([finished(1, 60, 10)]).windows;
      expect(window.parts.round).toEqual({ median: 10 * MIN, p95: 10 * MIN, count: 1, pulls: 1 });
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
      expect(window.localReviews).toEqual({ count: null, ms: null, byKind: { 'code-review': null, 'security-review': null } });
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
      expect(harness.kinds).toEqual({ checks: { ms: 24 * MIN, runs: 5, last: 2 } });
    });

    it('reads no pull requests in the window as no harness figures, not as a harness that held nothing', () => {
      expect(build([]).windows[0].harness).toBeNull();
    });

    it("gives a pull request its own harness, in the same shape as a window's, over its own rounds only", () => {
      const [pullModelled] = build([
        merged({
          commits: [
            commit('a', 0, [check('Test', 2, 8), check('E2E (F3)', 3, 12)]),
            commit('b', 30, [check('Test', 31, 36), check('claude-review', 31, 45), check('Security review', 31, 40)]),
          ],
        }),
      ]).pulls;
      expect(pullModelled.harness.rounds).toBe(2);
      expect(pullModelled.harness.kinds).toEqual({ checks: { ms: 24 * MIN, runs: 5, last: 2 } });
    });

    it('gives a pull request no check ran on a harness of zeroes, not null, since that is what it did', () => {
      const [pullModelled] = build([merged({ commits: [commit('a', 0)] })]).pulls;
      expect(pullModelled.harness).toEqual({ rounds: 0, kinds: { checks: { ms: 0, runs: 0, last: 0 } }, local: null });
    });

    it('reads pull requests no check ran on as no harness figures, not as a harness that held nothing', () => {
      const [window] = build([merged({ commits: [commit('a', 0)] })]).windows;
      expect(window.pulls.total).toBe(1);
      expect(window.harness).toBeNull();
      expect(window.flukes).toBeNull();
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

  });

  describe('a pull request is weighed as time coding and fixing against time in the harness', () => {
    // Started at 0; a ten-minute local review; first push at 20 (round 20–40), a fix, a second push at 55 (round 55–65).
    const commits = [commit('a', 0, [check('Test', 20, 40)]), commit('b', 50, [check('Test', 55, 65)])];
    const reviewed = recordBody([[0, 'start'], [5, 'review-start', 'code-review', 'high'], [15, 'review-end', 'code-review', 'high'], [16, 'pushed']]);

    it('takes the local review out of the coding and puts it with the harness, alongside every round', () => {
      const { balance } = pullModel(pull({ mergedAt: at(70), commits, body: reviewed }));
      // Coding: 20 minutes before the push and 15 fixing, less the 10 of review. Harness: 20 + 10 of rounds and the 10 of review.
      expect(balance).toEqual({ codingMs: 25 * MIN, harnessMs: 40 * MIN, rounds: 2, ratio: 1.6 });
    });

    it('leaves the wait to merge and time away out of both', () => {
      const { balance } = pullModel(pull({ mergedAt: at(65 + 60), commits, body: reviewed }));
      expect(balance).toMatchObject({ codingMs: 25 * MIN, harnessMs: 40 * MIN });
      const away = pullModel(pull({ mergedAt: at(420), commits: [commits[0], commit('b', 50, [check('Test', 300, 310)])], body: reviewed }));
      expect(away.balance).toMatchObject({ codingMs: 10 * MIN });
    });

    it('is not weighed at all without a session record, since the local reviews would be missing from it', () => {
      expect(pullModel(pull({ mergedAt: at(70), commits })).balance).toBeNull();
    });

    it('is not weighed where no check ran on it, since it has no harness time to place', () => {
      expect(pullModel(pull({ commits: [commit('a', 0)], body: reviewed })).balance).toBeNull();
    });

    it('has a dot but no ratio where all its time before the push was review', () => {
      const body = recordBody([[0, 'start'], [0, 'review-start', 'code-review', 'low'], [20, 'review-end', 'code-review', 'low']]);
      const { balance } = pullModel(pull({ commits: [commit('a', 0, [check('Test', 20, 30)])], body }));
      expect(balance).toEqual({ codingMs: 0, harnessMs: 30 * MIN, rounds: 1, ratio: null });
    });

    it('moves no more review to the harness than the part it sat in held, where one was marked past the push', () => {
      const body = recordBody([[0, 'start'], [5, 'review-start', 'code-review', 'low'], [45, 'review-end', 'code-review', 'low']]);
      const { balance } = pullModel(pull({ commits: [commit('a', 0, [check('Test', 20, 30)])], body }));
      // The 20 minutes before the push held 15 of the 40-minute review, from minute 5; the rest ran beside the round.
      expect(balance).toEqual({ codingMs: 5 * MIN, harnessMs: 25 * MIN, rounds: 1, ratio: 5 });
    });

    it("gives a window the dots of the pull requests it weighed and the median of their ratios, counting what it could not weigh", () => {
      const build = (pulls) =>
        buildModel({ pulls, now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] });
      const recorded = (number, harness) =>
        pull({ number, mergedAt: at(120), body: recordBody([[0, 'start'], [1, 'pushed']]), commits: [commit('a', 10, [check('Test', 20, 20 + harness)])] });
      // Every ratio is harness over 20 minutes of coding: 1, 2 and 4.
      const [window] = build([
        recorded(1, 20),
        recorded(2, 40),
        recorded(3, 80),
        pull({ number: 4, mergedAt: at(120), commits: [commit('b', 0, [check('Test', 2, 12)])] }),
        pull({ number: 5, mergedAt: at(120), body: recordBody([[0, 'start']]), commits: [commit('c', 0)] }),
      ]).windows;
      expect(window.balance.dots.map((dot) => [dot.number, dot.ratio])).toEqual([[1, 1], [2, 2], [3, 4]]);
      expect(window.balance.ratio).toMatchObject({ median: 2, pulls: 3 });
      expect(window.balance.noChecks).toBe(1);
      expect(window.pulls.withoutRecord).toBe(1);
    });

    it("gives each dot the lines its pull request changed, the figure the Evolution size lane uses", () => {
      const [window] = buildModel({
        pulls: [pull({ number: 1, additions: 30, deletions: 12, mergedAt: at(120), body: recordBody([[0, 'start'], [1, 'pushed']]), commits: [commit('a', 10, [check('Test', 20, 40)])] })],
        now: NOW,
        requestedDays: 7,
        coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN),
        repo: 'o/r',
        windows: [7],
      }).windows;
      expect(window.balance.dots.map((dot) => [dot.number, dot.lines])).toEqual([[1, 42]]);
    });

    it('reads a window with no weighed pull request as no median, never as a ratio of zero', () => {
      const [window] = buildModel({ pulls: [], now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] }).windows;
      expect(window.balance).toEqual({ dots: [], ratio: null, noChecks: 0 });
    });
  });

  describe('a local review is its own slice of the part it sat in', () => {
    // Started at 0; first push at 20 (round 20–40), a fix, a second push at 55 (round 55–65), merged at 70.
    const commits = [commit('a', 0, [check('Test', 20, 40)]), commit('b', 50, [check('Test', 55, 65)])];
    const reviewing = (...marks) => recordBody([[0, 'start'], ...marks, [66, 'pushed']]);
    const review = (kind, level, from, to) => [[from, 'review-start', kind, level], [to, 'review-end', kind, level]];
    const modelled = (body, overrides = {}) => pullModel(pull({ mergedAt: at(70), commits, body, ...overrides }));
    const shape = (slices) => slices.map((slice) => [slice.kind, slice.level, slice.gap, minutes(Date.parse(slice.at) - BASE), minutes(slice.ms)]);

    it.each([
      { situation: 'before the first push', marks: review('code-review', 'high', 5, 15), slices: [['code-review', 'high', 0, 5, 10]] },
      { situation: 'between a red round and the next push', marks: review('code-review', 'xhigh', 42, 50), slices: [['code-review', 'xhigh', 1, 42, 8]] },
      {
        situation: 'a code review then a security review',
        marks: [...review('code-review', 'high', 2, 6), ...review('security-review', 'medium', 8, 10)],
        slices: [['code-review', 'high', 0, 2, 4], ['security-review', 'medium', 0, 8, 2]],
      },
      {
        situation: 'a code review and its recheck',
        marks: [...review('code-review', 'high', 2, 6), ...review('code-review', 'low', 42, 44)],
        slices: [['code-review', 'high', 0, 2, 4], ['code-review', 'low', 1, 42, 2]],
      },
    ])('keeps a review $situation at the time it ran, with its kind and level', ({ marks, slices }) => {
      expect(shape(modelled(reviewing(...marks)).reviewSlices)).toEqual(slices);
    });

    it('takes a review out of the coding it sat in, and nothing else', () => {
      const plain = modelled(reviewing());
      const reviewed = modelled(reviewing(...review('code-review', 'high', 5, 15)));
      expect(reviewed.balance.codingMs).toBe(plain.balance.codingMs - 10 * MIN);
      expect(reviewed.beforeFirstPushMs).toBe(plain.beforeFirstPushMs);
      expect(reviewed.rounds.map((round) => round.ms)).toEqual(plain.rounds.map((round) => round.ms));
    });

    it.each([
      { situation: 'a review that was started and never ended', marks: [[5, 'review-start', 'code-review', 'high']] },
      { situation: 'an end marked before its start in the record', marks: [[15, 'review-end', 'code-review', 'high'], [5, 'review-start', 'code-review', 'high']] },
      { situation: 'an end dated before its start', marks: [[15, 'review-start', 'code-review', 'high'], [5, 'review-end', 'code-review', 'high']] },
    ])('draws no slice for $situation, and leaves the coding as it was', ({ marks }) => {
      const model = modelled(reviewing(...marks));
      expect(model.reviewSlices).toEqual([]);
      expect(model.balance.codingMs).toBe(modelled(reviewing()).balance.codingMs);
    });

    it('clips a review marked across the first push at the push, and leaves the round untouched', () => {
      const model = modelled(reviewing(...review('code-review', 'high', 10, 30)));
      expect(shape(model.reviewSlices)).toEqual([['code-review', 'high', 0, 10, 10]]);
      expect(model.rounds.map((round) => minutes(round.ms))).toEqual([20, 10]);
    });

    it('counts only the parts in the gaps either side of a round that a review spanned', () => {
      const model = modelled(reviewing(...review('security-review', 'high', 10, 50)));
      expect(shape(model.reviewSlices)).toEqual([['security-review', 'high', 0, 10, 10], ['security-review', 'high', 1, 40, 10]]);
    });

    it('keeps each of two parallel reviews at its own marked interval, with no shift', () => {
      const model = modelled(reviewing(...review('code-review', 'high', 2, 12), ...review('security-review', 'high', 3, 7)));
      expect(shape(model.reviewSlices)).toEqual([['code-review', 'high', 0, 2, 10], ['security-review', 'high', 0, 3, 4]]);
      expect(model.harness.local).toMatchObject({ 'code-review': { ms: 10 * MIN, runs: 1 }, 'security-review': { ms: 4 * MIN, runs: 1 } });
    });

    it('keeps two reviews one after the other at their own lengths', () => {
      const model = modelled(reviewing(...review('code-review', 'high', 2, 12), ...review('security-review', 'high', 12, 17)));
      expect(shape(model.reviewSlices)).toEqual([['code-review', 'high', 0, 2, 10], ['security-review', 'high', 0, 12, 5]]);
    });

    it('cuts a parallel review that runs past the first push at the push', () => {
      const model = modelled(reviewing(...review('code-review', 'high', 10, 30), ...review('security-review', 'high', 12, 25)));
      expect(shape(model.reviewSlices)).toEqual([['code-review', 'high', 0, 10, 10], ['security-review', 'high', 0, 12, 8]]);
    });

    it('counts the minutes two parallel reviews share once in the harness', () => {
      const plain = modelled(reviewing());
      const parallel = modelled(reviewing(...review('code-review', 'high', 2, 12), ...review('security-review', 'high', 3, 7)));
      expect(parallel.balance.harnessMs - plain.balance.harnessMs).toBe(10 * MIN);
    });

    it('counts a test run inside two parallel reviews as no extra harness minute', () => {
      const body = renderBlock([
        { at: at(0), phase: 'start' },
        { at: at(2), phase: 'review-start', kind: 'code-review', level: 'high' },
        { at: at(12), phase: 'review-end', kind: 'code-review', level: 'high' },
        { at: at(3), phase: 'review-start', kind: 'security-review', level: 'high' },
        { at: at(7), phase: 'review-end', kind: 'security-review', level: 'high' },
        { run: 'test', scopes: ['a'], start: at(4), end: at(10) },
        { at: at(66), phase: 'pushed' },
      ]);
      const model = modelled(body);
      const plain = modelled(reviewing());
      expect(model.balance.harnessMs - plain.balance.harnessMs).toBe(10 * MIN);
    });

    it("reads a pull request's local reviews as the wall clock, the count marked, and each kind's own minutes", () => {
      const { localReviews } = modelled(reviewing(...review('code-review', 'high', 2, 12), ...review('security-review', 'high', 3, 7)));
      expect(localReviews).toEqual({ count: 2, ms: 10 * MIN, byKind: { 'code-review': { count: 1, ms: 10 * MIN }, 'security-review': { count: 1, ms: 4 * MIN } } });
    });

    it('reads two sequential reviews of 10 and 5 minutes as 15', () => {
      const { localReviews } = modelled(reviewing(...review('code-review', 'high', 2, 12), ...review('security-review', 'high', 20, 25)));
      expect(localReviews.ms).toBe(15 * MIN);
    });

    it('gives a window each pull request’s review wall clock, shared minutes once', () => {
      const parallel = pull({ number: 1, mergedAt: at(70), commits, body: reviewing(...review('code-review', 'high', 2, 12), ...review('security-review', 'high', 3, 7)) });
      const sequential = pull({ number: 2, mergedAt: at(70), commits, body: reviewing(...review('code-review', 'high', 2, 12), ...review('security-review', 'high', 12, 17)) });
      const [window] = buildModel({ pulls: [parallel, sequential], now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] }).windows;
      expect(window.localReviews.ms).toMatchObject({ pulls: 2, count: 2, median: 12.5 * MIN });
      expect(window.localReviews.byKind['security-review']).toMatchObject({ pulls: 2, median: 4.5 * MIN });
    });

    describe('reviews whose ends were written together', () => {
      const ends = (secondEnd) => [[0, 'start'], [2, 'review-start', 'code-review', 'high'], [3, 'review-start', 'security-review', 'high'], [12, 'review-end', 'code-review', 'high'], [secondEnd, 'review-end', 'security-review', 'high']];
      const flags = (body) => modelled(body).reviewSlices.map((slice) => [slice.kind, minutes(slice.ms), slice.endedTogether ?? false]);
      const bodyWith = (secondEndMs) =>
        renderBlock([
          { at: at(0), phase: 'start' },
          { at: at(2), phase: 'review-start', kind: 'code-review', level: 'high' },
          { at: at(3), phase: 'review-start', kind: 'security-review', level: 'high' },
          { at: at(12), phase: 'review-end', kind: 'code-review', level: 'high' },
          { at: new Date(BASE + 12 * MIN + secondEndMs).toISOString(), phase: 'review-end', kind: 'security-review', level: 'high' },
        ]);

      it('draws both at the recorded shared length and flags each as ended together', () => {
        const body = renderBlock([
          { at: at(0), phase: 'start' },
          { at: at(2), phase: 'review-start', kind: 'code-review', level: 'high' },
          { at: at(2), phase: 'review-start', kind: 'security-review', level: 'high' },
          { at: at(12), phase: 'review-end', kind: 'code-review', level: 'high' },
          { at: at(12), phase: 'review-end', kind: 'security-review', level: 'high' },
        ]);
        expect(flags(body)).toEqual([['code-review', 10, true], ['security-review', 10, true]]);
      });

      it.each([
        { situation: 'ends 0.6 s apart', gap: 600, together: true },
        { situation: 'ends 2 s apart', gap: 2000, together: false },
      ])('reads $situation', ({ gap, together }) => {
        expect(flags(bodyWith(gap)).map((entry) => entry[2])).toEqual([together, together]);
      });

      it('does not flag one review alone', () => {
        expect(flags(recordBody(ends(12).filter((mark) => mark[2] !== 'security-review')))).toEqual([['code-review', 10, false]]);
      });
    });

    it('counts a review inside a gap long enough to read as away in neither the strip nor the harness', () => {
      const away = [commits[0], commit('b', 50, [check('Test', 300, 310)])];
      const model = pullModel(pull({ mergedAt: at(420), commits: away, body: reviewing(...review('code-review', 'high', 100, 120)) }));
      expect(model.awayMs.map(minutes)).toEqual([260]);
      expect(model.reviewSlices).toEqual([]);
      expect(model.harness.local['code-review']).toEqual({ ms: 0, runs: 0 });
    });

    it('counts a review during the wait to merge in no part', () => {
      expect(modelled(reviewing(...review('code-review', 'high', 66, 69))).reviewSlices).toEqual([]);
    });
  });

  describe("a pull request's harness is its rounds plus its local review, and its panel adds up to the scatter's", () => {
    const commits = [commit('a', 0, [check('Test', 20, 40)]), commit('b', 50, [check('Test', 55, 65)])];
    const marks = [
      [0, 'start'],
      [5, 'review-start', 'code-review', 'high'],
      [15, 'review-end', 'code-review', 'high'],
      [42, 'review-start', 'security-review', 'high'],
      [48, 'review-end', 'security-review', 'high'],
      [66, 'pushed'],
    ];
    const build = (pulls) =>
      buildModel({ pulls, now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] });

    it('gives a pull request with both kinds of review a lane of minutes for each', () => {
      const { harness } = pullModel(pull({ mergedAt: at(70), commits, body: recordBody(marks) }));
      expect(harness.local).toEqual({ 'code-review': { ms: 10 * MIN, runs: 1 }, 'security-review': { ms: 6 * MIN, runs: 1 }, test: null, browser: null });
    });

    it.each([
      { situation: 'two kinds of review', body: recordBody(marks) },
      { situation: 'a review marked past the push', body: recordBody([[0, 'start'], [10, 'review-start', 'code-review', 'low'], [30, 'review-end', 'code-review', 'low']]) },
    ])('totals the same minutes as the scatter’s harness: $situation', ({ body }) => {
      const model = pullModel(pull({ mergedAt: at(70), commits, body }));
      const panel = model.harness.kinds.checks.ms + sum(Object.values(model.harness.local).map((lane) => lane?.ms ?? 0));
      expect(panel).toBe(model.balance.harnessMs);
    });

    it('gives a window the local review time per kind beside the total, over the pull requests that ran that kind', () => {
      const codeOnly = recordBody([[0, 'start'], [5, 'review-start', 'code-review', 'high'], [11, 'review-end', 'code-review', 'high'], [66, 'pushed']]);
      const [window] = build([
        pull({ number: 1, mergedAt: at(70), commits, body: recordBody(marks) }),
        pull({ number: 2, mergedAt: at(70), commits, body: codeOnly }),
      ]).windows;
      expect(window.localReviews.ms).toMatchObject({ pulls: 2, count: 2 });
      expect(window.localReviews.byKind['code-review']).toMatchObject({ pulls: 2, median: 8 * MIN });
      expect(window.localReviews.byKind['security-review']).toMatchObject({ pulls: 1, median: 6 * MIN });
    });
  });

  describe('local review time nobody wrote down reads as not recorded, never zero', () => {
    const commits = [commit('a', 0, [check('Test', 20, 40)])];

    it.each([
      { situation: 'a pull request with no session record', body: '' },
      { situation: 'a record that marks no review', body: recordBody([[0, 'start'], [10, 'pushed']]) },
    ])('reads $situation as no review lanes', ({ body }) => {
      const model = pullModel(pull({ commits, body }));
      expect(model.harness.local).toBeNull();
      expect(model.localReviews).toBeNull();
      expect(model.reviewSlices).toEqual([]);
    });

    it('reads a window with no pull request in it as no review figures', () => {
      const [window] = buildModel({ pulls: [], now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] }).windows;
      expect(window.localReviews).toEqual({ count: null, ms: null, byKind: { 'code-review': null, 'security-review': null } });
    });
  });

  describe('a failed attempt names the files and the step it failed on', () => {
    const recordOf = (...packages) => ({ packages });
    const pkg = (name, files, report = 'written') => ({ name, report, files: files.map(([path, status]) => ({ path, status })) });
    const failing = (name, steps, record, from = 2, to = 10) =>
      check(name, from, to, 'failure', { failure: { steps, record: record === undefined ? null : record } });
    const read = (value) => ({ state: 'read', value });
    const roundOf = (checks) => pullModel(pull({ commits: [commit('a', 0, checks)] })).rounds[0];

    it.each([
      {
        situation: 'a red round whose Test attempt marks two files failed',
        checks: [failing('Test', ['Run the tests'], read(recordOf(pkg('api', [['a.test.ts', 'failed'], ['b.test.ts', 'failed'], ['c.test.ts', 'passed']]))))],
        outcome: 'red',
        files: ['a.test.ts', 'b.test.ts'],
      },
      {
        situation: 'a fluke: the E2E attempt failed on one spec and the re-run passed',
        checks: [failing('E2E (F3)', ['Run the walks'], read(recordOf(pkg('e2e', [['tests/e2e/x.test.ts', 'failed']])))), check('E2E (F3)', 12, 25)],
        outcome: 'fluke',
        files: ['tests/e2e/x.test.ts'],
      },
    ])('$situation names the files its own record marks failed', ({ checks, outcome, files }) => {
      const [failure] = roundOf(checks).failures;
      expect(failure).toMatchObject({ outcome, files, record: 'read', packagesNotRecorded: [] });
    });

    it('names the same files from a record that also names the failed tests as from one that does not', () => {
      const bare = recordOf(pkg('api', [['a.test.ts', 'failed'], ['b.test.ts', 'passed']]), pkg('web', [], 'none'));
      const named = { ...bare, failedTests: [{ file: 'a.test.ts', name: 'Triage > a', error: 'expected 1 to be 2' }], failedTestsMore: 4 };
      const [before] = roundOf([failing('Test', ['Run the tests'], read(bare))]).failures;
      const [after] = roundOf([failing('Test', ['Run the tests'], read(named))]).failures;
      expect(after).toEqual(before);
      expect(after).toMatchObject({ files: ['a.test.ts'], packagesNotRecorded: ['web'] });
    });

    it('reads a package that wrote no report as not recorded while the others still name their files', () => {
      const record = recordOf(pkg('api', [['a.test.ts', 'failed']]), pkg('web', [], 'none'));
      const [failure] = roundOf([failing('Test', ['Run the tests'], read(record))]).failures;
      expect(failure).toMatchObject({ files: ['a.test.ts'], record: 'read', packagesNotRecorded: ['web'] });
    });

    it.each([
      { situation: 'Checks failed at Lint', steps: ['Lint'], expected: ['Lint'] },
      { situation: 'two steps failed in one job', steps: ['Lint', 'Typecheck'], expected: ['Lint', 'Typecheck'] },
    ])('names the step, so $situation', ({ steps, expected }) => {
      const [failure] = roundOf([failing('Checks', steps)]).failures;
      expect(failure).toMatchObject({ check: 'Checks', steps: expected, files: [], record: null });
    });

    it('does not name files for a check that keeps no record', () => {
      const record = read(recordOf(pkg('api', [['a.test.ts', 'failed']])));
      expect(roundOf([failing('Checks', ['Lint'], record)]).failures[0].files).toEqual([]);
    });

    it.each([
      { situation: 'the artifact expired', record: { state: 'not-recorded', why: 'expired' }, why: 'expired' },
      { situation: 'no artifact was created during the job', record: { state: 'not-recorded', why: 'absent' }, why: 'absent' },
      { situation: 'two artifacts fall inside the job', record: { state: 'not-recorded', why: 'ambiguous' }, why: 'ambiguous' },
      { situation: 'the record could not be read', record: { state: 'not-recorded', why: 'unreadable' }, why: 'unreadable' },
      { situation: 'nothing was fetched for the attempt', record: undefined, why: 'not-fetched' },
    ])('reads a Test attempt as not recorded, never as passing, where $situation', ({ record, why }) => {
      const [failure] = roundOf([failing('Test', ['Run the tests'], record)]).failures;
      expect(failure).toMatchObject({ record: 'not-recorded', why, files: [] });
    });

    it('reads a Test attempt whose record was read but marks no file failed as failing outside any file', () => {
      const [failure] = roundOf([failing('Test', ['Run the tests'], read(recordOf(pkg('api', [['a.test.ts', 'passed']]))))]).failures;
      expect(failure).toMatchObject({ record: 'read', why: 'no-file-failed', files: [] });
    });

    it('counts an unreadable attempt of a check that keeps no record as not recorded', () => {
      const [failure] = roundOf([check('Checks', 2, 10, 'failure', { failure: { steps: [], record: null, unreadable: true } })]).failures;
      expect(failure).toMatchObject({ record: null, why: 'unreadable', steps: [] });
    });

    it('numbers the attempts of a check in the order they ran', () => {
      const round = roundOf([failing('Checks', ['Lint']), failing('Checks', ['Typecheck'], undefined, 12, 20), check('Checks', 22, 30)]);
      expect(round.failures.map((failure) => [failure.attempt, failure.outcome, failure.steps])).toEqual([[1, 'fluke', ['Lint']], [2, 'fluke', ['Typecheck']]]);
    });
  });

  describe('a record is matched to the attempt that uploaded it by when it was made', () => {
    const job = { startedAt: at(2), completedAt: at(10) };
    const artifact = (id, minute, expired = false) => ({ id, createdAt: at(minute), expired });

    it.each([
      { situation: 'one made during the job', artifacts: [artifact(1, 9)], expected: { artifact: { id: 1 } } },
      { situation: 'one made seconds after the job completed', artifacts: [artifact(1, 10.2)], expected: { artifact: { id: 1 } } },
      { situation: 'a re-run uploading under the same name: each attempt owns its own', artifacts: [artifact(1, 9), artifact(2, 24)], expected: { artifact: { id: 1 } } },
      { situation: 'one that has expired', artifacts: [artifact(1, 9, true)], expected: { why: 'expired' } },
      { situation: 'none made during the job', artifacts: [artifact(1, 30)], expected: { why: 'absent' } },
      { situation: 'none at all', artifacts: [], expected: { why: 'absent' } },
      { situation: 'two made during the job', artifacts: [artifact(1, 5), artifact(2, 9)], expected: { why: 'ambiguous' } },
    ])('finds the right one, or none, with $situation', ({ artifacts, expected }) => {
      expect(matchArtifact(artifacts, job)).toEqual(expected);
    });

    it('finds the second attempt its own record, not the first one', () => {
      expect(matchArtifact([artifact(1, 9), artifact(2, 24)], { startedAt: at(12), completedAt: at(25) })).toEqual({ artifact: { id: 2 } });
    });
  });

  describe('a window lists each failing file and step with the pull requests it failed on', () => {
    const record = (...paths) => ({ state: 'read', value: { packages: [{ name: 'p', report: 'written', files: paths.map((path) => ({ path, status: 'failed' })) }] } });
    const failedPull = (number, checks) => pull({ number, mergedAt: at(120), commits: [commit(`s${number}`, 0, checks)] });
    const failing = (name, steps, rec = null, from = 2, to = 10) => check(name, from, to, 'failure', { failure: { steps, record: rec } });
    const windowOf = (pulls) =>
      buildModel({ pulls, now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] }).windows[0];

    it('gives one row for a spec failing on two pull requests, with both', () => {
      const { failures } = windowOf([
        failedPull(1, [failing('Test', ['Run'], record('a.test.ts'))]),
        failedPull(2, [failing('Test', ['Run'], record('a.test.ts', 'b.test.ts'))]),
      ]);
      expect(failures.files.find((file) => file.path === 'a.test.ts')).toEqual({ path: 'a.test.ts', attempts: 2, pulls: [{ number: 1, attempts: 1 }, { number: 2, attempts: 1 }] });
      expect(failures.files.map((file) => file.path)).toEqual(['a.test.ts', 'b.test.ts']);
      expect(failures.steps).toEqual([{ check: 'Test', step: 'Run', attempts: 2, pulls: [{ number: 1, attempts: 1 }, { number: 2, attempts: 1 }] }]);
    });

    it('gives one pull request and two attempts for a spec failing twice on one pull request', () => {
      const { failures } = windowOf([failedPull(1, [failing('E2E (F3)', ['Walks'], record('x.test.ts')), failing('E2E (F3)', ['Walks'], record('x.test.ts'), 12, 20), check('E2E (F3)', 22, 30)])]);
      expect(failures.files).toEqual([{ path: 'x.test.ts', attempts: 2, pulls: [{ number: 1, attempts: 2 }] }]);
    });

    it('gives empty lists, not null, for a window with pull requests and no failures', () => {
      const { failures } = windowOf([failedPull(1, [check('Test', 2, 10)])]);
      expect(failures).toEqual({ attempts: 0, notRecorded: 0, noFileFailed: 0, steps: [], files: [] });
    });

    it('counts unreadable attempts of any check, and the records that name no failed file apart', () => {
      const { failures } = windowOf([
        failedPull(1, [check('Checks', 2, 10, 'failure', { failure: { steps: [], record: null, unreadable: true } })]),
        failedPull(2, [failing('Test', ['Run'], { state: 'read', value: { packages: [{ name: 'p', report: 'written', files: [] }] } })]),
      ]);
      expect(failures).toMatchObject({ attempts: 2, notRecorded: 1, noFileFailed: 1 });
    });

    it('counts the attempts it could not read, leaving them out of the files', () => {
      const { failures } = windowOf([
        failedPull(1, [failing('Test', ['Run'], { state: 'not-recorded', why: 'expired' })]),
        failedPull(2, [failing('Test', ['Run'], record('a.test.ts'))]),
        failedPull(3, [failing('Checks', ['Lint'])]),
      ]);
      expect(failures).toMatchObject({ attempts: 3, notRecorded: 1 });
      expect(failures.files.map((file) => file.path)).toEqual(['a.test.ts']);
      expect(failures.steps.map((step) => [step.check, step.step, step.attempts])).toEqual([['Test', 'Run', 2], ['Checks', 'Lint', 1]]);
    });
  });

  describe("a check's queue time is how long its job waited for a runner", () => {
    const SEC = 1000;
    const build = (pulls) =>
      buildModel({ pulls, now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] });
    const merged = (overrides) => pull({ createdAt: at(-10), mergedAt: at(120), ...overrides });
    /** A job created `created` minutes past 09:00 whose check run ran `from` to `to`. */
    const job = (name, created, from, to, conclusion = 'success') => check(name, from, to, conclusion, { queue: { state: 'read', createdAt: at(created), startedAt: at(from) } });
    const queuedOf = (checks) => pullModel(merged({ commits: [commit('a', 0, checks)] })).rounds[0].queued;

    it.each([
      { situation: 'a job created 2 seconds before it started', checks: [job('Test', 1, 1 + 2 / 60, 5)], queued: [{ name: 'Test', ms: 2 * SEC }] },
      { situation: "a re-run's copied job, started before it was created", checks: [job('Test', 1, 1, 5), job('Checks', 20, 2, 4)], queued: [{ name: 'Test', ms: 0 }] },
      { situation: 'a job created when its dependency finished, long after the push', checks: [job('Test', 0, 0.5, 5), job('Publish', 5, 5.5, 6)], queued: [{ name: 'Test', ms: 0.5 * MIN }, { name: 'Publish', ms: 0.5 * MIN }] },
      { situation: 'a job that started a second before it was created, which is the stamps rounding', checks: [job('Test', 1 + 1 / 60, 1, 5)], queued: [{ name: 'Test', ms: 0 }] },
      { situation: 'a job whose list was not read', checks: [check('Test', 1, 5)], queued: [] },
    ])('reads $situation', ({ checks, queued }) => {
      expect(queuedOf(checks)).toEqual(queued);
    });

    it('says a round has no queue recorded where the list of a job could not be read, and keeps the pull request', () => {
      const [round] = pullModel(merged({ commits: [commit('a', 0, [check('Test', 1, 5, 'success', { queue: { state: 'not-recorded', why: 'unreadable' } })])] })).rounds;
      expect(round).toMatchObject({ queued: [], queueNotRecorded: true, ms: 4 * MIN });
      expect(build([merged({ commits: [commit('a', 0, [check('Test', 1, 5, 'success', { queue: { state: 'not-recorded', why: 'unreadable' } })])] })]).windows[0]).toMatchObject({ pulls: { total: 1 }, queue: null, rounds: { queueNotRecorded: 1 } });
    });

    it('gives each check a median and p95 over the window, with the items and pull requests behind them', () => {
      const round = (number, queueSec) => merged({ number, commits: [commit(`s${number}`, 0, [job('Test', 0, queueSec / 60, 5), job('E2E (F3)', 0, 1, 9)])] });
      const { queue } = build([round(1, 2), round(2, 4), round(3, 60)]).windows[0];
      expect(queue.Test).toEqual({ median: 4 * SEC, p95: 60 * SEC, count: 3, pulls: 3 });
      expect(queue['E2E (F3)']).toMatchObject({ median: MIN, count: 3 });
    });

    it('reads a window with pull requests and no job list read as no queue figure, not zero', () => {
      expect(build([merged({ commits: [commit('a', 0, [check('Test', 1, 5)])] })]).windows[0].queue).toBeNull();
    });
  });

  describe('runner minutes thrown away by a cancelled run are counted, and a newer push is what tells why', () => {
    const build = (pulls) =>
      buildModel({ pulls, now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] });
    const merged = (overrides) => pull({ createdAt: at(-10), mergedAt: at(120), ...overrides });

    it.each([
      {
        situation: 'Test cancelled after 5 minutes with a newer push before it ended',
        commits: [commit('a', 0, [check('Test', 1, 6, 'cancelled')]), commit('b', 5, [check('Test', 5, 12)])],
        expected: { superseded: { runs: 1, ms: 5 * MIN }, other: { runs: 0, ms: 0 } },
      },
      {
        situation: 'Test cancelled two seconds before the push that cancelled it was seen',
        commits: [commit('a', 0, [check('Test', 1, 6, 'cancelled')]), commit('b', 5, [check('Test', 6 + 2 / 60, 12)])],
        expected: { superseded: { runs: 1, ms: 5 * MIN }, other: { runs: 0, ms: 0 } },
      },
      {
        situation: 'a re-run started after the later push, then cancelled by hand',
        commits: [commit('a', 0, [check('Test', 1, 10), check('Test', 20, 25, 'cancelled')]), commit('b', 15, [check('Test', 15, 30)])],
        expected: { superseded: { runs: 0, ms: 0 }, other: { runs: 1, ms: 5 * MIN } },
      },
      {
        situation: 'Test whose new push waited 40 seconds for a runner, then cancelled it',
        commits: [commit('a', 0, [check('Test', 1, 6, 'cancelled')]), commit('b', 5.8, [check('Test', 5.8 + 40 / 60, 12, 'success', { queue: { state: 'read', createdAt: at(5.8), startedAt: at(5.8 + 40 / 60) } })])],
        expected: { superseded: { runs: 1, ms: 5 * MIN }, other: { runs: 0, ms: 0 } },
      },
      {
        situation: 'a job stamped started the moment it was cancelled, with a push after its creation',
        commits: [commit('a', 0, [check('Test', 1, 10), check('Test', 20, 20, 'cancelled', { queue: { state: 'read', createdAt: at(18), startedAt: at(20) } })]), commit('b', 19, [check('Test', 19, 30)])],
        expected: { superseded: { runs: 1, ms: 0 }, other: { runs: 0, ms: 0 } },
      },
      {
        situation: 'a job cancelled with no later push before it ended',
        commits: [commit('a', 0, [check('Test', 1, 6, 'cancelled')]), commit('b', 30, [check('Test', 31, 36)])],
        expected: { superseded: { runs: 0, ms: 0 }, other: { runs: 1, ms: 5 * MIN } },
      },
      {
        situation: 'a job cancelled before it started',
        commits: [commit('a', 0, [check('Test', 1, 6), check('E2E (F3)', 5, 5.5, 'cancelled', { startedAt: null, queue: { state: 'read', createdAt: at(3), startedAt: null } })]), commit('b', 5, [check('Test', 4, 12)])],
        expected: { superseded: { runs: 1, ms: 0 }, other: { runs: 0, ms: 0 } },
      },
    ])('counts $situation', ({ commits, expected }) => {
      expect(pullModel(merged({ commits })).cancelled).toEqual(expected);
    });

    it("ignores a third-party app's check, which is no harness minutes of ours", () => {
      const model = pullModel(merged({ commits: [commit('a', 0, [check('Test', 1, 5), check('Lint', 1, 30, 'cancelled', { app: 'other-app' })])] }));
      expect(model).toMatchObject({ runnerMs: 4 * MIN, cancelled: { superseded: { runs: 0 }, other: { runs: 0 } } });
    });

    it('leaves a re-run copy out of the runner minutes, since it only repeats the original attempt', () => {
      const original = check('Checks', 1, 5);
      const copy = check('Checks', 1, 5, 'success', { queue: { state: 'read', createdAt: at(20), startedAt: at(1) } });
      expect(pullModel(merged({ commits: [commit('a', 0, [original, copy])] })).runnerMs).toBe(4 * MIN);
    });
  });

  describe('the cancelled share is cancelled runner minutes over all runner minutes in the window', () => {
    const build = (pulls) =>
      buildModel({ pulls, now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] });
    const merged = (overrides) => pull({ createdAt: at(-10), mergedAt: at(120), ...overrides });

    it('reads 10 superseded minutes against 100 runner minutes as 10%, and the other kind apart', () => {
      const [window] = build([
        merged({ number: 1, commits: [commit('a', 0, [check('Test', 1, 11, 'cancelled')]), commit('b', 5, [check('Test', 5, 95)])] }),
        merged({ number: 2, commits: [commit('c', 0, [check('Test', 1, 4, 'cancelled')]), commit('d', 60, [check('Test', 61, 61)])] }),
      ]).windows;
      expect(window.cancelled).toMatchObject({ superseded: { runs: 1, ms: 10 * MIN }, other: { runs: 1, ms: 3 * MIN }, runnerMs: 103 * MIN });
      expect(window.cancelled.supersededShare).toBeCloseTo(10 / 103);
      expect(window.cancelled.share).toBeCloseTo(13 / 103);
    });

    it('reads a window with no runner minutes as no share, not zero', () => {
      const [window] = build([merged({ commits: [commit('a', 0, [check('Test', 1, null)])] })]).windows;
      expect(window.cancelled.share).toBeNull();
    });
  });

  describe('a local test run and the browser pass are slices of the part they sat in', () => {
    // Started at 0; first push at 20 (round 20–40), a fix, a second push at 55 (round 55–65), merged at 70.
    const commits = [commit('a', 0, [check('Test', 20, 40)]), commit('b', 50, [check('Test', 55, 65)])];
    const recording = ({ marks = [], runs = [] } = {}) =>
      renderBlock([
        { at: at(0), phase: 'start' },
        ...marks.map(([minute, phase]) => ({ at: at(minute), phase })),
        ...runs.map(([from, to, ...scopes]) => ({ run: 'test', scopes, start: at(from), end: at(to) })),
        { at: at(66), phase: 'pushed' },
      ]);
    const modelled = (body) => pullModel(pull({ mergedAt: at(70), commits, body }));
    const browserPass = (from, to) => [[from, 'browser-start'], [to, 'browser-end']];
    const shape = (slices) => slices.map((slice) => [slice.kind, slice.scopes ?? null, slice.gap, minutes(Date.parse(slice.at) - BASE), minutes(slice.ms)]);

    it.each([
      { situation: 'a test run before the first push', body: recording({ runs: [[5, 9, '@cockpit/api']] }), slices: [['test', ['@cockpit/api'], 0, 5, 4]] },
      { situation: 'a test run while fixing between rounds', body: recording({ runs: [[44, 48, 'tools/cycle-time']] }), slices: [['test', ['tools/cycle-time'], 1, 44, 4]] },
      { situation: 'a browser pass, apart from the test runs', body: recording({ marks: browserPass(10, 16), runs: [[2, 4, 'a']] }), slices: [['test', ['a'], 0, 2, 2], ['browser', null, 0, 10, 6]] },
    ])('keeps $situation at the time it ran, with its kind and scope', ({ body, slices }) => {
      expect(shape(modelled(body).runSlices)).toEqual(slices);
    });

    it('takes a test run out of the coding it sat in and puts it with the harness, and nothing else', () => {
      const plain = modelled(recording());
      const tested = modelled(recording({ runs: [[5, 9, 'a']] }));
      expect(tested.balance.codingMs).toBe(plain.balance.codingMs - 4 * MIN);
      expect(tested.balance.harnessMs).toBe(plain.balance.harnessMs + 4 * MIN);
      expect(tested.beforeFirstPushMs).toBe(plain.beforeFirstPushMs);
    });

    it('draws no slice for a browser pass that was started and never ended, and leaves the coding as it was', () => {
      const model = modelled(recording({ marks: [[5, 'browser-start']] }));
      expect(model.runSlices).toEqual([]);
      expect(model.localRuns.browser).toBeNull();
      expect(model.balance.codingMs).toBe(modelled(recording()).balance.codingMs);
    });

    it('clips a test run marked across a push at the push, in the slice and in the scatter', () => {
      const model = modelled(recording({ runs: [[10, 30, 'a']] }));
      expect(shape(model.runSlices)).toEqual([['test', ['a'], 0, 10, 10]]);
      expect(model.harness.local.test).toEqual({ ms: 10 * MIN, runs: 1 });
      expect(model.balance.harnessMs).toBe(modelled(recording()).balance.harnessMs + 10 * MIN);
    });

    it('draws a test run during a review as well as the review, and counts the minutes they share once', () => {
      const body = renderBlock([
        { at: at(0), phase: 'start' },
        { at: at(2), phase: 'review-start', kind: 'code-review', level: 'high' },
        { at: at(12), phase: 'review-end', kind: 'code-review', level: 'high' },
        { run: 'test', scopes: ['a'], start: at(8), end: at(14) },
        { at: at(66), phase: 'pushed' },
      ]);
      const model = modelled(body);
      expect(model.reviewSlices).toHaveLength(1);
      expect(model.runSlices).toHaveLength(1);
      // Review 2–12 and test 8–14 cover 2–14: twelve minutes, not sixteen.
      expect(model.balance.harnessMs - modelled(recording()).balance.harnessMs).toBe(12 * MIN);
      expect(modelled(recording()).balance.codingMs - model.balance.codingMs).toBe(12 * MIN);
      // Each lane still has its own minutes.
      expect(model.harness.local['code-review'].ms).toBe(10 * MIN);
      expect(model.harness.local.test.ms).toBe(6 * MIN);
    });

    it('gives a window the test runs and the browser pass per kind, over the pull requests that have that kind', () => {
      const build = (pulls) => buildModel({ pulls, now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] });
      const [window] = build([
        pull({ number: 1, mergedAt: at(70), commits, body: recording({ marks: browserPass(10, 14), runs: [[2, 6, 'a'], [44, 46, 'b']] }) }),
        pull({ number: 2, mergedAt: at(70), commits, body: recording({ runs: [[2, 10, 'a']] }) }),
      ]).windows;
      expect(window.localRuns.test.ms).toMatchObject({ pulls: 2, median: 7 * MIN });
      expect(window.localRuns.test.count).toMatchObject({ pulls: 2, p95: 2 });
      expect(window.localRuns.browser.ms).toMatchObject({ pulls: 1, median: 4 * MIN });
    });
  });

  describe('test and browser time nobody wrote down reads as not recorded, never zero', () => {
    const commits = [commit('a', 0, [check('Test', 20, 40)])];
    const reviewedOnly = recordBody([[0, 'start'], [5, 'review-start', 'code-review', 'high'], [9, 'review-end', 'code-review', 'high']]);

    it.each([
      { situation: 'a record with reviews and no test runs', body: reviewedOnly },
      { situation: 'a record that marks nothing but its start', body: recordBody([[0, 'start']]) },
    ])('reads $situation as test time not recorded', ({ body }) => {
      const model = pullModel(pull({ commits, body }));
      expect(model.localRuns).toEqual({ test: null, browser: null });
      expect(model.harness.local?.test ?? null).toBeNull();
      expect(model.harness.local?.browser ?? null).toBeNull();
    });

    it('reads a pull request with no session record as no local lanes at all', () => {
      const model = pullModel(pull({ commits, body: '' }));
      expect(model.harness.local).toBeNull();
      expect(model.localRuns).toEqual({ test: null, browser: null });
      expect(model.runSlices).toEqual([]);
    });

    it('reads a window where no pull request has test runs as no figures, not zero', () => {
      const [window] = buildModel({ pulls: [pull({ commits, body: reviewedOnly })], now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] }).windows;
      expect(window.localRuns).toEqual({ test: { count: null, ms: null }, browser: { count: null, ms: null } });
    });
  });

  describe('jobs sharing a family name are one check in the counts', () => {
    /** A job created `created` minutes past 09:00 whose check run ran `from` to `to`, its job list read. */
    const job = (name, created, from, to, conclusion = 'success', overrides = {}) =>
      check(name, from, to, conclusion, { queue: { state: 'read', createdAt: at(created), startedAt: at(from) }, ...overrides });
    /** The four shards of `E2E (F3)`, all created at 09:00, as [start, end, conclusion] each. */
    const shards = (...each) => each.map(([from, to, conclusion = 'success', overrides], index) => job(`E2E (F3) (${index + 1})`, 0, from, to, conclusion, overrides));
    const fanIn = (from, to, conclusion = 'success', overrides = {}) => job('E2E (F3)', from, from, to, conclusion, overrides);
    const roundOf = (checks) => pullModel(pull({ mergedAt: at(120), commits: [commit('a', 0, checks)] })).rounds[0];
    const build = (pulls) => buildModel({ pulls, now: NOW, requestedDays: 7, coveredSince: new Date(NOW.getTime() - 30 * 24 * 60 * MIN), repo: 'o/r', windows: [7] });
    const recordOf = (value) => ({ state: 'read', value: { packages: [{ name: 'e2e', report: 'written', files: [{ path: 'tests/e2e/find.test.ts', status: value }] }] } });

    it('counts four shards and their fan-in as one check named for the family, which holds the round last', () => {
      const round = roundOf([job('Checks', 0, 1, 3), job('Test', 0, 1, 9), ...shards([1, 10], [1, 11], [1.5, 12], [2, 13]), fanIn(13, 14)]);
      expect(round.held.map((held) => held.name)).toEqual(['Checks', 'Test', 'E2E (F3)']);
      expect(round).toMatchObject({ last: 'E2E (F3)', red: false, failed: [], failures: [], flukes: [] });
      expect(minutes(round.ms)).toBe(13);
    });

    it('makes the check red once where one shard failed, naming that shard’s steps and the fan-in’s merged record', () => {
      const failing = shards([1, 10], [1, 11], [1, 12, 'failure', { failure: { steps: ['Run the walks'], record: null } }], [1, 13]);
      const round = roundOf([...failing, fanIn(13, 14, 'failure', { failure: { steps: ['Fail when a shard failed'], record: recordOf('failed') } })]);
      expect(round).toMatchObject({ red: true, failed: ['E2E (F3)'], last: 'E2E (F3)' });
      expect(round.failures).toEqual([
        { check: 'E2E (F3)', attempt: 1, outcome: 'red', steps: ['Run the walks'], files: ['tests/e2e/find.test.ts'], record: 'read', why: null, packagesNotRecorded: [] },
      ]);
    });

    it('counts a shard re-run to green as one fluke on the family, from the failed attempt’s end to the passing one’s', () => {
      const first = shards([1, 10], [1, 8, 'failure', { failure: { steps: ['Run the walks'], record: null } }], [1, 12], [1, 13]);
      const round = roundOf([...first, fanIn(13, 14, 'failure', { failure: { steps: [], record: recordOf('failed') } }), job('E2E (F3) (2)', 16, 16, 24), fanIn(24, 25)]);
      expect(round).toMatchObject({ red: false, failed: [] });
      expect(round.flukes).toEqual([{ name: 'E2E (F3)', sha: 'a', ms: 11 * MIN }]);
      expect(round.failures.map((failure) => [failure.check, failure.attempt, failure.outcome, failure.steps])).toEqual([['E2E (F3)', 1, 'fluke', ['Run the walks']]]);
      // The re-run's wait is the re-run shard's own, not the earlier wait of the three that were not run again.
      expect(round.queued.filter((entry) => entry.name === 'E2E (F3)').map((entry) => entry.ms)).toEqual([MIN, 0]);
    });

    it('reads one E2E (F3) job as it always did: its own queue, its own failure and no family', () => {
      const round = roundOf([job('E2E (F3)', 0, 2, 12, 'failure', { failure: { steps: ['Run the walks'], record: recordOf('failed') } })]);
      expect(round.queued).toEqual([{ name: 'E2E (F3)', ms: 2 * MIN }]);
      expect(round.failures[0]).toMatchObject({ check: 'E2E (F3)', steps: ['Run the walks'], files: ['tests/e2e/find.test.ts'] });
      expect(round.lanes).toEqual([expect.not.objectContaining({ family: expect.anything() })]);
    });

    it('reports each shard’s queue under the family, and the family’s figure is the longest wait', () => {
      const checks = [job('E2E (F3) (1)', 0, 1, 10), job('E2E (F3) (2)', 0, 1.5, 11), job('E2E (F3) (3)', 0, 3, 12), job('E2E (F3) (4)', 0, 2, 13), fanIn(13, 14)];
      expect(roundOf(checks).queued).toEqual([{ name: 'E2E (F3)', ms: 3 * MIN }]);
      const { queue } = build([pull({ createdAt: at(-10), mergedAt: at(120), commits: [commit('a', 0, checks)] })]).windows[0];
      expect(queue).toEqual({ 'E2E (F3)': { median: 3 * MIN, p95: 3 * MIN, count: 1, pulls: 1 } });
    });

    describe('a family with a job missing from the list is not a shorter family', () => {
      it.each([
        { situation: 'a shard whose job list was cut off by the rate limit', checks: [...shards([1, 10], [1, 11]), job('E2E (F3) (3)', 0, 1, 12, 'success', { queue: { state: 'not-recorded', why: 'rate-limit' } }), job('E2E (F3) (4)', 0, 2, 13), fanIn(13, 14)] },
        { situation: 'a shard absent from the list', checks: [...shards([1, 10], [1, 11], [1, 12]).slice(0, 2), job('E2E (F3) (4)', 0, 2, 13), fanIn(13, 14)] },
        { situation: 'no fan-in in the list', checks: shards([1, 10], [1, 11], [1, 12], [1, 13]) },
      ])('reads the family’s queue as not recorded, never the longest of the jobs that were read, where $situation', ({ checks }) => {
        const round = roundOf(checks);
        expect(round.queued).toEqual([]);
        expect(round.queueNotRecorded).toBe(true);
        expect(build([pull({ createdAt: at(-10), mergedAt: at(120), commits: [commit('a', 0, checks)] })]).windows[0].queue).toBeNull();
      });
    });

    it('reads a family whose fan-in was skipped behind a failed shard as that failure, not as a check that did not run', () => {
      const failing = shards([1, 10], [1, 11], [1, 12, 'failure', { failure: { steps: ['Run the walks'], record: null } }], [1, 13]);
      const round = roundOf([...failing, fanIn(13, 13, 'skipped')]);
      expect(round).toMatchObject({ red: true, failed: ['E2E (F3)'] });
      expect(round.failures.map((failure) => [failure.check, failure.steps])).toEqual([['E2E (F3)', ['Run the walks']]]);
    });
  });

  describe("a round's jobs are lanes", () => {
    /** A job created `created` minutes past 09:00 whose check run ran `from` to `to`, its job list read. */
    const job = (name, created, from, to, conclusion = 'success') => check(name, from, to, conclusion, { queue: { state: 'read', createdAt: at(created), startedAt: at(from) } });
    const lanesOf = (checks) => pullModel(pull({ mergedAt: at(120), commits: [commit('a', 0, checks)] })).rounds[0].lanes;

    it('places each job by its own start and stop in the round, with the wait before its start as a lead', () => {
      const lanes = lanesOf([job('Checks', 0, 1, 4), job('Test', 1, 3, 9)]);
      expect(lanes.map(({ name, offsetMs, ms, leadMs, queuedMs }) => ({ name, offsetMs, ms, leadMs, queuedMs }))).toEqual([
        { name: 'Checks', offsetMs: 0, ms: 3 * MIN, leadMs: 0, queuedMs: MIN },
        { name: 'Test', offsetMs: 2 * MIN, ms: 6 * MIN, leadMs: 2 * MIN, queuedMs: 2 * MIN },
      ]);
    });

    it('cuts a lead at the round’s start, since nothing before the first job to start belongs to the round', () => {
      const lanes = lanesOf([job('Checks', 1, 1, 4), job('Test', -5, 2, 9)]);
      const test = lanes.find((lane) => lane.name === 'Test');
      expect(test).toMatchObject({ offsetMs: MIN, leadMs: MIN, queuedMs: 7 * MIN });
    });

    it('draws no lane for a re-run’s copy of a job that passed, or for a job cancelled before a runner took it', () => {
      const copy = check('Test', 0, 5, 'success', { queue: { state: 'read', createdAt: at(20), startedAt: at(0) } });
      const lanes = lanesOf([job('Checks', 0, 1, 4), copy, job('Lint', 0, 3, 3, 'cancelled')]);
      expect(lanes.map((lane) => lane.name)).toEqual(['Checks']);
    });

    it('carries a job still running to the round’s end, with no stop of its own', () => {
      const rounds = pullModel(pull({ mergedAt: at(120), commits: [commit('a', 0, [job('Checks', 0, 1, 4), check('Test', 2, null, 'success', { queue: { state: 'read', createdAt: at(0), startedAt: at(2) } })])] })).rounds;
      const test = rounds[0].lanes.find((lane) => lane.name === 'Test');
      expect(test).toMatchObject({ outcome: 'running', endedAt: null });
      expect(test.offsetMs + test.ms).toBe(rounds[0].ms);
    });

    it('numbers a job’s attempts, the later ones marked as re-runs', () => {
      const lanes = lanesOf([job('Test', 0, 0, 5, 'failure'), job('Test', 6, 6, 12)]);
      expect(lanes.map(({ attempt, rerun }) => [attempt, rerun])).toEqual([[1, false], [2, true]]);
    });

    it.each([
      { situation: 'a job whose list could not be read', checks: () => [job('Checks', 0, 1, 4), check('Test', 2, 12, 'success', { queue: { state: 'not-recorded', why: 'unreadable' } })] },
      { situation: 'no job that ran on a runner', checks: () => [job('Lint', 0, 3, 3, 'cancelled')] },
    ])('has none to draw for $situation, so the round is the block', ({ checks }) => {
      expect(lanesOf(checks())).toBeNull();
    });
  });
});
