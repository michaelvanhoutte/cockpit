/**
 * The pull request and Actions APIs, and nothing else. Every number this tool
 * reports is model.js's; this file only fetches and normalizes.
 *
 * `fetchImpl` is a parameter rather than the global so the tests can drive the
 * failures a network actually has — a spent rate limit, a listing that stops
 * early — without one.
 *
 * **Request cost is what shapes this file.** `GITHUB_TOKEN` is capped at 1,000
 * requests an hour, and a pull request costs one for its detail, one for its
 * commits and one per commit for its check runs (`filter=all`, so the earlier
 * attempts of a re-run check arrive in the same request rather than a second
 * one) — about 5 to 6 in all. The listing that finds the pulls is one request in
 * a hundred. Two things read further:
 *
 * - **A failed attempt** costs one for its job (the failing step) and, for `Test`
 *   and `E2E (F3)`, one artifact list per run and record name (shared by every
 *   failed attempt of that run) and one download of the record: 1 for a check that
 *   keeps no record, about 3 for one that does. A passing attempt costs nothing.
 * - **Queue time** costs one request per CI run, its job list (shared by every
 *   round, attempt and pull request on that run), plus one listing of the CI
 *   workflow's runs per hundred, since a check run does not name its workflow and
 *   a review run is skipped on that list instead of asked about. That is about 1.4
 *   per pull request.
 *
 * Measured over fourteen days of this repository's merges, 103 pulls cost 767
 * requests. `maxPulls` (150 by default) is what keeps the hour's allowance
 * from being spent if the merge rate climbs: it stops rather than spending it, and the coverage it returns names the period it actually reached,
 * so the model reports that instead of the one it was asked for.
 */

import { readZipJson } from '../../selection/src/zip.js';
import { classify, matchArtifact, recordArtifactOf } from './model.js';

const API = 'https://api.github.com';
const RECORD_FILE = 'record.json';
const PER_PAGE = 100;
/** The workflow whose jobs hold the required checks, and so the only one whose job lists are read. */
const CI_WORKFLOW = 'ci.yml';
const RUN_OF = /\/actions\/runs\/(\d+)\//;
const DAY_MS = 86_400_000;

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
 * @typedef {object} CheckRun one attempt of one check on one commit.
 * @property {number} id
 * @property {string} name
 * @property {number|null} suiteId the check suite it belongs to, which is what tells two
 *   jobs that share a name (two workflows each have a `What changed`) from two attempts of one
 * @property {string} status
 * @property {string|null} conclusion
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {string|null} app the Actions app is the only one with a job to read
 * @property {number|null} runId the workflow run it belongs to, read off its `details_url`
 * @property {{ state: 'read', createdAt: string } | { state: 'not-recorded', why: string }} [queue]
 *   on a job of the CI workflow only: when the job was created, which with its start is the time it
 *   waited for a runner
 * @property {{ steps: string[], record: null | { state: 'read', value: object } | { state: 'not-recorded', why: string } }} [failure]
 *   on a failed attempt only: the steps that failed, and for `Test` and `E2E (F3)` the record it uploaded
 *
 * @typedef {object} Commit
 * @property {string} sha
 * @property {string|null} authoredAt
 * @property {number} parents
 * @property {CheckRun[]} checks
 *
 * @typedef {object} Pull
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string} createdAt
 * @property {string} mergedAt
 * @property {string} body
 * @property {number} additions
 * @property {number} deletions
 * @property {number} changedFiles
 * @property {number} commitCount
 * @property {Commit[]} commits
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, retried only where retrying can help.
 *
 * A report is hundreds of requests, so the interesting number is not the chance
 * of a 502 but the chance of *no* 502 across all of them: one transient failure
 * would otherwise discard the whole run. Only 5xx and a thrown fetch are
 * retried; a 404 or a spent allowance will say the same thing however many times
 * it is asked.
 */
