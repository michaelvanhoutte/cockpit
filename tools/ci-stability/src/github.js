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
 * got so the page can say so (model.js's coverage, rule 2).
 */

const API = 'https://api.github.com';
const PER_PAGE = 100;

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
 *   and rule 6 says list it rather than invent one.
 * @property {string} url
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
async function request(path, { token, fetchImpl, retries = 2, retryDelayMs = 250 }) {
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

    if (res.ok) return res.json();

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
  };
}

/** @returns {Job} */
function normalizeJob(raw) {
  const failedStep = (raw.steps ?? []).find((s) => s.conclusion === 'failure');
  return {
    runId: raw.run_id,
    name: raw.name,
    conclusion: raw.conclusion ?? null,
    status: raw.status,
    startedAt: raw.started_at ?? null,
    completedAt: raw.completed_at ?? null,
    failedStep: failedStep ? failedStep.name : null,
    url: raw.html_url,
  };
}

/**
 * Runs on one branch, newest first, back to `since` or until `maxRuns` is
 * reached — whichever comes first.
 *
 * Paginates and stops on the first run older than `since` rather than passing
 * the API's `created` filter, because the stop condition is then the same one
 * the budget uses and both are visible here.
 *
 * Runs that belong to no workflow file are dropped here, counted rather than
 * silently: Dependabot's update jobs appear in this list as one pseudo-workflow
 * *per update*, named `npm_and_yarn in /. for esbuild - Update #1547810405` and
 * pathed `dynamic/dependabot/dependabot-updates`. Each has a single run, and a
 * failed one therefore reads as a workflow with a 0% pass rate, which put three
 * of them above CI in the worst-first list on the first real run of this tool.
 * They are also not this repository's automation, which is the honest reason to
 * leave them out.
 *
 * @returns {Promise<{ runs: Run[], truncated: boolean, ignored: number,
 *   reachedWindowEdge: boolean }>} `truncated` when the budget stopped it before the
 *   window did. `reachedWindowEdge` when a run older than `since` was actually seen —
 *   which is the only honest evidence that history reaches back past the window, since
 *   every run that *is* returned satisfies `createdAt >= since` by construction and so
 *   can never show it.
 */
export async function listRuns({ repo, branch = 'main', since, maxRuns, ...ctx }) {
  const runs = [];
  let page = 1;
  let truncated = false;
  let ignored = 0;
  let reachedWindowEdge = false;

  for (;;) {
    const body = await request(
      `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${PER_PAGE}&page=${page}`,
      ctx,
    );
    const batch = body.workflow_runs ?? [];
    if (batch.length === 0) break;

    for (const raw of batch) {
      const run = normalizeRun(raw);
      if (new Date(run.createdAt) < since) {
        reachedWindowEdge = true;
        break;
      }
      if (!run.path?.startsWith('.github/workflows/')) {
        ignored += 1;
        continue;
      }
      if (runs.length >= maxRuns) {
        truncated = true;
        break;
      }
      runs.push(run);
    }

    if (reachedWindowEdge || truncated || batch.length < PER_PAGE) break;
    page += 1;
  }

  return { runs, truncated, ignored, reachedWindowEdge };
}

/** Every job of one run. @returns {Promise<Job[]>} */
export async function listJobs({ repo, runId, ...ctx }) {
  const body = await request(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=${PER_PAGE}`, ctx);
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
  const { runs, truncated, ignored, reachedWindowEdge } = await listRuns({
    repo,
    branch,
    since,
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
    requests: withJobs.length,
  };
}
