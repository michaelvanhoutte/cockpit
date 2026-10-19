//
// Unit tests for the E2E selection record, run by `node --test` from the Scripts
// step. Each case is a row of the statement list from "Show E2E in the test
// selection report" (issue 541).
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { E2E_SHARDS, buildE2eRecord, e2eVerdict, failedSpecFiles, mergeE2eRecords, ownersText, parseShard, readsText, renderE2eSummary, shardReads, shardResults, unsettledShards } from './e2e-record.mjs';

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

describe('a shard of the E2E run', () => {
  /** What shard `index` of four wrote after Playwright dealt it walks in `files`, those in `failing` having failed. */
  function shardRecord(index, files, { failing = [], plan = full('push to main'), changedFiles = [], report } = {}) {
    const written = report === undefined ? { stats: { expected: files.length - failing.length, unexpected: failing.length, flaky: 0 }, suites: files.map((file) => ({ file, specs: [{ ok: !failing.includes(file) }] })) } : report;
    return buildE2eRecord({ event: 'pull_request', baseCommit: 'a1b2c3d', changedFiles, plan, walks: WALKS, report: written, shard: { index, total: 4 } });
  }

  const statusOf = (built, name) => fileNamed(built, name).status;

  describe('names the shard from E2E_SHARD', () => {
    for (const [value, expected] of [
      ['2/4', { index: 2, total: 4 }],
      ['1/1', { index: 1, total: 1 }],
      [undefined, null],
      ['', null],
    ]) {
      it(`reads ${JSON.stringify(value)} as ${JSON.stringify(expected)}`, () => assert.deepEqual(parseShard(value), expected));
    }

    for (const value of ['5/4', '0/4', 'two/four', '2', '2/4/1']) {
      it(`refuses ${JSON.stringify(value)} rather than run every walk on every shard`, () => assert.throws(() => parseShard(value), /E2E_SHARD/));
    }
  });

  describe('records only the specs it was dealt a walk in', () => {
    const built = shardRecord(1, ['capture.test.ts', 'shared.test.ts'], { failing: ['shared.test.ts'] });

    it('marks the specs it ran passed or failed, and every other spec as not run', () => {
      assert.equal(statusOf(built, 'capture.test.ts'), 'passed');
      assert.equal(statusOf(built, 'shared.test.ts'), 'failed');
      assert.equal(statusOf(built, 'triage.test.ts'), 'not run');
      assert.equal(statusOf(built, 'sign-in.test.ts'), 'not run');
    });

    it('says which shard it is and how many walks it was dealt', () => {
      assert.deepEqual(built.shard, { index: 1, total: 4, walks: 2 });
    });

    it('counts the walks a phone skips itself among those it was dealt, so the shards add up to the suite', () => {
      const report = { stats: { expected: 40, unexpected: 1, flaky: 0, skipped: 27 }, suites: [{ file: 'capture.test.ts', specs: [{ ok: true }] }] };
      assert.equal(shardRecord(3, ['capture.test.ts'], { report }).shard.walks, 68);
    });

    it('marks a spec not run when the shard was dealt a walk in it but the selection did not reach it', () => {
      const selection = selected({ Capture: 'apps/web/src/capture/Box.tsx' });
      const narrowed = shardRecord(2, ['triage.test.ts'], { plan: selection });
      assert.equal(statusOf(narrowed, 'triage.test.ts'), 'not run');
    });

    it('lists every spec as not run, with a report written, where it was dealt no walk at all', () => {
      const empty = shardRecord(3, []);
      assert.equal(tier(empty).report, 'written');
      assert.ok(tier(empty).files.every((file) => file.status === 'not run'));
      assert.equal(empty.shard.walks, 0);
    });

    it('was dealt no walks where the selection starts none, with no report to count them from', () => {
      const idle = shardRecord(2, [], { plan: selected({}), report: null });
      assert.equal(idle.shard.walks, 0);
      assert.equal(tier(idle).report, 'written');
    });

    it('says it left no report where Playwright died before writing one', () => {
      const none = shardRecord(4, [], { report: null });
      assert.equal(tier(none).report, 'none');
      assert.equal(none.shard.walks, null);
    });
  });

  describe('four records become one under the name the reports read', () => {
    const records = [
      shardRecord(1, ['capture.test.ts', 'shared.test.ts'], { changedFiles: ['a.ts'] }),
      shardRecord(2, ['triage.test.ts'], { changedFiles: ['a.ts'] }),
      shardRecord(3, ['shared.test.ts'], { changedFiles: ['a.ts'] }),
      shardRecord(4, ['sign-in.test.ts'], { changedFiles: ['a.ts'] }),
    ];
    const merged = mergeE2eRecords(records);

    it('marks a spec ran where any shard ran it, however many shards held its walks', () => {
      for (const name of ['capture.test.ts', 'triage.test.ts', 'shared.test.ts', 'sign-in.test.ts']) assert.equal(statusOf(merged, name), 'passed');
    });

    it('marks a spec failed where it failed in any one shard', () => {
      const failing = mergeE2eRecords([records[0], shardRecord(2, ['triage.test.ts', 'shared.test.ts'], { failing: ['shared.test.ts'] }), records[2], records[3]]);
      assert.equal(statusOf(failing, 'shared.test.ts'), 'failed');
      assert.equal(statusOf(failing, 'capture.test.ts'), 'passed');
    });

    it('carries the plan and the changed files once, and not the shard it came from', () => {
      assert.equal(tier(merged).mode, 'full');
      assert.deepEqual(tier(merged).reason, { rule: 'push to main', path: null });
      assert.deepEqual(merged.changedFiles, [{ path: 'a.ts', ignored: false }]);
      assert.equal(merged.shard, undefined);
      assert.equal(merged.packages.length, 1);
    });

    it('carries the area that selected a spec from the shard that ran it', () => {
      const plan = selected({ Capture: 'apps/web/src/capture/Box.tsx' });
      const some = mergeE2eRecords([shardRecord(1, [], { plan }), shardRecord(2, ['capture.test.ts'], { plan }), shardRecord(3, [], { plan }), shardRecord(4, [], { plan })]);
      assert.deepEqual(fileNamed(some, 'capture.test.ts').selectedBy.owners, [{ concept: 'Capture', path: 'apps/web/src/capture/Box.tsx' }]);
      assert.equal(statusOf(some, 'triage.test.ts'), 'not run');
    });

    it('says how many walks each shard was dealt, which add up to the suite', () => {
      assert.deepEqual(merged.shards, [
        { index: 1, report: 'written', walks: 2 },
        { index: 2, report: 'written', walks: 1 },
        { index: 3, report: 'written', walks: 1 },
        { index: 4, report: 'written', walks: 1 },
      ]);
      assert.match(renderE2eSummary(merged), /5 walks over 4 shards \(2, 1, 1, 1\)/);
    });

    it('says "unknown" rather than null for a shard whose walks could not be counted', () => {
      const uncounted = shardRecord(4, ['triage.test.ts'], { report: { suites: [{ file: 'triage.test.ts', specs: [{ ok: true }] }] } });
      assert.match(renderE2eSummary(mergeE2eRecords([records[0], records[1], records[2], uncounted])), /walks over 4 shards \(2, 1, 1, unknown\)/);
    });

    it('takes the records in any order', () => {
      assert.deepEqual(mergeE2eRecords([...records].reverse()), merged);
    });
  });

  describe('a shard that left no report', () => {
    const merged = mergeE2eRecords([shardRecord(1, ['capture.test.ts']), shardRecord(2, ['triage.test.ts']), shardRecord(3, [], { report: null }), shardRecord(4, ['sign-in.test.ts'])]);

    it('makes the record say its report is missing rather than that the specs did not run', () => {
      assert.equal(tier(merged).report, 'none');
      assert.deepEqual(tier(merged).files, []);
      assert.match(renderE2eSummary(merged), /Shard 3 left no report, so which specs ran and how they ended is not recorded/);
    });
  });

  describe('fewer than four records', () => {
    const merged = mergeE2eRecords([shardRecord(1, ['capture.test.ts']), shardRecord(2, ['triage.test.ts']), shardRecord(4, ['sign-in.test.ts'])]);

    it('names the shard that left none', () => {
      assert.deepEqual(merged.shards.find((shard) => shard.report === 'missing'), { index: 3, report: 'missing', walks: null });
      assert.equal(tier(merged).report, 'none');
      assert.match(renderE2eSummary(merged), /Shard 3 left no record/);
    });

    it('names each where several left none', () => {
      assert.match(renderE2eSummary(mergeE2eRecords([shardRecord(2, ['triage.test.ts'])])), /Shard 1 left no record, Shard 3 left no record, Shard 4 left no record/);
    });

    it('leaves nothing to merge where no shard left one, as on a documentation-only diff', () => {
      assert.equal(mergeE2eRecords([]), null);
    });
  });
});