async function request(path, { token, fetchImpl, retries = 2, retryDelayMs = 250, counter, abort }, parse = (res) => res.json()) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // Once one request has found the allowance spent, every other one in flight
    // is only spending it further.
    if (abort?.stopped) throw new GitHubError('Stopped: another request already failed.', { reason: 'stopped' });
    if (attempt > 0) await sleep(retryDelayMs * attempt);
    if (counter) counter.requests += 1;

    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'cockpit-lead-time',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (error) {
      lastError = new GitHubError(`Could not reach GitHub for ${path}: ${error.message}`, { reason: 'network' });
      continue;
    }

    if (res.ok) return parse(res);

    // A spent allowance is the one failure that is about *us* rather than about
    // GitHub, and the fix (fewer pull requests, or wait) differs from every other
    // status. Never retried: asking again is what spent it.
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    // The secondary limit, which throttles bursts, says so with a Retry-After
    // instead of an empty allowance, and is the same failure for the same reason.
    const throttled = res.headers?.get?.('retry-after') != null;
    if ((res.status === 403 || res.status === 429) && (remaining === '0' || throttled)) {
      const reset = res.headers?.get?.('x-ratelimit-reset');
      const at = reset ? new Date(Number(reset) * 1000).toISOString() : 'an unknown time';
      if (abort) abort.stopped = true;
      throw new GitHubError(
        `GitHub's rate limit is spent; it resets at ${at}. Read fewer pull requests (--max-pulls) or wait.`,
        { status: res.status, reason: 'rate-limit' },
      );
    }

    lastError = new GitHubError(`GitHub answered ${res.status} for ${path}`, { status: res.status, reason: 'http' });
    if (res.status < 500) throw lastError;
  }

  throw lastError;
}

/** Runs `worker` over `items`, at most `limit` at a time, preserving order, and starting no more once `abort` is set. */
async function pool(items, limit, worker, abort) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (abort?.stopped) return;
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** @returns {CheckRun} */
function normalizeCheck(raw) {
  return {
    id: raw.id,
    name: raw.name,
    suiteId: raw.check_suite?.id ?? null,
    status: raw.status,
    conclusion: raw.conclusion ?? null,
    startedAt: raw.started_at ?? null,
    completedAt: raw.completed_at ?? null,
    app: raw.app?.slug ?? null,
    runId: Number(raw.details_url?.match(RUN_OF)?.[1]) || null,
  };
}

/**
 * Merged pulls into `base`, most recently updated first, back to `since` or until
 * `maxPulls` is reached — whichever comes first.
 *
 * The listing is ordered by *update*, not by merge, so it is read in that order
 * and stopped on a pull last updated before `since`: a pull merged inside the
 * window was updated at or after its merge, so nothing later in the list can have
 * been merged inside it. The same fact is what makes the coverage below honest —
 * a pull the budget left unread was updated no later than the last one read, so
 * everything merged after that instant *was* read.
 *
 * Closed pulls that were never merged cost nothing and are dropped here, and so
 * is a merged one whose merge predates the window (it is in the list only
 * because somebody commented on it since).
 *
 * @returns {Promise<{ pulls: { number: number, updatedAt: string }[], truncated: boolean,
 *   reachedWindowEdge: boolean, oldestSeen: Date|null }>} `oldestSeen` is the instant the
 *   listing was read back to when it did not reach the window's edge.
 */
export async function listPulls({ repo, base = 'main', since, maxPulls, ...ctx }) {
  const pulls = [];
  let page = 1;
  let truncated = false;
  let reachedWindowEdge = false;
  let oldestSeen = null;

  for (;;) {
    const batch = await request(
      `/repos/${repo}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`,
      ctx,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const raw of batch) {
      const updatedAt = new Date(raw.updated_at);
      if (updatedAt < since) {
        reachedWindowEdge = true;
        break;
      }
      oldestSeen = updatedAt;
      if (!raw.merged_at || new Date(raw.merged_at) < since) continue;
      if (pulls.length >= maxPulls) {
        truncated = true;
        break;
      }
      pulls.push({ number: raw.number, updatedAt: raw.updated_at });
    }

    if (reachedWindowEdge || truncated || batch.length < PER_PAGE) break;
    page += 1;
  }

  // A budget that stopped the listing has read back only as far as the last pull
  // it took, whatever the pulls it looked at and dropped came after.
  if (truncated) oldestSeen = new Date(pulls[pulls.length - 1].updatedAt);
  return { pulls, truncated, reachedWindowEdge, oldestSeen };
}

