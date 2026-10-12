//
// Integration tests for the test runners recording their own runs on the
// branch's session record (scripts/lib/test-run-record.mjs). Each case starts a
// real runner - Vitest, Playwright, Node's test runner - in a throwaway git
// repository, because only a real runner proves its configuration lists the
// reporter, and only a real file system decides what a missing or unwritable
// record does to a run.
//

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseRecord, recordFileName } from './session-record.mjs';
import { sessionRunReporter } from './vitest-session-reporter.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const playwrightSessionReporter = fileURLToPath(new URL('./playwright-session-reporter.mjs', import.meta.url));
const nodeReporter = new URL('./node-test-session-reporter.mjs', import.meta.url).href;
const recorder = pathToFileURL(fileURLToPath(new URL('./test-run-record.mjs', import.meta.url))).href;
const vitestCli = join(createRequire(join(repoRoot, 'packages/shared/package.json')).resolve('vitest/package.json'), '..', 'vitest.mjs');
const playwrightCli = join(repoRoot, 'node_modules/@playwright/test/cli.js');

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A git repository on branch `main`, with a session record already started unless `recorded` is false. */
function repo({ recorded = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-run-record-'));
  made.push(dir);
  const git = spawnSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const record = join(dir, '.git', recordFileName('main'));
  if (recorded) writeFileSync(record, '{"phase":"start","at":"2026-09-21T10:00:00.000Z"}\n');
  return { dir, record };
}

const entriesOf = (record) => parseRecord(readFileSync(record, 'utf8')).filter((entry) => entry.run);

function run(command, args, cwd, env = {}) {
  return new Promise((resolve) => {
    // NODE_TEST_CONTEXT would make a Node test run started here think it was nested in this one.
    const { NODE_TEST_CONTEXT: _nested, ...inherited } = process.env;
    const child = spawn(command, args, { cwd, env: { ...inherited, npm_lifecycle_event: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (status) => resolve({ status, output }));
  });
}

/** A Vitest project listing the reporter exactly as a package's configuration does. */
function vitestProject(dir, { slow = false, failing = false } = {}) {
  writeFileSync(join(dir, 'package.json'), '{"name":"@scratch/pkg","private":true}');
  writeFileSync(join(dir, 'vitest.config.mjs'), `export default { test: { globals: true, reporters: ['default', ${JSON.stringify(sessionRunReporter)}] } };`);
  writeFileSync(join(dir, 'a.test.mjs'), `test('a', async () => { ${slow ? 'await new Promise((r) => setTimeout(r, 1500));' : ''} ${failing ? 'throw new Error("red");' : ''} });`);
  writeFileSync(join(dir, 'b.test.mjs'), "test('b', () => {});");
}

const vitest = (dir, ...args) => run(process.execPath, [vitestCli, 'run', ...args], dir);

describe('every local test run is recorded with its start, end and scope', () => {
  it('scopes a whole Vitest suite to its package', async () => {
    const { dir, record } = repo();
    vitestProject(dir);
    assert.equal((await vitest(dir)).status, 0);
    const [only, ...rest] = entriesOf(record);
    assert.equal(rest.length, 0);
    assert.deepEqual(only.scopes, ['@scratch/pkg']);
    assert.ok(Date.parse(only.start) <= Date.parse(only.end));
  });

  it('scopes one Vitest file to the file', async () => {
    const { dir, record } = repo();
    vitestProject(dir);
    assert.equal((await vitest(dir, 'a.test.mjs')).status, 0);
    assert.deepEqual(entriesOf(record).map((entry) => entry.scopes), [['a.test.mjs']]);
  });

  it('keeps the real end of a run that takes a while, not its launch', async () => {
    const { dir, record } = repo();
    vitestProject(dir, { slow: true });
    assert.equal((await vitest(dir)).status, 0);
    const [only] = entriesOf(record);
    assert.ok(Date.parse(only.end) - Date.parse(only.start) >= 1400, `${only.start} to ${only.end}`);
  });

  it('scopes the Playwright suite to E2E', async () => {
    const { dir, record } = repo();
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(join(repoRoot, 'node_modules', '@playwright'), join(dir, 'node_modules', '@playwright'), 'junction');
    writeFileSync(join(dir, 'playwright.config.mjs'), `export default { testDir: '.', testMatch: '*.pw.mjs', reporter: [['list'], [${JSON.stringify(playwrightSessionReporter)}]] };`);
    writeFileSync(join(dir, 'a.pw.mjs'), "import { test } from '@playwright/test';\ntest('a', async () => {});\n");
    const result = await run(process.execPath, [playwrightCli, 'test'], dir);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(entriesOf(record).map((entry) => entry.scopes), [['E2E']]);
  });

  it("scopes Node's test runner to the script that ran it", async () => {
    const { dir, record } = repo();
    writeFileSync(join(dir, 'a.test.mjs'), "import { test } from 'node:test';\ntest('a', () => {});\n");
    const args = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${nodeReporter}`, '--test-reporter-destination=stdout', 'a.test.mjs'];
    const result = await run(process.execPath, args, dir, { npm_lifecycle_event: 'test:scripts' });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /✔ a /, 'the spec output is still printed');
    assert.deepEqual(entriesOf(record).map((entry) => entry.scopes), [['test:scripts']]);
  });
});

describe('nothing is recorded where the branch has no session record, and a failed write never fails a run', () => {
  it('creates no record where the branch has none', async () => {
    const { dir } = repo({ recorded: false });
    vitestProject(dir);
    assert.equal((await vitest(dir)).status, 0);
    assert.deepEqual(readdirSync(join(dir, '.git')).filter((name) => name.startsWith('cockpit-session-record')), []);
  });

  it('lets the run pass or fail on its tests alone where the record cannot be written', async () => {
    const { dir, record } = repo({ recorded: false });
    mkdirSync(record); // present, but not a file anything can append to
    vitestProject(dir);
    assert.equal((await vitest(dir)).status, 0);
    vitestProject(dir, { failing: true });
    const failed = await vitest(dir);
    assert.equal(failed.status, 1);
    assert.match(failed.output, /red/);
  });

  it('keeps every line whole where two runner processes finish at once', async () => {
    const { dir, record } = repo();
    const scope = 'x'.repeat(4_000);
    const writer = (name) =>
      run(process.execPath, ['--input-type=module', '-e', `import { recordTestRun } from ${JSON.stringify(recorder)}; for (let i = 0; i < 40; i++) recordTestRun({ scopes: ['${name}-${scope}'], start: Date.now(), end: Date.now() }, ${JSON.stringify(dir)});`], dir);
    const results = await Promise.all([writer('one'), writer('two')]);
    assert.deepEqual(results.map((result) => result.status), [0, 0]);
    const unreadable = [];
    const runs = parseRecord(readFileSync(record, 'utf8'), (line) => unreadable.push(line)).filter((entry) => entry.run);
    assert.deepEqual(unreadable, []);
    assert.equal(runs.length, 80);
    assert.equal(runs.filter((entry) => entry.scopes[0].startsWith('one-')).length, 40);
  });
});
