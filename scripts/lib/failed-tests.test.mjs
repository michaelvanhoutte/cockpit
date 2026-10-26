//
// Unit tests for the failed tests a CI job records (scripts/lib/failed-tests.mjs),
// the rows of "Record each failed test's name and error in CI's test records"
// (issue 1580). The workflows that upload the record for Deploy staging, Promote
// to production and Contract are proved by the first failing run of each after
// merge, which only GitHub can run.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ERROR_LENGTH, FAILED_TESTS_CAP, capFailedTests, firstLine, mergeFailedTests, playwrightFailedTests, vitestFailedTests } from './failed-tests.mjs';

const rel = (path) => path.replace('/repo/', '');

/** A test module as Vitest hands it to a reporter, holding `tests` of `[fullName, result]`. */
const testModule = (moduleId, tests) => ({ moduleId, children: { allTests: () => tests.map(([fullName, result]) => ({ fullName, result: () => result })) } });
const passed = { state: 'passed', errors: undefined };
const failed = (message) => ({ state: 'failed', errors: [{ message }] });

/** A Playwright JSON report: one spec file `file` holding `suite` (a describe block) with a spec `title` run on `projects`, each `[projectName, status, message]`. */
const report = (file, suite, title, projects, helper = '/repo/tests/e2e/support/arrange.ts') => ({
  suites: [
    {
      title: file,
      file,
      suites: [
        {
          title: suite,
          file,
          specs: [
            {
              title,
              file,
              tests: projects.map(([projectName, status, message]) => ({
                projectName,
                status,
                results: [{ status: status === 'expected' ? 'passed' : 'failed', error: message === undefined ? undefined : { message, location: { file: helper, line: 12 } } }],
              })),
            },
          ],
        },
      ],
    },
  ],
});

describe('the failed tests of a Vitest run', () => {
  describe('a failed test is recorded with its file, its full name and its error’s first line', () => {
    const modules = [
      testModule('/repo/apps/api/tests/unit/triage.test.ts', [
        ['Triage > a dismissed item > leaves the lists', failed('expected 1 to be 2 // Object.is equality\n\n- Expected\n+ Received')],
        ['Triage > a dismissed item > is never erased', passed],
        ['Triage > a snoozed item > comes back', failed('Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".')],
      ]),
      testModule('/repo/apps/api/tests/unit/capture.test.ts', [['Capture > keeps a thought', passed]]),
    ];

    it('names the assertion that failed inside two describe blocks', () => {
      assert.deepEqual(vitestFailedTests(modules, rel).failedTests[0], {
        file: 'apps/api/tests/unit/triage.test.ts',
        name: 'Triage > a dismissed item > leaves the lists',
        error: 'expected 1 to be 2 // Object.is equality',
      });
    });

    it('names the timeout message of a test that timed out', () => {
      assert.deepEqual(vitestFailedTests(modules, rel).failedTests[1], {
        file: 'apps/api/tests/unit/triage.test.ts',
        name: 'Triage > a snoozed item > comes back',
        error: 'Test timed out in 5000ms.',
      });
    });

    it('records only the tests that failed', () => {
      assert.equal(vitestFailedTests(modules, rel).failedTests.length, 2);
    });

    it('names no failed test where every test passes', () => {
      assert.deepEqual(vitestFailedTests([modules[1]], rel), { failedTests: [], failedTestsMore: 0 });
    });

    it('records a failure that carries no message with no error rather than dropping the test', () => {
      const [only] = vitestFailedTests([testModule('/repo/a.test.ts', [['a', { state: 'failed', errors: [] }]])], rel).failedTests;
      assert.deepEqual(only, { file: 'a.test.ts', name: 'a', error: null });
    });
  });
});

