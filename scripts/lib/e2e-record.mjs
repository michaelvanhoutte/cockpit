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
// walks and the changed file that area owns (planE2eRun's `changedBy`), with the
// registered file that placed it (`via`) where the changed file was placed by its
// importers. A changed file that selected no walk is named in the tier's
// `unplaced` with the rule, so a miss is readable. A `full` run carries the
// plan's own `{ rule, path }` and no per-file reason.
//
// Pure: no git, no filesystem, no process.env, so each rule is asserted by
// `node --test` without a browser.
//

import { mergeFailedTests, playwrightFailedTests } from './failed-tests.mjs';
import { isNonProduct } from './what-changed.mjs';
import { SPECS } from './test-selection.mjs';

/** Why a changed file selected no walk, as the record keeps it. */
export const NOTHING_IMPORTS_IT = 'nothing imports it';

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

/** How many shards the tier runs as. The workflow's matrix lists the same indices; a test holds the two together. */
export const E2E_SHARDS = 4;

/** The shard `E2E_SHARD` names (`2/4`): `{ index, total }`, or `null` where the variable is unset and the whole tier runs in one process. */
export function parseShard(value) {
  if (value === undefined || value === '') return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index < 1 || index > total) throw new Error(`E2E_SHARD reads like 2/4, a shard and how many there are, not "${value}"`);
  return { index, total };
}

/** The spec files a Playwright JSON report holds a walk in: for a shard's report, the files it was dealt. */
function filesIn(report) {
  return new Set((report?.suites ?? []).map((file) => file.file ?? file.title ?? ''));
}

/** How many walks the report holds, those a walk skips itself (a phone has no Connections) included, so the shards' counts add up to the suite's; `null` where the process left no report. */
function walksDealt(report) {
  const stats = report?.stats;
  return stats ? stats.expected + stats.unexpected + stats.flaky + (stats.skipped ?? 0) : null;
}

/**
 * The whole record. `plan` is planE2eRun's answer, `walks` the tier's listing
 * (walksIn), `report` what Playwright's JSON reporter wrote - null where the
 * process died before writing one - and `changedFiles` what the diff named.
 *
 * A spec file ran where the plan is `full`, or where any walk in it sits under a
 * selected area, which is what `--grep` matches. A run that started and left no
 * report says so (`report: 'none'`) rather than guessing which files failed.
 *
 * A `shard` (parseShard) ran only the walks Playwright dealt it, so there a file
 * ran where the report holds a walk of it, and the record carries the shard and
 * how many walks it was dealt for mergeE2eRecords.
 */
export function buildE2eRecord({ event, baseCommit, changedFiles, plan, walks, report, shard = null }) {
  const selecting = plan.mode === 'selected';
  const areas = new Set(selecting ? plan.areas : []);
  const started = !selecting || areas.size > 0;
  const failed = failedSpecFiles(report);
  const dealt = shard ? filesIn(report) : null;

  const areasByFile = new Map();
  for (const walk of walks) {
    if (!areasByFile.has(walk.where)) areasByFile.set(walk.where, new Set());
    areasByFile.get(walk.where).add(walk.area);
  }

  const files = started && !report ? [] : [...areasByFile.keys()].sort().map((where) => {
    const own = [...areasByFile.get(where)];
    const selectedAreas = own.filter((area) => areas.has(area)).sort();
    const ran = (!selecting || selectedAreas.length > 0) && (!dealt || dealt.has(where));
    const entry = { path: `${SPECS}${where}`, level: 'e2e', status: !ran ? 'not run' : failed.has(where) ? 'failed' : 'passed' };
    if (selecting && ran) {
      entry.selectedBy = {
        kind: 'concept',
        owners: selectedAreas.map((concept) => {
          const owner = { concept, path: plan.changedBy?.[concept] ?? null };
          if (plan.via?.[concept]) owner.via = plan.via[concept];
          return owner;
        }),
      };
    }
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
        unplaced: selecting ? (plan.unplaced ?? []).map((path) => ({ path, rule: NOTHING_IMPORTS_IT })) : [],
        files,
      },
    ],
    // The walks that failed, by name and project, filed under their spec (failed-tests.mjs).
    ...playwrightFailedTests(report, (file) => `${SPECS}${file}`),
    // A selection that starts nothing deals nothing; only a run that started and left no report leaves the count unknown.
    ...(shard ? { shard: { ...shard, walks: started ? walksDealt(report) : 0 } } : {}),
  };
}

