//
// Unit tests for the E2E selection record, run by `node --test` from the Scripts
// step. Each case is a row of the statement list from "Show E2E in the test
// selection report" (issue 541).
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildE2eRecord, failedSpecFiles, ownersText, renderE2eSummary } from './e2e-record.mjs';

const WALKS = [
  { area: 'Capture', where: 'capture.test.ts' },
  { area: 'Triage', where: 'triage.test.ts' },
  { area: 'Sign-in', where: 'sign-in.test.ts' },
  { area: 'Capture', where: 'shared.test.ts' },
  { area: 'Sign-in', where: 'shared.test.ts' },
];

const selected = (changedBy) => ({ mode: 'selected', areas: Object.keys(changedBy).sort(), grep: 'x', changedBy });
const full = (rule, path = null) => ({ mode: 'full', reason: rule, forced: { rule, path } });

function record(plan, { changedFiles = [], report = { suites: [] }, walks = WALKS } = {}) {
  return buildE2eRecord({ event: 'pull_request', baseCommit: 'a1b2c3d', changedFiles, plan, walks, report });
}

const tier = (built) => built.packages[0];
const fileNamed = (built, name) => tier(built).files.find((file) => file.path === `tests/e2e/${name}`);

describe('the E2E record', () => {
  describe('a pull request that changes a file only one area owns', () => {
    const built = record(selected({ Capture: 'apps/web/src/capture/Box.tsx' }), { changedFiles: ['apps/web/src/capture/Box.tsx'] });

    it('runs that area’s specs, each naming the area and the changed file', () => {
      assert.deepEqual(fileNamed(built, 'capture.test.ts'), {
        path: 'tests/e2e/capture.test.ts',
        level: 'e2e',
        status: 'passed',
        selectedBy: { kind: 'concept', owners: [{ concept: 'Capture', path: 'apps/web/src/capture/Box.tsx' }] },
      });
    });

    it('records every other spec as not run', () => {
      assert.equal(fileNamed(built, 'triage.test.ts').status, 'not run');
      assert.equal(fileNamed(built, 'sign-in.test.ts').status, 'not run');
      assert.equal(fileNamed(built, 'triage.test.ts').selectedBy, undefined);
    });

    it('is a selecting tier with no forcing reason', () => {
      assert.equal(tier(built).mode, 'changed');
      assert.equal(tier(built).reason, null);
    });
  });

  it('names both areas on a spec whose walks sit under two selected areas', () => {
    const built = record(selected({ Capture: 'a.ts', 'Sign-in': 'b.ts' }));
    assert.deepEqual(fileNamed(built, 'shared.test.ts').selectedBy.owners, [
      { concept: 'Capture', path: 'a.ts' },
      { concept: 'Sign-in', path: 'b.ts' },
    ]);
  });

  it('runs both areas’ specs where a file is owned by two areas', () => {
    const built = record(selected({ Capture: 'apps/api/src/domain/items.ts', Triage: 'apps/api/src/domain/items.ts' }));
    assert.equal(fileNamed(built, 'capture.test.ts').status, 'passed');
    assert.equal(fileNamed(built, 'triage.test.ts').status, 'passed');
    assert.equal(fileNamed(built, 'sign-in.test.ts').status, 'not run');
  });

  describe('a run that had to run every spec', () => {
    it('carries the rule and the path for a file no area owns', () => {
      const built = record(full('owned by no concept', 'apps/web/src/api/client.ts'));
      assert.equal(tier(built).mode, 'full');
      assert.deepEqual(tier(built).reason, { rule: 'owned by no concept', path: 'apps/web/src/api/client.ts' });
      assert.ok(tier(built).files.every((file) => file.status === 'passed' && file.selectedBy === undefined));
    });

    it('carries "push to main" with no path for a push', () => {
      assert.deepEqual(tier(record(full('push to main'))).reason, { rule: 'push to main', path: null });
    });
  });

  it('lists every spec file once, however many walks it holds', () => {
    assert.deepEqual(
      tier(record(full('push to main'))).files.map((file) => file.path),
      ['tests/e2e/capture.test.ts', 'tests/e2e/shared.test.ts', 'tests/e2e/sign-in.test.ts', 'tests/e2e/triage.test.ts'],
    );
  });

  describe('results', () => {
    const report = { suites: [{ file: 'triage.test.ts', specs: [{ ok: true }], suites: [{ title: 'Triage', specs: [{ ok: false }] }] }, { file: 'capture.test.ts', specs: [{ ok: true }] }] };

    it('marks a spec file failed where any of its walks failed, at any depth', () => {
      const built = record(full('push to main'), { report });
      assert.equal(fileNamed(built, 'triage.test.ts').status, 'failed');
      assert.equal(fileNamed(built, 'capture.test.ts').status, 'passed');
    });

    it('reads the failing files off a Playwright JSON report', () => {
      assert.deepEqual([...failedSpecFiles(report)], ['triage.test.ts']);
      assert.deepEqual([...failedSpecFiles(null)], []);
    });
  });

  describe('a run with nothing to record from', () => {
    it('says there is no report where walks started and Playwright left none', () => {
      const built = record(full('push to main'), { report: null });
      assert.equal(tier(built).report, 'none');
      assert.deepEqual(tier(built).files, []);
    });

    it('still lists every spec as not run where the areas own no walk, so nothing started', () => {
      const built = record({ mode: 'selected', areas: [], grep: null, changedBy: {} }, { report: null });
      assert.equal(tier(built).report, 'written');
      assert.ok(tier(built).files.every((file) => file.status === 'not run'));
    });
  });

  it('marks a documentation path in the diff as ignored', () => {
    const built = record(full('push to main'), { changedFiles: ['docs/a.md', 'apps/web/src/x.ts'] });
    assert.deepEqual(built.changedFiles, [
      { path: 'docs/a.md', ignored: true },
      { path: 'apps/web/src/x.ts', ignored: false },
    ]);
  });
});

describe('the E2E summary', () => {
  it('says which changed file made each spec run, and not run for the rest', () => {
    const text = renderE2eSummary(record(selected({ Capture: 'apps/web/src/capture/Box.tsx' })));
    assert.match(text, /\| `tests\/e2e\/capture.test.ts` \| passed \| owned by Capture, which `apps\/web\/src\/capture\/Box.tsx` changed \|/);
    assert.match(text, /\| `tests\/e2e\/triage.test.ts` \| not run \| {2}\|/);
  });

  it('gives the rule and path where every spec ran', () => {
    assert.match(renderE2eSummary(record(full('owned by no concept', 'apps/x.ts'))), /full \| owned by no concept \(`apps\/x.ts`\)/);
  });

  it('says so where the run left no report', () => {
    assert.match(renderE2eSummary(record(full('push to main'), { report: null })), /no report/);
  });

  it('joins several owners', () => {
    assert.equal(ownersText({ owners: [{ concept: 'A', path: 'a' }, { concept: 'B', path: null }] }), 'owned by A, which `a` changed; owned by B');
  });
});
