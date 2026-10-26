import { describe, expect, it } from 'vitest';

import { collectAttempts, dayChunks, GitHubError, listBranchRuns } from '../../src/github.js';

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const refuse = (status) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}) });

let nextId = 1;
const rawRun = (overrides = {}) => ({
  id: nextId++,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'pull_request',
  head_branch: 'claude/1582-nightly',
  conclusion: 'success',
  status: 'completed',
  head_sha: 'aaaaaaa',
  created_at: '2026-10-20T12:00:00Z',
  run_attempt: 1,
  pull_requests: [{ number: 1604 }],
  html_url: 'https://github.com/o/r/actions/runs/1',
  ...overrides,
});

const FROM = new Date('2026-10-20T00:00:00Z');
const TO = new Date('2026-10-21T00:00:00Z');

/** GitHub answering run pages from `answer(range, page)`, keeping each request it was asked. */
function stubRuns(answer) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(decodeURIComponent(url.replace('https://api.github.com', '')));
    const range = new URL(url).searchParams.get('created');
    const page = Number(new URL(url).searchParams.get('page'));
    return ok({ workflow_runs: answer(range, page) });
  };
  return { fetchImpl, calls };
}

const list = (stub, over = {}) => listBranchRuns({ repo: 'o/r', from: FROM, to: TO, fetchImpl: stub.fetchImpl, retries: 0, ...over });

