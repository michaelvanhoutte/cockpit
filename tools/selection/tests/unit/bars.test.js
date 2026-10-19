import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';

const NOW = new Date('2026-02-15T00:00:00Z');
const IN_WINDOW = '2026-02-14T00:00:00Z';

const file = ({ path, status = 'passed' }) => ({ path, level: 'unit', status, selectedBy: null });
const pkg = ({ name = '@cockpit/pkg', dir = 'apps/pkg', mode = 'changed', reason = null, files = [] }) => ({ name, dir, mode, reason, report: 'written', files });
const record = ({ event = 'pull_request', packages = [] }) => ({ event, baseCommit: 'abc123', changedFiles: [], packages });
const forced = (rule = 'outside every package', path = 'scripts/x.mjs') => ({ mode: 'full', reason: { rule, path }, files: [] });

let nextNumber = 1;
/**
 * A merged pull request. `test` and `e2e` are the packages its Test and E2E jobs
 * recorded (`null`: no record); `mainTest` is what main's run of the merge failed.
 */
function aPull({ test = null, e2e = null, mainFailed = null, mergedAt = IN_WINDOW, files = null } = {}) {
  const number = nextNumber++;
  const prRecord = test ? record({ packages: test }) : null;
  const e2eRecord = e2e ? record({ packages: e2e }) : null;
  return {
    pull: { number, title: `Pull ${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt },
    prRun: prRecord || e2eRecord ? { id: number * 10, testDurationMs: 60_000, record: prRecord, e2eRecord } : null,
    mainRun: mainFailed ? { id: number * 10 + 1, testDurationMs: 400_000, record: record({ event: 'push', packages: [pkg({ mode: 'full', files: [file({ path: mainFailed, status: 'failed' })] })] }), e2eRecord: null } : null,
    files: prRecord || e2eRecord ? null : (files ?? ['docs/notes.md']),
  };
}

const e2eTier = (overrides) => pkg({ name: 'e2e', dir: 'tests/e2e', ...overrides });
const times = (count, make) => Array.from({ length: count }, (_, index) => make(index));
/** Documentation-only pull requests: they pad a window to the 20 a bar needs without touching any figure but the count. */
const padding = (count) => times(count, () => aPull());

const build = (pulls, options = {}) => buildModel({ pulls, now: NOW, requestedDays: 14, coveredSince: new Date('2026-01-01'), ...options });
const bar = (model, id) => model.bars.items.find((each) => each.id === id);

/** Pull requests whose Test job ran everything on `forcedCount` of `total` and whose E2E job ran every spec on `e2eForcedCount`. */
function forcedWindow({ total, testForced = 0, e2eForced = 0 }) {
  return times(total, (index) =>
    aPull({
      test: [index < testForced ? pkg(forced()) : pkg({ mode: 'changed' })],
      e2e: [e2eTier(index < e2eForced ? forced('owned by no concept', `apps/api/src/${index}.ts`) : { mode: 'changed' })],
    }),
  );
}

/** `selected` of `total` pull requests select `hot.test.ts` among those that could have skipped it, plus `fullRuns` that ran its package in full. */
function hotFileWindow({ total, selected, fullRuns = 0, path = 'apps/pkg/tests/unit/hot.test.ts' }) {
  return [
    ...times(total, (index) => aPull({ test: [pkg({ mode: 'changed', files: [file({ path, status: index < selected ? 'passed' : 'not run' })] })] })),
    ...times(fullRuns, () => aPull({ test: [pkg({ ...forced(), files: [file({ path })] })] })),
  ];
}

describe('Test selection report', () => {
  describe('each headline figure carries a verdict against its bar on the 14-day window', () => {
    it.each([
      { situation: 'Test forced to run everything on 47 of 145 pull requests', id: 'test-forced-full', pulls: () => forcedWindow({ total: 145, testForced: 47 }), verdict: 'crossed', count: 47, of: 145 },
      { situation: 'E2E forced to run every spec on 143 of 145 pull requests', id: 'e2e-forced-full', pulls: () => forcedWindow({ total: 145, e2eForced: 143 }), verdict: 'crossed', count: 143, of: 145 },
      { situation: 'Test forced to run everything on 20 of 145 pull requests', id: 'test-forced-full', pulls: () => forcedWindow({ total: 145, testForced: 20 }), verdict: 'within', count: 20, of: 145 },
      { situation: 'E2E forced to run every spec on 20 of 145 pull requests', id: 'e2e-forced-full', pulls: () => forcedWindow({ total: 145, e2eForced: 20 }), verdict: 'within', count: 20, of: 145 },
      { situation: 'Test forced to run everything on exactly a quarter of the pull requests', id: 'test-forced-full', pulls: () => forcedWindow({ total: 100, testForced: 25 }), verdict: 'crossed', count: 25, of: 100 },
      { situation: 'Test forced to run everything on just under a quarter of the pull requests', id: 'test-forced-full', pulls: () => forcedWindow({ total: 100, testForced: 24 }), verdict: 'within', count: 24, of: 100 },
      { situation: '3 misses', id: 'misses', pulls: () => [...times(3, () => aPull({ test: [pkg({ mode: 'changed', files: [file({ path: 'apps/pkg/tests/unit/a.test.ts', status: 'not run' })] })], mainFailed: 'apps/pkg/tests/unit/a.test.ts' })), ...padding(20)], verdict: 'crossed', count: 3, of: null },
      { situation: 'no miss', id: 'misses', pulls: () => padding(20), verdict: 'within', count: 0, of: null },
    ])('$situation: $verdict', ({ id, pulls, verdict, count, of }) => {
      expect(bar(build(pulls()), id)).toMatchObject({ verdict, unread: null, count, of });
    });

    it('a crossed bar carries its figure and threshold, and a place for the alarm issue the nightly job files', () => {
      const crossed = bar(build(forcedWindow({ total: 145, testForced: 47 })), 'test-forced-full');
      expect(crossed.value).toBeCloseTo(47 / 145);
      expect(crossed).toMatchObject({ threshold: 0.25, alarmIssue: null });
    });

    it.each([
      { situation: 'the most-selected test at 67% over 12 pull requests', pulls: () => [...hotFileWindow({ total: 12, selected: 8 }), ...padding(10)], verdict: 'within', unread: null },
      { situation: 'the most-selected test at 83% over 12 pull requests', pulls: () => [...hotFileWindow({ total: 12, selected: 10 }), ...padding(10)], verdict: 'crossed', unread: null },
      { situation: 'the most-selected test at 83% over 6 pull requests', pulls: () => [...hotFileWindow({ total: 6, selected: 5 }), ...padding(20)], verdict: 'unread', unread: 'figure' },
      { situation: 'the most-selected test at 80% over exactly 10 pull requests', pulls: () => [...hotFileWindow({ total: 10, selected: 8 }), ...padding(20)], verdict: 'crossed', unread: null },
      { situation: 'a test selected on 8 of 12 pull requests, and run in full by 10 others', pulls: () => [...hotFileWindow({ total: 12, selected: 8, fullRuns: 10 })], verdict: 'within', unread: null },
    ])('$situation: $verdict', ({ pulls, verdict, unread }) => {
      expect(bar(build(pulls()), 'most-selected')).toMatchObject({ verdict, unread });
    });

    it('a browser spec is read like a test file: selected on 10 of 12 pull requests it crosses', () => {
      const spec = (index) => aPull({ e2e: [e2eTier({ mode: 'changed', files: [file({ path: 'tests/e2e/hot.test.ts', status: index < 10 ? 'passed' : 'not run' })] })] });
      expect(bar(build([...times(12, spec), ...padding(10)]), 'most-selected')).toMatchObject({ verdict: 'crossed', path: 'tests/e2e/hot.test.ts', count: 10, of: 12 });
    });

    it('the worst test with at least ten pull requests is the figure, not a worse one with fewer', () => {
      const pulls = [...hotFileWindow({ total: 6, selected: 6, path: 'few.test.ts' }), ...hotFileWindow({ total: 20, selected: 14, path: 'many.test.ts' })];
      expect(bar(build(pulls), 'most-selected')).toMatchObject({ verdict: 'within', path: 'many.test.ts', count: 14, of: 20 });
    });

    it('a window with 19 merged pull requests leaves every bar unread, and says the window is why', () => {
      const model = build(forcedWindow({ total: 19, testForced: 19, e2eForced: 19 }));
      expect(model.bars.read).toBe(false);
      expect(model.bars.items.map((each) => [each.verdict, each.unread])).toEqual(times(4, () => ['unread', 'window']));
    });

    it('a window with exactly 20 merged pull requests is read', () => {
      expect(build(forcedWindow({ total: 20, testForced: 20 })).bars.read).toBe(true);
    });

    it('a figure the window cannot give is unread, never within', () => {
      // Twenty documentation-only pull requests: no Test job and no E2E job ran, so neither forced-full figure exists.
      const model = build(padding(20));
      expect(bar(model, 'test-forced-full')).toMatchObject({ verdict: 'unread', unread: 'figure', value: null });
      expect(bar(model, 'e2e-forced-full')).toMatchObject({ verdict: 'unread', unread: 'figure', value: null });
      expect(bar(model, 'most-selected')).toMatchObject({ verdict: 'unread', unread: 'figure', value: null });
    });

    it('pull requests merged before the window are not read', () => {
      const old = times(30, () => aPull({ test: [pkg(forced())], mergedAt: '2026-01-10T00:00:00Z' }));
      const model = build([...old, ...padding(20)]);
      expect(model.bars.pulls).toBe(20);
      expect(bar(model, 'test-forced-full').verdict).toBe('unread');
    });

    it('a partial window is read by its actual days, still gives its verdict, and names that it is partial', () => {
      const model = build(forcedWindow({ total: 40, testForced: 20 }), { coveredSince: new Date('2026-02-05T00:00:00Z') });
      expect(model.bars).toMatchObject({ partial: true, actualDays: 10, windowDays: 14, read: true });
      expect(bar(model, 'test-forced-full').verdict).toBe('crossed');
    });

    it('a window covered in full is not partial', () => {
      expect(build(padding(20)).bars).toMatchObject({ partial: false, actualDays: 14 });
    });
  });

  describe('a rule’s total counts a pull request once', () => {
    const rulesOf = (model) => model.forcedFullRules.map(({ tier, rule, count }) => ({ tier, rule, count }));

    it('a pull request forced by two paths of one rule is counted once by that rule, and once by each path', () => {
      const model = build([aPull({ test: [pkg({ name: 'a', ...forced('outside every package', 'a.mjs') }), pkg({ name: 'b', ...forced('outside every package', 'b.mjs') })] })]);
      expect(rulesOf(model)).toEqual([{ tier: 'Vitest', rule: 'outside every package', count: 1 }]);
      expect(model.forcedFullRules[0].paths.map(({ path, count }) => ({ path, count }))).toEqual([
        { path: 'a.mjs', count: 1 },
        { path: 'b.mjs', count: 1 },
      ]);
    });

    it('a pull request forced by two rules is counted by both', () => {
      const model = build([aPull({ test: [pkg({ name: 'a', ...forced('outside every package', 'a.mjs') }), pkg({ name: 'b', ...forced('any tsconfig', 'tsconfig.json') })] })]);
      expect(rulesOf(model)).toEqual([
        { tier: 'Vitest', rule: 'any tsconfig', count: 1 },
        { tier: 'Vitest', rule: 'outside every package', count: 1 },
      ]);
    });

    it('a rule of one job is apart from the same rule of the other', () => {
      const model = build([aPull({ test: [pkg(forced('any tsconfig', 'tsconfig.json'))], e2e: [e2eTier(forced('any tsconfig', 'tsconfig.json'))] })]);
      expect(rulesOf(model)).toEqual([
        { tier: 'Vitest', rule: 'any tsconfig', count: 1 },
        { tier: 'E2E', rule: 'any tsconfig', count: 1 },
      ]);
    });

    it('rows come worst first, each with its paths nested worst first', () => {
      const catching = (rule, path) => aPull({ test: [pkg(forced(rule, path))] });
      const model = build([
        catching('own migration', 'apps/pkg/migrations/1.sql'),
        catching('outside every package', 'scripts/rare.mjs'),
        catching('outside every package', 'scripts/common.mjs'),
        catching('outside every package', 'scripts/common.mjs'),
        catching('outside every package', 'scripts/common.mjs'),
        catching('any tsconfig', 'tsconfig.json'),
        catching('any tsconfig', 'tsconfig.json'),
      ]);
      expect(rulesOf(model)).toEqual([
        { tier: 'Vitest', rule: 'outside every package', count: 4 },
        { tier: 'Vitest', rule: 'any tsconfig', count: 2 },
        { tier: 'Vitest', rule: 'own migration', count: 1 },
      ]);
      expect(model.forcedFullRules[0].paths.map(({ path, count }) => [path, count])).toEqual([
        ['scripts/common.mjs', 3],
        ['scripts/rare.mjs', 1],
      ]);
    });

    it('one rule spread over thirty paths crosses by its total although no path comes near the bar', () => {
      const pulls = [...times(30, (index) => aPull({ test: [pkg(forced('outside every package', `scripts/new-${index}.mjs`))] })), ...times(70, () => aPull({ test: [pkg({ mode: 'changed' })] }))];
      const model = build(pulls);
      const [row] = model.forcedFullRules;
      expect(row).toMatchObject({ rule: 'outside every package', count: 30, of: 100, verdict: 'crossed' });
      expect(Math.max(...row.paths.map((each) => each.count))).toBe(1);
      expect(bar(model, 'test-forced-full')).toMatchObject({ verdict: 'crossed', cause: { rule: 'outside every package', count: 30 } });
    });

    it('a rule under the bar is within, and a rule in a window too small to read is unread', () => {
      const small = build([aPull({ test: [pkg(forced())] })]);
      expect(small.forcedFullRules[0].verdict).toBe('unread');

      const model = build(forcedWindow({ total: 100, testForced: 10 }));
      expect(model.forcedFullRules[0]).toMatchObject({ count: 10, verdict: 'within' });
    });

    it('a rule that forced one package of several shows its count but is not read as running everything', () => {
      const partial = () => aPull({ test: [pkg({ name: 'a', ...forced('own package.json', 'apps/a/package.json') }), pkg({ name: 'b', mode: 'changed' })] });
      const model = build([...times(10, partial), ...times(10, () => aPull({ test: [pkg({ mode: 'changed' })] }))]);
      expect(model.forcedFullRules[0]).toMatchObject({ rule: 'own package.json', count: 10, of: 20, verdict: 'within' });
      expect(bar(model, 'test-forced-full')).toMatchObject({ count: 0, verdict: 'within' });
    });

    it('the leading rule of a bar is the one that forced most of the pull requests that ran everything', () => {
      const pulls = [
        ...times(6, () => aPull({ test: [pkg(forced('outside every package', 'a.mjs'))] })),
        ...times(2, () => aPull({ test: [pkg(forced('any tsconfig', 'tsconfig.json'))] })),
        ...times(12, () => aPull({ test: [pkg({ mode: 'changed' })] })),
      ];
      expect(bar(build(pulls), 'test-forced-full').cause).toEqual({ rule: 'outside every package', count: 6 });
    });

    it('rules count only the pull requests merged in the window', () => {
      const model = build([aPull({ test: [pkg(forced())], mergedAt: '2026-01-10T00:00:00Z' }), aPull({ test: [pkg({ mode: 'changed' })] })]);
      expect(model.forcedFullRules).toEqual([]);
    });
  });
});
