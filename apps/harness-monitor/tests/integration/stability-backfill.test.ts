import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The backfill is the engineer's command, plain JavaScript under tools/: it runs here as it runs there, against this Worker and its D1.
// @ts-expect-error no declarations for a tool written without types
import { backfill } from '../../../../tools/ci-stability/src/backfill.js';
// @ts-expect-error likewise
import { zipOf } from '../../../../tools/ci-stability/tests/support/zip.js';
import { emptyTheDatabase, storedAttempts, storedFailedTests, WRITE_KEY } from './support';

const NOW = new Date('2026-10-12T12:00:00Z');
const MONITOR = 'https://monitor.test';

beforeEach(emptyTheDatabase);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Raw = Record<string, unknown>;

const rawRun = (id: number, created: string, over: Raw = {}): Raw => ({
  id,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'push',
  head_branch: 'main',
  pull_requests: [],
  conclusion: 'success',
  status: 'completed',
  head_sha: 'a'.repeat(40),
  created_at: created,
  run_attempt: 1,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  ...over,
});

const rawJob = (runId: number, name: string, conclusion: string, over: Raw = {}): Raw => ({
  id: runId * 10,
  run_id: runId,
  name,
  conclusion,
  status: 'completed',
  started_at: '2026-10-02T10:00:00Z',
  completed_at: '2026-10-02T10:10:00Z',
  html_url: `https://github.com/o/r/actions/runs/${runId}/job/${runId * 10}`,
  steps: [{ number: 1, name: conclusion === 'failure' ? 'Run node scripts/ci-test.mjs' : 'Run the tests', conclusion, started_at: '2026-10-02T10:00:00Z', completed_at: '2026-10-02T10:10:00Z' }],
  ...over,
});

const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

interface World {
  runs?: Raw[];
  jobs?: (runId: number) => Raw[];
  annotations?: Record<string, Raw[]>;
  logs?: Record<string, string>;
  artifacts?: Raw[];
  zips?: Record<string, unknown>;
}

/** GitHub holding `world`, and the Monitor as this Worker. Answers every request GitHub was asked. */
function theWorld({ runs = [], jobs = () => [], annotations = {}, logs = {}, artifacts = [], zips = {} }: World = {}) {
  const github: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.startsWith(MONITOR)) return SELF.fetch(url, init);
    const path = decodeURIComponent(url.replace('https://api.github.com', ''));
    github.push(path);
    const listed = path.match(/runs\/(\d+)\/(?:attempts\/\d+\/)?jobs/);
    if (listed) return ok({ jobs: jobs(Number(listed[1])) });
    const noted = path.match(/check-runs\/(\d+)\/annotations/);
    if (noted) return ok(annotations[noted[1]!] ?? []);
    const logged = path.match(/jobs\/(\d+)\/logs/);
    if (logged) return { ok: true, status: 200, headers: { get: () => null }, text: async () => logs[logged[1]!] ?? '' };
    if (path.includes('/artifacts?')) return ok({ artifacts: artifacts.filter((each) => each.name === new URL(url).searchParams.get('name')) });
    const zip = path.match(/artifacts\/(\d+)\/zip/);
    if (zip) return zips[zip[1]!];

    const params = new URL(url).searchParams;
    const [start, end] = params.get('created')!.split('..').map((time) => new Date(time));
    const branch = params.get('branch');
    const inRange = runs.filter((run) => new Date(run.created_at as string) >= start! && new Date(run.created_at as string) <= end! && (branch === null || run.head_branch === branch));
    const page = Number(params.get('page'));
    return ok({ workflow_runs: inRange.slice((page - 1) * 100, page * 100) });
  });
  vi.stubEnv('HARNESS_MONITOR_URL', MONITOR);
  vi.stubEnv('HARNESS_WRITE_KEY', WRITE_KEY);
  vi.stubEnv('GITHUB_TOKEN', 'a-token');
  return { github };
}

/** The command, run on `argv` with the clock held at 12 October. */
async function theCommand(argv: string[]) {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  const said: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((text) => !!said.push(String(text)));
  try {
    const code = await backfill(['--repo', 'o/r', ...argv], { now: NOW });
    return { code: code as number, said: said.join('') };
  } finally {
    stderr.mockRestore();
  }
}

const storedWhere = async () =>
  (await env.DB.prepare('SELECT run_id, attempt, branch, pull_number, on_main FROM ci_attempts ORDER BY run_id, attempt').all()).results;