describe('CI stability', () => {
  describe("the runs on every branch but main's are listed by the day they were created", () => {
    it('asks for the span as a range and no branch, and drops the runs on main, whatever started them', async () => {
      const stub = stubRuns((_, page) =>
        page === 1
          ? [
              rawRun({ id: 1 }),
              rawRun({ id: 2, event: 'push', head_branch: 'main' }),
              rawRun({ id: 3, event: 'schedule', head_branch: 'main' }),
              rawRun({ id: 4, event: 'push', head_branch: 'claude/other', pull_requests: [] }),
              rawRun({ id: 5, event: 'pull_request_target', head_branch: 'main' }),
              rawRun({ id: 6, event: 'workflow_run', head_branch: 'claude/other' }),
            ]
          : [],
      );
      const { runs } = await list(stub);

      expect(runs.map((run) => run.id)).toEqual([1, 4, 5]);
      expect(stub.calls).toEqual(['/repos/o/r/actions/runs?created=2026-10-20T00:00:00Z..2026-10-20T23:59:59Z&per_page=100&page=1']);
    });

    it.each([
      { situation: 'created before the span', created: '2026-10-19T23:59:59Z', kept: false },
      { situation: 'created at its start', created: '2026-10-20T00:00:00Z', kept: true },
      { situation: 'created at the instant it ends, which belongs to the next span', created: '2026-10-21T00:00:00Z', kept: false },
    ])('a run $situation is kept: $kept', async ({ created, kept }) => {
      const stub = stubRuns(() => [rawRun({ id: 9, created_at: created })]);
      const { runs } = await list(stub);

      expect(runs.map((run) => run.id)).toEqual(kept ? [9] : []);
    });

    it('keeps Dependabot, which belongs to no workflow file, and counts any other run of none', async () => {
      const stub = stubRuns(() => [
        rawRun({ id: 1, path: 'dynamic/dependabot/dependabot-updates', event: 'dynamic', head_branch: null, name: 'npm_and_yarn in /. for esbuild - Update #5' }),
        rawRun({ id: 2, path: 'dynamic/something-else', event: 'dynamic', head_branch: null, name: 'Something' }),
      ]);
      const { runs, ignored } = await list(stub);

      expect(runs.map((run) => run.id)).toEqual([1]);
      expect(ignored).toBe(1);
    });

    it('reads every page of a span until one comes back short', async () => {
      const full = (from) => Array.from({ length: 100 }, (_, i) => rawRun({ id: from + i }));
      const stub = stubRuns((_, page) => [full(1000), full(2000), full(3000).slice(0, 40)][page - 1] ?? []);
      const { runs, truncated } = await list(stub);

      expect(runs).toHaveLength(240);
      expect(truncated).toBe(false);
      expect(stub.calls.map((call) => call.match(/&page=(\d+)/)[1])).toEqual(['1', '2', '3']);
    });

    it('a span that fills the ten pages GitHub lists at most is read again as two halves, with no run in both', async () => {
      const wide = (range) => new Date(range.split('..')[1]) - new Date(range.split('..')[0]) > 13 * 3_600_000;
      let id = 100;
      const stub = stubRuns((range, page) => {
        if (wide(range)) return Array.from({ length: 100 }, () => rawRun({ id: 1 }));
        return page === 1 ? [rawRun({ id: id++ }), rawRun({ id: id++ })] : [];
      });
      const { runs, truncated } = await list(stub);

      expect(truncated).toBe(false);
      expect(runs.map((run) => run.id)).toEqual([100, 101, 102, 103]);
      const ranges = stub.calls.filter((call) => /&page=1$/.test(call)).map((call) => call.match(/created=(.*?)&/)[1]);
      expect(ranges).toEqual(['2026-10-20T00:00:00Z..2026-10-20T23:59:59Z', '2026-10-20T00:00:00Z..2026-10-20T11:59:59Z', '2026-10-20T12:00:00Z..2026-10-20T23:59:59Z']);
    });

    it('a second that still fills them is reported truncated, rather than halved for ever', async () => {
      const stub = stubRuns(() => Array.from({ length: 100 }, (_, i) => rawRun({ id: i + 1 })));
      const { truncated } = await list(stub, { from: new Date('2026-10-20T00:00:00Z'), to: new Date('2026-10-20T00:00:02Z') });

      expect(truncated).toBe(true);
    });

    it('counts every request, so the night can say what it spent', async () => {
      const stub = stubRuns((_, page) => (page === 1 ? [rawRun()] : []));
      const counter = { requests: 0 };
      await list(stub, { counter });

      expect(counter.requests).toBe(1);
    });
  });

  describe('a window is cut into days, oldest first', () => {
    it('gives whole days from the window start, and the last one the rest', () => {
      const chunks = dayChunks(new Date('2026-10-20T08:00:00Z'), new Date('2026-10-22T12:00:00Z'));

      expect(chunks.map(({ from, to }) => [from.toISOString(), to.toISOString()])).toEqual([
        ['2026-10-20T08:00:00.000Z', '2026-10-21T08:00:00.000Z'],
        ['2026-10-21T08:00:00.000Z', '2026-10-22T08:00:00.000Z'],
        ['2026-10-22T08:00:00.000Z', '2026-10-22T12:00:00.000Z'],
      ]);
    });

    it('starts on a whole second, since the API reads a range to the second and would drop the runs of the second a boundary splits', () => {
      const chunks = dayChunks(new Date('2026-10-20T08:00:00.700Z'), new Date('2026-10-22T08:00:00Z'));

      expect(chunks.map(({ from }) => from.toISOString())).toEqual(['2026-10-20T08:00:00.000Z', '2026-10-21T08:00:00.000Z']);
    });

    it('gives none for a window with no length', () => {
      expect(dayChunks(new Date('2026-10-20T08:00:00Z'), new Date('2026-10-20T08:00:00Z'))).toEqual([]);
    });
  });

  describe("a branch's attempts read the jobs of the ones that failed and no other", () => {
    const run = (overrides = {}) => ({
      id: 1,
      workflow: 'CI',
      path: '.github/workflows/ci.yml',
      event: 'pull_request',
      branch: 'claude/1582-nightly',
      pullRequest: 1604,
      conclusion: 'failure',
      status: 'completed',
      headSha: 'deadbeef1234',
      createdAt: '2026-10-20T08:00:00Z',
      startedAt: '2026-10-20T08:00:00Z',
      attempt: 1,
      url: 'https://github.com/o/r/actions/runs/1',
      ...overrides,
    });

    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url.replace('https://api.github.com', ''));
      if (url.includes('/jobs')) return ok({ jobs: [{ run_id: 1, name: 'Lint', conclusion: 'failure', status: 'completed', steps: [{ name: 'Run pnpm lint', conclusion: 'failure' }] }] });
      return refuse(404);
    };
    const read = (runs, extra = {}) => collectAttempts({ repo: 'o/r', runs, since: new Date('2026-10-19T00:00:00Z'), fetchImpl, retries: 0, ...extra });

    it.each([
      { situation: 'failed', conclusion: 'failure', requests: 1 },
      { situation: 'passed', conclusion: 'success', requests: 0 },
      { situation: 'was cancelled', conclusion: 'cancelled', requests: 0 },
    ])('a run that $situation costs $requests request(s) for its jobs', async ({ conclusion, requests }) => {
      asked.length = 0;
      const [entry] = await read([run({ conclusion })], { failedJobs: true });

      expect(asked.filter((url) => url.includes('/jobs'))).toHaveLength(requests);
      expect(entry.jobs.map((job) => job.name)).toEqual(requests ? ['Lint'] : []);
    });

    it('a run that failed is left with no job unless asked for them, as the send for main reads them from its own list', async () => {
      asked.length = 0;
      const [entry] = await read([run()]);

      expect(asked).toEqual([]);
      expect(entry.jobs).toEqual([]);
    });

    it('a request GitHub refuses fails the read, naming it', async () => {
      await expect(read([run({ attempt: 2 })], { failedJobs: true, fetchImpl: async () => refuse(403) })).rejects.toThrow(GitHubError);
    });
  });
});
