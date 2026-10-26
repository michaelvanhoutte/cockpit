/**
 * The backfill as the engineer runs it: argv and the environment in, GitHub and the Harness Monitor
 * stubbed at the network, what reaches the Monitor out. What the Monitor stores from it is proved
 * against the real Worker and D1 in apps/harness-monitor (stability-backfill.test.ts); what only
 * this level shows is the order the two sends run in, the windows each is given, and where a stop
 * leaves the engineer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { backfill } from '../../src/backfill.js';

const NOW = new Date('2026-10-12T12:00:00Z');

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
  event: 'push',
  head_branch: 'main',
  pull_requests: [],
  conclusion: 'success',
  status: 'completed',
  head_sha: 'deadbeef1234',
  created_at: created,
  run_attempt: 1,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  ...overrides,
});

const rawJob = (runId, overrides = {}) => ({
  id: runId * 10,
  run_id: runId,
  name: 'Test',
  conclusion: 'failure',
  status: 'completed',
  started_at: '2026-10-05T10:00:00Z',
  completed_at: '2026-10-05T10:10:00Z',
  html_url: `https://github.com/o/r/actions/runs/${runId}/job/${runId * 10}`,
  steps: [{ name: 'Run node scripts/ci-test.mjs', conclusion: 'failure' }],
  ...overrides,
});

/** GitHub holding `runs`, and a Monitor that stores what it is sent. `refuseListingFrom` spends the allowance at the listing that starts then. */
function stubWorld({ runs = [], jobs = (runId) => [rawJob(runId)], logs = {}, refuseListingFrom = null } = {}) {
  const monitor = [];
  const github = [];
  vi.stubGlobal('fetch', async (url, init) => {
    if (url.startsWith('https://monitor.test')) {
      const path = url.replace('https://monitor.test', '');
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        monitor.push({ path, ids: (body.runs ?? body.attempts).map((each) => (each.attempt ? `${each.runId}/${each.attempt}` : String(each.id))), attempts: body.attempts });
        return ok({ stored: 1 });
      }
      monitor.push({ path, asked: true });
      return ok({});
    }

    const path = decodeURIComponent(url.replace('https://api.github.com', ''));
    github.push(path);
    const listed = path.match(/runs\/(\d+)\/jobs/);
    if (listed) return ok({ jobs: jobs(Number(listed[1])) });
    if (path.includes('/annotations')) return ok([]);
    const log = path.match(/jobs\/(\d+)\/logs/);
    if (log) return { ok: true, status: 200, headers: { get: () => null }, text: async () => logs[log[1]] ?? '' };
    if (path.includes('/artifacts?')) return ok({ artifacts: [] });

    const params = new URL(url).searchParams;
    const [start, end] = params.get('created').split('..').map((time) => new Date(time));
    if (refuseListingFrom && start.toISOString().startsWith(refuseListingFrom)) {
      return { ok: false, status: 403, headers: { get: (name) => ({ 'x-ratelimit-remaining': '0' })[name] ?? null }, json: async () => ({}) };
    }
    const branch = params.get('branch');
    const inRange = runs.filter((run) => new Date(run.created_at) >= start && new Date(run.created_at) <= end && (branch === null || run.head_branch === branch));
    return ok({ workflow_runs: inRange.slice((Number(params.get('page')) - 1) * 100, Number(params.get('page')) * 100) });
  });
  vi.stubEnv('HARNESS_MONITOR_URL', 'https://monitor.test');
  vi.stubEnv('HARNESS_WRITE_KEY', 'k');
  return { monitor, github };
}

async function run(argv, options) {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  const world = stubWorld(options);
  const said = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((text) => said.push(String(text)));
  try {
    const code = await backfill(['--repo', 'o/r', ...argv], { now: NOW });
    return { code, said: said.join(''), ...world };
  } finally {
    stderr.mockRestore();
  }
}

const listings = (github, branch) => github.filter((call) => call.includes('/actions/runs?') && (branch ? call.includes('branch=main') : !call.includes('branch=')));