describe('Harness Monitor', () => {
  describe("the backfill sends every attempt since 1 October on main and on every other branch, once, whatever number of times it runs", () => {
    const onBranch = { event: 'pull_request', head_branch: 'claude/x', pull_requests: [{ number: 1604 }] };

    it('stores a run of main with its jobs and steps and a run of a branch with its failure alone, each as the two nightly jobs store them', async () => {
      theWorld({
        runs: [rawRun(1, '2026-10-02T09:00:00Z'), rawRun(2, '2026-10-03T09:00:00Z', { ...onBranch, conclusion: 'failure' }), rawRun(3, '2026-10-04T09:00:00Z', { ...onBranch })],
        jobs: (runId) => (runId === 2 ? [rawJob(2, 'Test', 'failure'), rawJob(2, 'Lint', 'success')] : [rawJob(runId, 'Test', 'success')]),
      });

      expect((await theCommand(['--from', '2026-10-01', '--to', '2026-10-05'])).code).toBe(0);

      expect(await storedAttempts()).toEqual([
        { run_id: 1, attempt: 1, outcome: 'pass', jobs: 1, steps: 1, failed_jobs: 0 },
        { run_id: 2, attempt: 1, outcome: 'fail', jobs: 0, steps: 0, failed_jobs: 1 },
        { run_id: 3, attempt: 1, outcome: 'pass', jobs: 0, steps: 0, failed_jobs: 0 },
      ]);
      expect(await storedWhere()).toEqual([
        { run_id: 1, attempt: 1, branch: 'main', pull_number: null, on_main: 1 },
        { run_id: 2, attempt: 1, branch: 'claude/x', pull_number: 1604, on_main: 0 },
        { run_id: 3, attempt: 1, branch: 'claude/x', pull_number: 1604, on_main: 0 },
      ]);
    });

    it("reads a failure's tests from its record when it has one, and never its annotations or log", async () => {
      const { github } = theWorld({
        runs: [rawRun(2, '2026-10-03T09:00:00Z', { ...onBranch, conclusion: 'failure' })],
        jobs: () => [rawJob(2, 'Test', 'failure', { started_at: '2026-10-03T09:01:00Z', completed_at: '2026-10-03T09:11:00Z' })],
        artifacts: [{ id: 11, name: 'test-selection-record', created_at: '2026-10-03T09:11:00Z', expired: false }],
        zips: { 11: zipOf({ failedTests: [{ file: 'apps/api/tests/triage.test.ts', name: 'Triage > a dismissed item leaves the lists', error: 'expected 1 to be 2' }], failedTestsMore: 0 }) },
        logs: { 20: ' FAIL  tests/other.test.ts > Other > never read' },
      });

      await theCommand(['--from', '2026-10-01', '--to', '2026-10-05']);

      expect(await storedFailedTests()).toEqual([{ run_id: 2, attempt: 1, job: 'Test', step: 'Run node scripts/ci-test.mjs', name: 'Triage > a dismissed item leaves the lists', project: null }]);
      expect(github.filter((call) => call.includes('/logs') || call.includes('/annotations'))).toEqual([]);
    });

    it("reads an older failure's tests from its annotations, or its log, where nothing records them", async () => {
      theWorld({
        runs: [rawRun(2, '2026-10-03T09:00:00Z', { ...onBranch, conclusion: 'failure' }), rawRun(4, '2026-10-04T09:00:00Z', { conclusion: 'failure' })],
        jobs: (runId) => [rawJob(runId, runId === 2 ? 'E2E (F3)' : 'Test', 'failure', { steps: [{ number: 1, name: runId === 2 ? "Run this shard's walks" : 'Run node scripts/ci-test.mjs', conclusion: 'failure' }] })],
        annotations: {
          20: [{ annotation_level: 'failure', path: 'tests/e2e/support/app.ts', title: '[phone] › tests/e2e/triage.test.ts:57:9 › Triage › starting work', message: '  1) [phone] › tests/e2e/triage.test.ts:57:9 › Triage › starting work on an item \n    Error: strict mode violation' }],
        },
        logs: { 40: '2026-10-04T09:05:00.0Z [@cockpit/x] FAIL  tests/unit/a.test.ts > A > rule\n2026-10-04T09:05:00.0Z [@cockpit/x] Error: boom' },
      });

      await theCommand(['--from', '2026-10-01', '--to', '2026-10-05']);

      expect(await storedFailedTests()).toEqual([
        { run_id: 2, attempt: 1, job: 'E2E (F3)', step: "Run this shard's walks", name: 'Triage > starting work on an item', project: 'phone' },
        { run_id: 4, attempt: 1, job: 'Test', step: 'Run node scripts/ci-test.mjs', name: 'A > rule', project: null },
      ]);
      const { results } = await env.DB.prepare('SELECT file, error FROM ci_failed_tests ORDER BY run_id').all();
      expect(results).toEqual([
        { file: 'tests/e2e/triage.test.ts', error: 'Error: strict mode violation' },
        // The Worker pool has no checkout to read the workspace from, so the log's package is unresolved and the path stays as given (the mapping is proved in tools/ci-stability).
        { file: 'tests/unit/a.test.ts', error: 'Error: boom' },
      ]);
    });

    it('run a second time, stores the same rows and none twice', async () => {
      theWorld({
        runs: [rawRun(1, '2026-10-02T09:00:00Z'), rawRun(2, '2026-10-03T09:00:00Z', { ...onBranch, conclusion: 'failure', run_attempt: 2, run_started_at: '2026-10-04T12:00:00Z' })],
        jobs: (runId) => (runId === 1 ? [rawJob(1, 'Test', 'success')] : [rawJob(2, 'Test', 'failure')]),
        logs: { 20: ' FAIL  tests/unit/a.test.ts > A > rule' },
      });

      await theCommand(['--from', '2026-10-01', '--to', '2026-10-05']);
      const first = { attempts: await storedAttempts(), tests: await storedFailedTests(), where: await storedWhere() };
      expect(first.attempts).toHaveLength(3);
      expect(first.tests).toHaveLength(2);

      expect((await theCommand(['--from', '2026-10-01', '--to', '2026-10-05'])).code).toBe(0);

      expect({ attempts: await storedAttempts(), tests: await storedFailedTests(), where: await storedWhere() }).toEqual(first);
    });

    it('reads every run of a day with more runs than one list of GitHub holds', async () => {
      theWorld({ runs: Array.from({ length: 150 }, (_, i) => rawRun(1000 + i, '2026-10-02T09:00:00Z', { ...onBranch })) });

      expect((await theCommand(['--from', '2026-10-02', '--to', '2026-10-02', '--only', 'branches'])).code).toBe(0);

      expect(await storedAttempts()).toHaveLength(150);
    });
  });
});
