//
// What CI's E2E (F3) job selected, and why ("Show E2E in the test selection
// report", issue 541): the browser tier's counterpart to scripts/lib/test-record.mjs,
// which scripts/ci-e2e.mjs writes beside the run, uploads as an artifact and
// summarises on the run's own page.
//
// The record has the shape test-record.mjs's has, with the whole tier as one
// package (`e2e`) and each spec file as one of its files, so tools/selection
// reads either with the same functions. What differs is why a file ran: not an
// import chain but `{ kind: 'concept', owners }`, the product area that owns its
// walks and the changed file that area owns (planE2eRun's `changedBy`). A `full`
// run carries the plan's own `{ rule, path }` and no per-file reason.
//
// Pure: no git, no filesystem, no process.env, so each rule is asserted by
// `node --test` without a browser.
//

import { isNonProduct } from './what-changed.mjs';

const SPECS = 'tests/e2e/';

/** Every spec file the Playwright JSON report (`--reporter=json`) records a failed walk in, as the path the listing gives: relative to tests/e2e. */
export function failedSpecFiles(report) {
  const failed = new Set();
  const visit = (suite, file) => {
    for (const spec of suite.specs ?? []) if (spec.ok === false) failed.add(file);
    for (const child of suite.suites ?? []) visit(child, file);
  };
  for (const file of report?.suites ?? []) visit(file, file.file ?? file.title ?? '');
  return failed;
}

/**
 * The whole record. `plan` is planE2eRun's answer, `walks` the tier's listing
 * (walksIn), `report` what Playwright's JSON reporter wrote - null where the
 * process died before writing one - and `changedFiles` what the diff named.
 *
 * A spec file ran where the plan is `full`, or where any walk in it sits under a
 * selected area, which is what `--grep` matches. A run that started and left no
 * report says so (`report: 'none'`) rather than guessing which files failed.
 */
export function buildE2eRecord({ event, baseCommit, changedFiles, plan, walks, report }) {
  const selecting = plan.mode === 'selected';
  const areas = new Set(selecting ? plan.areas : []);
  const started = !selecting || areas.size > 0;
  const failed = failedSpecFiles(report);

  const areasByFile = new Map();
  for (const walk of walks) {
    if (!areasByFile.has(walk.where)) areasByFile.set(walk.where, new Set());
    areasByFile.get(walk.where).add(walk.area);
  }

  const files = started && !report ? [] : [...areasByFile.keys()].sort().map((where) => {
    const own = [...areasByFile.get(where)];
    const selectedAreas = own.filter((area) => areas.has(area)).sort();
    const ran = !selecting || selectedAreas.length > 0;
    const entry = { path: `${SPECS}${where}`, level: 'e2e', status: !ran ? 'not run' : failed.has(where) ? 'failed' : 'passed' };
    if (selecting && ran) entry.selectedBy = { kind: 'concept', owners: selectedAreas.map((concept) => ({ concept, path: plan.changedBy?.[concept] ?? null })) };
    return entry;
  });

  return {
    event,
    baseCommit: baseCommit ?? null,
    changedFiles: changedFiles.map((path) => ({ path, ignored: isNonProduct(path) })),
    packages: [
      {
        name: 'e2e',
        dir: 'tests/e2e',
        mode: selecting ? 'changed' : 'full',
        reason: selecting ? null : plan.forced,
        report: started && !report ? 'none' : 'written',
        files,
      },
    ],
  };
}

/** A reason in words: `owned by Capture (path)`, joined where a file's walks sit under several selected areas. */
export function ownersText(selectedBy) {
  return selectedBy.owners.map(({ concept, path }) => (path ? `owned by ${concept}, which \`${path}\` changed` : `owned by ${concept}`)).join('; ');
}

function reasonText(reason) {
  if (!reason) return '';
  return reason.path ? `${reason.rule} (\`${reason.path}\`)` : reason.rule;
}

/** The record as Markdown for a run's step summary. */
export function renderE2eSummary(record) {
  const [tier] = record.packages;
  const lines = ['## E2E selection', ''];
  lines.push(record.baseCommit ? `Base commit \`${record.baseCommit.slice(0, 7)}\` · event \`${record.event || 'unknown'}\`` : `No base commit · event \`${record.event || 'unknown'}\``, '');

  if (tier.report === 'none') {
    lines.push(`Mode ${tier.mode}${tier.reason ? ` (${reasonText(tier.reason)})` : ''}. The run left no report, so which specs ran and how they ended is not recorded.`);
    return lines.join('\n');
  }

  const count = (status) => tier.files.filter((file) => file.status === status).length;
  lines.push('| Mode | Reason | Ran | Not run | Failed |', '|---|---|---|---|---|');
  lines.push(`| ${tier.mode} | ${reasonText(tier.reason)} | ${count('passed') + count('failed')} | ${count('not run')} | ${count('failed')} |`, '');

  if (tier.files.length > 0) {
    lines.push('| Spec | Result | Why |', '|---|---|---|');
    for (const file of tier.files) {
      const why = file.status === 'not run' ? '' : tier.mode === 'full' ? 'every spec ran' : ownersText(file.selectedBy);
      lines.push(`| \`${file.path}\` | ${file.status} | ${why} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
