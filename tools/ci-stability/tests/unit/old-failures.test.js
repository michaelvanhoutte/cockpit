import { describe, expect, it } from 'vitest';

import { asRecord, MOST_TESTS, testsFromAnnotations, testsFromLog } from '../../src/old-failures.js';

const failure = (title, message, path = 'tests/e2e/support/app.ts') => ({ annotation_level: 'failure', path, title, message });

/** A line of a job's log as pnpm and GitHub write it: a timestamp, the package in brackets, colour codes. */
const logLine = (text, label = '@cockpit/architecture (full)') => `2026-10-12T18:52:01.0016352Z [${label}] ${text}`;
const bold = (text) => `\u001b[41m\u001b[1m ${text} \u001b[22m\u001b[49m`;
const dim = (text) => `\u001b[2m${text}\u001b[22m`;

describe('CI stability', () => {
  describe("an old failure's tests are read from its annotations or its log", () => {
    it('a Playwright annotation is the test under its spec and project, never under the helper its failing line is in', () => {
      const tests = testsFromAnnotations([
        failure(
          '[phone] › tests/e2e/triage.test.ts:57:9 › Triage › starting work on an item shows a pill on its ro',
          '  7) [phone] › tests/e2e/triage.test.ts:57:9 › Triage › starting work on an item shows a pill on its row › wears a pill once started \n    Error: locator.tap: Error: strict mode violation: getByRole(\'dialog\')\n\n    Locator: ...',
        ),
        failure('[desktop] › tests/e2e/dashboards.test.ts:68:9 › Dashboards › a dashboard you add', '  1) [desktop] › tests/e2e/dashboards.test.ts:68:9 › Dashboards › a dashboard you add › opens it empty \n    Error: expect(locator).toBeVisible() failed', 'tests/e2e/dashboards.test.ts'),
      ]);

      expect(tests).toEqual([
        {
          file: 'tests/e2e/triage.test.ts',
          name: 'Triage > starting work on an item shows a pill on its row > wears a pill once started',
          project: 'phone',
          error: "Error: locator.tap: Error: strict mode violation: getByRole('dialog')",
        },
        { file: 'tests/e2e/dashboards.test.ts', name: 'Dashboards > a dashboard you add > opens it empty', project: 'desktop', error: 'Error: expect(locator).toBeVisible() failed' },
      ]);
    });

    it('a Vitest log line is the test under its file and full name, behind pnpm\'s prefix and colour codes, with the next line of error', () => {
      const tests = testsFromLog(
        [
          logLine('  ✓ tests/integration/changes.test.js (22 tests) 3900ms'),
          logLine(''),
          logLine(`${bold('FAIL')} tests/integration/cli.test.js${dim(' > ')}Dependencies${dim(' > ')}orders its own areas by the exact search`),
          logLine("\u001b[31m\u001b[1mAssertionError\u001b[22m: expected 'approximate' to be 'exact' // Object.is equality\u001b[39m"),
          logLine(''),
          logLine('Expected: "exact"'),
        ].join('\n'),
      );

      expect(tests).toEqual([
        {
          file: 'tests/integration/cli.test.js',
          name: 'Dependencies > orders its own areas by the exact search',
          project: null,
          error: "AssertionError: expected 'approximate' to be 'exact' // Object.is equality",
        },
      ]);
    });

    it('a line of a package run on its own reads the same, behind pnpm\'s "package test:" instead of a bracket', () => {
      const tests = testsFromLog('2026-10-12T18:52:01.0Z apps/api test: FAIL  tests/unit/triage.test.ts > Triage > a dismissed item\n2026-10-12T18:52:01.0Z apps/api test: Error: boom');

      expect(tests).toEqual([{ file: 'tests/unit/triage.test.ts', name: 'Triage > a dismissed item', project: null, error: 'Error: boom' }]);
    });

    describe('a test read from a log is filed under its package\'s folder, as a record files it', () => {
      const packages = [
        { name: '@cockpit/web', dir: 'apps/web' },
        { name: '@harness-monitor/worker', dir: 'apps/harness-monitor' },
        { name: '@cockpit/architecture', dir: 'tools/architecture' },
      ];
      const fail = 'FAIL  tests/unit/a.test.ts > A > rule';

      it.each([
        { situation: "ci-test.mjs's bracket, with the package's name and its suffix", line: `2026-10-12T18:52:01.0Z [@cockpit/web (full)] ${fail}`, file: 'apps/web/tests/unit/a.test.ts' },
        { situation: "pnpm -r's prefix with the package's folder", line: `2026-10-12T18:52:01.0Z tools/architecture test: ${fail}`, file: 'tools/architecture/tests/unit/a.test.ts' },
        { situation: "pnpm -r's prefix with a package's name that is not its folder's", line: `2026-10-12T18:52:01.0Z @harness-monitor/worker test:unit: ${fail}`, file: 'apps/harness-monitor/tests/unit/a.test.ts' },
      ])('$situation', ({ line, file }) => {
        expect(testsFromLog(line, packages)).toEqual([{ file, name: 'A > rule', project: null, error: null }]);
      });

      it.each([
        { situation: 'a package the workspace does not have', line: `[@cockpit/gone (full)] ${fail}` },
        { situation: 'no prefix at all', line: fail },
        { situation: 'no workspace to look in', line: `[@cockpit/web (full)] ${fail}`, none: true },
      ])('$situation keeps the path as the log gave it', ({ line, none }) => {
        expect(testsFromLog(line, none ? undefined : packages).map((test) => test.file)).toEqual(['tests/unit/a.test.ts']);
      });

      it('the same file of two packages is two tests', () => {
        const log = [`[@cockpit/web (full)] ${fail}`, `[@cockpit/architecture (full)] ${fail}`].join('\n');

        expect(testsFromLog(log, packages).map((test) => test.file)).toEqual(['apps/web/tests/unit/a.test.ts', 'tools/architecture/tests/unit/a.test.ts']);
      });
    });

    it('a Vitest annotation that names its file inside the test\'s name is the test with the file taken out of the name', () => {
      const tests = testsFromAnnotations([
        failure('apps/api/tests/unit/triage.test.ts > Triage > a dismissed item leaves the lists', "AssertionError: expected 1 to be 2\n  at ...", 'apps/api/tests/unit/triage.test.ts'),
      ]);

      expect(tests).toEqual([{ file: 'apps/api/tests/unit/triage.test.ts', name: 'Triage > a dismissed item leaves the lists', project: null, error: 'AssertionError: expected 1 to be 2' }]);
    });

    it("an annotation that names its test only in its title keeps the message's first line as the error", () => {
      const [test] = testsFromAnnotations([failure('[phone] › tests/e2e/a.test.ts:1:1 › A › rule', 'Error: expect(locator).toBeVisible() failed\n  Locator: x')]);

      expect(test).toEqual({ file: 'tests/e2e/a.test.ts', name: 'A > rule', project: 'phone', error: 'Error: expect(locator).toBeVisible() failed' });
    });

    it("a log that begins with GitHub's byte order mark reads its first line like any other", () => {
      const tests = testsFromLog(`\uFEFF${logLine(' FAIL  tests/unit/a.test.ts > A > rule')}\n${logLine('Error: boom')}`, [{ name: '@cockpit/architecture', dir: 'tools/architecture' }]);

      expect(tests.map((test) => test.file)).toEqual(['tools/architecture/tests/unit/a.test.ts']);
    });

    it('a log naming the same test twice, or a spec failing on two lines of one annotation list, is one test', () => {
      const line = logLine(' FAIL  tests/unit/a.test.ts > A > rule');
      expect(testsFromLog([line, logLine('boom'), logLine('⎯⎯⎯⎯⎯⎯⎯'), line, logLine('boom')].join('\n'))).toHaveLength(1);

      const note = failure('[phone] › tests/e2e/a.test.ts:1:1 › A › rule', '  1) [phone] › tests/e2e/a.test.ts:1:1 › A › rule \n    Error: boom');
      expect(testsFromAnnotations([note, note])).toHaveLength(1);
      // The same spec on the other project is another failure.
      expect(testsFromAnnotations([note, { ...note, title: note.title.replace('phone', 'desktop'), message: note.message.replace('phone', 'desktop') }])).toHaveLength(2);
    });

    it.each([
      { situation: 'a log with no FAIL line', read: () => testsFromLog(logLine('Test Files  1 passed (1)')) },
      { situation: 'a file that failed to load, which names no test', read: () => testsFromLog(logLine(' FAIL  tests/unit/a.test.ts [ tests/unit/a.test.ts ]')) },
      { situation: "a step's exit code, a deprecation notice and a type checker's finding", read: () => testsFromAnnotations([failure('', 'Process completed with exit code 1.', '.github'), { annotation_level: 'warning', path: '.github', title: '', message: 'Node.js 20 is deprecated.' }, failure('TS2322', "Type 'string' is not assignable to type 'number'.", 'apps/api/src/a.ts')]) },
      { situation: "Playwright's run summary, which is a notice", read: () => testsFromAnnotations([{ annotation_level: 'notice', path: '.github', title: '🎭 Playwright Run Summary', message: '  7 failed\n    [desktop] › tests/e2e/a.test.ts:1:1 › A › rule' }]) },
      { situation: 'nothing at all', read: () => testsFromAnnotations(undefined) },
    ])('$situation names no test', ({ read }) => {
      expect(read()).toEqual([]);
      expect(asRecord(read())).toBeNull();
    });

    it("an error is the next line that says anything, and none when the output moves on to another section first", () => {
      const tests = testsFromLog([logLine(' FAIL  tests/unit/a.test.ts > A > one'), logLine(' FAIL  tests/unit/a.test.ts > A > two'), logLine('Error: second'), logLine('⎯⎯⎯⎯⎯⎯⎯'), logLine(' FAIL  tests/unit/b.test.ts > B > three')].join('\n'));

      expect(tests.map((test) => [test.name, test.error])).toEqual([['A > one', null], ['A > two', 'Error: second'], ['B > three', null]]);
    });

    it('stands in for a record that names the first fifty tests and counts the rest', () => {
      const tests = Array.from({ length: MOST_TESTS + 3 }, (_, i) => ({ file: 'a.test.ts', name: `t${i}`, project: null, error: null }));
      const record = asRecord(tests);

      expect(record.state).toBe('read');
      expect(record.value.failedTests).toHaveLength(MOST_TESTS);
      expect(record.value.failedTestsMore).toBe(3);
    });
  });
});
