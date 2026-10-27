//
// Unit tests for the Test job's record (scripts/lib/test-record.mjs) - the rows
// of "Record what CI's Test job selected, and why, on every run" (issue 539).
// What Vitest's own import graph holds, and that recording never changes the
// job's outcome, are checked by hand on that pull request's CI run.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FAILED_TESTS_CAP } from './failed-tests.mjs';
import { planTestRun } from './test-selection.mjs';
import { buildRecord, renderSlowTests, renderSummary, selectionChain, slowTests, slowTestsWarning, testLevel } from './test-record.mjs';

const PACKAGES = [
  { name: '@cockpit/shared', dir: 'packages/shared' },
  { name: '@cockpit/api', dir: 'apps/api' },
];

const pr = (changedFiles) => planTestRun({ event: 'pull_request', mergeBase: 'abc1234', changedFiles, packages: PACKAGES });
const recordOf = (plan, reports, changedFiles = []) => buildRecord({ event: 'pull_request', baseCommit: 'abc1234', changedFiles, plan, reports });
const entry = (record, name) => record.packages.find((pkg) => pkg.name === name);

describe('buildRecord', () => {
  it('lists a documentation file as ignored, and forcing nothing', () => {
    const changedFiles = ['docs/x.md', 'apps/api/src/a.ts'];
    const record = recordOf(pr(changedFiles), {}, changedFiles);
    assert.deepEqual(record.changedFiles, [{ path: 'docs/x.md', ignored: true }, { path: 'apps/api/src/a.ts', ignored: false }]);
    assert.equal(entry(record, '@cockpit/api').mode, 'changed');
  });

  it('carries each package’s mode and reason from the plan', () => {
    const record = recordOf(pr(['pnpm-lock.yaml']), {}, ['pnpm-lock.yaml']);
    assert.deepEqual(entry(record, '@cockpit/api').reason, { rule: 'outside every package', path: 'pnpm-lock.yaml' });
    assert.equal(entry(record, '@cockpit/api').mode, 'full');
  });

  it('marks the files Vitest ran and the ones it did not, in a changed package', () => {
    const reports = { '@cockpit/api': { all: ['apps/api/tests/unit/a.test.ts', 'apps/api/tests/unit/b.test.ts', 'apps/api/tests/unit/c.test.ts'], ran: [{ file: 'apps/api/tests/unit/a.test.ts', state: 'passed' }, { file: 'apps/api/tests/unit/b.test.ts', state: 'failed' }], edges: {} } };
    const files = entry(recordOf(pr(['apps/api/tests/unit/a.test.ts']), reports), '@cockpit/api').files;
    assert.deepEqual(files.map((file) => file.status), ['passed', 'failed', 'not run']);
  });

  it('marks every file not run where nothing was selected', () => {
    const reports = { '@cockpit/api': { all: ['apps/api/tests/unit/a.test.ts'], ran: [], edges: {} } };
    assert.deepEqual(entry(recordOf(pr(['apps/api/src/x.ts']), reports), '@cockpit/api').files.map((file) => file.status), ['not run']);
  });

  it('marks every file run in a full package, with no chain', () => {
    const plan = planTestRun({ event: 'push', mergeBase: null, changedFiles: [], packages: PACKAGES });
    const reports = { '@cockpit/api': { all: ['apps/api/tests/unit/a.test.ts'], ran: [{ file: 'apps/api/tests/unit/a.test.ts', state: 'passed' }], edges: {} } };
    const [file] = entry(recordOf(plan, reports), '@cockpit/api').files;
    assert.equal(file.status, 'passed');
    assert.equal('selectedBy' in file, false);
  });

  it('marks a package with no report, and lists none of its files', () => {
    const api = entry(recordOf(pr(['apps/api/src/x.ts']), {}), '@cockpit/api');
    assert.equal(api.report, 'none');
    assert.deepEqual(api.files, []);
  });

  it('names the level of each test file from where it lives', () => {
    assert.equal(testLevel('apps/api/tests/integration/http/a.test.ts'), 'integration');
    assert.equal(testLevel('packages/connectors/teams/tests/contract/a.test.ts'), 'contract');
    assert.equal(testLevel('apps/api/tests/unit/a.test.ts'), 'unit');
    assert.equal(testLevel('tools/x/a.test.ts'), 'other');
  });

  it('names why each file run in a changed package was selected', () => {
    const test = 'apps/api/tests/unit/a.test.ts';
    const reports = { '@cockpit/api': { all: [test], ran: [{ file: test, state: 'passed' }], edges: { [test]: ['apps/api/src/x.ts'] } } };
    const [file] = entry(recordOf(pr(['apps/api/src/x.ts']), reports, ['apps/api/src/x.ts']), '@cockpit/api').files;
    assert.deepEqual(file.selectedBy, { kind: 'chain', chain: [test, 'apps/api/src/x.ts'] });
  });
});