describe('the failed tests of a Playwright run', () => {
  describe('a failed test is recorded under its spec file and the project it failed on', () => {
    it('files a walk that fails on the phone under its spec, though its failing line is in a helper', () => {
      const built = playwrightFailedTests(report('capture.test.ts', 'Capture', 'a thought is kept', [['phone', 'unexpected', 'Error: expect(locator).toBeVisible() failed\nLocator: …'], ['desktop', 'expected']]), (file) => `tests/e2e/${file}`);
      assert.deepEqual(built.failedTests, [{ file: 'tests/e2e/capture.test.ts', name: 'Capture > a thought is kept', project: 'phone', error: 'Error: expect(locator).toBeVisible() failed' }]);
    });

    it('records the same walk once for each project it failed on', () => {
      const built = playwrightFailedTests(report('capture.test.ts', 'Capture', 'a thought is kept', [['phone', 'unexpected', 'boom'], ['desktop', 'unexpected', 'boom']]));
      assert.deepEqual(built.failedTests.map((test) => test.project), ['phone', 'desktop']);
    });

    it('names no failed test where every walk passes', () => {
      assert.deepEqual(playwrightFailedTests(report('capture.test.ts', 'Capture', 'a thought is kept', [['phone', 'expected'], ['desktop', 'expected']])), { failedTests: [], failedTestsMore: 0 });
    });

    it('records a walk that timed out with the timeout message', () => {
      const built = playwrightFailedTests(report('capture.test.ts', 'Capture', 'a thought is kept', [['phone', 'unexpected', 'Test timeout of 30000ms exceeded.']]));
      assert.equal(built.failedTests[0].error, 'Test timeout of 30000ms exceeded.');
    });

    it('records no failure where the process left no report', () => {
      assert.deepEqual(playwrightFailedTests(null), { failedTests: [], failedTestsMore: 0 });
    });
  });
});

describe('an error is kept as its first line, cut to a fixed length', () => {
  for (const [situation, message, expected] of [
    ['a message of many lines', 'first line\nsecond line\nthird', 'first line'],
    ['a message that opens with blank lines', '\n\n  first line  \nsecond', 'first line'],
    ['colour codes in it', '\u001b[31mError:\u001b[39m expect(received).toBe(expected)\n', 'Error: expect(received).toBe(expected)'],
    ['a line of exactly the longest length', 'x'.repeat(ERROR_LENGTH), 'x'.repeat(ERROR_LENGTH)],
    ['one very long line', 'y'.repeat(ERROR_LENGTH * 3), `${'y'.repeat(ERROR_LENGTH - 1)}…`],
    ['an astral character at the cut', `${'z'.repeat(ERROR_LENGTH - 2)}😀tail`, `${'z'.repeat(ERROR_LENGTH - 2)}…`],
    ['an empty message', '', null],
    ['no message', undefined, null],
  ]) {
    it(`keeps ${situation} as ${expected === null ? 'no error' : 'its first line'}`, () => {
      const kept = firstLine(message);
      assert.equal(kept, expected);
      if (kept !== null) assert.ok(kept.length <= ERROR_LENGTH);
    });
  }
});

describe('a job where very many tests fail records a capped number and how many more', () => {
  const tests = (count) => Array.from({ length: count }, (_, index) => ({ file: 'a.test.ts', name: `test ${index}`, error: 'red' }));

  it('records the first ones up to the cap and counts the rest', () => {
    const built = capFailedTests(tests(FAILED_TESTS_CAP + 7));
    assert.deepEqual(built.failedTests, tests(FAILED_TESTS_CAP));
    assert.equal(built.failedTestsMore, 7);
  });

  it('records all of them, with no count of more, where exactly the cap fail', () => {
    const built = capFailedTests(tests(FAILED_TESTS_CAP));
    assert.equal(built.failedTests.length, FAILED_TESTS_CAP);
    assert.equal(built.failedTestsMore, 0);
  });

  it('caps a Vitest run and a Playwright run alike', () => {
    const vitest = vitestFailedTests([testModule('/repo/a.test.ts', tests(FAILED_TESTS_CAP + 1).map((test) => [test.name, failed('red')]))], rel);
    const projects = Array.from({ length: FAILED_TESTS_CAP + 1 }, () => ['phone', 'unexpected', 'red']);
    const playwright = playwrightFailedTests(report('a.test.ts', 'Area', 'a walk', projects));
    for (const built of [vitest, playwright]) assert.deepEqual([built.failedTests.length, built.failedTestsMore], [FAILED_TESTS_CAP, 1]);
  });

  describe('several processes’ answers become one', () => {
    it('keeps them in order, caps the whole, and counts what each already dropped', () => {
      const merged = mergeFailedTests([
        { failedTests: tests(FAILED_TESTS_CAP), failedTestsMore: 3 },
        { failedTests: tests(2), failedTestsMore: 0 },
      ]);
      assert.equal(merged.failedTests.length, FAILED_TESTS_CAP);
      assert.equal(merged.failedTestsMore, 3 + 2);
    });

    it('takes a part that is missing, or from before a record carried failed tests, as naming none', () => {
      assert.deepEqual(mergeFailedTests([undefined, {}, { failedTests: tests(1), failedTestsMore: 0 }]), { failedTests: tests(1), failedTestsMore: 0 });
    });
  });
});
