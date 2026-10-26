/**
 * The nightly send of every branch's attempts but main's, as the command makes it: argv in,
 * GitHub and the Harness Monitor stubbed at the network, the sends that reach the Monitor out.
 * The rows themselves are decided and tested below this level (attempts.test.js,
 * branch-runs.test.js); what only this level shows is that the window comes from the Monitor's
 * answer for branches, that only branches are read and sent, and what a refusal leaves stored.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli.js';
import { zipOf } from '../support/zip.js';

const NOW = new Date('2026-10-23T12:00:00Z');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

const rawRun = (id, created, overrides = {}) => ({
  id,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'pull_request',
  head_branch: 'claude/1582-nightly',
  pull_requests: [{ number: 1604 }],
  conclusion: 'success',
  status: 'completed',
  head_sha: 'deadbeef1234',
  created_at: created,
  run_attempt: 1,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  ...overrides,
});

const rawJob = (runId, overrides = {}) => ({
  run_id: runId,
  name: 'Test',
  conclusion: 'failure',
  status: 'completed',
  started_at: '2026-10-22T10:00:00Z',
  completed_at: '2026-10-22T10:10:00Z',
  html_url: `https://github.com/o/r/actions/runs/${runId}/job/9`,
  steps: [{ name: 'Run pnpm test', conclusion: 'failure' }],
  ...overrides,
});

/**
 * GitHub holding `runs` (listed by their `created` range, a hundred to a page) and a Monitor that
 * holds `newestBranch` and `newestMain` as its newest attempts. `refuseListingFrom` answers the
 * listing that starts at that time with a spent allowance; `monitorDown` answers the Monitor's
 * newest with a 404; `refuseSend` answers the nth send of attempts with a 400.
 */
function stubWorld({
  newestBranch = '2026-10-22T08:00:00.000Z',
  newestMain = '2026-10-23T08:00:00.000Z',
  runs = [],
  jobs = () => [],
  artifacts = [],
  zips = {},
  refuseListingFrom = null,
  monitorDown = false,
  refuseSend = null,
} = {}) {
  const sends = [];
  const sentRows = [];
  const monitorAsked = [];
  const github = [];
  vi.stubGlobal('fetch', async (url, init) => {
    if (url.startsWith('https://monitor.test')) {
      monitorAsked.push(url.replace('https://monitor.test', ''));
      if (monitorDown) return { ok: false, status: 404, json: async () => ({}) };
      if (init?.method === 'POST') {
        const { attempts } = JSON.parse(init.body);
        sends.push(attempts.map((attempt) => `${attempt.runId}/${attempt.attempt}`));
        sentRows.push(...attempts);
        return refuseSend === sends.length
          ? { ok: false, status: 400, json: async () => ({ error: 'Attempt 0: has no conclusion.' }) }
          : ok({ stored: attempts.length });
      }
      return ok({ newestAttempt: url.endsWith('on=branches') ? newestBranch : newestMain });
    }

    github.push(decodeURIComponent(url.replace('https://api.github.com', '')));
    const listed = url.match(/runs\/(\d+)\/(?:attempts\/(\d+)\/)?jobs/);
    if (listed) return ok({ jobs: jobs(Number(listed[1]), listed[2] ? Number(listed[2]) : null) });
    if (url.includes('/artifacts?')) return ok({ artifacts: artifacts.filter((each) => each.name === new URL(url).searchParams.get('name')) });
    const zip = url.match(/\/artifacts\/(\d+)\/zip$/);
    if (zip) return zips[zip[1]];

    const params = new URL(url).searchParams;
    const [start, end] = params.get('created').split('..').map((time) => new Date(time));
    if (refuseListingFrom && start.toISOString().startsWith(refuseListingFrom.slice(0, 19))) {
      return { ok: false, status: 403, headers: { get: (name) => ({ 'x-ratelimit-remaining': '0' })[name] ?? null }, json: async () => ({}) };
    }
    const inRange = runs.filter((run) => new Date(run.created_at) >= start && new Date(run.created_at) <= end);
    const page = Number(params.get('page'));
    return ok({ workflow_runs: inRange.slice((page - 1) * 100, page * 100) });
  });
  vi.stubEnv('HARNESS_MONITOR_URL', 'https://monitor.test');
  vi.stubEnv('HARNESS_WRITE_KEY', 'k');
  return { sends, sentRows, monitorAsked, github };
}

