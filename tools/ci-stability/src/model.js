/**
 * The numbers, and nothing else. Takes the normalized runs and jobs github.js
 * fetched and returns the model the renderer draws: no I/O, and no clock of its
 * own — `now` is a parameter, so a window boundary is something a test can put
 * anywhere it likes.
 *
 * The rule the whole file turns on: **a rate counts only what finished.**
 * `cancel-in-progress` cancels about a quarter of main's jobs, and a cancelled
 * job is not a failed one — folding the two together would have reported the
 * browser tier at 70% when it was passing 93% of the runs it was allowed to
 * finish. Everything excluded is still counted, under its own name, so the
 * page can show what it left out instead of quietly shrinking a denominator.
 */

const DAY_MS = 86_400_000;

/**
 * Every conclusion the Actions API documents, and what it means for a rate.
 * `other` is known-but-not-a-verdict; `unknown` is a value that did not exist
 * when this was written. Both stay out of the rate and both get surfaced —
 * silently counting a new conclusion as success is the one way this report
 * could lie in the reassuring direction.
 */
const CONCLUSIONS = new Map([
  ['success', 'pass'],
  ['failure', 'fail'],
  ['timed_out', 'fail'],
  ['startup_failure', 'fail'],
  ['cancelled', 'cancelled'],
  ['skipped', 'skipped'],
  ['neutral', 'other'],
  ['action_required', 'other'],
  ['stale', 'other'],
]);

/** @param {{ status?: string, conclusion?: string|null }} item */
export function classify({ status, conclusion }) {
  if (status && status !== 'completed') return 'running';
  if (conclusion === null || conclusion === undefined) return 'running';
  return CONCLUSIONS.get(conclusion) ?? 'unknown';
}

/**
 * @param {string[]} outcomes
 * @returns {{ pass: number, fail: number, cancelled: number, skipped: number,
 *   running: number, other: number, unknown: number, completed: number, rate: number|null }}
 *   `rate` is null rather than 0 when nothing completed — a job nobody has finished yet
 *   has no reliability, and rendering that as 0% would put a brand new job at the top of
 *   a worst-first list.
 */
export function tally(outcomes) {
  const counts = { pass: 0, fail: 0, cancelled: 0, skipped: 0, running: 0, other: 0, unknown: 0 };
  for (const outcome of outcomes) counts[outcome] += 1;
  const completed = counts.pass + counts.fail;
  return { ...counts, completed, rate: completed === 0 ? null : counts.pass / completed };
}

/**
 * Median and p90 of a set of durations, in milliseconds.
 *
 * Median averages the middle pair on an even count, so it is defined for every
 * non-empty input; p90 is nearest-rank, so it is always a duration that really
 * happened. One value is therefore both, which is the honest answer for a job
 * that has run once.
 */
export function quantiles(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
  const rank = Math.max(1, Math.ceil(0.9 * sorted.length));
  return { median, p90: sorted[rank - 1], count: sorted.length };
}

/**
 * A shard job is named for its family and its index, `E2E (F3) (1)` (what GitHub names a matrix
 * job called `E2E (F3)` over a `shard` dimension), and the family is the fan-in job named exactly
 * `E2E (F3)` that needs every shard. The family's name ends in something other than a number, so
 * `E2E (F3)` itself is never read as a shard. The cycle-time report reads the same convention.
 */
const SHARD_NAME = /^(.+) \((\d+)\)$/;

/**
 * The jobs of one run with every shard family counted as one job under the family's name: the
 * fan-in's verdict, one occurrence per run, and a duration from the first shard's start to the
 * last shard's end. That duration is `null` where a shard did not run to a finish or the family
 * is not whole (a shard missing from the list, or no fan-in) — never the span of the shards that
 * were read. A family with no fan-in is `other` unless a shard failed, so a partial list never
 * reads as a pass. The failing step is the failing shard's.
 *
 * @param {import('./github.js').Job[]} jobs the jobs of one run
 */
