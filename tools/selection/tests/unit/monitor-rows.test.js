import { describe, expect, it } from 'vitest';

import { BARS, buildModel, monitorBars, monitorRows } from '../../src/model.js';

const MERGED = '2026-10-10T10:00:00Z';

const file = (path, status = 'passed', over = {}) => ({ path, level: 'unit', status, ...over });
const pkg = (over = {}) => ({ name: 'api', dir: 'apps/api', mode: 'changed', reason: null, report: 'written', files: [], ...over });
const record = (packages, changedFiles = [{ path: 'apps/api/src/a.ts', ignored: false }], event = 'pull_request') => ({ event, baseCommit: 'abc', changedFiles, packages });

const aPull = ({ number = 1, test = null, e2e = null, e2eChanged, mainFailed = null, files = null } = {}) => ({
  pull: { number, title: `Pull ${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt: MERGED },
  prRun: test || e2e ? { id: number * 10, testDurationMs: 90_000, record: test ? record(test) : null, e2eRecord: e2e ? record(e2e, e2eChanged) : null } : null,
  mainRun: mainFailed
    ? { id: number * 10 + 1, testDurationMs: 400_000, record: record([pkg({ mode: 'full', files: [file(mainFailed, 'failed')] })], [], 'push'), e2eRecord: null }
    : null,
  files,
});

const rowOf = (data) => monitorRows({ pulls: [data] })[0];
const job = (data, name) => rowOf(data).jobs.find((each) => each.job === name);

describe('Selection', () => {
  describe("a merged pull request is cut into the rows the Harness Monitor stores: a row per job, with the files it ran and the chain that picked each", () => {
    const selected = aPull({
      test: [
        pkg({
          files: [
            file('apps/api/tests/unit/a.test.ts', 'passed', { selectedBy: { kind: 'itself' } }),
            file('apps/api/tests/unit/b.test.ts', 'failed', { selectedBy: { kind: 'chain', chain: ['apps/api/tests/unit/b.test.ts', 'apps/api/src/a.ts'] } }),
            file('apps/api/tests/unit/odd.test.ts', 'passed', { selectedBy: null }),
            file('apps/api/tests/unit/skipped.test.ts', 'not run'),
          ],
        }),
      ],
      e2e: [
        pkg({
          name: 'e2e',
          dir: 'tests/e2e',
          files: [
            { path: 'tests/e2e/capture.test.ts', level: 'e2e', status: 'passed', selectedBy: { kind: 'concept', owners: [{ concept: 'Capture', path: 'apps/api/src/a.ts' }] } },
            { path: 'tests/e2e/other.test.ts', level: 'e2e', status: 'not run' },
          ],
        }),
      ],
    });

    it('sends only the files a job ran, each with why: itself changed, an import chain, a product area, or a trigger no chain explains', () => {
      const test = job(selected, 'test');
      const e2e = job(selected, 'e2e');

      expect(test).toMatchObject({ status: 'ran', ranEverything: false, selecting: true, filesRun: 3, filesTotal: 4, prDurationMs: 90_000, mainDurationMs: null });
      expect(test.packages[0].files).toEqual([
        { path: 'apps/api/tests/unit/a.test.ts', level: 'unit', status: 'passed', selectedBy: { kind: 'itself', text: 'itself changed' } },
        {
          path: 'apps/api/tests/unit/b.test.ts',
          level: 'unit',
          status: 'failed',
          selectedBy: { kind: 'chain', chain: ['apps/api/tests/unit/b.test.ts', 'apps/api/src/a.ts'], text: 'apps/api/tests/unit/b.test.ts → apps/api/src/a.ts' },
        },
        { path: 'apps/api/tests/unit/odd.test.ts', level: 'unit', status: 'passed', selectedBy: { kind: 'unknown', text: 'selected by Vitest; no import chain found' } },
      ]);
      expect(e2e).toMatchObject({ status: 'ran', filesRun: 1, filesTotal: 2, prDurationMs: null });
      expect(e2e.packages[0].files).toEqual([
        {
          path: 'tests/e2e/capture.test.ts',
          level: 'e2e',
          status: 'passed',
          selectedBy: { kind: 'concept', owners: [{ concept: 'Capture', path: 'apps/api/src/a.ts' }], text: 'owned by Capture, which `apps/api/src/a.ts` changed' },
        },
      ]);
    });

    it('sends a package that ran everything with its rule and path, and its files as run whole rather than picked', () => {
      const full = aPull({
        test: [pkg({ mode: 'full', reason: { rule: 'a lockfile changed', path: 'pnpm-lock.yaml' }, files: [file('apps/api/tests/unit/a.test.ts', 'passed')] })],
        e2e: [pkg({ name: 'e2e', dir: 'tests/e2e', mode: 'full', reason: { rule: 'owned by no concept' }, files: [] })],
      });

      expect(job(full, 'test')).toMatchObject({
        ranEverything: true,
        selecting: false,
        packages: [{ mode: 'full', reason: { rule: 'a lockfile changed', path: 'pnpm-lock.yaml' }, files: [{ path: 'apps/api/tests/unit/a.test.ts', selectedBy: { kind: 'full' } }] }],
      });
      expect(job(full, 'e2e').packages[0].reason).toEqual({ rule: 'owned by no concept', path: null });
    });

    it('sends a documentation-only pull request as such, with no packages and no files run, and its changed files', () => {
      const docs = aPull({ files: ['docs/notes.md'] });

      expect(rowOf(docs).jobs).toMatchObject([
        { job: 'test', status: 'docs-only', ranEverything: false, selecting: false, filesRun: null, filesTotal: null, packages: [], changedFiles: [{ path: 'docs/notes.md', ignored: false }] },
        { job: 'e2e', status: 'docs-only', packages: [], changedFiles: [{ path: 'docs/notes.md', ignored: false }] },
      ]);
    });

    it("sends each package's total test files, the ones it skipped counted, and how many changed files the browser tier placed on no walk", () => {
      const counted = aPull({
        test: [pkg({ files: [file('apps/api/tests/unit/a.test.ts', 'passed', { selectedBy: { kind: 'itself' } }), file('apps/api/tests/unit/b.test.ts', 'not run'), file('apps/api/tests/unit/c.test.ts', 'not run')] })],
        e2e: [pkg({ name: 'e2e', dir: 'tests/e2e', files: [], unplaced: [{ path: 'scripts/a.mjs', rule: 'nothing imports it' }, { path: 'scripts/b.mjs', rule: 'nothing imports it' }] })],
      });

      expect(job(counted, 'test').packages[0]).toMatchObject({ filesTotal: 3, files: [{ path: 'apps/api/tests/unit/a.test.ts' }] });
      expect(job(counted, 'test').unplacedFiles).toBeNull();
      expect(job(counted, 'e2e').unplacedFiles).toBe(2);
    });

    it('sends no total for a package whose process wrote no report, rather than none held', () => {
      const crashed = aPull({ test: [pkg({ report: 'none', files: [] })] });

      expect(job(crashed, 'test').packages[0]).toMatchObject({ report: 'none', filesTotal: null });
    });

    it('sends no count of unplaced files, rather than none, where the browser tier did not run or its record carries no list', () => {
      const olderRecord = aPull({ test: [pkg()], e2e: [pkg({ name: 'e2e', dir: 'tests/e2e' })] });
      const docs = aPull({ files: ['docs/notes.md'] });
      const noneUnplaced = aPull({ test: [pkg()], e2e: [pkg({ name: 'e2e', dir: 'tests/e2e', unplaced: [] })] });

      expect(job(olderRecord, 'e2e').unplacedFiles).toBeNull();
      expect(job(docs, 'e2e').unplacedFiles).toBeNull();
      expect(job(noneUnplaced, 'e2e').unplacedFiles).toBe(0);
    });

    it('sends a product pull request that left no record as no record, which the Monitor counts in neither direction', () => {
      const missing = aPull({ files: ['apps/api/src/a.ts'] });

      expect(rowOf(missing).jobs.map((each) => each.status)).toEqual(['no-record', 'no-record']);
    });

    it('gives the E2E job the diff its own record read, and the Test job its own', () => {
      const split = aPull({ test: [pkg()], e2e: [pkg({ name: 'e2e' })], e2eChanged: [{ path: 'apps/web/src/b.ts', ignored: false }] });

      expect(job(split, 'test').changedFiles).toEqual([{ path: 'apps/api/src/a.ts', ignored: false }]);
      expect(job(split, 'e2e').changedFiles).toEqual([{ path: 'apps/web/src/b.ts', ignored: false }]);
    });

    it('sends a miss to the job it was missed by: a spec by its level, any other test to the Test job', () => {
      const missed = aPull({
        test: [pkg({ files: [file('apps/api/tests/unit/m.test.ts', 'not run')] })],
        e2e: [pkg({ name: 'e2e', dir: 'tests/e2e' })],
        mainFailed: 'apps/api/tests/unit/m.test.ts',
      });

      expect(rowOf(missed).misses).toEqual([{ job: 'test', path: 'apps/api/tests/unit/m.test.ts', level: 'unit', reason: null }]);
    });

    it('cuts what the Monitor would refuse a whole batch for, so one extreme pull request never holds every later night back', () => {
      const longChain = Array.from({ length: 60 }, (_, index) => `apps/api/src/a-module-with-a-long-name-${index}.ts`);
      const broken = {
        ...aPull({ test: [pkg({ files: [file('apps/api/tests/unit/a.test.ts', 'passed', { selectedBy: { kind: 'chain', chain: longChain } })] })] }),
        mainRun: {
          id: 2,
          testDurationMs: 400_000,
          record: record([pkg({ mode: 'full', files: Array.from({ length: 600 }, (_, index) => file(`apps/api/tests/unit/f${index}.test.ts`, 'failed')) })], [], 'push'),
          e2eRecord: null,
        },
      };

      expect(rowOf(broken).misses).toHaveLength(500);
      expect(job(broken, 'test').packages[0].files[0].selectedBy.text).toHaveLength(2000);
    });
  });

  describe("the bars' thresholds are sent with the rows, since the tool owns them", () => {
    it('carries every bar with the numbers the page reads it against, and the window they are judged on', () => {
      const bars = monitorBars();

      expect(bars).toMatchObject({ windowDays: BARS.windowDays, minPulls: BARS.minPulls });
      expect(bars.items.map((bar) => [bar.id, bar.threshold, bar.minOver])).toEqual([
        ['e2e-forced-full', 0.25, null],
        ['test-forced-full', 0.25, null],
        ['misses', 1, null],
        ['most-selected', 0.8, 10],
      ]);
    });

    it('names each bar as the page does, so the answer and the page never disagree', () => {
      const model = buildModel({ pulls: [], now: new Date('2026-10-12T00:00:00Z'), requestedDays: 14, coveredSince: new Date('2026-09-28T00:00:00Z'), repo: 'o/r' });

      expect(monitorBars().items.map((bar) => bar.name)).toEqual(model.bars.items.map((bar) => bar.name));
    });

    it.each([
      {
        situation: 'an open alarm issue for a bar names it, and the bars without one say none is open',
        alarms: [{ number: 41, state: 'open', body: '<!-- selection-alarm bar=misses first=2026-10-01 last=2026-10-02 -->' }],
        expected: { 'e2e-forced-full': null, 'test-forced-full': null, misses: 41, 'most-selected': null },
      },
      {
        situation: 'a closed alarm issue is not open',
        alarms: [{ number: 41, state: 'closed', body: '<!-- selection-alarm bar=misses first=2026-10-01 last=2026-10-02 -->' }],
        expected: { 'e2e-forced-full': null, 'test-forced-full': null, misses: null, 'most-selected': null },
      },
      {
        situation: 'alarm issues that could not be read say nothing, so the Monitor keeps the ones it holds',
        alarms: undefined,
        expected: { 'e2e-forced-full': undefined, 'test-forced-full': undefined, misses: undefined, 'most-selected': undefined },
      },
    ])('$situation', ({ alarms, expected }) => {
      const bars = monitorBars({ alarms });

      expect(Object.fromEntries(bars.items.map((bar) => [bar.id, bar.alarmIssue]))).toEqual(expected);
      if (alarms === undefined) expect(bars.items.every((bar) => !('alarmIssue' in bar))).toBe(true);
    });
  });
});
