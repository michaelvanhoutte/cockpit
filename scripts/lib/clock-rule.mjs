//
// The clock rule at every tier ("inject time", docs/testing-strategy.md): a
// test that reads the real clock fails on a Wednesday, or under load, for no
// defect of the product's.
//
// A branch may not ADD a real-clock read - `Date.now()` or `new Date()` with
// no argument - to a test at any tier: a vitest file, a browser walk under
// tests/e2e, a script's `node --test` file. The reads already in the
// repository stay until someone touches the line, so only added lines are
// judged (scripts/lib/writing-rules.mjs's linesAdded, against the same
// merge-base the writing rules' touched-lines report uses).
//
// A deliberate read is marked on its own line with `// clock-ok: <reason>`;
// a marker with no reason is refused, since the reason is the point. A file
// that installs fake time (vi.useFakeTimers, vi.setSystemTime, Playwright's
// page.clock) is exempt: its reads are of a clock the test controls.
// performance.now() is not a read of the date and never matches.
//
// Pure: a diff and a way to read a file in, violations out. The git calls live
// in clock-rule.test.mjs, which is the repository-wide enforcement.
//

import { linesAdded } from './writing-rules.mjs';

// `Date.now()`; `new Date` with no argument, parenthesised or not; and a bare
// `Date()` call, which returns today as a string.
const REAL_CLOCK_READ = /\bDate\.now\s*\(|\bnew\s+Date\b(?!\s*\(\s*[^)\s])|(?<!\bnew\s+)\bDate\s*\(/;
const MARKER = /\/\/\s*clock-ok\b(?::\s*(\S.*))?/;
const FAKE_TIME = /\bvi\.(?:useFakeTimers|setSystemTime)\b|\bclock\.(?:install|setFixedTime|setSystemTime|pauseAt|fastForward|runFor)\b/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/** A test at any tier: a `.test.` or `.spec.` file, or anything under a `tests` folder, outside `poc/`, which never runs in CI. */
export function isTestFile(path) {
  if (path.startsWith('poc/')) return false;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)tests\//.test(path);
}

/**
 * Real-clock reads on the lines `diff` adds to test files, as
 * `{ file, line, text, problem }` - `problem` is `'unmarked'` or
 * `'marker without a reason'`.
 *
 * @param {string} diff a `git diff --unified=0`
 * @param {(file: string) => string | null} readFile a file's current contents, null where unreadable
 */
export function findClockReads(diff, readFile) {
  const found = [];
  for (const [file, added] of linesAdded(diff)) {
    if (!isTestFile(file) || added.size === 0) continue;
    const source = readFile(file);
    if (source === null || FAKE_TIME.test(source)) continue;
    const lines = source.split('\n');
    for (const number of [...added].sort((a, b) => a - b)) {
      const text = lines[number - 1];
      if (text === undefined || COMMENT_LINE.test(text) || !REAL_CLOCK_READ.test(text)) continue;
      const marker = MARKER.exec(text);
      if (marker && marker[1]) continue;
      found.push({ file, line: number, text: text.trim(), problem: marker ? 'marker without a reason' : 'unmarked' });
    }
  }
  return found;
}

/** One line per violation, naming file and line. */
export function renderClockReads(found) {
  return found.map(
    ({ file, line, text, problem }) =>
      `${file}:${line}  ${problem === 'unmarked' ? 'real-clock read' : 'clock-ok marker needs a reason'}: ${text.slice(0, 100)}\n` +
      '    Inject the time instead, or mark a deliberate read in place: // clock-ok: <reason>',
  );
}

/**
 * What the repository-wide run reports: `{ checked: false, said }` where there
 * is no diff to read (no merge-base with main), else the rendered violations.
 */
export function clockReport(diff, readFile) {
  if (diff === null) return { checked: false, said: 'clock rule: no merge-base with main to diff against, so nothing was checked.', violations: [] };
  return { checked: true, said: '', violations: renderClockReads(findClockReads(diff, readFile)) };
}
