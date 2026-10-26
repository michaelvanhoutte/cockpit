//
// What CI's Test job selected, and why ("Record what CI's Test job selected,
// and why, on every run", issue 539): the record scripts/ci-test.mjs writes
// beside the run, uploads as an artifact and summarises on the run's own page.
//
// Every package's mode and its reason come straight from planTestRun's own
// decision (scripts/lib/test-selection.mjs), so the record cannot disagree with
// what ran. What Vitest did with that mode comes from the report each package's
// process writes (scripts/lib/vitest-record-reporter.mjs): every test file it
// knows of, which ones ran and how they ended, and the import edges it walked
// from the ones it ran. A package whose process died before writing one has no
// report, and the record says so rather than guessing which files ran.
//
// Pure: no git, no filesystem, no process.env - the same split test-selection.mjs
// keeps, so each rule here is asserted by `node --test` without a checkout.
//

import { mergeFailedTests } from './failed-tests.mjs';
import { isNonProduct } from './what-changed.mjs';

/** `unit`, `integration` or `contract` from a test file's place under `tests/`, `other` for anywhere else. */
export function testLevel(path) {
  const match = /(?:^|\/)tests\/(unit|integration|contract)\//.exec(path);
  return match ? match[1] : 'other';
}

/**
 * Why `testFile` was selected, given `edges` - file to the files it imports,
 * the graph Vitest walked - and the `changed` paths: `{ kind: 'itself' }` where
 * the test file is one of them, else the shortest import chain from the test
 * file to a changed one, `{ kind: 'chain', chain }`. `null` where no path
 * reaches one - Vitest selected it on a trigger this graph does not carry.
 */
export function selectionChain({ edges, changed, testFile }) {
  const changedSet = new Set(changed);
  if (changedSet.has(testFile)) return { kind: 'itself' };
  const previous = new Map([[testFile, null]]);
  const queue = [testFile];
  for (let head = 0; head < queue.length; head++) {
    const file = queue[head];
    for (const dep of edges[file] ?? []) {
      if (previous.has(dep)) continue;
      previous.set(dep, file);
      if (changedSet.has(dep)) {
        const chain = [];
        for (let step = dep; step !== null; step = previous.get(step)) chain.unshift(step);
        return { kind: 'chain', chain };
      }
      queue.push(dep);
    }
  }
  return null;
}

/**
 * One package's entry. `report` is what its Vitest process wrote -
 * `{ all, ran: [{ file, state }], edges }` - or null where it wrote none.
 * A `full` package runs everything it lists, so no file in it carries a chain:
 * the package's own reason stands for all of them.
 */
function packageEntry(pkg, report, changed) {
  const base = { name: pkg.name, dir: pkg.dir, mode: pkg.mode, reason: pkg.reason };
  if (!report) return { ...base, report: 'none', files: [] };

  const outcomes = new Map(report.ran.map(({ file, state }) => [file, state]));
  const files = [...new Set([...report.all, ...outcomes.keys()])].sort().map((path) => {
    const state = outcomes.get(path);
    const entry = { path, level: testLevel(path), status: state === undefined ? 'not run' : state === 'failed' ? 'failed' : 'passed' };
    if (state !== undefined && pkg.mode === 'changed') entry.selectedBy = selectionChain({ edges: report.edges ?? {}, changed, testFile: path });
    return entry;
  });
  return { ...base, report: 'written', files };
}

/**
 * The whole record. `plan` is planTestRun's answer, `reports` maps a package's
 * name to its report (absent for a package that wrote none), `changedFiles`
 * what the diff named - empty where it could not be read.
 */
export function buildRecord({ event, baseCommit, changedFiles, plan, reports }) {
  const changed = changedFiles.filter((path) => !isNonProduct(path));
  return {
    event,
    baseCommit: baseCommit ?? null,
    changedFiles: changedFiles.map((path) => ({ path, ignored: isNonProduct(path) })),
    packages: plan.packages.map((pkg) => packageEntry(pkg, reports[pkg.name] ?? null, changed)),
    // Every package's failed tests, capped together (failed-tests.mjs).
    ...mergeFailedTests(plan.packages.map((pkg) => reports[pkg.name])),
  };
}