describe('the failed tests in a record', () => {
  const failedTest = (file, name) => ({ file, name, error: 'expected 1 to be 2' });
  const written = (failedTests, failedTestsMore = 0) => ({ all: [], ran: [], edges: {}, failedTests, failedTestsMore });
  const plan = () => pr(['apps/api/src/x.ts']);

  it('names the failed tests of every package, in the order the plan lists them', () => {
    const reports = {
      '@cockpit/api': written([failedTest('apps/api/tests/unit/a.test.ts', 'Triage > a')]),
      '@cockpit/shared': written([failedTest('packages/shared/tests/unit/b.test.ts', 'Menus > b')]),
    };
    assert.deepEqual(recordOf(plan(), reports).failedTests.map((test) => test.name), ['Menus > b', 'Triage > a']);
  });

  it('names no failed test where every test passed, or no package wrote a report', () => {
    assert.deepEqual([recordOf(plan(), { '@cockpit/api': written([]) }), recordOf(plan(), {})].map((record) => [record.failedTests, record.failedTestsMore]), [[[], 0], [[], 0]]);
  });

  it('caps the whole record, not each package, and counts the rest', () => {
    const many = (count) => Array.from({ length: count }, (_, index) => failedTest('a.test.ts', `t${index}`));
    const reports = { '@cockpit/api': written(many(40), 5), '@cockpit/shared': written(many(40)) };
    const record = recordOf(plan(), reports);
    assert.equal(record.failedTests.length, FAILED_TESTS_CAP);
    assert.equal(record.failedTestsMore, 5 + 80 - FAILED_TESTS_CAP);
  });

  it('leaves the files each package marks failed as they were', () => {
    const file = 'apps/api/tests/unit/a.test.ts';
    const reports = { '@cockpit/api': { all: [file], ran: [{ file, state: 'failed' }], edges: {}, failedTests: [failedTest(file, 'a')], failedTestsMore: 0 } };
    assert.deepEqual(entry(recordOf(plan(), reports), '@cockpit/api').files, [{ path: file, level: 'unit', status: 'failed', selectedBy: null }]);
  });
});

describe('selectionChain', () => {
  const test = 't.test.ts';

  it('says the test itself changed', () => {
    assert.deepEqual(selectionChain({ edges: {}, changed: [test], testFile: test }), { kind: 'itself' });
  });

  it('gives the chain when the test imports the changed file', () => {
    assert.deepEqual(selectionChain({ edges: { [test]: ['a.ts'] }, changed: ['a.ts'], testFile: test }), { kind: 'chain', chain: [test, 'a.ts'] });
  });

  it('gives the whole chain, in order, through other modules', () => {
    const edges = { [test]: ['a.ts'], 'a.ts': ['b.ts'], 'b.ts': ['c.ts'] };
    assert.deepEqual(selectionChain({ edges, changed: ['c.ts'], testFile: test }).chain, [test, 'a.ts', 'b.ts', 'c.ts']);
  });

  it('gives the shortest chain when two changed files are reachable', () => {
    const edges = { [test]: ['a.ts', 'far.ts'], 'a.ts': ['b.ts'], 'b.ts': ['deep.ts'], 'far.ts': ['near.ts'] };
    assert.deepEqual(selectionChain({ edges, changed: ['deep.ts', 'near.ts'], testFile: test }).chain, [test, 'far.ts', 'near.ts']);
  });

  it('survives an import cycle', () => {
    const edges = { [test]: ['a.ts'], 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] };
    assert.equal(selectionChain({ edges, changed: ['c.ts'], testFile: test }), null);
  });
});

describe('renderSummary', () => {
  it('renders a record without throwing, marking ignored files and a missing report', () => {
    const changedFiles = ['docs/x.md', 'apps/api/src/x.ts'];
    const text = renderSummary(recordOf(pr(changedFiles), {}, changedFiles));
    assert.match(text, /`docs\/x\.md` \(ignored\)/);
    assert.match(text, /no report/);
  });
});

describe('slowTests', () => {
  const timed = (duration, timeout = 5000) => ({ '@cockpit/api': { timings: [{ file: 'a.test.ts', name: 'does it', duration, timeout }] } });
  const slowOf = (reports) => slowTests(['@cockpit/api'], reports);

  it('lists a test at 2.6 s of the 5 s default with package, file, name, duration and timeout', () => {
    assert.deepEqual(slowOf(timed(2600)).slow, [{ pkg: '@cockpit/api', file: 'a.test.ts', name: 'does it', duration: 2600, timeout: 5000 }]);
  });

  it('does not list a test at 2.4 s of the 5 s default', () => {
    assert.deepEqual(slowOf(timed(2400)).slow, []);
  });

  it('lists a test with its own 20 s timeout at 11 s, against 20 s', () => {
    assert.equal(slowOf(timed(11000, 20000)).slow[0].timeout, 20000);
  });

  it('does not list a test with its own 20 s timeout at 6 s, never judged against the default', () => {
    assert.deepEqual(slowOf(timed(6000, 20000)).slow, []);
  });

  it('says none took more than half its timeout, with none slow', () => {
    assert.match(renderSlowTests(slowOf(timed(100))), /No test took more than half its timeout/);
    assert.equal(slowTestsWarning(slowOf(timed(100))), null);
  });

  it('lists all twelve slow tests, with one warning giving the count', () => {
    const timings = Array.from({ length: 12 }, (_, i) => ({ file: 'a.test.ts', name: `t${i}`, duration: 4000, timeout: 5000 }));
    const result = slowOf({ '@cockpit/api': { timings } });
    assert.equal(renderSlowTests(result).split('\n').filter((line) => line.startsWith('| @cockpit/api')).length, 12);
    assert.match(slowTestsWarning(result), /^::warning::12 tests /);
  });

  it('keeps a slow test whose name holds a pipe in its own table row', () => {
    const result = slowOf({ '@cockpit/api': { timings: [{ file: 'a.test.ts', name: 'parses a|b', duration: 4000, timeout: 5000 }] } });
    assert.match(renderSlowTests(result), /\| parses a\\\|b \|/);
  });

  it('names a package whose report is missing rather than reporting none slow', () => {
    const result = slowOf({});
    assert.deepEqual(result.unread, ['@cockpit/api']);
    assert.match(renderSlowTests(result), /Could not read the report of @cockpit\/api/);
  });
});