describe('CI stability', () => {
  describe("the backfill sends main's runs and attempts, then every other branch's attempts, for the days it is given", () => {
    const runs = [
      rawRun(1, '2026-10-02T09:00:00Z'),
      rawRun(2, '2026-10-02T10:00:00Z', { event: 'pull_request', head_branch: 'claude/x', pull_requests: [{ number: 5 }], conclusion: 'failure' }),
      rawRun(3, '2026-10-09T09:00:00Z', { conclusion: 'failure' }),
    ];

    it("reads main a week at a time, oldest first, then the other branches a day at a time, and asks the Monitor where it starts nowhere", async () => {
      const { code, monitor, github, said } = await run(['--from', '2026-10-01', '--to', '2026-10-09'], { runs });

      expect(code).toBe(0);
      expect(listings(github, 'main').map((call) => call.match(/created=([^&]+)/)[1])).toEqual([
        '2026-10-01T00:00:00Z..2026-10-08T00:00:00Z',
        '2026-10-08T00:00:00Z..2026-10-10T00:00:00Z',
      ]);
      expect(listings(github).map((call) => call.match(/created=([^.]+)\.\./)[1])).toEqual(
        ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((day) => `2026-10-${day}T00:00:00Z`),
      );
      expect(monitor.filter((call) => call.asked)).toEqual([]);
      // Main's runs, then its attempts, a week at a time; then the branches' attempts, the day they ran.
      expect(monitor.map((call) => [call.path, call.ids])).toEqual([
        ['/v1/stability', ['1']],
        ['/v1/ci-attempts', ['1/1']],
        ['/v1/stability', ['3']],
        ['/v1/ci-attempts', ['3/1']],
        ['/v1/ci-attempts', ['2/1']],
      ]);
      expect(said).toContain('Done:');
    });

    it('reads the tests of a failure from its log, since no record names them, and sends them with the attempt', async () => {
      const log = '2026-10-09T09:05:00.0Z [@cockpit/x] FAIL  tests/unit/a.test.ts > A > rule\n2026-10-09T09:05:00.0Z [@cockpit/x] Error: boom';
      const { monitor, github } = await run(['--from', '2026-10-09', '--to', '2026-10-09', '--only', 'main'], { runs, logs: { 30: log } });

      const sent = monitor.find((call) => call.path === '/v1/ci-attempts').attempts;
      expect(sent[0].failedJobs[0].tests).toEqual([{ file: 'tests/unit/a.test.ts', name: 'A > rule', project: null, error: 'Error: boom' }]);
      expect(github.filter((call) => call.includes('/logs'))).toEqual(['/repos/o/r/actions/jobs/30/logs']);
    });

    it.each([
      { only: 'main', reads: { main: true, others: false } },
      { only: 'branches', reads: { main: false, others: true } },
    ])('--only $only reads that half and not the other', async ({ only, reads }) => {
      const { code, github } = await run(['--from', '2026-10-01', '--to', '2026-10-09', '--only', only], { runs });

      expect(code).toBe(0);
      expect(listings(github, 'main').length > 0).toBe(reads.main);
      expect(listings(github).length > 0).toBe(reads.others);
    });

    it('starts on 1 October when given no day, and ends today', async () => {
      const { github } = await run([], { runs: [] });

      expect(listings(github, 'main')[0]).toContain('created=2026-10-01T00:00:00Z..2026-10-08T00:00:00Z');
      expect(listings(github, 'main').at(-1)).toContain('..2026-10-13T00:00:00Z');
    });
  });

  describe('a stop says what was sent and how to send the rest', () => {
    it("GitHub's allowance spent in a week of main stops there, names that week as the place to start again, and reads no other branch", async () => {
      const { code, said, github, monitor } = await run(['--from', '2026-10-01', '--to', '2026-10-12'], {
        runs: [rawRun(1, '2026-10-02T09:00:00Z'), rawRun(2, '2026-10-09T09:00:00Z')],
        refuseListingFrom: '2026-10-08',
      });

      expect(code).toBe(1);
      expect(said).toContain("GitHub's rate limit is spent");
      expect(said).toContain('pnpm stability:backfill --from 2026-10-08 --to 2026-10-12');
      expect(monitor.map((call) => call.ids)).toEqual([['1'], ['1/1']]);
      expect(listings(github)).toEqual([]);
    });

    it("a day of the other branches that GitHub refuses stops there, naming the day, after main was sent whole", async () => {
      const { code, said } = await run(['--from', '2026-10-01', '--to', '2026-10-05'], {
        runs: [rawRun(2, '2026-10-02T10:00:00Z', { event: 'pull_request', head_branch: 'claude/x' })],
        refuseListingFrom: '2026-10-03',
      });

      expect(code).toBe(1);
      expect(said).toContain('The day from 2026-10-03T00:00:00.000Z was not sent; 1 attempts were sent before it, and --from 2026-10-03 sends the rest.');
      expect(said).toContain('pnpm stability:backfill --only branches');
    });

    it("counts the requests it made to GitHub, and not the Monitor's", async () => {
      const { said } = await run(['--from', '2026-10-01', '--to', '2026-10-01'], { runs: [rawRun(1, '2026-10-01T09:00:00Z')], jobs: (runId) => [rawJob(runId, { conclusion: 'success', steps: [] })] });

      // main's listing and its run's jobs, then the day's listing of the other branches.
      expect(said).toMatch(/Done: 3 GitHub requests/);
    });
  });

  describe('a backfill that cannot start says why, and reads nothing', () => {
    it.each([
      { situation: 'no write key', env: { HARNESS_WRITE_KEY: '' }, argv: [], complaint: 'Set HARNESS_MONITOR_URL and HARNESS_WRITE_KEY first' },
      { situation: 'no Monitor address', env: { HARNESS_MONITOR_URL: '' }, argv: [], complaint: 'Set HARNESS_MONITOR_URL and HARNESS_WRITE_KEY first' },
      { situation: 'an end before its start', env: {}, argv: ['--from', '2026-10-05', '--to', '2026-10-04'], complaint: '--to cannot be before --from' },
      { situation: 'a day that does not exist', env: {}, argv: ['--from', '2026-02-30'], complaint: '--from needs a day as YYYY-MM-DD' },
      { situation: 'a half that does not exist', env: {}, argv: ['--only', 'both'], complaint: '--only needs main or branches' },
      { situation: 'an argument it does not know', env: {}, argv: ['--send'], complaint: 'unknown argument: --send' },
    ])('refuses $situation', async ({ env, argv, complaint }) => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const { github } = stubWorld();
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const said = [];
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((text) => said.push(String(text)));
      try {
        expect(await backfill(argv, { now: NOW })).toBe(2);
      } finally {
        stderr.mockRestore();
      }

      expect(said.join('')).toContain(complaint);
      expect(github).toEqual([]);
    });
  });
});
