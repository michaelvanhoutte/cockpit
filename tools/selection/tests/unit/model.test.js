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
});
