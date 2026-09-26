/**
 * The pull request and Actions APIs, and nothing else. Every number this tool
 * reports is model.js's; this file only fetches, downloads and normalizes.
 *
 * `fetchImpl` is a parameter rather than the global so the tests can drive the
 * failures a network actually has — a spent rate limit, a missing artifact —
 * without one.
 *
 * **A pull request is read from its last Test run** (its own `pull_request`
 * run on its head commit) **and from `main`'s push run of its merge commit** —
 * the two the model needs to tell a miss from a test that never had the
 * chance to run. Each carries the `test-selection-record` artifact
 * scripts/lib/test-record.mjs writes, read here with zip.js since Actions
 * hands artifacts back as a zip and nothing else in this repository reads one.
 *
 * **Any failure to read one pull request's data fails the whole run.** A
 * report that quietly dropped a pull request would look complete while being
 * wrong in the reassuring direction — the opposite of ci-stability and
 * lead-time, which are advisory pages a missing pull request only thins.
 * This one is read to find gaps in selection, so a gap in the reading itself
 * has to be loud. Only a genuinely absent record — the artifact expired, or
 * the Test job never ran because the pull request was documentation-only —
 * is not a failure; both come back as `null`, for model.js to tell apart.
 *
 * **Request cost**: up to two workflow-run lookups, two job lists, two
 * artifact lists and two zip downloads per pull request, plus one changed-file
 * listing where a record is missing — about ten requests each, so a
 * fourteen-day window of a few dozen merges stays well inside the thousand
 * `GITHUB_TOKEN` allows an hour. `maxPulls` stops rather than spending it.
 */

import { readZipJson } from './zip.js';

const API = 'https://api.github.com';
const PER_PAGE = 100;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const RECORD_ARTIFACT = 'test-selection-record';
const RECORD_FILE = 'record.json';
const TEST_JOB = 'Test';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, retried only where retrying can help, parsed by `parse` —
 * `(res) => res.json()` for the API, `(res) => res.arrayBuffer()` for a zip.
 *
 * Only 5xx and a thrown fetch are retried: a 404 or a spent allowance will say
 * the same thing however many times it is asked.
 */
async function request(path, { token, fetchImpl, retries = 2, retryDelayMs = 250, abort }, parse = (res) => res.json()) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // Once one request has failed, the whole run is going to fail with it (see
    // this file's own top comment) — every other request still in flight or
    // queued is only spending an allowance the failure has already made moot.
    if (abort?.stopped) throw new GitHubError('Stopped: another request already failed.', { reason: 'stopped' });
    if (attempt > 0) await sleep(retryDelayMs * attempt);

    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'cockpit-selection',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (error) {
      lastError = new GitHubError(`Could not reach GitHub for ${path}: ${error.message}`, { reason: 'network' });
      continue;
    }

    if (res.ok) return parse(res);

    // A spent allowance is worth its own message: it is the one failure that is
    // about *us* rather than about GitHub, and the fix (read fewer pull
    // requests, or wait) is different from every other status. Never retried —
    // asking again is what spent it.
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    const throttled = res.headers?.get?.('retry-after') != null;
    if ((res.status === 403 || res.status === 429) && (remaining === '0' || throttled)) {
      const reset = res.headers?.get?.('x-ratelimit-reset');
      const at = reset ? new Date(Number(reset) * 1000).toISOString() : 'an unknown time';
      if (abort) abort.stopped = true;
      throw new GitHubError(`GitHub's rate limit is spent; it resets at ${at}. Read fewer pull requests (--max-pulls) or wait.`, {
        status: res.status,
        reason: 'rate-limit',
      });
    }

    lastError = new GitHubError(`GitHub answered ${res.status} for ${path}`, { status: res.status, reason: 'http' });
    if (res.status < 500) {
      if (abort) abort.stopped = true;
      throw lastError;
    }
  }

  if (abort) abort.stopped = true;
  throw lastError;
}

const requestJson = (path, ctx) => request(path, ctx);
const requestZip = async (path, ctx) => Buffer.from(await request(path, ctx, (res) => res.arrayBuffer()));