describe('the E2E (F3) check answers for its shards', () => {
  const results = (...each) => each.map((result, at) => ({ index: at + 1, result }));

  it('passes where all four shards passed', () => {
    assert.deepEqual(e2eVerdict({ results: results('success', 'success', 'success', 'success'), aggregate: 'success' }), { ok: true, message: 'All 4 shards passed.' });
  });

  it('fails naming the shard that failed', () => {
    assert.deepEqual(e2eVerdict({ results: results('success', 'failure', 'success', 'success'), aggregate: 'failure' }), { ok: false, message: 'Shard 2 failed.' });
  });

  it('fails where a shard was cancelled', () => {
    assert.deepEqual(e2eVerdict({ results: results('success', 'success', 'cancelled', 'success'), aggregate: 'cancelled' }), { ok: false, message: 'Shard 3 was cancelled.' });
  });

  it('names every shard that went wrong', () => {
    assert.equal(e2eVerdict({ results: results('failure', 'success', 'cancelled', 'timed_out') }).message, 'Shard 1 failed; shard 3 was cancelled; shard 4 ended timed_out.');
  });

  it('passes where every shard skipped, as on a documentation-only diff', () => {
    assert.equal(e2eVerdict({ results: results('skipped', 'skipped', 'skipped', 'skipped'), aggregate: 'skipped' }).ok, true);
  });

  it('fails where a shard has no result and the matrix gave no verdict to stand in for it', () => {
    assert.deepEqual(e2eVerdict({ results: results('success', 'success', 'success') }), { ok: false, message: 'Shard 4 has no result.' });
    assert.deepEqual(e2eVerdict({ results: results('success', 'in_progress', 'success', 'success') }), { ok: false, message: 'Shard 2 ended in_progress.' });
  });

  it('leaves a shard the jobs list does not show, or shows unfinished, to the matrix\'s own verdict', () => {
    assert.equal(e2eVerdict({ results: results('success', 'success', 'success'), aggregate: 'success' }).ok, true);
    assert.equal(e2eVerdict({ results: results('success', 'in_progress', 'success', 'success'), aggregate: 'success' }).ok, true);
    assert.deepEqual(e2eVerdict({ results: results('success', 'success', 'success'), aggregate: 'failure' }), { ok: false, message: 'The shards ended failure; shards 1 to 3 read as success, shard 4 read as missing.' });
  });

  it('says what each shard read as where the matrix failed and no shard could be named, so the verdict is never a bare aggregate', () => {
    assert.deepEqual(e2eVerdict({ results: results('success', 'success', 'success', 'in_progress'), aggregate: 'failure' }), { ok: false, message: 'The shards ended failure; shards 1 to 3 read as success, shard 4 read as in_progress.' });
    assert.equal(e2eVerdict({ results: results('success', 'queued', 'success', 'in_progress'), aggregate: 'failure' }).message, 'The shards ended failure; shards 1, 3 read as success, shard 2 read as queued, shard 4 read as in_progress.');
  });

  it('names the shard that failed rather than the matrix once the jobs list shows it', () => {
    assert.equal(e2eVerdict({ results: results('success', 'success', 'success', 'failure'), aggregate: 'failure' }).message, 'Shard 4 failed.');
  });

  it('keeps to the aggregate alone where there are no results to describe', () => {
    assert.equal(e2eVerdict({ results: null, aggregate: 'cancelled' }).message, 'The shards ended cancelled.');
  });

  it('reads each shard as its result, or missing where the jobs list does not show it', () => {
    assert.deepEqual(shardReads(results('success', 'failure'), 3), [{ index: 1, read: 'success' }, { index: 2, read: 'failure' }, { index: 3, read: 'missing' }]);
  });

  it('groups what the shards read as, with runs of three as a range', () => {
    assert.equal(readsText(shardReads(results('success', 'success', 'success', 'failure'))), 'shards 1 to 3 read as success, shard 4 read as failure');
    assert.equal(readsText(shardReads(results('success', 'failure', 'success', 'success'))), 'shards 1, 3, 4 read as success, shard 2 read as failure');
    assert.equal(readsText(shardReads(results('skipped', 'skipped', 'skipped', 'skipped'))), 'shards 1 to 4 read as skipped');
  });

  it('lists the shards that read as missing or unfinished, which are the ones worth reading the jobs list for again', () => {
    assert.deepEqual(unsettledShards(results('success', 'in_progress', 'success')), [2, 4]);
    assert.deepEqual(unsettledShards(results('success', 'failure', 'cancelled', 'skipped')), []);
  });

  it('answers on the matrix\'s own verdict where the shards\' results could not be read', () => {
    assert.equal(e2eVerdict({ results: null, aggregate: 'success' }).ok, true);
    assert.deepEqual(e2eVerdict({ results: null, aggregate: 'failure' }), { ok: false, message: 'The shards ended failure.' });
  });

  it('fails on a matrix that says failure even where the results it read say otherwise', () => {
    assert.equal(e2eVerdict({ results: results('success', 'success', 'success', 'success'), aggregate: 'failure' }).ok, false);
  });

  it('reads the shards\' results off the run\'s jobs, and not the fan-in or any other job', () => {
    const jobs = [
      { name: 'Checks', conclusion: 'success', status: 'completed' },
      { name: 'E2E (F3) (2)', conclusion: 'failure', status: 'completed' },
      { name: 'E2E (F3)', conclusion: 'success', status: 'completed' },
      { name: 'E2E (F3) (1)', conclusion: null, status: 'in_progress' },
      { name: 'Test (1)', conclusion: 'success', status: 'completed' },
    ];
    assert.deepEqual(shardResults(jobs), [{ index: 2, result: 'failure' }, { index: 1, result: 'in_progress' }]);
  });
});