async function nightly(options, extraArgs = []) {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  const world = stubWorld(options);
  const said = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((text) => said.push(String(text)));
  try {
    const code = await main(['--repo', 'o/r', '--branches', '--send', ...extraArgs]);
    return { code, said: said.join(''), ...world };
  } finally {
    stderr.mockRestore();
  }
}

const listings = (github) => github.filter((call) => call.includes('/actions/runs?created='));

describe('CI stability', () => {
  describe("the nightly send reads only feature branches, from the newest held of their own less two days", () => {
    it("reads from the newest feature-branch attempt less two days, and never asks for main's", async () => {
      const { code, github, monitorAsked } = await nightly({ newestBranch: '2026-10-22T08:00:00.000Z', newestMain: '2026-10-23T08:00:00.000Z' });

      expect(code).toBe(0);
      expect(monitorAsked).toEqual(['/v1/ci-attempts?on=branches']);
      expect(listings(github)[0]).toContain('created=2026-10-20T08:00:00Z..2026-10-21T07:59:59Z');
      expect(listings(github).at(-1)).toContain('..2026-10-23T11:59:59Z');
    });

    it("sends a pull request's attempts and a push to a branch with their branch, pull request and verdict, and the failed jobs of the failed one alone", async () => {
      const { code, sentRows, github } = await nightly({
        runs: [
          rawRun(1, '2026-10-22T09:00:00Z'),
          rawRun(2, '2026-10-22T09:30:00Z', { conclusion: 'failure' }),
          rawRun(3, '2026-10-22T10:00:00Z', { event: 'push', head_branch: 'claude/other', pull_requests: [] }),
        ],
        jobs: (runId) => (runId === 2 ? [rawJob(2)] : []),
        artifacts: [{ id: 11, name: 'test-selection-record', created_at: '2026-10-22T10:10:00Z', expired: false }],
        zips: { 11: zipOf({ failedTests: [{ file: 'apps/api/tests/triage.test.ts', name: 'Triage > a dismissed item leaves the lists', error: 'expected 1 to be 2' }], failedTestsMore: 0 }) },
      });

      expect(code).toBe(0);
      expect(sentRows.map((row) => [row.runId, row.branch, row.pullRequest, row.outcome, row.onMain, row.jobs, row.failedJobs.length])).toEqual([
        [1, 'claude/1582-nightly', 1604, 'pass', false, [], 0],
        [2, 'claude/1582-nightly', 1604, 'fail', false, [], 1],
        [3, 'claude/other', null, 'pass', false, [], 0],
      ]);
      expect(sentRows[1].failedJobs[0]).toMatchObject({ name: 'Test', step: 'Run pnpm test', tests: [{ name: 'Triage > a dismissed item leaves the lists' }] });
      // The attempt that passed asked GitHub for no job at all.
      expect(github.filter((call) => call.includes('/jobs'))).toEqual(['/repos/o/r/actions/runs/2/jobs?per_page=100']);
    });

    it('does not send a run on main, whatever started it, nor one reporting on a pull request', async () => {
      const { code, sends } = await nightly({
        runs: [
          rawRun(1, '2026-10-22T09:00:00Z', { event: 'push', head_branch: 'main', pull_requests: [] }),
          rawRun(2, '2026-10-22T09:10:00Z', { event: 'schedule', head_branch: 'main', pull_requests: [] }),
          rawRun(3, '2026-10-22T09:20:00Z', { event: 'workflow_run', head_branch: 'claude/other' }),
          rawRun(4, '2026-10-22T09:30:00Z'),
        ],
      });

      expect(code).toBe(0);
      expect(sends).toEqual([['4/1']]);
    });

    it('sends a re-run on the next night as its new attempt beside the one it replaced', async () => {
      const { code, sentRows } = await nightly({
        // The first night sent attempt 1 of run 7, started 22 Oct 09:00; the run was re-run this morning.
        newestBranch: '2026-10-22T09:00:00.000Z',
        runs: [rawRun(7, '2026-10-22T09:00:00Z', { run_attempt: 2, run_started_at: '2026-10-23T07:00:00Z' })],
        jobs: (runId, attempt) => (attempt === 1 ? [rawJob(runId, { started_at: '2026-10-22T09:01:00Z', completed_at: '2026-10-22T09:11:00Z' })] : []),
      });

      expect(code).toBe(0);
      expect(sentRows.map((row) => [row.runId, row.attempt, row.outcome, row.createdAt])).toEqual([
        [7, 1, 'fail', '2026-10-22T09:01:00Z'],
        [7, 2, 'pass', '2026-10-23T07:00:00Z'],
      ]);
    });

    describe('a re-run started after its run\'s day is sent last, so a stop cannot move the newest past days not yet sent', () => {
      const world = {
        runs: [
          rawRun(1, '2026-10-20T12:00:00Z', { run_attempt: 2, run_started_at: '2026-10-23T07:00:00Z' }),
          rawRun(2, '2026-10-21T12:00:00Z'),
          rawRun(3, '2026-10-22T12:00:00Z'),
        ],
        jobs: (runId, attempt) => (runId === 1 && attempt === 1 ? [rawJob(1, { started_at: '2026-10-20T12:01:00Z', completed_at: '2026-10-20T12:11:00Z' })] : []),
      };

      it('after the last day when the night completes', async () => {
        const { code, sends } = await nightly(world);

        expect(code).toBe(0);
        expect(sends).toEqual([['1/1'], ['2/1'], ['3/1'], ['1/2']]);
      });

      it('not at all when GitHub stops the night first, which says how to send it', async () => {
        const { code, sends, said } = await nightly({ ...world, refuseListingFrom: '2026-10-22T08:00:00Z' });

        expect(code).toBe(1);
        expect(sends).toEqual([['1/1'], ['2/1']]);
        expect(said).toContain('1 re-run attempts started after their day were held back; --from 2026-10-20 sends them.');
      });

      it('not at all when the run budget stops the night first', async () => {
        const { code, sends, said } = await nightly(world, ['--max-runs', '1']);

        expect(code).toBe(1);
        expect(sends).toEqual([['1/1']]);
        expect(said).toContain('1 re-run attempts started after their day were held back');
      });

      it('in the order they started, and a Monitor that refuses them fails the night naming them', async () => {
        const later = { ...world, runs: [...world.runs, rawRun(4, '2026-10-21T13:00:00Z', { run_attempt: 2, run_started_at: '2026-10-22T09:00:00Z' })] };
        const { sends } = await nightly(later);
        expect(sends.at(-1)).toEqual(['4/2', '1/2']);

        const { code, said } = await nightly({ ...later, refuseSend: 4 });
        expect(code).toBe(1);
        expect(said).toContain('The re-runs started after their day were not sent; 4 attempts were sent before them');
      });
    });

    it('reads every page of a day with more runs than one page holds, and sends them in batches the Monitor takes', async () => {
      const runs = Array.from({ length: 150 }, (_, i) => rawRun(1000 + i, '2026-10-22T09:00:00Z'));
      const { code, sends, github } = await nightly({ runs });

      expect(code).toBe(0);
      expect(sends.map((batch) => batch.length)).toEqual([50, 50, 50]);
      const day = listings(github).filter((call) => call.includes('created=2026-10-22T08:00:00Z..'));
      expect(day.map((call) => call.match(/&page=(\d+)/)[1])).toEqual(['1', '2']);
    });

    it('a request GitHub refuses halfway fails the job naming it, and the days sent before it stay stored', async () => {
      const { code, said, sends } = await nightly({
        runs: [rawRun(1, '2026-10-20T12:00:00Z'), rawRun(2, '2026-10-21T12:00:00Z'), rawRun(3, '2026-10-22T12:00:00Z')],
        refuseListingFrom: '2026-10-22T08:00:00Z',
      });

      expect(code).toBe(1);
      expect(said).toContain("GitHub's rate limit is spent");
      expect(said).toContain('The day from 2026-10-22T08:00:00.000Z was not sent; 2 attempts were sent before it');
      expect(sends).toEqual([['1/1'], ['2/1']]);
    });

    it('a send the Monitor refuses fails the job naming the attempt, and the days sent before it stay stored', async () => {
      const { code, said, sends } = await nightly({
        runs: [rawRun(1, '2026-10-20T12:00:00Z'), rawRun(2, '2026-10-21T12:00:00Z')],
        refuseSend: 2,
      });

      expect(code).toBe(1);
      expect(said).toContain('refused batch 1 of 1 (400: Attempt 0: has no conclusion.)');
      expect(said).toContain('The day from 2026-10-21T08:00:00.000Z was not sent; 1 attempts were sent before it');
      expect(sends).toEqual([['1/1'], ['2/1']]);
    });

    it('a run budget stops the read after the day that reaches it, and fails, saying the next night continues', async () => {
      const { code, said, sends } = await nightly(
        { runs: [rawRun(1, '2026-10-20T12:00:00Z'), rawRun(2, '2026-10-20T13:00:00Z'), rawRun(3, '2026-10-21T12:00:00Z')] },
        ['--max-runs', '2'],
      );

      expect(code).toBe(1);
      expect(sends).toEqual([['1/1', '2/1']]);
      expect(said).toContain('The run budget (--max-runs 2) stopped the read at 2026-10-21T08:00:00.000Z');
      expect(said).toContain('The next night continues from the newest the Monitor holds.');
    });

    it('a Monitor that cannot say where the branches start costs the night, with nothing read from GitHub', async () => {
      const { code, said, sends, github } = await nightly({ monitorDown: true, runs: [rawRun(1, '2026-10-22T09:00:00Z')] });

      expect(code).toBe(1);
      expect(said).toContain('The Harness Monitor answered 404 when asked its newest attempt.');
      expect(sends).toEqual([]);
      expect(github).toEqual([]);
    });

    it('with none held, reads the last 30 days, and with nothing to send sends nothing and passes', async () => {
      const { code, sends, github } = await nightly({ newestBranch: null }, ['--max-runs', '100000']);

      expect(code).toBe(0);
      expect(sends).toEqual([]);
      expect(listings(github)[0]).toContain('created=2026-09-23T12:00:00Z..');
    });
  });

  describe('a window given by hand is sent whatever the Monitor holds, for the backfill', () => {
    it('reads the days from the first to the last, inclusive, and does not ask the Monitor where to start', async () => {
      const { code, sends, monitorAsked, github } = await nightly(
        { runs: [rawRun(1, '2026-10-01T09:00:00Z'), rawRun(2, '2026-10-02T09:00:00Z'), rawRun(3, '2026-10-03T09:00:00Z')] },
        ['--from', '2026-10-01', '--to', '2026-10-02'],
      );

      expect(code).toBe(0);
      // Only the sends, one a day: no question about where to start.
      expect(monitorAsked).toEqual(['/v1/ci-attempts', '/v1/ci-attempts']);
      expect(listings(github)).toHaveLength(2);
      expect(listings(github)[0]).toContain('created=2026-10-01T00:00:00Z..2026-10-01T23:59:59Z');
      expect(sends).toEqual([['1/1'], ['2/1']]);
    });
  });
});
