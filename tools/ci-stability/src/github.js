/**
 * The Actions API, and nothing else. Every number this tool reports is
 * model.js's; this file only fetches and normalizes.
 *
 * `fetchImpl` is a parameter rather than the global so the tests can drive the
 * failures a network actually has — a spent rate limit, a page that stops
 * early — without one.
 *
 * **Cost is what shapes this file.** Job detail is one request per run and
 * `GITHUB_TOKEN` is capped at 1,000 requests an hour per repository, so the
 * request count is the design constraint rather than an afterthought. Thirty
 * days of `main` measured 394 runs on 7 September 2026 once the skipped ones
 * are dropped — they ran no jobs, so there is nothing to ask about, and the
 * mention bot alone is 244 of them. That fits with room to spare. `maxRuns` is
 * what keeps it true if the merge rate climbs: it stops fetching rather than
 * spending the hour's allowance, and reports the shorter window it actually
 * got, so the page can say which period it actually covers rather than claiming
 * the one it was asked for (model.js's coverage).
 */

import { matchArtifact } from '../../cycle-time/src/model.js';
import { readZipJson } from '../../selection/src/zip.js';
import { classify, isDependabot, recordArtifactFor } from './model.js';

const API = 'https://api.github.com';
const RECORD_FILE = 'record.json';
const PER_PAGE = 100;
/** The most runs a filtered list returns, however many pages are asked for. */
const LISTED_AT_MOST = 1_000;

/** Thrown for anything that means the picture would be incomplete. */
export class GitHubError extends Error {
  /** @param {string} message @param {{ status?: number, reason?: string }} [detail] */
  constructor(message, { status, reason } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * @typedef {object} Run
 * @property {number} id
 * @property {string} workflow
 * @property {string} path the workflow file this run belongs to, which is how a run that
 *   belongs to no workflow of ours is told apart — see listRuns.
 * @property {string|null} conclusion
 * @property {string} status
 * @property {string} headSha
 * @property {string} createdAt
 * @property {string} url
 * @property {string|null} event what started it: push, pull_request, schedule, workflow_dispatch ...
 * @property {string|null} branch the branch it ran for
 * @property {number} attempt its latest attempt, 1 for a run never re-run
 * @property {number|null} pullRequest the pull request it ran for, if any
 * @property {string} startedAt when its latest attempt started
 */

/**
 * @typedef {object} Job
 * @property {number} runId
 * @property {string} name
 * @property {string|null} conclusion
 * @property {string} status
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {string|null} failedStep name of the first step that failed, or null when
 *   none is recorded — a job killed by a timeout or a cancellation has no failing step,
 *   and such a job is still listed among the failures rather than given an invented one.
 * @property {Step[]} steps the job's steps in the order it ran them, from the job list
 *   already fetched — no further request
 * @property {string} url
 */

/**
 * @typedef {object} Step
 * @property {number} number its position in the job
 * @property {string} name
 * @property {string|null} conclusion
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, retried only where retrying can help.
 *
 * A report is about four hundred requests, so the interesting number is not the
 * chance of a 502 but the chance of *no* 502 across four hundred of them. A
 * single transient failure would otherwise discard the whole run — and because
 * the CI job is advisory, discard it silently, leaving the published page to go
 * stale with nothing turning red. Only 5xx and a thrown fetch are retried: a
 * 404 or a spent allowance will say the same thing however many times it is
 * asked.
 */
async function request(path, { token, fetchImpl, retries = 2, retryDelayMs = 250 }, parse = (res) => res.json()) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(retryDelayMs * attempt);

    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'cockpit-ci-stability',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (error) {
      lastError = new GitHubError(`Could not reach GitHub for ${path}: ${error.message}`, {
        reason: 'network',
      });
      continue;
    }

    if (res.ok) {
      // A body that breaks off mid-read is a failed request like a thrown fetch, not a bug here.
      try {
        return await parse(res);
      } catch (error) {
        lastError = new GitHubError(`Could not read GitHub's answer for ${path}: ${error.message}`, { reason: 'network' });
        continue;
      }
    }

    // A spent allowance is worth its own message: it is the one failure that is
    // about *us* rather than about GitHub, and the fix (fetch fewer runs, or
    // wait) is different from every other status. Never retried — asking again
    // is what spent it.
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    if ((res.status === 403 || res.status === 429) && remaining === '0') {
      const reset = res.headers?.get?.('x-ratelimit-reset');
      const at = reset ? new Date(Number(reset) * 1000).toISOString() : 'an unknown time';
      throw new GitHubError(
        `GitHub's rate limit is spent; it resets at ${at}. Fetch fewer runs (--max-runs) or wait.`,
        { status: res.status, reason: 'rate-limit' },
      );
    }

    lastError = new GitHubError(`GitHub answered ${res.status} for ${path}`, {
      status: res.status,
      reason: 'http',
    });
    if (res.status < 500) throw lastError;
  }

