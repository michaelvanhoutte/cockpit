import { describe, expect, it } from 'vitest';

import { collect, GitHubError, listRuns } from '../../src/github.js';

const SINCE = new Date('2026-08-08T00:00:00Z');

const ok = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
});

const notOk = (status, headers = {}) => ({
  ok: false,
  status,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => ({}),
});

let nextId = 1;
const rawRun = (overrides = {}) => ({
  id: nextId++,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'push',
  conclusion: 'success',
  status: 'completed',
  head_sha: 'aaaaaaa',
  created_at: '2026-09-01T12:00:00Z',
  run_attempt: 1,
  html_url: 'https://github.com/o/r/actions/runs/1',
  ...overrides,
});

/** A fetch that answers run pages from `pages` and every job request with `jobs`. */
function stubFetch({ pages = [[]], jobs = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/jobs')) return ok({ jobs });
    const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
    return ok({ workflow_runs: pages[page - 1] ?? [] });
  };
  return { fetchImpl, calls };
}

describe('listRuns', () => {
  it('stops at the edge of the window rather than reading the whole history', async () => {
    const { fetchImpl } = stubFetch({
      pages: [
        [
          rawRun({ created_at: '2026-09-01T12:00:00Z' }),
          rawRun({ created_at: '2026-07-01T12:00:00Z' }),
        ],
      ],
    });
    const { runs, truncated } = await listRuns({
      repo: 'o/r',
      since: SINCE,
      maxRuns: 100,
      fetchImpl,
    });
    expect(runs).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  it('stops at its budget and says so, so the window it reports is the one it read', async () => {
    const { fetchImpl } = stubFetch({
      pages: [[rawRun(), rawRun(), rawRun()]],
    });
    const { runs, truncated } = await listRuns({ repo: 'o/r', since: SINCE, maxRuns: 2, fetchImpl });
    expect(runs).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('leaves out a run belonging to no workflow file, and counts what it left out', async () => {
    const { fetchImpl } = stubFetch({
      pages: [
        [
          rawRun(),
          rawRun({
            name: 'npm_and_yarn in /. for esbuild - Update #1547810405',
            path: 'dynamic/dependabot/dependabot-updates',
            conclusion: 'failure',
          }),
        ],
      ],
    });
    const { runs, ignored } = await listRuns({ repo: 'o/r', since: SINCE, maxRuns: 100, fetchImpl });
    expect(runs.map((run) => run.workflow)).toEqual(['CI']);
    expect(ignored).toBe(1);
  });

  it('reads the next page while a full one keeps arriving', async () => {
    const full = Array.from({ length: 100 }, () => rawRun());
    const { fetchImpl, calls } = stubFetch({ pages: [full, [rawRun()]] });
    const { runs } = await listRuns({ repo: 'o/r', since: SINCE, maxRuns: 500, fetchImpl });
    expect(runs).toHaveLength(101);
    expect(calls.filter((url) => url.includes('page=2'))).toHaveLength(1);
  });
});

describe('collect', () => {
  it('fails loudly on a refusal, so no page is built from half a picture', async () => {
    const fetchImpl = async () => notOk(500);
    await expect(
      collect({ repo: 'o/r', since: SINCE, fetchImpl, retries: 0 }),
    ).rejects.toThrow(GitHubError);
  });

  it('rides out one transient failure, rather than discarding four hundred good requests', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      if (calls === 1) return notOk(502);
      if (url.includes('/jobs')) return ok({ jobs: [] });
      return ok({ workflow_runs: [rawRun()] });
    };
    const { runs } = await collect({ repo: 'o/r', since: SINCE, fetchImpl, retryDelayMs: 0 });
    expect(runs).toHaveLength(1);
  });

  it('rides out a connection that never answered, the same way', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      if (url.includes('/jobs')) return ok({ jobs: [] });
      return ok({ workflow_runs: [rawRun()] });
    };
    const { runs } = await collect({ repo: 'o/r', since: SINCE, fetchImpl, retryDelayMs: 0 });
    expect(runs).toHaveLength(1);
  });

  it('does not retry a refusal that would say the same thing again', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return notOk(404);
    };
    await expect(collect({ repo: 'o/r', since: SINCE, fetchImpl, retryDelayMs: 0 })).rejects.toThrow(
      GitHubError,
    );
    expect(calls).toBe(1);
  });

  it('never retries a spent rate limit, because asking again is what spent it', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return notOk(403, { 'x-ratelimit-remaining': '0' });
    };
    await expect(
      collect({ repo: 'o/r', since: SINCE, fetchImpl, retryDelayMs: 0 }),
    ).rejects.toMatchObject({ reason: 'rate-limit' });
    expect(calls).toBe(1);
  });

  it('names a spent rate limit as itself, because the fix for it is a different one', async () => {
    const fetchImpl = async () =>
      notOk(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789000000' });
    await expect(collect({ repo: 'o/r', since: SINCE, fetchImpl })).rejects.toMatchObject({
      reason: 'rate-limit',
    });
  });

  it('does not ask a skipped run for its jobs, because it ran none', async () => {
    const { fetchImpl, calls } = stubFetch({
      pages: [[rawRun({ conclusion: 'skipped' }), rawRun()]],
    });
    const { runs, requests } = await collect({ repo: 'o/r', since: SINCE, fetchImpl });
    expect(runs).toHaveLength(2);
    expect(requests).toBe(1);
    expect(calls.filter((url) => url.includes('/jobs'))).toHaveLength(1);
  });

  it('carries the failing step of a job through, and leaves it empty when none is recorded', async () => {
    const { fetchImpl } = stubFetch({
      pages: [[rawRun({ conclusion: 'failure' })]],
      jobs: [
        {
          run_id: 1,
          name: 'E2E (F3)',
          conclusion: 'failure',
          status: 'completed',
          started_at: '2026-09-01T12:00:00Z',
          completed_at: '2026-09-01T12:05:00Z',
          html_url: 'https://github.com/o/r/actions/runs/1/job/9',
          steps: [
            { name: 'Checkout', conclusion: 'success' },
            { name: 'Run pnpm test:e2e', conclusion: 'failure' },
          ],
        },
        {
          run_id: 1,
          name: 'Build',
          conclusion: 'cancelled',
          status: 'completed',
          started_at: '2026-09-01T12:00:00Z',
          completed_at: '2026-09-01T12:00:30Z',
          html_url: 'https://github.com/o/r/actions/runs/1/job/8',
          steps: [],
        },
      ],
    });
    const { jobs } = await collect({ repo: 'o/r', since: SINCE, fetchImpl });
    expect(jobs[0].failedStep).toBe('Run pnpm test:e2e');
    expect(jobs[1].failedStep).toBeNull();
  });
});