/** Every page of a listing that reports how many there are in all. */
async function listAll(path, key, ctx, { paged }) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const body = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`, ctx);
    const batch = key ? (body[key] ?? []) : body;
    items.push(...batch);
    if (batch.length === 0 || !paged(body, items, batch)) return items;
  }
}

/** Every check run on one commit, the earlier attempts of a re-run included. @returns {Promise<CheckRun[]>} */
export async function listChecks({ repo, sha, ...ctx }) {
  const raw = await listAll(`/repos/${repo}/commits/${sha}/check-runs?filter=all`, 'check_runs', ctx, {
    paged: (body, items) => items.length < (body.total_count ?? 0),
  });
  return raw.map(normalizeCheck);
}

/**
 * What a failed attempt failed on: the steps that ended failed in its job, and for
 * `Test` and `E2E (F3)` the record whose artifact was created during that job.
 * `artifacts` memoizes a run's artifact list, since a re-run puts several failed
 * attempts in one run.
 *
 * This is supplementary detail, so nothing here may cost a pull request its place in
 * the other figures: any error but a spent allowance (or the run already stopping)
 * reads as `unreadable` (a bug in this code is not one and still throws), and a job
 * that cannot be read names no steps.
 */
async function readFailure({ repo, check, artifacts, ...ctx }) {
  const name = recordArtifactOf(check.name);
  const unreadable = (steps) => ({ steps, record: name ? { state: 'not-recorded', why: 'unreadable' } : null, unreadable: true });
  let steps = [];

  try {
    const job = await request(`/repos/${repo}/actions/jobs/${check.id}`, ctx);
    steps = (job.steps ?? []).filter((step) => classify(step) === 'fail').map((step) => step.name);
    if (!name) return { steps, record: null };

    const key = `${job.run_id}|${name}`;
    if (!artifacts.has(key)) {
      artifacts.set(key, listAll(`/repos/${repo}/actions/runs/${job.run_id}/artifacts?name=${encodeURIComponent(name)}`, 'artifacts', ctx, { paged: (body, items) => items.length < (body.total_count ?? 0) }));
    }
    const named = (await artifacts.get(key)).map((raw) => ({ id: raw.id, createdAt: raw.created_at, expired: Boolean(raw.expired) }));
    const match = matchArtifact(named, { startedAt: job.started_at ?? check.startedAt, completedAt: job.completed_at ?? check.completedAt });
    if (!match.artifact) return { steps, record: { state: 'not-recorded', why: match.why } };

    const zip = Buffer.from(await request(`/repos/${repo}/actions/artifacts/${match.artifact.id}/zip`, ctx, (res) => res.arrayBuffer()));
    let value;
    try {
      value = readZipJson(zip, RECORD_FILE);
    } catch (error) {
      throw new GitHubError(`The ${name} artifact (id ${match.artifact.id}) could not be read: ${error.message}`, { reason: 'bad-artifact' });
    }
    return { steps, record: value ? { state: 'read', value } : { state: 'not-recorded', why: 'absent' } };
  } catch (error) {
    // Only a GitHub or archive failure is "unreadable"; a bug in this code must still throw.
    if (!(error instanceof GitHubError) || error.reason === 'rate-limit' || error.reason === 'stopped') throw error;
    return unreadable(steps);
  }
}

/**
 * When each job of the CI workflow was created, put on its check run as `queue`, so the
 * model can say how long it waited for a runner. A check run does not name its workflow,
 * so the CI runs are listed once, from the earliest check read: about one request per 100
 * runs, against one per run to ask each. Then each distinct CI run's job list is read once,
 * however many rounds, attempts or pulls share it (`filter=all`, so a re-run's attempts come
 * together), and a job's id is its check run's id. A review or other workflow's run is not in
 * that list and costs nothing.
 *
 * This is supplementary detail like `readFailure`: an error but a spent allowance (or the run
 * already stopping) leaves the affected checks `not-recorded` and every pull request in place.
 */
async function readQueue({ repo, pulls, concurrency = 4, ...ctx }) {
  const checks = pulls
    .flatMap((pull) => pull.commits.flatMap((commit) => commit.checks))
    .filter((check) => check.runId !== null && (check.app === null || check.app === 'github-actions'));
  if (checks.length === 0) return;

  const notRecorded = (list, why) => list.forEach((check) => (check.queue = { state: 'not-recorded', why }));
  const rethrows = (error) => !(error instanceof GitHubError) || error.reason === 'rate-limit' || error.reason === 'stopped';

  const earliest = Math.min(...checks.map((check) => Date.parse(check.startedAt ?? check.completedAt)).filter(Number.isFinite));
  const from = new Date((Number.isFinite(earliest) ? earliest : Date.now()) - DAY_MS).toISOString().slice(0, 10);

  let ci;
  try {
    const runs = await listAll(
      `/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?event=pull_request&exclude_pull_requests=true&created=${encodeURIComponent(`>=${from}`)}`,
      'workflow_runs',
      ctx,
      { paged: (body, items) => items.length < (body.total_count ?? 0) },
    );
    ci = new Set(runs.map((run) => run.id));
  } catch (error) {
    if (rethrows(error)) throw error;
    notRecorded(checks, 'unreadable');
    return;
  }

  const ofCi = checks.filter((check) => ci.has(check.runId));
  const ids = [...new Set(ofCi.map((check) => check.runId))];
  const jobs = new Map();
  await pool(
    ids,
    concurrency,
    async (runId) => {
      try {
        const listed = await listAll(`/repos/${repo}/actions/runs/${runId}/jobs?filter=all`, 'jobs', ctx, { paged: (body, items) => items.length < (body.total_count ?? 0) });
        jobs.set(runId, new Map(listed.map((job) => [job.id, job])));
      } catch (error) {
        if (rethrows(error)) throw error;
        jobs.set(runId, null);
      }
    },
    ctx.abort,
  );

  for (const check of ofCi) {
    const run = jobs.get(check.runId);
    const job = run?.get(check.id);
    if (job?.created_at) check.queue = { state: 'read', createdAt: job.created_at };
    else notRecorded([check], run ? 'absent' : 'unreadable');
  }
}

/** One pull request: its detail, its commits and each commit's check runs. @returns {Promise<Pull>} */
export async function readPull({ repo, number, commitConcurrency = 4, ...ctx }) {
  const [detail, rawCommits] = await Promise.all([
    request(`/repos/${repo}/pulls/${number}`, ctx),
    listAll(`/repos/${repo}/pulls/${number}/commits`, null, ctx, { paged: (_body, _items, batch) => batch.length === PER_PAGE }),
  ]);

  const checks = await pool(rawCommits, commitConcurrency, (commit) => listChecks({ repo, sha: commit.sha, ...ctx }), ctx.abort);

  // Only a failed attempt says anything a passing one does not, so only those are read further.
  const artifacts = new Map();
  const failed = checks.flat().filter((check) => classify(check) === 'fail' && (check.app === null || check.app === 'github-actions'));
  await pool(
    failed,
    commitConcurrency,
    async (check) => {
      check.failure = await readFailure({ repo, check, artifacts, ...ctx });
    },
    ctx.abort,
  );

  return {
    number: detail.number,
    title: detail.title,
    url: detail.html_url,
    createdAt: detail.created_at,
    mergedAt: detail.merged_at,
    body: detail.body ?? '',
    additions: detail.additions ?? 0,
    deletions: detail.deletions ?? 0,
    changedFiles: detail.changed_files ?? 0,
    commitCount: detail.commits ?? rawCommits.length,
    commits: rawCommits.map((commit, index) => ({
      sha: commit.sha,
      authoredAt: commit.commit?.author?.date ?? null,
      parents: commit.parents?.length ?? 0,
      checks: checks[index] ?? [],
    })),
  };
}

/**
 * Everything the model needs, in as few requests as it can be had.
 *
 * A pull request that cannot be read — its commits or its check runs came back
 * refused — is named and left out while the rest are answered: one bad pull is not
 * a reason to discard the other hundred. A spent rate limit is the exception, and
 * fails the run, because what comes after it would be missing for the same reason
 * and the picture would only look complete.
 *
 * @returns {Promise<{ pulls: Pull[], failed: { number: number, reason: string }[],
 *   coveredSince: Date, truncated: boolean, reachedWindowEdge: boolean, requests: number }>}
 *   `coveredSince` is how far back the listing was actually read.
 */
export async function collect({
  repo,
  branch = 'main',
  since,
  now = new Date(),
  maxPulls = 150,
  concurrency = 2,
  token,
  fetchImpl = globalThis.fetch,
  retries,
  retryDelayMs,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new GitHubError('No fetch available; pass fetchImpl.', { reason: 'no-fetch' });
  }

  const counter = { requests: 0 };
  const abort = { stopped: false };
  const ctx = { token, fetchImpl, retries, retryDelayMs, counter, abort };

  const listing = await listPulls({ repo, base: branch, since, maxPulls, ...ctx });

  const failed = [];
  const read = await pool(
    listing.pulls,
    concurrency,
    async ({ number }) => {
      try {
        return await readPull({ repo, number, ...ctx });
      } catch (error) {
        if (!(error instanceof GitHubError) || error.reason === 'rate-limit' || error.reason === 'stopped') throw error;
        failed.push({ number, reason: error.message });
        return null;
      }
    },
    abort,
  );

  const pulls = read.filter(Boolean);
  await readQueue({ repo, pulls, ...ctx });

  return {
    pulls,
    failed: failed.sort((a, b) => a.number - b.number),
    coveredSince: listing.reachedWindowEdge && !listing.truncated ? since : (listing.oldestSeen ?? now),
    truncated: listing.truncated,
    reachedWindowEdge: listing.reachedWindowEdge,
    requests: counter.requests,
  };
}