const RANK = { 'not run': 0, passed: 1, failed: 2 };

/**
 * The shards' records as the one record the selection report and the cycle-time
 * report read: a spec ran if any shard ran it and failed if any failed, and the
 * plan and the changed files are carried once, from the first shard's, since
 * every shard plans the same diff. `records` are what each shard wrote
 * (buildE2eRecord with a shard), in any order, and fewer than `total` is allowed.
 *
 * A shard that left no record, or whose run left no report, makes the whole say
 * so (`report: 'none'`, as a run with no report does) rather than say its specs
 * did not run: a spec's walks are dealt across shards, so what the others
 * reported cannot say how it ended. `shards` names each one's own state.
 *
 * `null` where no shard left a record, for a diff that ran none.
 */
export function mergeE2eRecords(records, total = E2E_SHARDS) {
  const byIndex = new Map();
  for (const record of records) if (record?.shard && !byIndex.has(record.shard.index)) byIndex.set(record.shard.index, record);
  if (byIndex.size === 0) return null;

  const first = byIndex.get(Math.min(...byIndex.keys()));
  const shards = Array.from({ length: total }, (_, at) => {
    const record = byIndex.get(at + 1);
    return record ? { index: at + 1, report: record.packages[0].report, walks: record.shard.walks } : { index: at + 1, report: 'missing', walks: null };
  });
  const complete = shards.every((shard) => shard.report === 'written');

  const merged = new Map();
  if (complete) {
    for (const record of byIndex.values()) {
      for (const file of record.packages[0].files) {
        const known = merged.get(file.path);
        if (!known) merged.set(file.path, { ...file });
        else {
          if (RANK[file.status] > RANK[known.status]) known.status = file.status;
          if (!known.selectedBy && file.selectedBy) known.selectedBy = file.selectedBy;
        }
      }
    }
  }

  const { shard: _shard, ...rest } = first;
  // The failed walks of every shard, whether or not the whole is complete: a shard that did write one names what failed in it.
  const failed = mergeFailedTests([...byIndex.entries()].sort(([a], [b]) => a - b).map(([, record]) => record));
  return { ...rest, ...failed, packages: [{ ...first.packages[0], report: complete ? 'written' : 'none', files: [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) }], shards };
}

/** The shard a job of the E2E (F3) family is, from its name (`E2E (F3) (2)`), or `null` for any other job, the fan-in included. */
const SHARD_JOB = /^E2E \(F3\) \((\d+)\)$/;

/** A job status GitHub reports before there is a conclusion. */
const UNFINISHED = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

/** Each shard's result from the run's jobs (GitHub's `jobs` list): `{ index, result }`, where an unfinished job's result is its status. */
export function shardResults(jobs) {
  return jobs.flatMap((job) => {
    const match = SHARD_JOB.exec(job.name);
    return match ? [{ index: Number(match[1]), result: job.conclusion ?? job.status }] : [];
  });
}

/** What each shard read as, `{ index, read }` for 1 to `total`: its result, or `missing` where the jobs list does not show it. */
export function shardReads(results, total = E2E_SHARDS) {
  return Array.from({ length: total }, (_, at) => ({ index: at + 1, read: results.find((one) => one.index === at + 1)?.result ?? 'missing' }));
}

/** The shards among 1 to `total` that read as missing or unfinished, which the fan-in reads the jobs list again for. */
export function unsettledShards(results, total = E2E_SHARDS) {
  return shardReads(results, total).filter(({ read }) => read === 'missing' || UNFINISHED.has(read)).map(({ index }) => index);
}

/** Shard numbers as words, runs of three or more as a range: `shards 1 to 3, 5`. */
function shardsText(indices) {
  const runs = [];
  for (const index of indices) {
    const last = runs.at(-1);
    if (last && last.to === index - 1) last.to = index;
    else runs.push({ from: index, to: index });
  }
  const parts = runs.flatMap(({ from, to }) => (to - from >= 2 ? [`${from} to ${to}`] : Array.from({ length: to - from + 1 }, (_, at) => String(from + at))));
  return `shard${indices.length === 1 ? '' : 's'} ${parts.join(', ')}`;
}