  throw lastError;
}

/** @returns {Run} */
function normalizeRun(raw) {
  return {
    id: raw.id,
    workflow: raw.name,
    path: raw.path,
    conclusion: raw.conclusion ?? null,
    status: raw.status,
    headSha: raw.head_sha,
    createdAt: raw.created_at,
    url: raw.html_url,
    event: raw.event ?? null,
    branch: raw.head_branch ?? null,
    attempt: raw.run_attempt ?? 1,
    pullRequest: raw.pull_requests?.[0]?.number ?? null,
    // A re-run keeps the run's created_at, so this is when its latest attempt started.
    startedAt: raw.run_started_at ?? raw.created_at,
  };
}

/** @returns {Job} */
function normalizeJob(raw) {
  const steps = (raw.steps ?? []).map((s) => ({
    number: s.number ?? null,
    name: s.name ?? '',
    conclusion: s.conclusion ?? null,
    startedAt: s.started_at ?? null,
    completedAt: s.completed_at ?? null,
  }));
  const failedStep = steps.find((s) => s.conclusion === 'failure');
  return {
    runId: raw.run_id,
    name: raw.name,
    conclusion: raw.conclusion ?? null,
    status: raw.status,
    startedAt: raw.started_at ?? null,
    completedAt: raw.completed_at ?? null,
    failedStep: failedStep ? failedStep.name : null,
    steps,
    url: raw.html_url,
  };
}

/**
 * Runs on one branch, newest first, back to `since` or until `maxRuns` is
 * reached — whichever comes first.
 *
 * Paginates and stops on the first run older than `since`, because the stop
 * condition is then the same one the budget uses and both are visible here. Only
 * a window with an `until` (the backfill) passes the API's `created` filter too.
 * A list filtered by branch or `created` ends at 1,000 runs, as an empty page;
 * reaching that is counted as `truncated`, since the runs past it went unread.
 *
 * Runs that belong to no workflow file are dropped here, counted rather than
 * silently: Dependabot's update jobs appear in this list as one pseudo-workflow
 * *per update*, named `npm_and_yarn in /. for esbuild - Update #1547810405` and
 * pathed `dynamic/dependabot/dependabot-updates`. Each has a single run, and a
 * failed one therefore reads as a workflow with a 0% pass rate, which put three
 * of them above CI in the worst-first list on the first real run of this tool.
 * They are also not this repository's automation, which is the honest reason to
 * leave them out. A `workflow_run` run is left out too, uncounted and without
 * spending the budget: GitHub files it under `main` whatever it reports on, and
 * pr-tests.yml's reports on a pull request.
 *
 * @returns {Promise<{ runs: Run[], truncated: boolean, ignored: number,
 *   reachedWindowEdge: boolean, dependabot: Run[] }>} `dependabot` is the ignored runs that are
 *   Dependabot's, for the attempts alone: today's figures leave them out. `truncated` when the budget stopped it before the
 *   window did. `reachedWindowEdge` when a run older than `since` was actually seen —
 *   which is the only honest evidence that history reaches back past the window, since
 *   every run that *is* returned satisfies `createdAt >= since` by construction and so
 *   can never show it.
 */