/** Runs `worker` over `items`, at most `limit` at a time, preserving order, and starting no more once `abort` is set. Exported for its own deterministic test — timing through the full fetch stub cannot pin down when `abort` actually lands. */
export async function pool(items, limit, worker, abort) {
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

/**
 * @typedef {object} Pull
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string} mergedAt
 * @property {string|null} headSha the pull request's own last commit, whose `pull_request` run is its last Test run
 * @property {string|null} mergeCommitSha `main`'s commit for this merge, whose `push` run tells whether a skipped test later failed
 */

/**
 * Merged pulls into `base`, most recently updated first, back to `since` or
 * until `maxPulls` is reached — whichever comes first. Ordered and stopped the
 * same way lead-time's own `listPulls` is; see there for why that makes the
 * coverage honest.
 *
 * @returns {Promise<{ pulls: Pull[], truncated: boolean, reachedWindowEdge: boolean, oldestSeen: Date|null }>}
 */
export async function listMergedPulls({ repo, base = 'main', since, maxPulls, ...ctx }) {
  const pulls = [];
  const updates = [];
  let page = 1;
  let truncated = false;
  let reachedWindowEdge = false;
  let oldestSeen = null;

  for (;;) {
    const batch = await requestJson(
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
      pulls.push({
        number: raw.number,
        title: raw.title,
        url: raw.html_url,
        mergedAt: raw.merged_at,
        headSha: raw.head?.sha ?? null,
        mergeCommitSha: raw.merge_commit_sha ?? null,
      });
      updates.push(updatedAt);
    }

    if (reachedWindowEdge || truncated || batch.length < PER_PAGE) break;
    page += 1;
  }

  if (truncated) oldestSeen = updates[updates.length - 1];
  return { pulls, truncated, reachedWindowEdge, oldestSeen };
}

/** The newest `ci.yml` run for `sha` on `event`, or `null` where none has run — never a failure, since a skipped job legitimately runs nothing. */
export async function findRun({ repo, sha, event, ...ctx }) {
  if (!sha) return null;
  const body = await requestJson(`/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&event=${encodeURIComponent(event)}&per_page=20`, ctx);
  const runs = (body.workflow_runs ?? []).filter((raw) => raw.path === WORKFLOW_PATH);
  if (runs.length === 0) return null;
  runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { id: runs[0].id };
}

/** The named jobs of one run — just enough to time the `Test` job. */
export async function listJobs({ repo, runId, ...ctx }) {
  const body = await requestJson(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=${PER_PAGE}`, ctx);
  return (body.jobs ?? []).map((raw) => ({ name: raw.name, startedAt: raw.started_at ?? null, completedAt: raw.completed_at ?? null }));
}

/** How long a job actually ran, or `null` where it never started and finished — a skipped job among them. */
export function jobDurationMs(job) {
  if (!job?.startedAt || !job?.completedAt) return null;
  const ms = new Date(job.completedAt) - new Date(job.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * The newest non-expired artifact named `name` on `runId`, or `null` where the
 * run uploaded none — the ordinary shape of a documentation-only pull
 * request's run, whose Test job never started.
 *
 * Newest, not first: a re-run job re-uploads under the same name, and picking
 * the latest is how "the run's last attempt decides" (test-record.mjs's own
 * rule) holds here without this file needing to know what an attempt is.
 */
export async function findArtifact({ repo, runId, name, ...ctx }) {
  const body = await requestJson(`/repos/${repo}/actions/runs/${runId}/artifacts?per_page=${PER_PAGE}`, ctx);
  const candidates = (body.artifacts ?? []).filter((raw) => raw.name === name && !raw.expired);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { id: candidates[0].id };
}

/**
 * The record inside one artifact — test-record.mjs's own `buildRecord` shape.
 *
 * A malformed archive or a `record.json` that is not valid JSON is this
 * repository's own writer failing, never attacker input reaching this far —
 * `collect()` only ever reads a merged pull request's own artifact, which
 * means the code that produced it already passed review. Caught anyway and
 * turned into the same `GitHubError` every other gap here becomes, so a
 * corrupt artifact fails the run with a clear message instead of a bare stack
 * trace out of `zip.js`.
 */
export async function downloadRecord({ repo, artifactId, ...ctx }) {
  const zip = await requestZip(`/repos/${repo}/actions/artifacts/${artifactId}/zip`, ctx);
  try {
    return readZipJson(zip, RECORD_FILE);
  } catch (error) {
    throw new GitHubError(`The ${RECORD_ARTIFACT} artifact (id ${artifactId}) could not be read: ${error.message}`, { reason: 'bad-artifact' });
  }
}

/** Every path a pull request's diff touches — asked only where its record is missing, to tell a documentation-only skip from a genuine gap. */
export async function listPullFiles({ repo, number, ...ctx }) {
  const files = [];
  for (let page = 1; ; page += 1) {
    const batch = await requestJson(`/repos/${repo}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`, ctx);
    if (!Array.isArray(batch) || batch.length === 0) break;
    files.push(...batch.map((raw) => raw.filename));
    if (batch.length < PER_PAGE) break;
  }
  return files;
}

/**
 * @typedef {object} Run
 * @property {number} id
 * @property {number|null} testDurationMs
 * @property {object|null} record test-record.mjs's `buildRecord` shape, or `null` where the Test job uploaded none
 */

/** Everything one `ci.yml` run can tell this tool: its `Test` job's time, and the record it uploaded. @returns {Promise<Run>} */
async function readRun({ repo, run, ...ctx }) {
  const [jobs, artifact] = await Promise.all([listJobs({ repo, runId: run.id, ...ctx }), findArtifact({ repo, runId: run.id, name: RECORD_ARTIFACT, ...ctx })]);
  const record = artifact ? await downloadRecord({ repo, artifactId: artifact.id, ...ctx }) : null;
  return { id: run.id, testDurationMs: jobDurationMs(jobs.find((job) => job.name === TEST_JOB)), record };
}

/**
 * @typedef {object} PullData
 * @property {Pull} pull
 * @property {Run|null} prRun
 * @property {Run|null} mainRun
 * @property {string[]|null} files every changed path, read only where `prRun.record` is missing
 */

/** One pull request's own last Test run, `main`'s run of its merge, and — only where the first has no record — its changed files. @returns {Promise<PullData>} */
async function readPull({ repo, pull, ...ctx }) {
  const [prRunInfo, mainRunInfo] = await Promise.all([
    findRun({ repo, sha: pull.headSha, event: 'pull_request', ...ctx }),
    findRun({ repo, sha: pull.mergeCommitSha, event: 'push', ...ctx }),
  ]);

  const [prRun, mainRun] = await Promise.all([
    prRunInfo ? readRun({ repo, run: prRunInfo, ...ctx }) : null,
    mainRunInfo ? readRun({ repo, run: mainRunInfo, ...ctx }) : null,
  ]);

  const files = prRun?.record ? null : await listPullFiles({ repo, number: pull.number, ...ctx });

  return { pull, prRun, mainRun, files };
}

/**
 * Everything the model needs, in as few requests as it can be had.
 *
 * Unlike ci-stability and lead-time, a pull request that cannot be read is not
 * dropped and counted — see this file's own top comment for why — so the
 * first failure here fails the whole run, named to the pull request it came
 * from.
 *
 * @returns {Promise<{ pulls: PullData[], truncated: boolean, reachedWindowEdge: boolean, coveredSince: Date }>}
 */
export async function collect({ repo, branch = 'main', since, now = new Date(), maxPulls = 150, concurrency = 4, token, fetchImpl = globalThis.fetch, retries, retryDelayMs }) {
  if (typeof fetchImpl !== 'function') {
    throw new GitHubError('No fetch available; pass fetchImpl.', { reason: 'no-fetch' });
  }

  const abort = { stopped: false };
  const ctx = { token, fetchImpl, retries, retryDelayMs, abort };
  const listing = await listMergedPulls({ repo, base: branch, since, maxPulls, ...ctx });

  const pulls = await pool(
    listing.pulls,
    concurrency,
    async (pull) => {
      try {
        return await readPull({ repo, pull, ...ctx });
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        // Once one pull request's own failure sets `abort`, every other lane's
        // next request throws the same generic "stopped" error (see request()'s
        // own comment) — reported through whichever one's rejection Promise.all
        // happens to see first, which is not necessarily the one that actually
        // failed. `abort.cause` is that one's own pull and error, recorded here
        // the first time a real (non-"stopped") failure is caught, so a
        // "stopped" one reports the real cause instead of its own
        // uninformative message — falling back to its own where none is
        // recorded yet, rather than waiting for one that might never come.
        if (error.reason !== 'stopped') abort.cause ??= { pull, error };
        const { pull: causePull, error: causeError } = abort.cause ?? { pull, error };
        throw new GitHubError(`Pull request #${causePull.number} (${causePull.url}): ${causeError.message}`, { status: causeError.status, reason: causeError.reason });
      }
    },
    abort,
  );

  return {
    pulls,
    truncated: listing.truncated,
    reachedWindowEdge: listing.reachedWindowEdge,
    coveredSince: listing.reachedWindowEdge && !listing.truncated ? since : (listing.oldestSeen ?? now),
  };
}
