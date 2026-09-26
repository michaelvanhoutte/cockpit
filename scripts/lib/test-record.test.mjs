//
// Unit tests for the Test job's record (scripts/lib/test-record.mjs) - the rows
// of "Record what CI's Test job selected, and why, on every run" (issue 539).
// What Vitest's own import graph holds, and that recording never changes the
// job's outcome, are checked by hand on that pull request's CI run.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planTestRun } from './test-selection.mjs';
import { buildRecord, renderSummary, selectionChain, testLevel } from './test-record.mjs';

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