function foldFamilies(jobs) {
  const shards = jobs.filter((job) => SHARD_NAME.test(job.name));
  if (shards.length === 0) return jobs;

  const families = new Map();
  for (const shard of shards) {
    const [, family, index] = SHARD_NAME.exec(shard.name);
    if (!families.has(family)) families.set(family, []);
    families.get(family).push({ shard, index: Number(index) });
  }

  const folded = [];
  const replaced = new Set(shards);
  for (const [family, members] of families) {
    const fanIn = jobs.find((job) => job.name === family) ?? null;
    if (fanIn) replaced.add(fanIn);
    const indices = members.map((member) => member.index).sort((a, b) => a - b);
    const whole = fanIn !== null && indices.every((index, position) => index === position + 1);
    const finished = members.every(({ shard }) => (classify(shard) === 'pass' || classify(shard) === 'fail') && durationMs(shard) !== null);
    const failing = members.find(({ shard }) => classify(shard) === 'fail')?.shard ?? null;
    // A fan-in skipped behind a failed shard says nothing, so the shard's failure stands in for it.
    const base = (fanIn && !(failing && classify(fanIn) === 'skipped') ? fanIn : null) ?? { runId: members[0].shard.runId, name: family, conclusion: failing ? 'failure' : 'neutral', status: 'completed', url: members[0].shard.url, steps: [] };
    folded.push({
      ...base,
      name: family,
      // The span of the whole family, or nothing: a figure over the shards that were read would be a shorter family.
      familyMs: whole && finished ? Math.max(...members.map(({ shard }) => Date.parse(shard.completedAt))) - Math.min(...members.map(({ shard }) => Date.parse(shard.startedAt))) : null,
      ...(failing ? { failedStep: failing.failedStep ?? base.failedStep, url: failing.url ?? base.url } : {}),
    });
  }
  return [...jobs.filter((job) => !replaced.has(job)), ...folded];
}