export async function listRuns({ repo, branch = 'main', since, until = null, maxRuns, ...ctx }) {
  const runs = [];
  let page = 1;
  let truncated = false;
  let ignored = 0;
  const dependabot = [];
  let reachedWindowEdge = false;
  // An older window (the Harness Monitor's backfill) is asked of the API as a
  // range: a list filtered by branch stops at 1,000 runs, which paging back
  // from today would spend before a window 60 days old was reached.
  const created = until ? `&created=${encodeURIComponent(`${apiTime(since)}..${apiTime(until)}`)}` : '';

  for (;;) {
    const body = await request(
      `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}${created}&per_page=${PER_PAGE}&page=${page}`,
      ctx,
    );
    const batch = body.workflow_runs ?? [];
    if (batch.length === 0) break;

    for (const raw of batch) {
      const run = normalizeRun(raw);
      // The range is inclusive at both ends, and the window is not at its end.
      if (until && new Date(run.createdAt) >= until) continue;
      if (new Date(run.createdAt) < since) {
        reachedWindowEdge = true;
        break;
      }
      if (raw.event === 'workflow_run') continue;
      if (!run.path?.startsWith('.github/workflows/')) {
        ignored += 1;
        if (isDependabot(run)) dependabot.push(run);
        continue;
      }
      if (runs.length >= maxRuns) {
        truncated = true;
        break;
      }
      runs.push(run);
    }

    if (reachedWindowEdge || truncated || batch.length < PER_PAGE) break;
    if (page * PER_PAGE >= LISTED_AT_MOST) {
      truncated = true;
      break;
    }
    page += 1;
  }

  return { runs, truncated, ignored, reachedWindowEdge, dependabot };
}

/** A time as the API's search syntax takes it: to the second, in UTC. */
const apiTime = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Every job of one run's latest attempt, or of the earlier `attempt` named. @returns {Promise<Job[]>} */
export async function listJobs({ repo, runId, attempt = null, ...ctx }) {
  const attemptPath = attempt === null ? '' : `/attempts/${attempt}`;
  const body = await request(`/repos/${repo}/actions/runs/${runId}${attemptPath}/jobs?per_page=${PER_PAGE}`, ctx);
  return (body.jobs ?? []).map(normalizeJob);
}

/** Runs `worker` over `items`, at most `limit` at a time, preserving order. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Everything the model needs, in as few requests as it can be had.
 *
 * Skipped runs are fetched as runs and not as jobs: a skipped run ran nothing,
 * so its job list is empty and asking for it would spend a request to learn
 * that. It still counts in the run tallies, which is why it is not filtered out
 * altogether.
 */
export async function collect({
  repo,
  branch = 'main',
  since,
  until = null,
  maxRuns = 800,
  concurrency = 8,
  token,
  fetchImpl = globalThis.fetch,
  retries,
  retryDelayMs,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new GitHubError('No fetch available; pass fetchImpl.', { reason: 'no-fetch' });
  }

  const ctx = { token, fetchImpl, retries, retryDelayMs };
  const { runs, truncated, ignored, reachedWindowEdge, dependabot } = await listRuns({
    repo,
    branch,
    since,
    until,
    maxRuns,
    ...ctx,
  });

  const withJobs = runs.filter((run) => run.conclusion !== 'skipped');
  const jobLists = await pool(withJobs, concurrency, (run) =>
    listJobs({ repo, runId: run.id, ...ctx }),
  );

  return {
    runs,
    jobs: jobLists.flat(),
    truncated,
    ignored,
    reachedWindowEdge,
    dependabot,
    requests: withJobs.length,
  };
}

/**
 * The record a failed job uploaded, the artifact created during that job's own run of it
 * (`matchArtifact`: a re-run puts several under one name), trimmed to the tests it names.
 * A job with no record, an expired or ambiguous one, or one that cannot be read is
 * `not-recorded` and names no test. Only a spent allowance, or a bug in this code, throws.
 */
