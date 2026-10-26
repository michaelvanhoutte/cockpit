//
// Integration tests for the runners handing their failed tests to the record
// (scripts/lib/failed-tests.mjs): "Record each failed test's name and error in
// CI's test records" (issue 1580). Each case starts a real Vitest or Playwright
// in a throwaway folder, because the unit tests hold the shaping rules over
// fixtures and only a real runner proves its objects have the shape those
// functions read.
//
// At the root, as `tests/lint` is: it needs the installed runners.
//

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { playwrightFailedTests } from '../../scripts/lib/failed-tests.mjs';
import { sessionRunReporter } from '../../scripts/lib/vitest-session-reporter.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const recordReporter = fileURLToPath(new URL('../../scripts/lib/vitest-record-reporter.mjs', import.meta.url));
const vitestCli = join(createRequire(join(repoRoot, 'packages/shared/package.json')).resolve('vitest/package.json'), '..', 'vitest.mjs');
const playwrightCli = join(repoRoot, 'node_modules/@playwright/test/cli.js');

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-failed-tests-'));
  made.push(dir);
  return dir;
};

function run(args, cwd, env = {}) {
  return new Promise((resolve) => {
    // NODE_TEST_CONTEXT would make a runner started here think it was nested in this one.
    const { NODE_TEST_CONTEXT: _nested, ...inherited } = process.env;
    const child = spawn(process.execPath, args, { cwd, env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (status) => resolve({ status, output }));
  });
}

/** A Vitest project with a passing file and, unless `passing`, a file whose tests fail an assertion inside two describe blocks and time out. */
function vitestProject(dir, reporters, { passing = false } = {}) {
  writeFileSync(join(dir, 'package.json'), '{"name":"@scratch/pkg","private":true}');
  writeFileSync(join(dir, 'vitest.config.mjs'), `export default { test: { globals: true, testTimeout: 200, reporters: ${JSON.stringify(reporters)} } };`);
  writeFileSync(join(dir, 'ok.test.mjs'), "test('fine', () => {});");
  if (passing) return;
  writeFileSync(
    join(dir, 'bad.test.mjs'),
    [
      "describe('Triage', () => {",
      "  describe('a dismissed item', () => {",
      "    test('leaves the lists', () => { expect(1).toBe(2); });",
      "    test('is never erased', () => {});",
      '  });',
      "  test('a slow one', async () => { await new Promise((r) => setTimeout(r, 2000)); });",
      '});',
    ].join('\n'),
  );
}

describe('a real Vitest run hands its failed tests to the record', () => {
  it('writes them into the report the Test job’s record is built from', async () => {
    const dir = scratch();
    vitestProject(dir, ['default', recordReporter]);
    const out = join(dir, 'report.json');
    const result = await run([vitestCli, 'run'], dir, { COCKPIT_TEST_REPORT: out, COCKPIT_REPO_ROOT: dir });
    assert.equal(result.status, 1, result.output);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(
      report.failedTests.map((test) => [test.file, test.name, test.error]),
      [
        ['bad.test.mjs', 'Triage > a dismissed item > leaves the lists', 'expected 1 to be 2 // Object.is equality'],
        ['bad.test.mjs', 'Triage > a slow one', 'Test timed out in 200ms.'],
      ],
    );
    assert.equal(report.failedTestsMore, 0);
  });

  it('leaves a file for the workflows that run `pnpm test`, only where a test failed', async () => {
    const failing = scratch();
    vitestProject(failing, ['default', sessionRunReporter]);
    const into = join(failing, 'failed-tests');
    assert.equal((await run([vitestCli, 'run'], failing, { COCKPIT_FAILED_TESTS_DIR: into })).status, 1);
    const [only, ...rest] = readdirSync(into);
    assert.equal(rest.length, 0);
    const written = JSON.parse(readFileSync(join(into, only), 'utf8'));
    assert.deepEqual(written.failedTests.map((test) => test.name), ['Triage > a dismissed item > leaves the lists', 'Triage > a slow one']);
    assert.ok(written.failedTests.every((test) => test.file.endsWith('bad.test.mjs')));

    const passing = scratch();
    vitestProject(passing, ['default', sessionRunReporter], { passing: true });
    const left = join(passing, 'failed-tests');
    assert.equal((await run([vitestCli, 'run'], passing, { COCKPIT_FAILED_TESTS_DIR: left })).status, 0);
    assert.equal(existsSync(left), false);
  });
});

describe('the step after the tests gathers what the runs left', () => {
  it('keeps the other runs’ failed tests when one run left a file cut short', async () => {
    const dir = scratch();
    const into = join(dir, 'failed-tests');
    const out = join(dir, 'failed-tests-record');
    mkdirSync(into);
    writeFileSync(join(into, 'a-1.json'), JSON.stringify({ failedTests: [{ file: 'a.test.ts', name: 'x', error: 'boom' }], failedTestsMore: 0 }));
    writeFileSync(join(into, 'b-2.json'), '{"failedTests":[{"file":');
    const gathered = await run([join(repoRoot, 'scripts/ci-failed-tests.mjs')], dir, { COCKPIT_FAILED_TESTS_DIR: into, FAILED_TESTS_RECORD_DIR: out });
    assert.equal(gathered.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'record.json'), 'utf8')).failedTests.map((test) => test.name), ['x']);
  });
});

describe('a real Playwright run hands its failed walks to the record', () => {
  it('files a walk that fails on each project under its spec, not the helper its failing line is in', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(join(repoRoot, 'node_modules', '@playwright'), join(dir, 'node_modules', '@playwright'), 'junction');
    mkdirSync(join(dir, 'tests', 'support'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'support', 'arrange.mjs'), "export function arrange() { throw new Error('the helper threw\\nsecond line'); }\n");
    writeFileSync(
      join(dir, 'playwright.config.mjs'),
      "export default { testDir: 'tests', testMatch: '*.pw.mjs', projects: [{ name: 'desktop' }, { name: 'phone' }], reporter: [['json', { outputFile: 'report.json' }]] };",
    );
    writeFileSync(
      join(dir, 'tests', 'capture.pw.mjs'),
      [
        "import { test } from '@playwright/test';",
        "import { arrange } from './support/arrange.mjs';",
        "test.describe('Capture', () => {",
        "  test('a thought is kept', async () => { arrange(); });",
        "  test('a thought is shown', async () => {});",
        '});',
      ].join('\n'),
    );
    const result = await run([playwrightCli, 'test'], dir);
    assert.equal(result.status, 1, result.output);
    const built = playwrightFailedTests(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')), (file) => `tests/${file}`);
    assert.deepEqual(
      built.failedTests.map((test) => [test.file, test.name, test.project, test.error]),
      [
        ['tests/capture.pw.mjs', 'Capture > a thought is kept', 'desktop', 'Error: the helper threw'],
        ['tests/capture.pw.mjs', 'Capture > a thought is kept', 'phone', 'Error: the helper threw'],
      ],
    );
  });
});
