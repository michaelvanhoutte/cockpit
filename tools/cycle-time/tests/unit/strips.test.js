import { describe, expect, it } from 'vitest';

import { renderBlock } from '../../../../scripts/lib/session-record.mjs';
import { pullModel } from '../../src/model.js';
import { fitTo, partsOf, scaleFor } from '../../src/render/strips.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = Date.UTC(2026, 8, 15, 9, 0);
const at = (minutes) => new Date(BASE + minutes * MIN).toISOString();

/** A model pull request with rounds given as [pushed, ended] minutes past 09:00, merged at `merged`. */
const pull = (rounds, merged, beforeFirstPush = 0) => ({
  mergedAt: at(merged),
  beforeFirstPushMs: beforeFirstPush * MIN,
  rounds: rounds.map(([from, to]) => ({ pushedAt: at(from), endedAt: at(to), ms: (to - from) * MIN })),
});

/** A real pull request from the model: a round 20–40 and another 55–65 after a fix, merged at 70, and the marks of its record. */
const modelled = (marks, { rounds = [[20, 40], [55, 65]], merged = 70 } = {}) => {
  let id = 1;
  const check = (from, to) => ({ id: id++, name: 'Test', suiteId: 1, status: 'completed', conclusion: 'success', startedAt: at(from), completedAt: at(to) });
  return pullModel({
    number: 1,
    title: 'A change',
    url: 'https://github.com/o/r/pull/1',
    createdAt: at(0),
    mergedAt: at(merged),
    body: renderBlock([{ at: at(0), phase: 'start' }, ...marks.map(([minute, phase, kind, level]) => ({ at: at(minute), phase, kind, level }))]),
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commitCount: rounds.length,
    commits: rounds.map(([from, to], index) => ({ sha: `c${index}`, authoredAt: at(index === 0 ? 0 : from - 5), parents: 1, checks: [check(from, to)] })),
  });
};
const review = (kind, from, to) => [[from, 'review-start', kind, 'high'], [to, 'review-end', kind, 'high']];
const total = (parts, ...types) => parts.filter((part) => types.includes(part.type)).reduce((sum, part) => sum + part.ms, 0);