function durationMs(job) {
  if (job.familyMs !== undefined) return job.familyMs;
  if (!job.startedAt || !job.completedAt) return null;
  const ms = new Date(job.completedAt) - new Date(job.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** A step's duration, or null when it did not run to a finish with timings of its own. */
function stepDurationMs(step) {
  if (step.conclusion === 'skipped' || step.conclusion === 'cancelled') return null;
  return durationMs(step);
}

/**
 * Each step of a job, keyed by its name and its occurrence of that name within
 * the job run (the 1st "Upload", the 2nd "Upload"). GitHub numbers steps 1..N
 * without gaps, so a number shifts whenever a step is inserted and cannot be a
 * key. Rows are ordered by the median of the step's position across the runs
 * that have it, ties by name then occurrence, so a step since removed from the
 * job still sits where it used to. Takes only the job's finished runs, as for
 * the job's own durations: a cancelled job's steps are truncated, and a step
 * seen only there has no row. A step nothing was counted for stays listed with
 * `durations: null` — no data, not 0.
 */
function stepDurations(finishedJobs) {
  const samples = [];
  for (const jobRun of finishedJobs) {
    const seen = new Map();
    (jobRun.steps ?? []).forEach((step, position) => {
      const name = step.name ?? '';
      const occurrence = (seen.get(name) ?? 0) + 1;
      seen.set(name, occurrence);
      samples.push({ name, occurrence, position, ms: stepDurationMs(step) });
    });
  }
  return [...group(samples, (x) => `${x.name}\u0000${x.occurrence}`).values()]
    .map((rows) => ({
      name: rows[0].name,
      occurrence: rows[0].occurrence,
      at: quantiles(rows.map((x) => x.position)).median,
      durations: quantiles(rows.map((x) => x.ms).filter((ms) => ms !== null)),
    }))
    .sort((x, y) => x.at - y.at || x.name.localeCompare(y.name) || x.occurrence - y.occurrence)
    .map(({ name, occurrence, durations }) => ({ name, occurrence, durations }));
}

const byCreatedAsc = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);

/**
 * How long the branch stayed red, per stretch: from the run that failed to the
 * next one that passed.
 *
 * Only a pass closes a window and only a failure opens one, so a cancelled run
 * in between does neither — it is not evidence either way, and treating it as a
 * pass would report the branch green while it was still broken. Consecutive
 * failures are one window rather than several, because "how long was it red"
 * is a question about the stretch, not about each run in it.
 *
 * @param {{ now: Date }} options
 */
export function redWindows(runs, { now }) {
  const windows = [];
  let open = null;

  for (const run of [...runs].sort(byCreatedAsc)) {
    const outcome = classify(run);
    if (outcome === 'fail') {
      if (!open) open = { from: run, shas: new Set() };
      open.shas.add(run.headSha);
    } else if (outcome === 'pass' && open) {
      windows.push(closeWindow(open, run, null));
      open = null;
    }
  }

  if (open) windows.push(closeWindow(open, null, now));
  return windows;
}

function closeWindow(open, until, now) {
  const from = new Date(open.from.createdAt);
  const end = until ? new Date(until.createdAt) : now;
  return {
    workflow: open.from.workflow,
    from: open.from.createdAt,
    fromUrl: open.from.url,
    until: until ? until.createdAt : null,
    untilUrl: until ? until.url : null,
    ongoing: !until,
    ms: end - from,
    commits: open.shas.size,
  };
}

/**
 * The most recent of `entries` that passed or failed, by time rather than by
 * list position, or null when none did. A cancelled, skipped, running or
 * unrecognised one is passed over for the same reason the rates leave it out:
 * a cancellation must not hide a red that is still the latest verdict.
 *
 * @param {{ outcome: string, at: string, url: string }[]} entries
 */
function lastFinished(entries) {
  let last = null;
  for (const entry of entries) {
    if (entry.outcome !== 'pass' && entry.outcome !== 'fail') continue;
    if (!last || new Date(entry.at) > new Date(last.at)) last = entry;
  }
  return last && { outcome: last.outcome, at: last.at, url: last.url };
}

/**
 * Each workflow's and each job's last run, over every run fetched rather than
 * per window — "did it pass the last time it ran" is not a question about 7 or
 * 30 days. A job's is its own, so it can come from an older run than its
 * workflow's when the latest run skipped it. A job takes its run's time: the
 * order of two jobs by name is the order of their runs.
 */
function lastRuns(runs, jobsByRun) {
  return [...group(runs, (run) => run.workflow).entries()].map(([name, workflowRuns]) => {
    const jobRuns = workflowRuns.flatMap((run) =>
      (jobsByRun.get(run.id) ?? []).map((job) => ({
        name: job.name,
        outcome: classify(job),
        at: run.createdAt,
        url: job.url,
      })),
    );
    return {
      name,
      last: lastFinished(
        workflowRuns.map((run) => ({ outcome: classify(run), at: run.createdAt, url: run.url })),
      ),
      jobs: [...group(jobRuns, (entry) => entry.name).entries()].map(([jobName, entries]) => ({
        name: jobName,
        last: lastFinished(entries),
      })),
    };
  });
}

/** Worst first, and a job nobody has finished sorts last rather than first. */
function byReliability(a, b) {
  const ra = a.tally.rate;
  const rb = b.tally.rate;
  if (ra === null && rb === null) return a.name.localeCompare(b.name);
  if (ra === null) return 1;
  if (rb === null) return -1;
  if (ra !== rb) return ra - rb;
  if (a.tally.completed !== b.tally.completed) return b.tally.completed - a.tally.completed;
  return a.name.localeCompare(b.name);
}

function group(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

/**
 * One window's picture: every workflow that ran in it, and every job inside
 * each.
 *
 * A job is grouped by its name, so a job added part-way through the window
 * rates over the runs it actually appeared in rather than over all of them —
 * and a job that was *renamed* becomes two rows rather than one merged one.
 * That is the accepted cost of having no stable identity for a job: its name
 * is all the API gives, and inventing continuity across a rename would be a
 * guess rendered as a fact.
 */
function windowModel(runs, jobsByRun, { days, now, oldestRun, reachedWindowEdge, fetchedDays }) {
  const since = new Date(now.getTime() - days * DAY_MS);
  const inWindow = runs.filter((run) => new Date(run.createdAt) >= since);

  const workflows = [...group(inWindow, (run) => run.workflow).entries()]
    .map(([name, workflowRuns]) => {
      const jobs = workflowRuns.flatMap((run) => jobsByRun.get(run.id) ?? []);
      return {
        name,
        tally: tally(workflowRuns.map(classify)),
        runs: workflowRuns.length,
        jobs: [...group(jobs, (job) => job.name).entries()]
          .map(([jobName, jobRuns]) => {
            const outcomes = jobRuns.map(classify);
            const finished = jobRuns.filter((_, i) => outcomes[i] === 'pass' || outcomes[i] === 'fail');
            return {
              name: jobName,
              tally: tally(outcomes),
              durations: quantiles(
                finished.map(durationMs).filter((ms) => ms !== null),
              ),
              steps: stepDurations(finished),
            };
          })
          .sort(byReliability),
      };
    })
    .sort(byReliability);

  // A window is partial when history does not reach back to its start — a
  // 30-day column over eleven days of data is an eleven-day column, and saying
  // otherwise would make a young repository look like a stable one.
  //
  // The oldest run fetched cannot answer that on its own: every run the fetch
  // returned satisfies `createdAt >= since` by construction, so "the oldest one
  // is inside the window" is true of a year of history as much as of a week,
  // and reading it alone would banner every report as partial. `reachedWindowEdge`
  // is the evidence — a run *older* than the window was actually seen — and the
  // oldest run then only narrows which of the shorter windows it applies to.
  //
  // That evidence is about the *fetch*, though, so it says nothing about a
  // window wider than the fetch was: `--days 7` with the default `7,30` reaches
  // the edge of its seven days and would otherwise render a plain "30 days"
  // heading over seven days of runs. A window can only be whole if the fetch
  // went at least as far back as the window does.
  const coveredByFetch = reachedWindowEdge && days <= fetchedDays;
  const partial = !coveredByFetch && oldestRun !== null && oldestRun > since;
  return {
    days,
    since: since.toISOString(),
    partial,
    actualDays: partial ? (now - oldestRun) / DAY_MS : days,
    runs: inWindow.length,
    workflows,
  };
}

/**
 * @param {object} input
 * @param {import('./github.js').Run[]} input.runs
 * @param {import('./github.js').Job[]} input.jobs
 * @param {Date} input.now
 * @param {number} input.requestedDays how far back the fetch was asked to go
 * @param {boolean} input.truncated whether the run budget stopped the fetch short
 * @param {boolean} [input.reachedWindowEdge] whether a run older than the requested window
 *   was seen — the only evidence that history reaches back past it
 * @param {number} [input.ignored] runs dropped for belonging to no workflow file
 * @param {number[]} [input.windows] the windows to report, in days
 * @param {number} [input.failureLimit] how many recent failures to list
 */
export function buildModel({
  runs,
  jobs,
  now,
  requestedDays,
  truncated,
  reachedWindowEdge = false,
  ignored = 0,
  repo,
  branch = 'main',
  commit = null,
  windows = [7, 30],
  failureLimit = 15,
}) {
  // A shard family is one job, so its shards are in no row, last run or failure of their own.
  const jobsByRun = new Map([...group(jobs, (job) => job.runId)].map(([runId, own]) => [runId, foldFamilies(own)]));
  const oldest = runs.length
    ? new Date(Math.min(...runs.map((run) => new Date(run.createdAt).getTime())))
    : null;

  const anomalies = [];
  for (const [conclusion, items] of group(
    [...runs, ...jobs].filter((item) => classify(item) === 'unknown'),
    (item) => item.conclusion,
  )) {
    anomalies.push({
      kind: 'unknown-conclusion',
      detail: `${items.length} run${items.length === 1 ? '' : 's'} or job${
        items.length === 1 ? '' : 's'
      } concluded "${conclusion}", which this report does not know how to count.`,
    });
  }

  const failures = runs
    .filter((run) => classify(run) === 'fail')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, failureLimit)
    .map((run) => ({
      runId: run.id,
      workflow: run.workflow,
      createdAt: run.createdAt,
      headSha: run.headSha,
      url: run.url,
      jobs: (jobsByRun.get(run.id) ?? [])
        .filter((job) => classify(job) === 'fail')
        .map((job) => ({ name: job.name, failedStep: job.failedStep, url: job.url })),
    }));

  return {
    repo,
    branch,
    commit,
    generatedAt: now.toISOString(),
    coverage: {
      requestedDays,
      since: new Date(now.getTime() - requestedDays * DAY_MS).toISOString(),
      until: now.toISOString(),
      oldestRun: oldest ? oldest.toISOString() : null,
      actualDays: oldest ? (now - oldest) / DAY_MS : null,
      partial:
        truncated ||
        (!reachedWindowEdge &&
          oldest !== null &&
          oldest > new Date(now.getTime() - requestedDays * DAY_MS)),
      truncated,
      runs: runs.length,
      ignoredRuns: ignored,
    },
    windows: windows.map((days) =>
      windowModel(runs, jobsByRun, {
        days,
        now,
        oldestRun: oldest,
        // A budget that stopped the fetch short leaves history unread, which is
        // the same thing as not having reached the edge of the window.
        reachedWindowEdge: reachedWindowEdge && !truncated,
        fetchedDays: requestedDays,
      }),
    ),
    lastRuns: lastRuns(runs, jobsByRun),
    redWindows: [...group(runs, (run) => run.workflow).values()]
      .flatMap((workflowRuns) => redWindows(workflowRuns, { now }))
      .sort((a, b) => new Date(b.from) - new Date(a.from)),
    recentFailures: failures,
    anomalies,
  };
}