async function readRecord({ repo, run, job, artifacts, ...ctx }) {
  const name = recordArtifactFor(run.path, job.name);
  try {
    const key = `${run.id}|${name}`;
    if (!artifacts.has(key)) {
      artifacts.set(
        key,
        request(`/repos/${repo}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(name)}&per_page=${PER_PAGE}`, ctx).then((body) =>
          (body.artifacts ?? []).map((raw) => ({ id: raw.id, createdAt: raw.created_at, expired: Boolean(raw.expired) })),
        ),
      );
    }
    const match = matchArtifact(await artifacts.get(key), { startedAt: job.startedAt, completedAt: job.completedAt });
    if (!match.artifact) return { state: 'not-recorded', why: match.why };

    const zip = Buffer.from(await request(`/repos/${repo}/actions/artifacts/${match.artifact.id}/zip`, ctx, (res) => res.arrayBuffer()));
    const value = readZipJson(zip, RECORD_FILE);
    return value ? { state: 'read', value: { failedTests: value.failedTests, failedTestsMore: value.failedTestsMore } } : { state: 'not-recorded', why: 'absent' };
  } catch (error) {
    if (error instanceof GitHubError && error.reason === 'rate-limit') throw error;
    // A GitHub failure, or an archive that is not one; anything else is a bug in this code.
    if (error instanceof GitHubError || error instanceof SyntaxError || /zip/i.test(error?.message ?? '')) return { state: 'not-recorded', why: 'unreadable' };
    throw error;
  }
}

/**
 * Every attempt of the runs created since `since`, with the jobs of each: the latest attempt's
 * from the list `collect` read, an earlier attempt's from its own (`/runs/{id}/attempts/{n}/jobs`,
 * one request each, so only a re-run costs more than today), and a failed job that keeps a record
 * carrying the `record` it uploaded. The runs are `collect`'s plus Dependabot's, whose jobs are
 * read only where the run failed, since the page needs no job of a run that passed. Skipped runs
 * ran no job and cost nothing.
 *
 * @param {{ repo: string, runs: Run[], jobs: Job[], since: Date }} input
 * @returns {Promise<{ run: Run, attempt: number, jobs: Job[] }[]>} one per attempt, in no order
 */
export async function collectAttempts({
  repo,
  runs,
  jobs,
  since,
  concurrency = 8,
  token,
  fetchImpl = globalThis.fetch,
  retries,
  retryDelayMs,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new GitHubError('No fetch available; pass fetchImpl.', { reason: 'no-fetch' });
  }
  const ctx = { token, fetchImpl, retries, retryDelayMs };
  const latestJobs = new Map();
  for (const job of jobs) latestJobs.set(job.runId, [...(latestJobs.get(job.runId) ?? []), job]);
  const artifacts = new Map();

  const perRun = await pool(
    runs.filter((run) => new Date(run.createdAt) >= since),
    concurrency,
    async (run) => {
      const entries = [];
      for (let attempt = 1; attempt <= (run.attempt ?? 1); attempt += 1) {
        let own;
        if (attempt < run.attempt) {
          // An attempt GitHub no longer holds is one whose verdict cannot be read, not a failure of this one.
          own = await listJobs({ repo, runId: run.id, attempt, ...ctx }).catch((error) => {
            if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) return [];
            throw error;
          });
        } else if (latestJobs.has(run.id)) {
          own = latestJobs.get(run.id);
        } else {
          own = isDependabot(run) && classify(run) === 'fail' ? await listJobs({ repo, runId: run.id, ...ctx }) : [];
        }
        const withRecords = [];
        for (const job of own) {
          withRecords.push(classify(job) === 'fail' && recordArtifactFor(run.path, job.name) ? { ...job, record: await readRecord({ repo, run, job, artifacts, ...ctx }) } : job);
        }
        entries.push({ run, attempt, jobs: withRecords });
      }
      return entries;
    },
  );
  return perRun.flat();
}