/** What the shards read as, grouped: `shards 1 to 3 read as success, shard 4 read as in_progress`. */
export function readsText(reads) {
  const groups = new Map();
  for (const { index, read } of reads) groups.set(read, [...(groups.get(read) ?? []), index]);
  return [...groups].map(([read, indices]) => `${shardsText(indices)} read as ${read}`).join(', ');
}

/**
 * What the fan-in answers for the shards: `{ ok, message }`. `results` are the
 * shards' own (shardResults), `null` where they could not be read, and
 * `aggregate` is the matrix's own verdict (`needs.e2e.result`), which still
 * fails the fan-in where it says so and is all there is without `results`.
 * A shard that passed or was skipped, as on a documentation-only diff, is a
 * pass; anything else is named. A shard the jobs list does not show, or shows
 * unfinished, is unknown rather than wrong (a re-run lists only the attempt's
 * own jobs, and a conclusion can trail the matrix's), so it fails only where
 * there is no `aggregate` to say how the shards ended. Where the matrix says
 * it failed and no shard is named for it, the message says what each shard read
 * as, so the verdict is never a bare aggregate while there are results.
 */
export function e2eVerdict({ results, aggregate = null, total = E2E_SHARDS }) {
  const problems = [];
  if (results) {
    for (let index = 1; index <= total; index += 1) {
      const result = results.find((one) => one.index === index)?.result;
      const unknown = result === undefined || UNFINISHED.has(result);
      if (unknown) {
        if (aggregate === null) problems.push(result === undefined ? `shard ${index} has no result` : `shard ${index} ended ${result}`);
      } else if (result === 'cancelled') problems.push(`shard ${index} was cancelled`);
      else if (result === 'failure') problems.push(`shard ${index} failed`);
      else if (result !== 'success' && result !== 'skipped') problems.push(`shard ${index} ended ${result}`);
    }
  }
  if (problems.length === 0 && aggregate !== null && aggregate !== 'success' && aggregate !== 'skipped') problems.push(results ? `the shards ended ${aggregate}; ${readsText(shardReads(results, total))}` : `the shards ended ${aggregate}`);
  return problems.length === 0 ? { ok: true, message: `All ${total} shards passed.` } : { ok: false, message: `${problems.join('; ')}.`.replace(/^./, (letter) => letter.toUpperCase()) };
}

/** A reason in words: `owned by Capture (path)`, joined where a file's walks sit under several selected areas. A changed file placed by its importers names the registered file that owns the area. */
export function ownersText(selectedBy) {
  return selectedBy.owners
    .map(({ concept, path, via }) => {
      if (!path) return `owned by ${concept}`;
      return via ? `owned by ${concept}, through \`${via}\`, which depends on \`${path}\`, changed` : `owned by ${concept}, which \`${path}\` changed`;
    })
    .join('; ');
}

/** The files a changed file placed nothing from, in words: `` `path` selected no walk: nothing imports it``. */
export function unplacedText(unplaced) {
  return unplaced.map(({ path, rule }) => `\`${path}\` selected no walk: ${rule}`);
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

  const shards = record.shards ?? [];
  if (tier.report === 'none') {
    const left = shards.filter((shard) => shard.report !== 'written').map((shard) => `Shard ${shard.index} left no ${shard.report === 'missing' ? 'record' : 'report'}`);
    const why = left.length > 0 ? left.join(', ') : 'The run left no report';
    lines.push(`Mode ${tier.mode}${tier.reason ? ` (${reasonText(tier.reason)})` : ''}. ${why}, so which specs ran and how they ended is not recorded.`);
    return lines.join('\n');
  }
  if (shards.length > 0) lines.push(`${shards.reduce((sum, shard) => sum + (shard.walks ?? 0), 0)} walks over ${shards.length} shards (${shards.map((shard) => shard.walks ?? 'unknown').join(', ')}).`, '');

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

  if (tier.unplaced?.length > 0) lines.push(...unplacedText(tier.unplaced).map((text) => `- ${text}`), '');

  return lines.join('\n');
}
