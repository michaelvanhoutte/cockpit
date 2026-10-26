//
// The tests that failed in a CI job, as the process that ran them saw it ("Record
// each failed test's name and error in CI's test records", issue 1580): the file,
// the full name (describe blocks included), the Playwright project where there
// is one, and the first line of the error. No log is parsed; the Vitest reporters
// (vitest-record-reporter.mjs, vitest-session-reporter.mjs) and the Playwright
// JSON report the E2E record is built from hand their results to the functions
// here.
//
// A record stays small: at most FAILED_TESTS_CAP tests are named and the rest
// are only counted, in `failedTestsMore`. Every function answers
// `{ failedTests, failedTestsMore }`, the two fields a record carries, so the
// answers of several processes merge with mergeFailedTests.
//
// Pure: no filesystem, no process.env, so each rule is asserted by `node --test`.
//

/** The most failed tests one record names; the ones past it are counted in `failedTestsMore`. */
export const FAILED_TESTS_CAP = 50;

/** The most characters of an error's first line a record keeps. */
export const ERROR_LENGTH = 240;

const ANSI = /\u001b\[[0-9;]*m/g;

/** The first line of an error message with any colour codes removed, cut to ERROR_LENGTH; `null` where there is no message. */
export function firstLine(message) {
  if (typeof message !== 'string') return null;
  const line = message
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => text !== '');
  if (line === undefined) return null;
  return line.length > ERROR_LENGTH ? `${line.slice(0, ERROR_LENGTH - 1)}…` : line;
}

/** `tests` as the two record fields: the first FAILED_TESTS_CAP, and how many more failed, counting the `more` the caller already dropped. */
export function capFailedTests(tests, more = 0) {
  return { failedTests: tests.slice(0, FAILED_TESTS_CAP), failedTestsMore: more + Math.max(0, tests.length - FAILED_TESTS_CAP) };
}

/** Several processes' answers as one, in order, capped again: a part may be missing or hold neither field (a record from before this one). */
export function mergeFailedTests(parts) {
  const tests = parts.flatMap((part) => part?.failedTests ?? []);
  const more = parts.reduce((sum, part) => sum + (part?.failedTestsMore ?? 0), 0);
  return capFailedTests(tests, more);
}

/**
 * The failed tests of a Vitest run. `modules` are the test modules the run
 * ended with, each `{ moduleId, children: { allTests() } }` where a test has a
 * `fullName` (its describe blocks and name, joined by ` > `) and a `result()`;
 * `rel` turns a module's id into the path the record keeps. A failed test with
 * no message (a timeout always has one) is recorded with `error: null`.
 */
export function vitestFailedTests(modules, rel) {
  const failed = [];
  for (const module of modules) {
    for (const test of module.children.allTests()) {
      const result = test.result();
      if (result.state !== 'failed') continue;
      failed.push({ file: rel(module.moduleId), name: test.fullName, error: firstLine(result.errors?.[0]?.message) });
    }
  }
  return capFailedTests(failed);
}

/**
 * The failed tests of a Playwright run, from its JSON report (`--reporter=json`).
 * A test is filed under the spec file whose suite holds it, never under the file
 * its failing line sits in (a helper under tests/e2e/support/), and once per
 * project it failed on. `path` puts a spec file, as the report gives it relative
 * to the test directory, where the record keeps it.
 */
export function playwrightFailedTests(report, path = (file) => file) {
  const failed = [];
  const visit = (suite, file, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== 'unexpected') continue;
        const result = test.results?.at(-1);
        const message = result?.error?.message ?? result?.errors?.[0]?.message;
        failed.push({ file: path(file), name: [...titles, spec.title].join(' > '), project: test.projectName, error: firstLine(message) });
      }
    }
    for (const child of suite.suites ?? []) visit(child, file, [...titles, child.title]);
  };
  // A top-level suite is a spec file; its own title is the file, not a describe block.
  for (const fileSuite of report?.suites ?? []) visit(fileSuite, fileSuite.file ?? fileSuite.title ?? '', []);
  return capFailedTests(failed);
}