function reasonText(reason) {
  if (!reason) return '';
  return reason.path ? `${reason.rule} (\`${reason.path}\`)` : reason.rule;
}

function chainText(selectedBy) {
  if (!selectedBy) return 'selected by Vitest; no import chain found';
  if (selectedBy.kind === 'itself') return 'itself changed';
  return selectedBy.chain.map((path) => `\`${path}\``).join(' → ');
}

/** The record as Markdown for a run's step summary. */
export function renderSummary(record) {
  const lines = ['## Test selection', ''];
  lines.push(record.baseCommit ? `Base commit \`${record.baseCommit.slice(0, 7)}\` · event \`${record.event || 'unknown'}\`` : `No base commit · event \`${record.event || 'unknown'}\``, '');

  if (record.changedFiles.length > 0) {
    lines.push('**Changed files**', '');
    for (const { path, ignored } of record.changedFiles) lines.push(`- \`${path}\`${ignored ? ' (ignored)' : ''}`);
    lines.push('');
  }

  lines.push('| Package | Mode | Reason | Ran | Not run | Failed |', '|---|---|---|---|---|---|');
  for (const pkg of record.packages) {
    const count = (status) => pkg.files.filter((file) => file.status === status).length;
    const counts = pkg.report === 'none' ? ['no report', 'no report', 'no report'] : [count('passed') + count('failed'), count('not run'), count('failed')];
    lines.push(`| ${pkg.name} | ${pkg.mode} | ${reasonText(pkg.reason)} | ${counts.join(' | ')} |`);
  }
  lines.push('');

  for (const pkg of record.packages) {
    const ran = pkg.files.filter((file) => file.status !== 'not run');
    if (pkg.mode !== 'changed' || ran.length === 0) continue;
    lines.push(`<details><summary>${pkg.name}: why each file ran</summary>`, '');
    for (const file of ran) lines.push(`- \`${file.path}\` (${file.level}${file.status === 'failed' ? ', failed' : ''}): ${chainText(file.selectedBy)}`);
    lines.push('', '</details>', '');
  }

  return lines.join('\n');
}

/**
 * The tests that took more than half their own timeout ("Hold the clock rule at
 * every tier, and list the slow tests", issue 1425), from the per-package
 * reports. A report's `timings` are `{ file, name, duration, timeout }` for
 * every test that ran, `timeout` being the one that test ran under: its own, or
 * else the config's, so a test is never judged against a limit it did not have.
 * A package with no report is `unread`, never "none slow".
 *
 * Listed whatever the outcome and never a failure: runner load swings durations.
 */
export function slowTests(packageNames, reports) {
  const slow = [];
  const unread = [];
  for (const pkg of packageNames) {
    const report = reports[pkg];
    if (!report || !Array.isArray(report.timings)) {
      unread.push(pkg);
      continue;
    }
    for (const { file, name, duration, timeout } of report.timings) {
      if (timeout > 0 && duration > timeout / 2) slow.push({ pkg, file, name, duration, timeout });
    }
  }
  return { slow, unread };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** The slow tests as Markdown for the step summary. */
export function renderSlowTests({ slow, unread }) {
  const lines = ['## Slow tests', ''];
  if (slow.length === 0) lines.push('No test took more than half its timeout.', '');
  else {
    lines.push(`${slow.length} took more than half their timeout (listed, not failed; runner load swings durations).`, '', '| Package | File | Test | Took | Timeout |', '|---|---|---|---|---|');
    for (const { pkg, file, name, duration, timeout } of slow) lines.push(`| ${pkg} | \`${file}\` | ${name.replace(/\|/g, '\\|')} | ${seconds(duration)} | ${seconds(timeout)} |`);
    lines.push('');
  }
  if (unread.length > 0) lines.push(`Could not read the report of ${unread.join(', ')}, so its tests are not judged.`, '');
  return lines.join('\n');
}

/** The single warning line for the pull request, or null with none slow. */
export function slowTestsWarning({ slow }) {
  return slow.length === 0 ? null : `::warning::${slow.length} test${slow.length === 1 ? '' : 's'} took more than half their timeout; see the Slow tests section of the step summary.`;
}
