import { describe, expect, it } from 'vitest';

import { buildModel, chainText, median, pullModel } from '../../src/model.js';

const file = ({ path, level = 'unit', status = 'passed', selectedBy = null }) => ({ path, level, status, selectedBy });
const pkg = ({ name = '@cockpit/pkg', dir = 'apps/pkg', mode = 'changed', reason = null, report = 'written', files = [] }) => ({ name, dir, mode, reason, report, files });
const record = ({ event = 'pull_request', baseCommit = 'abc123', changedFiles = [], packages = [] }) => ({ event, baseCommit, changedFiles, packages });

let nextNumber = 1;
function pullData({ prRecord = null, mainRecord = null, files = null, prDuration = null, mainDuration = null, mergedAt = '2026-01-15T00:00:00Z', ...rest } = {}) {
  const number = rest.number ?? nextNumber++;
  return {
    pull: { number, title: `Pull ${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt, ...rest },
    prRun: prRecord || prDuration !== null ? { id: number * 10, testDurationMs: prDuration, record: prRecord } : null,
    mainRun: mainRecord || mainDuration !== null ? { id: number * 10 + 1, testDurationMs: mainDuration, record: mainRecord } : null,
    files,
  };
}

// The E2E job's record has the Test record's shape: the whole tier is one package `e2e`, each spec file one of its files.
const spec = ({ path, status = 'passed', selectedBy }) => file({ path, level: 'e2e', status, selectedBy });
const tier = ({ mode = 'changed', reason = null, report = 'written', files = [] }) => pkg({ name: 'e2e', dir: 'tests/e2e', mode, reason, report, files });
const owned = (concept, path) => ({ kind: 'concept', owners: [{ concept, path }] });

/** A pull request whose Test and E2E jobs both left a record, with main's run of its merge alike. */
function pullWithE2e({ e2e, mainE2e = null, ...rest } = {}) {
  const data = pullData({ prRecord: record({ packages: [] }), ...rest });
  data.prRun.e2eRecord = e2e ? record({ packages: [e2e] }) : null;
  if (mainE2e) {
    data.mainRun = { id: 999, testDurationMs: null, record: record({ event: 'push', packages: [] }), e2eRecord: record({ event: 'push', packages: [mainE2e] }) };
  }
  return data;
}

const build = (pulls, now = new Date('2026-02-01')) => buildModel({ pulls, now, requestedDays: 30, coveredSince: new Date('2026-01-01') });

describe('pullModel: Rule 1, a miss is a test that failed on main and was not run on the pull request', () => {
  it('failed on main, not run on the pull request: a miss', () => {
    const data = pullData({
      prRecord: record({ packages: [pkg({ mode: 'changed', files: [file({ path: 'a.test.ts', status: 'not run' })] })] }),
      mainRecord: record({ event: 'push', packages: [pkg({ mode: 'full', files: [file({ path: 'a.test.ts', status: 'failed' })] })] }),
    });
    expect(pullModel(data).misses).toEqual([{ path: 'a.test.ts', level: 'unit', reason: null }]);
  });

  it('failed on main, run and passed on the pull request: not a miss', () => {
    const data = pullData({
      prRecord: record({ packages: [pkg({ mode: 'changed', files: [file({ path: 'a.test.ts', status: 'passed' })] })] }),
      mainRecord: record({ event: 'push', packages: [pkg({ mode: 'full', files: [file({ path: 'a.test.ts', status: 'failed' })] })] }),
    });
    expect(pullModel(data).misses).toEqual([]);
  });

  it('failed on main, its package ran in full on the pull request: not a miss', () => {
    const data = pullData({
      prRecord: record({ packages: [pkg({ mode: 'full', reason: { rule: 'any tsconfig', path: 'tsconfig.json' }, files: [file({ path: 'a.test.ts', status: 'passed' })] })] }),
      mainRecord: record({ event: 'push', packages: [pkg({ mode: 'full', files: [file({ path: 'a.test.ts', status: 'failed' })] })] }),
    });
    expect(pullModel(data).misses).toEqual([]);
  });

  it('failed on main, the pull request was documentation only and skipped tests: a miss, reason docs only', () => {
    const data = pullData({
      files: ['docs/notes.md'],
      mainRecord: record({ event: 'push', packages: [pkg({ mode: 'full', files: [file({ path: 'a.test.ts', status: 'failed' })] })] }),
    });
    const model = pullModel(data);
    expect(model.status).toBe('docs-only');
    expect(model.misses).toEqual([{ path: 'a.test.ts', level: 'unit', reason: 'docs only' }]);
  });

  it('failed on a first attempt on main, passed on the re-run: not a miss, because the record already reflects the last attempt', () => {
    // github.js hands the model whichever artifact is newest, so a re-run that
    // passed arrives here as a plain "passed" — there is nothing left for the
    // model itself to decide between attempts.
    const data = pullData({
      prRecord: record({ packages: [pkg({ mode: 'changed', files: [file({ path: 'a.test.ts', status: 'not run' })] })] }),
      mainRecord: record({ event: 'push', packages: [pkg({ mode: 'full', files: [file({ path: 'a.test.ts', status: 'passed' })] })] }),
    });
    expect(pullModel(data).misses).toEqual([]);
  });

  it("the pull request's record is missing or expired: no record, counted neither way", () => {
    const data = pullData({
      files: ['apps/api/src/thing.ts'],
      mainRecord: record({ event: 'push', packages: [pkg({ mode: 'full', files: [file({ path: 'a.test.ts', status: 'failed' })] })] }),
    });
    const model = pullModel(data);
    expect(model.status).toBe('no-record');
    expect(model.misses).toEqual([]);
  });

  it('a package whose process crashed before writing a report explains nothing either way', () => {
    const data = pullData({
      prRecord: record({ packages: [pkg({ dir: 'apps/pkg', mode: 'changed', report: 'none', files: [] })] }),
      mainRecord: record({ event: 'push', packages: [pkg({ mode: 'full', files: [file({ path: 'apps/pkg/tests/unit/a.test.ts', status: 'failed' })] })] }),
    });
    expect(pullModel(data).misses).toEqual([]);
  });
});

describe('pullModel: status', () => {
  it('is "ran" whenever the pull request carries its own record', () => {
    const data = pullData({ prRecord: record({ packages: [] }) });
    expect(pullModel(data).status).toBe('ran');
  });

  it('is "docs-only" with no record and a documentation-only diff', () => {
    expect(pullModel(pullData({ files: ['docs/a.md', 'CLAUDE.md'] })).status).toBe('docs-only');
  });

  it('is "no-record" with no record and a diff that touches product code', () => {
    expect(pullModel(pullData({ files: ['apps/web/src/x.ts'] })).status).toBe('no-record');
  });

  it('is "no-record" with no record and an empty diff, the same fallback ci.yml\'s own classifier takes', () => {
    expect(pullModel(pullData({ files: [] })).status).toBe('no-record');
  });
});

describe('pullModel: packages, files run and what forced a full run', () => {
  it('counts every file whose status is not "not run"', () => {
    const data = pullData({
      prRecord: record({
        packages: [
          pkg({ mode: 'changed', files: [file({ path: 'a.test.ts', status: 'passed' }), file({ path: 'b.test.ts', status: 'not run' })] }),
          pkg({ name: '@cockpit/other', mode: 'full', files: [file({ path: 'c.test.ts', status: 'failed' })] }),
        ],
      }),
    });
    expect(pullModel(data).filesRun).toBe(2);
  });

  it('collects one distinct reason per package, deduplicated by rule and path', () => {
    const reason = { rule: 'outside every package', path: 'pnpm-lock.yaml' };
    const data = pullData({ prRecord: record({ packages: [pkg({ mode: 'full', reason, files: [] }), pkg({ name: '@cockpit/other', mode: 'full', reason, files: [] })] }) });
    expect(pullModel(data).forcedFull).toEqual([reason]);
  });

  it('a pull request forced full on every package is not "selecting"', () => {
    const data = pullData({ prRecord: record({ packages: [pkg({ mode: 'full', reason: { rule: 'push to main', path: null }, files: [] })] }) });
    const model = pullModel(data);
    expect(model.ranEverything).toBe(true);
    expect(model.selecting).toBe(false);
  });

  it('a pull request with at least one changed-mode package is "selecting"', () => {
    const data = pullData({ prRecord: record({ packages: [pkg({ mode: 'changed', files: [] }), pkg({ name: '@cockpit/other', mode: 'full', reason: { rule: 'any tsconfig', path: 'x' }, files: [] })] }) });
    const model = pullModel(data);
    expect(model.ranEverything).toBe(false);
    expect(model.selecting).toBe(true);
  });
});

describe('buildModel: Rule 2, what forced a full run counts pull requests per rule and path', () => {
  it('two pull requests each forced full by the same rule and path: one row, counting two', () => {
    const reason = { rule: 'outside every package', path: 'pnpm-lock.yaml' };
    const pulls = [pullData({ prRecord: record({ packages: [pkg({ mode: 'full', reason, files: [] })] }) }), pullData({ prRecord: record({ packages: [pkg({ mode: 'full', reason, files: [] })] }) })];
    const model = buildModel({ pulls, now: new Date('2026-02-01'), requestedDays: 30, coveredSince: new Date('2026-01-01') });
    expect(model.forcedFull).toEqual([{ rule: reason.rule, path: reason.path, count: 2, pulls: expect.any(Array) }]);
  });

  it('one pull request forced full by two distinct reasons: a row for each', () => {
    const pulls = [
      pullData({
        prRecord: record({
          packages: [
            pkg({ mode: 'full', reason: { rule: 'outside every package', path: 'pnpm-lock.yaml' }, files: [] }),
            pkg({ name: '@cockpit/other', mode: 'full', reason: { rule: 'any tsconfig', path: 'apps/api/tsconfig.json' }, files: [] }),
          ],
        }),
      }),
    ];
    const model = buildModel({ pulls, now: new Date('2026-02-01'), requestedDays: 30, coveredSince: new Date('2026-01-01') });
    expect(model.forcedFull).toHaveLength(2);
    expect(model.forcedFull.every((row) => row.count === 1)).toBe(true);
  });
});

describe('buildModel: Rule 3, tests selected most often counts only pull requests that selected', () => {
  it('a test run on 5 of 8 selecting pull requests and in 3 full runs reads 5 of 8, apart from the full runs', () => {
    const selecting = (status, chain) => pkg({ mode: 'changed', files: [file({ path: 'shared.test.ts', status, selectedBy: chain })] });
    const full = () => pkg({ mode: 'full', files: [file({ path: 'shared.test.ts', status: 'passed' })] });

    const pulls = [
      ...Array.from({ length: 3 }, () => pullData({ prRecord: record({ packages: [selecting('passed', { kind: 'chain', chain: ['shared.test.ts', 'x.ts'] })] }) })),
      ...Array.from({ length: 2 }, () => pullData({ prRecord: record({ packages: [selecting('passed', { kind: 'chain', chain: ['shared.test.ts', 'y.ts'] })] }) })),
      ...Array.from({ length: 3 }, () => pullData({ prRecord: record({ packages: [selecting('not run')] }) })),
      ...Array.from({ length: 3 }, () => pullData({ prRecord: record({ packages: [full()] }) })),
    ];

    const model = buildModel({ pulls, now: new Date('2026-02-01'), requestedDays: 30, coveredSince: new Date('2026-01-01') });
    const row = model.mostSelected.find((each) => each.path === 'shared.test.ts');
    expect(row).toMatchObject({ selectedPulls: 5, selectingPulls: 8, fullRunPulls: 3 });
    // Reached by chain X (x.ts) on 3 and chain Y (y.ts) on 2: chain X.
    expect(row.mostCommonChain).toBe(chainText({ kind: 'chain', chain: ['shared.test.ts', 'x.ts'] }));
  });
});

describe('buildModel: Rule 4, the summary is per window and says "none" rather than inventing a number', () => {
  const now = new Date('2026-02-15T00:00:00Z');

  it('a window with no pull requests: every value is none', () => {
    const model = buildModel({ pulls: [], now, requestedDays: 7, coveredSince: new Date('2026-02-08') });
    const window = model.windows[0];
    expect(window.pulls).toBe(0);
    expect(window.misses).toBeNull();
    expect(window.forcedFull).toBeNull();
    expect(window.typicalFiles).toBeNull();
    expect(window.duration).toEqual({ pr: null, main: null });
    expect(window.docsOnly).toBeNull();
  });

  it('a window where every pull request ran in full: typical count none, forced-full count is all of them', () => {
    const pulls = Array.from({ length: 3 }, () => pullData({ mergedAt: now.toISOString(), prRecord: record({ packages: [pkg({ mode: 'full', reason: { rule: 'push to main', path: null }, files: [] })] }) }));
    const model = buildModel({ pulls, now, requestedDays: 7, coveredSince: new Date('2026-02-08'), windows: [7] });
    const window = model.windows[0];
    expect(window.typicalFiles).toBeNull();
    expect(window.forcedFull).toEqual({ count: 3, of: 3 });
  });

  it('a window with pull requests that never ran a Test job at all: forced-full is none, not zero of zero', () => {
    const pulls = [pullData({ mergedAt: now.toISOString(), files: ['docs/a.md'] })];
    const model = buildModel({ pulls, now, requestedDays: 7, coveredSince: new Date('2026-02-08'), windows: [7] });
    expect(model.windows[0].forcedFull).toBeNull();
  });

  it('an even number of selecting pull requests: the typical count is the median of the middle two', () => {
    const filesRun = [2, 4, 6, 8];
    const pulls = filesRun.map((count) =>
      pullData({
        mergedAt: now.toISOString(),
        prRecord: record({ packages: [pkg({ mode: 'changed', files: Array.from({ length: count }, (_, index) => file({ path: `t${index}.test.ts`, status: 'passed' })) })] }),
      }),
    );
    const model = buildModel({ pulls, now, requestedDays: 7, coveredSince: new Date('2026-02-08'), windows: [7] });
    expect(model.windows[0].typicalFiles).toBe(5);
  });
});

describe('median', () => {
  it('is null for no values', () => {
    expect(median([])).toBeNull();
  });

  it('is the middle value for an odd count', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('is the average of the middle two for an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('chainText', () => {
  it('names an unexplained selection honestly', () => {
    expect(chainText(null)).toBe('selected by Vitest; no import chain found');
  });

  it('says "itself changed" for a test file that is itself one of the changed paths', () => {
    expect(chainText({ kind: 'itself' })).toBe('itself changed');
  });

  it('joins a chain in order', () => {
    expect(chainText({ kind: 'chain', chain: ['a.test.ts', 'b.ts', 'c.ts'] })).toBe('a.test.ts → b.ts → c.ts');
  });

  it('names the concept that owns an E2E spec and the changed file that concept owns', () => {
    expect(chainText(owned('Capture', 'apps/web/src/capture/Box.tsx'))).toBe('owned by Capture, which `apps/web/src/capture/Box.tsx` changed');
  });
});

describe('pullModel: Rule 2, the report treats E2E specs as it treats Vitest test files', () => {
  const failedOnMain = tier({ mode: 'full', reason: { rule: 'push to main', path: null }, files: [spec({ path: 'tests/e2e/capture.test.ts', status: 'failed' })] });

  it('a spec that failed on main after the pull request skipped it: a miss, marked E2E', () => {
    const data = pullWithE2e({ e2e: tier({ files: [spec({ path: 'tests/e2e/capture.test.ts', status: 'not run' })] }), mainE2e: failedOnMain });
    expect(pullModel(data).misses).toEqual([{ path: 'tests/e2e/capture.test.ts', level: 'e2e', reason: null }]);
  });

  it('a spec that failed on main and ran on the pull request: not a miss', () => {
    const data = pullWithE2e({ e2e: tier({ files: [spec({ path: 'tests/e2e/capture.test.ts', selectedBy: owned('Capture', 'a.ts') })] }), mainE2e: failedOnMain });
    expect(pullModel(data).misses).toEqual([]);
  });

  it('a spec that failed on main where the pull request ran every spec: not a miss', () => {
    const forced = tier({ mode: 'full', reason: { rule: 'owned by no concept', path: 'x.ts' }, files: [spec({ path: 'tests/e2e/capture.test.ts' })] });
    expect(pullModel(pullWithE2e({ e2e: forced, mainE2e: failedOnMain })).misses).toEqual([]);
  });

  it('a documentation-only pull request skipped every spec, so main’s failed spec is a miss for it', () => {
    const data = pullData({ files: ['docs/notes.md'] });
    data.mainRun = { id: 9, testDurationMs: null, record: null, e2eRecord: record({ event: 'push', packages: [failedOnMain] }) };
    const model = pullModel(data);
    expect(model.e2e.status).toBe('docs-only');
    expect(model.misses).toEqual([{ path: 'tests/e2e/capture.test.ts', level: 'e2e', reason: 'docs only' }]);
  });

  it('a pull request from before E2E recorded anything: no record, and no misses from it', () => {
    const model = pullModel(pullWithE2e({ mainE2e: failedOnMain }));
    expect(model.e2e.status).toBe('no-record');
    expect(model.misses).toEqual([]);
  });

  it('counts the specs a pull request ran out of those it recorded', () => {
    const data = pullWithE2e({
      e2e: tier({ files: [spec({ path: 'tests/e2e/a.test.ts', selectedBy: owned('A', 'a.ts') }), spec({ path: 'tests/e2e/b.test.ts', status: 'not run' }), spec({ path: 'tests/e2e/c.test.ts', status: 'not run' })] }),
    });
    expect(pullModel(data).e2e).toMatchObject({ status: 'ran', filesRun: 1, filesTotal: 3, selecting: true, ranEverything: false });
  });

  it('lists the miss beside the Vitest ones in the report, naming its pull request', () => {
    const data = pullWithE2e({ e2e: tier({ files: [spec({ path: 'tests/e2e/capture.test.ts', status: 'not run' })] }), mainE2e: failedOnMain });
    expect(build([data]).misses).toMatchObject([{ path: 'tests/e2e/capture.test.ts', level: 'e2e', pull: { number: data.pull.number } }]);
  });
});

describe('buildModel: the E2E forced-full rows count pull requests per E2E rule and path', () => {
  const unowned = () => tier({ mode: 'full', reason: { rule: 'owned by no concept', path: 'apps/web/src/api/client.ts' }, files: [] });

  it('four pull requests forced full by an unowned file: one E2E row, 4', () => {
    const model = build(Array.from({ length: 4 }, () => pullWithE2e({ e2e: unowned() })));
    expect(model.e2eForcedFull).toEqual([{ rule: 'owned by no concept', path: 'apps/web/src/api/client.ts', count: 4, pulls: expect.any(Array) }]);
  });

  it('keeps the E2E rows apart from the Test job’s, since one rule can force both', () => {
    const reason = { rule: 'push to main', path: null };
    const data = pullWithE2e({ e2e: tier({ mode: 'full', reason, files: [] }) });
    data.prRun.record = record({ packages: [pkg({ mode: 'full', reason, files: [] })] });
    const model = build([data]);
    expect(model.forcedFull).toHaveLength(1);
    expect(model.e2eForcedFull).toHaveLength(1);
  });

  it('leaves a pull request with no E2E record out of the rows and out of the window’s figures', () => {
    const now = new Date('2026-02-15T00:00:00Z');
    const model = buildModel({ pulls: [pullData({ mergedAt: now.toISOString(), prRecord: record({ packages: [] }) })], now, requestedDays: 7, coveredSince: new Date('2026-02-08'), windows: [7] });
    expect(model.e2eForcedFull).toEqual([]);
    expect(model.windows[0].e2e).toEqual({ forcedFull: null, typicalSpecs: null });
  });
});

describe('buildModel: the summary carries E2E beside Vitest', () => {
  const now = new Date('2026-02-15T00:00:00Z');

  it('reads forced-full and the typical spec count over the pull requests that recorded E2E', () => {
    const selecting = (count) => pullWithE2e({ mergedAt: now.toISOString(), e2e: tier({ files: Array.from({ length: count }, (_, index) => spec({ path: `tests/e2e/${index}.test.ts`, selectedBy: owned('A', 'a.ts') })) }) });
    const forced = () => pullWithE2e({ mergedAt: now.toISOString(), e2e: tier({ mode: 'full', reason: { rule: 'push to main', path: null }, files: [] }) });
    const model = buildModel({ pulls: [selecting(2), selecting(4), forced()], now, requestedDays: 7, coveredSince: new Date('2026-02-08'), windows: [7] });
    expect(model.windows[0].e2e).toEqual({ forcedFull: { count: 1, of: 3 }, typicalSpecs: 3 });
  });
});