describe('Cycle time', () => {
  describe('a local review is its own slice on the strip, at the time it ran', () => {
    it('cuts a review before the first push out of the coding, which shortens by its length', () => {
      const parts = partsOf(modelled(review('code-review', 5, 15)));
      expect(parts.slice(0, 4).map((part) => [part.type, part.kind ?? null, part.ms / MIN])).toEqual([
        ['coding', null, 5],
        ['review', 'code-review', 10],
        ['coding', null, 5],
        ['round', null, 20],
      ]);
    });

    it('cuts a review between a red round and the next push out of the fixing', () => {
      const parts = partsOf(modelled(review('security-review', 42, 50)));
      expect(parts.map((part) => [part.type, part.kind ?? null, part.ms / MIN])).toEqual([
        ['coding', null, 20],
        ['round', null, 20],
        ['fixing', null, 2],
        ['review', 'security-review', 8],
        ['fixing', null, 5],
        ['round', null, 10],
        ['wait', null, 5],
      ]);
    });

    it('draws a code review then a security review as two slices, each named by its kind and level', () => {
      const parts = partsOf(modelled([...review('code-review', 2, 6), ...review('security-review', 8, 10)]));
      expect(parts.filter((part) => part.type === 'review').map((part) => [part.kind, part.level, part.ms / MIN])).toEqual([
        ['code-review', 'high', 4],
        ['security-review', 'high', 2],
      ]);
    });

    it('keeps both of two code reviews, a recheck', () => {
      const parts = partsOf(modelled([...review('code-review', 2, 6), ...review('code-review', 42, 44)]));
      expect(parts.filter((part) => part.type === 'review').map((part) => part.ms / MIN)).toEqual([4, 2]);
    });

    it('draws no slice for a review that was started and never ended, and leaves the coding whole', () => {
      const parts = partsOf(modelled([[5, 'review-start', 'code-review', 'high']]));
      expect(parts.map((part) => part.type)).toEqual(['coding', 'round', 'fixing', 'round', 'wait']);
      expect(parts[0].ms).toBe(20 * MIN);
    });
  });

  describe('a strip and its scatter dot count the same review time', () => {
    it.each([
      { situation: 'a review marked across the first push', marks: review('code-review', 10, 30), merged: 70, rounds: undefined },
      { situation: 'a review spanning a whole round', marks: review('code-review', 10, 50), merged: 70, rounds: undefined },
      { situation: 'a review in the wait to merge', marks: review('code-review', 66, 69), merged: 70, rounds: undefined },
      { situation: 'two reviews that overlap', marks: [...review('code-review', 2, 10), ...review('security-review', 6, 14)], merged: 70, rounds: undefined },
      { situation: 'a review inside a gap long enough to read as away', marks: review('code-review', 100, 120), merged: 420, rounds: [[20, 40], [300, 310]] },
    ])('agree to the minute on $situation', ({ marks, merged, rounds }) => {
      const model = modelled(marks, { merged, ...(rounds ? { rounds } : {}) });
      const parts = partsOf(model);
      // The strip's slices are what the scatter moves from coding to the harness; coding and fixing are what is left.
      expect(total(parts, 'review')).toBe(model.balance.harnessMs - total(parts, 'round'));
      expect(total(parts, 'coding', 'fixing')).toBe(model.balance.codingMs);
    });

    it('draws a review across the first push only as far as the push, and leaves the round whole', () => {
      const parts = partsOf(modelled(review('code-review', 10, 30)));
      expect(parts.slice(0, 3).map((part) => [part.type, part.ms / MIN])).toEqual([['coding', 10], ['review', 10], ['round', 20]]);
    });
  });

  describe('a strip is cut to one shared scale and says so', () => {
    it('lays out coding, each round, the fixing between them and the wait to merge, in order', () => {
      const parts = partsOf(pull([[10, 20], [30, 40]], 45, 10));
      expect(parts.map((part) => [part.type, part.ms / MIN])).toEqual([
        ['coding', 10],
        ['round', 10],
        ['fixing', 10],
        ['round', 10],
        ['wait', 5],
      ]);
    });

    it('lays out nothing for a pull request no check ran on', () => {
      expect(partsOf(pull([], 45))).toEqual([]);
    });

    it('takes the longest strip as the scale, up to four hours, and never a scale of nothing', () => {
      expect(scaleFor([partsOf(pull([[0, 30]], 30)), partsOf(pull([[0, 90]], 90))])).toBe(90 * MIN);
      expect(scaleFor([partsOf(pull([[0, 6 * 60]], 6 * 60))])).toBe(4 * HOUR);
      expect(scaleFor([])).toBeGreaterThan(0);
    });

    it('leaves a strip that fits as it is, and says nothing was cut', () => {
      const parts = partsOf(pull([[0, 30]], 30));
      expect(fitTo(parts, 60 * MIN)).toMatchObject({ parts, shownMs: 30 * MIN, clipped: null });
    });

    it('cuts a strip at the scale and names how much it cut', () => {
      const fitted = fitTo(partsOf(pull([[0, 60], [70, 200]], 200)), 120 * MIN);
      expect(fitted.clipped).toEqual({ shownMs: 120 * MIN, totalMs: 200 * MIN });
      expect(fitted.parts.map((part) => [part.type, part.ms / MIN, Boolean(part.cut)])).toEqual([
        ['round', 60, false],
        ['fixing', 10, false],
        ['round', 50, true],
      ]);
    });

    it('draws no time away after the edge it was cut at, since it happened beyond it', () => {
      // A round fills the scale exactly, then the pull request goes away for a night.
      const fitted = fitTo(partsOf(pull([[0, 60], [600, 660]], 660)), 60 * MIN);
      expect(fitted.parts.map((part) => part.type)).toEqual(['round']);
      expect(fitted.clipped).toEqual({ shownMs: 60 * MIN, totalMs: 120 * MIN });
    });

    it('keeps time away that comes before the edge, and leaves it off the scale', () => {
      const fitted = fitTo(partsOf(pull([[0, 30], [400, 430]], 430)), 60 * MIN);
      expect(fitted.parts.map((part) => part.type)).toEqual(['round', 'away', 'round']);
      expect(fitted.clipped).toBeNull();
      expect(fitted.shownMs).toBe(60 * MIN);
    });

    it('keeps time away that comes before the edge of a strip that is cut', () => {
      const fitted = fitTo(partsOf(pull([[0, 30], [400, 470]], 470)), 60 * MIN);
      expect(fitted.parts.map((part) => [part.type, part.ms / MIN])).toEqual([
        ['round', 30],
        ['away', 370],
        ['round', 30],
      ]);
      expect(fitted.clipped).toEqual({ shownMs: 60 * MIN, totalMs: 100 * MIN });
    });
  });

  describe('a local test run and the browser pass are slices on the strip, and the strip and scatter count the same time', () => {
    /** The same pull request `modelled` builds, with a record that carries test runs `[from, to, scope]` and browser passes `[from, to]`. */
    const withRuns = ({ runs = [], browser = [], reviews = [] } = {}) => {
      const [first, second] = [[20, 40], [55, 65]];
      let id = 1;
      const check = ([from, to]) => ({ id: id++, name: 'Test', suiteId: 1, status: 'completed', conclusion: 'success', startedAt: at(from), completedAt: at(to) });
      return pullModel({
        number: 1,
        title: 'A change',
        url: 'https://github.com/o/r/pull/1',
        createdAt: at(0),
        mergedAt: at(70),
        body: renderBlock([
          { at: at(0), phase: 'start' },
          ...reviews.flatMap(([from, to]) => [{ at: at(from), phase: 'review-start', kind: 'code-review', level: 'high' }, { at: at(to), phase: 'review-end', kind: 'code-review', level: 'high' }]),
          ...browser.flatMap(([from, to]) => [{ at: at(from), phase: 'browser-start' }, { at: at(to), phase: 'browser-end' }]),
          ...runs.map(([from, to, scope]) => ({ run: 'test', scopes: [scope], start: at(from), end: at(to) })),
        ]),
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        commitCount: 2,
        commits: [
          { sha: 'c0', authoredAt: at(0), parents: 1, checks: [check(first)] },
          { sha: 'c1', authoredAt: at(50), parents: 1, checks: [check(second)] },
        ],
      });
    };

    it('cuts a test run before the first push and one while fixing out of the part they sat in', () => {
      const parts = partsOf(withRuns({ runs: [[5, 9, 'api'], [44, 48, 'web']] }));
      expect(parts.map((part) => [part.type, part.scopes?.[0] ?? null, part.ms / MIN])).toEqual([
        ['coding', null, 5],
        ['test', 'api', 4],
        ['coding', null, 11],
        ['round', null, 20],
        ['fixing', null, 4],
        ['test', 'web', 4],
        ['fixing', null, 7],
        ['round', null, 10],
        ['wait', null, 5],
      ]);
    });

    it('draws the browser pass as its own slice, apart from a test run', () => {
      const parts = partsOf(withRuns({ runs: [[2, 4, 'api']], browser: [[10, 16]] }));
      expect(parts.filter((part) => ['test', 'browser'].includes(part.type)).map((part) => [part.type, part.ms / MIN])).toEqual([['test', 2], ['browser', 6]]);
    });

    it('draws a browser pass that was started and never ended as no slice', () => {
      const parts = partsOf(withRuns({ browser: [] }));
      expect(parts.map((part) => part.type)).toEqual(['coding', 'round', 'fixing', 'round', 'wait']);
    });

    it('draws a test run during a review as one stretch naming both, so the strip adds up to the union', () => {
      const parts = partsOf(withRuns({ reviews: [[2, 12]], runs: [[8, 14, 'api']] }));
      expect(parts.slice(0, 4).map((part) => [part.type, part.ms / MIN])).toEqual([['coding', 2], ['review', 6], ['overlap', 4], ['test', 2]]);
      expect(parts.find((part) => part.type === 'overlap').slices.map((slice) => slice.kind)).toEqual(['code-review', 'test']);
    });

    it.each([
      { situation: 'a test run marked across a push', model: () => withRuns({ runs: [[10, 30, 'api']] }) },
      { situation: 'a test run in the wait to merge', model: () => withRuns({ runs: [[66, 69, 'api']] }) },
      { situation: 'a test run during a review', model: () => withRuns({ reviews: [[2, 12]], runs: [[8, 14, 'api']] }) },
      { situation: 'a test run and a browser pass', model: () => withRuns({ runs: [[2, 6, 'api'], [44, 46, 'web']], browser: [[10, 16]] }) },
    ])('agree to the minute on $situation', ({ model }) => {
      const built = model();
      const parts = partsOf(built);
      const local = total(parts, 'review', 'test', 'browser', 'overlap');
      expect(local).toBe(built.balance.harnessMs - total(parts, 'round'));
      expect(total(parts, 'coding', 'fixing')).toBe(built.balance.codingMs);
    });

    it('draws a test run across the first push only as far as the push', () => {
      const parts = partsOf(withRuns({ runs: [[10, 30, 'api']] }));
      expect(parts.slice(0, 3).map((part) => [part.type, part.ms / MIN])).toEqual([['coding', 10], ['test', 10], ['round', 20]]);
    });
  });
});