describe('the E2E (F3) jobs in the workflow', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  /** One job's own lines, from its key down to the next job. */
  const job = (id) => {
    const lines = workflow.split('\n');
    const start = lines.findIndex((line) => line.trimEnd() === `  ${id}:`);
    assert.notEqual(start, -1, `ci.yml has no ${id} job`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}\S/.test(line) && !/^ {2}#/.test(line));
    return rest.slice(0, end === -1 ? rest.length : end).join('\n');
  };

  it('lists as many shards as the merge expects, so a shard added in one place is not missed in the other', () => {
    const listed = /^ {8}shard: \[([\d, ]+)\]$/m.exec(job('e2e'))?.[1].split(',').map(Number);
    assert.deepEqual(listed, Array.from({ length: E2E_SHARDS }, (_, at) => at + 1));
  });

  it('names the shards for the family and the fan-in for the family alone, which is what the reports and branch protection read', () => {
    assert.match(job('e2e'), /^ {4}name: E2E \(F3\)$/m);
    assert.match(job('e2e-result'), /^ {4}name: E2E \(F3\)$/m);
    assert.match(readFileSync(fileURLToPath(new URL('../../.github/branch-protection.json', import.meta.url)), 'utf8'), /"E2E \(F3\)"/);
  });

  it('lets one red shard finish the others, and the fan-in run whatever they did short of a cancelled run', () => {
    assert.match(job('e2e'), /^ {6}fail-fast: false$/m);
    assert.match(job('e2e-result'), /^ {4}needs: e2e$/m);
    assert.match(job('e2e-result'), /^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
  });

  it('uploads the merged record under today\'s name from the fan-in alone, and each shard\'s under a name of its own', () => {
    assert.match(job('e2e-result'), /name: e2e-selection-record$/m);
    assert.doesNotMatch(job('e2e'), /name: e2e-selection-record$/m);
    assert.match(job('e2e'), /name: e2e-selection-record-\$\{\{ matrix\.shard \}\}$/m);
    assert.match(job('e2e-result'), /pattern: e2e-selection-record-\*/);
  });

  it('lets a re-run shard replace its first attempt\'s record, or the fan-in merges the stale one', () => {
    assert.match(job('e2e'), /name: e2e-selection-record-\$\{\{ matrix\.shard \}\}\n(?: {10}.*\n)*? {10}overwrite: true\n/, 'a shard\'s record upload does not overwrite');
    assert.match(job('e2e-result'), /name: e2e-selection-record\n(?: {10}.*\n)*? {10}overwrite: true\n/, 'the merged record upload does not overwrite');
  });
});

describe('the tests/e2e/ prefix', () => {
  it('shares its constant with test-selection.mjs rather than redefining it', () => {
    // Mirrors e2e-selection.test.mjs's own source-level assertion of the
    // same thing: importing SPECS here and using it inline would pass even
    // if e2e-record.mjs carried its own separate copy of the same literal.
    const path = fileURLToPath(new URL('./e2e-record.mjs', import.meta.url));
    const source = readFileSync(path, 'utf8');
    assert.match(source, /import\s*\{[^}]*\bSPECS\b[^}]*\}\s*from\s*'\.\/test-selection\.mjs';/, 'e2e-record.mjs should import SPECS rather than duplicate it');
    assert.doesNotMatch(source, /const SPECS = /, 'e2e-record.mjs should not redefine SPECS itself');
  });
});
