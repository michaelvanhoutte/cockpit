/**
 * The tests that failed in a job that kept no record of them, read from what GitHub still holds of
 * it: Playwright's annotations on the job's check run, and Vitest's `FAIL <file> > <name>` lines in
 * the job's log. Only the backfill reads these (the nightly sends rely on records), for the
 * attempts from before the records named tests or after they expired.
 *
 * Pure: text in, tests out, in the shape a record's `failedTests` has, so `failedTestsOf` takes
 * them as it takes a record's. Playwright's annotations name a test by its spec and project in the
 * title and put the helper the failing line is in under `path`, so the spec is taken from the
 * title and `path` is never read. Vitest's annotations never reach GitHub, since `ci-test.mjs`
 * prefixes every line of a run, so its tests come from the log behind pnpm's prefixes and colours.
 */

/** The most tests one job names, as a record's; the rest are counted. */
export const MOST_TESTS = 50;
/** The most characters of an error's first line kept, as a record's. */
const ERROR_LENGTH = 240;

const ANSI = /\u001b\[[0-9;]*m/g;
const SPEC = String.raw`[\w@./-]+\.(?:test|spec)\.[cm]?[jt]sx?`;
/** `  7) [phone] › tests/e2e/triage.test.ts:57:9 › Triage › the rule › the case`, the project and number optional. */
const PLAYWRIGHT = new RegExp(String.raw`^(?:\d+\)\s*)?(?:\[([^\]]+)\]\s*›\s*)?(${SPEC}):\d+:\d+\s*›\s*(.+)$`);
/** `apps/api/tests/triage.test.ts > Triage > the rule`: Vitest's own way to name a test. */
const VITEST_NAME = new RegExp(String.raw`^(${SPEC})\s+>\s+(.+)$`);
/** A line of Vitest's output naming a failed test, after the prefixes are stripped. */
const FAIL_LINE = new RegExp(String.raw`^\s*FAIL\s+(?:\|[^|]+\|\s+)?(${SPEC})\s+>\s+(.+)$`);

const cut = (line) => (line.length <= ERROR_LENGTH ? line : `${line.slice(0, ERROR_LENGTH - 1)}…`);

/** The first line of `lines` from `from` that says anything, or null. */
function errorFrom(lines, from) {
  const line = lines.slice(from).find((each) => each.trim() !== '');
  return line === undefined ? null : cut(line.trim());
}

/**
 * The failed tests a job's check-run annotations name. An annotation that is not a failure, or
 * names no spec (a step's exit code, the Node.js deprecation, a type checker's finding), is no test.
 *
 * @param {{ annotation_level?: string, title?: string|null, message?: string|null }[]} annotations
 * @returns {{ file: string, name: string, project: string|null, error: string|null }[]}
 */
export function testsFromAnnotations(annotations) {
  const tests = new Map();
  const add = (file, name, project, error) => {
    const key = `${file}|${project ?? ''}|${name}`;
    if (!tests.has(key)) tests.set(key, { file, name, project, error });
  };
  for (const note of annotations ?? []) {
    if (note?.annotation_level !== 'failure') continue;
    const title = String(note.title ?? '').replace(ANSI, '').trim();
    const lines = String(note.message ?? '').replace(ANSI, '').split(/\r?\n/);
    const head = lines[0].trim();

    // Playwright puts the whole title on the message's first line; the annotation's own title is cut short.
    const viaHead = PLAYWRIGHT.exec(head);
    const playwright = viaHead ?? PLAYWRIGHT.exec(title);
    if (playwright) {
      const name = playwright[3].split('›').map((part) => part.trim()).join(' > ');
      add(playwright[2], name, playwright[1] ?? null, errorFrom(lines, viaHead ? 1 : 0));
      continue;
    }
    // A Vitest annotation names the file inside the test's name; the file comes out of it.
    const viaTitle = VITEST_NAME.exec(title);
    const vitest = viaTitle ?? VITEST_NAME.exec(head);
    if (vitest) add(vitest[1], vitest[2].trim(), null, errorFrom(lines, viaTitle ? 0 : 1));
  }
  return [...tests.values()];
}

/**
 * A line of a job's log without GitHub's timestamp, pnpm's prefix and any colour, and the package
 * the prefix named. `ci-test.mjs` prefixes a package's output with `[@cockpit/web (full)] `, and
 * `pnpm -r` with `apps/harness-monitor test: ` (the package's folder, or its name).
 */
function bare(line) {
  const plain = line.replace(/^﻿/, '').replace(ANSI, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '');
  const bracket = /^\[([^\]\s]+)[^\]]*\] /.exec(plain);
  if (bracket) return { text: plain.slice(bracket[0].length).trimEnd(), prefix: bracket[1] };
  const recursive = /^([\w./@-]+) test[\w:-]*: /.exec(plain);
  if (recursive) return { text: plain.slice(recursive[0].length).trimEnd(), prefix: recursive[1] };
  return { text: plain.trimEnd(), prefix: null };
}

/** The folder of the package a log's prefix names, by the package's name or its folder, or null where the workspace has none. */
function folderOf(prefix, packages) {
  if (prefix === null) return null;
  return (packages.find((each) => each.name === prefix) ?? packages.find((each) => each.dir === prefix))?.dir ?? null;
}

/**
 * The failed tests a job's log names, by `FAIL <file> > <describe> > <name>`, each once however
 * often Vitest repeats it, with the next line of output as the error. A `FAIL` of a file that did
 * not load names no test, so none is read from it. Vitest prints a file relative to its package,
 * so it is put under the package's folder, as a record keeps it; where the prefix names no package
 * of `packages`, the path stays as the log gave it.
 *
 * @param {string} log
 * @param {{ name: string, dir: string }[]} [packages] the workspace's, `workspacePackages()`
 * @returns {{ file: string, name: string, project: null, error: string|null }[]}
 */
export function testsFromLog(log, packages = []) {
  const lines = String(log ?? '').split('\n').map(bare);
  const tests = new Map();
  for (const [index, { text, prefix }] of lines.entries()) {
    const match = FAIL_LINE.exec(text);
    if (!match) continue;
    const folder = folderOf(prefix, packages);
    const file = folder === null ? match[1] : `${folder}/${match[1]}`;
    const key = `${file}|${match[2].trim()}`;
    if (tests.has(key)) continue;
    // The error is the next line that says anything, unless the output moves on to another section first.
    const next = lines.slice(index + 1, index + 12).find((each) => each.text.trim() !== '')?.text;
    const error = next === undefined || /^\s*(?:FAIL\b|\u23af)/.test(next) ? null : cut(next.trim());
    tests.set(key, { file, name: match[2].trim(), project: null, error });
  }
  return [...tests.values()];
}

/**
 * Tests as the record they stand in for (`failedTestsOf` reads it as it reads one a job uploaded),
 * or null when there are none: a job that names no test keeps no record, and its failed step stands.
 */
export function asRecord(tests) {
  if (tests.length === 0) return null;
  return { state: 'read', value: { failedTests: tests.slice(0, MOST_TESTS), failedTestsMore: Math.max(0, tests.length - MOST_TESTS) } };
}
