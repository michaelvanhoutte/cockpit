/**
 * The whole pipeline against a stubbed API: argv in, a real file on disk out.
 * Everything below this level is covered by the unit tests; what only this
 * level can show is that the three halves are wired to each other and that a
 * failed fetch leaves nothing behind.
 */

import { existsSync, readdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli.js';
import { zipOf } from '../support/zip.js';

const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-stability-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

function stubApi({ runs = [], jobs = [] } = {}) {
  vi.stubGlobal('fetch', async (url) => {
    if (url.includes('/jobs')) return ok({ jobs });
    const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
    return ok({ workflow_runs: page === 1 ? runs : [] });
  });
}

const rawRun = (overrides = {}) => ({
  id: 1,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'push',
  head_branch: 'main',
  conclusion: 'failure',
  status: 'completed',
  head_sha: 'deadbeef1234',
  created_at: new Date(Date.now() - 3_600_000).toISOString(),
  run_attempt: 1,
  html_url: 'https://github.com/o/r/actions/runs/1',
  ...overrides,
});

const rawJob = (overrides = {}) => ({
  run_id: 1,
  name: 'E2E (F3)',
  conclusion: 'failure',
  status: 'completed',
  started_at: new Date(Date.now() - 3_600_000).toISOString(),
  completed_at: new Date(Date.now() - 3_300_000).toISOString(),
  html_url: 'https://github.com/o/r/actions/runs/1/job/9',
  steps: [{ name: 'Run pnpm test:e2e', conclusion: 'failure' }],
  ...overrides,
});

describe('the generator, end to end against a stubbed API', () => {
  it('writes the model, carrying the failing job and its step, and draws no page', async () => {
    stubApi({ runs: [rawRun()], jobs: [rawJob()] });
    const dir = path.join(tmp(), 'stability');
    const out = path.join(dir, 'model.json');

    expect(await main(['--repo', 'o/r', '--model', out])).toBe(0);

    const model = JSON.parse(readFileSync(out, 'utf8'));
    expect(model.repo).toBe('o/r');
    expect(JSON.stringify(model)).toContain('E2E (F3)');
    expect(JSON.stringify(model)).toContain('Run pnpm test:e2e');
    // The directory it was told to write to did not exist; a run that only
    // works into an existing tree would fail on the first CI run of a fresh
    // checkout.
    expect(readdirSync(dir)).toEqual(['model.json']);
  });

  it('carries the numbers something else can read', async () => {
    stubApi({ runs: [rawRun({ conclusion: 'success' })], jobs: [rawJob({ conclusion: 'success' })] });
    const out = path.join(tmp(), 'model.json');

    expect(await main(['--repo', 'o/r', '--model', out])).toBe(0);

    const model = JSON.parse(readFileSync(out, 'utf8'));
    expect(model.windows[0].workflows[0].jobs[0].tally.rate).toBe(1);
  });

  it('writes no model at all when the API refuses, rather than one full of plausible zeroes', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 403,
      headers: { get: (name) => (name === 'x-ratelimit-remaining' ? '0' : null) },
      json: async () => ({}),
    }));
    const out = path.join(tmp(), 'model.json');

    expect(await main(['--repo', 'o/r', '--model', out])).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('stops on a bad argument before spending a single request', async () => {
    // Which arguments are refused, and what the complaint says, is parseArgs's
    // own business and is proved in tests/unit/cli.test.js. What only this level
    // can show is that main acts on the complaint rather than fetching anyway.
    const fetched = [];
    vi.stubGlobal('fetch', async (url) => {
      fetched.push(url);
      return ok({ workflow_runs: [] });
    });
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      expect(await main(['--repo', 'o/r', '--max-runs', '8OO'])).toBe(2);
      expect(await main(['--branhc', 'main'])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(fetched).toEqual([]);
  });

  describe('with --send, the runs reach the Harness Monitor after the model is written', () => {
    const NOW = new Date('2026-10-23T12:00:00Z');

    /**
     * GitHub with `runs` (by default two, days apart), and a Monitor that holds `newestRun` and
     * `newestAttempt` and answers each send of runs with `answer`, each send of attempts with
     * `attemptAnswer` (a function of the batch's place, from 1, where it should differ).
     */
    function stubBoth({
      newestRun = null,
      newestAttempt = null,
      answer = { status: 200, body: { stored: 1 } },
      attemptAnswer = () => ({ status: 200, body: { stored: 1 } }),
      runs = [rawRun({ id: 2, created_at: '2026-10-23T08:00:00Z' }), rawRun({ id: 1, created_at: '2026-10-19T08:00:00Z' })],
      jobs = (runId) => [rawJob({ run_id: runId })],
      artifacts = [],
      zips = {},
      withoutAttempts = false,
    } = {}) {
      const posted = [];
      const postedAttempts = [];
      const sentAttempts = [];
      const asked = [];
      vi.stubGlobal('fetch', async (url, init) => {
        if (url.startsWith('https://monitor.test')) {
          // A Monitor not yet deployed with the attempts' address answers as an unknown address does.
          if (withoutAttempts && url.includes('/v1/ci-attempts')) return { ok: false, status: 404, json: async () => ({}) };
          if (init?.method === 'POST' && url.endsWith('/v1/ci-attempts')) {
            const { attempts } = JSON.parse(init.body);
            sentAttempts.push(...attempts);
            postedAttempts.push(attempts.map((attempt) => `${attempt.runId}/${attempt.attempt}`));
            const answered = attemptAnswer(postedAttempts.length);
            return { ok: answered.status === 200, status: answered.status, json: async () => answered.body };
          }
          if (init?.method === 'POST') {
            posted.push(JSON.parse(init.body).runs.map((run) => run.id));
            return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
          }
          return ok(url.endsWith('/v1/ci-attempts?on=main') ? { newestAttempt } : { newestRun });
        }
        asked.push(url);
        const listed = url.match(/runs\/(\d+)\/(?:attempts\/\d+\/)?jobs/);
        if (listed) return ok({ jobs: jobs(Number(listed[1])) });
        if (url.includes('/artifacts?')) return ok({ artifacts: artifacts.filter((each) => each.name === new URL(url).searchParams.get('name')) });
        const zip = url.match(/\/artifacts\/(\d+)\/zip$/);
        if (zip) return zips[zip[1]];
        const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
        return ok({ workflow_runs: page === 1 ? runs : [] });
      });
      vi.stubEnv('HARNESS_MONITOR_URL', 'https://monitor.test');
      vi.stubEnv('HARNESS_WRITE_KEY', 'k');
      return { posted, postedAttempts, sentAttempts, asked };
    }

    const quietly = async (run, said = []) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((text) => said.push(String(text)));
      try {
        return await run();
      } finally {
        stderr.mockRestore();
      }
    };

    it('a run budget that stops the read inside the send window fails, naming the backfill, and the model over its own window is whole', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      // The Monitor is weeks behind, so the send reads past the page's 30 days and the budget stops it on 21 Sep.
      const { posted } = stubBoth({
        newestRun: '2026-09-01T08:00:00.000Z',
        runs: ['2026-10-23', '2026-09-22', '2026-09-21', '2026-09-20'].map((date, i) => rawRun({ id: 10 - i, created_at: `${date}T08:00:00Z` })),
      });
      const dir = tmp();
      const said = [];
      try {
        const args = ['--repo', 'o/r', '--model', path.join(dir, 'model.json'), '--send', '--max-runs', '3'];
        expect(await quietly(() => main(args), said)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expect(posted).toEqual([[8, 9, 10]]);
      expect(said.join('')).toContain('Send them with the Stability backfill, --from 2026-08-30 --to 2026-09-21.');
      expect(JSON.parse(readFileSync(path.join(dir, 'model.json'), 'utf8')).coverage).toMatchObject({ partial: false, truncated: false });
    });

    it('a run budget that stops the read past the send window\'s start sends it all and fails nothing', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const { posted } = stubBoth({
        newestRun: '2026-10-23T08:00:00.000Z',
        newestAttempt: '2026-10-23T08:00:00.000Z',
        runs: ['2026-10-23', '2026-10-22', '2026-10-19', '2026-10-18'].map((date, i) => rawRun({ id: 10 - i, created_at: `${date}T08:00:00Z` })),
      });
      const said = [];
      try {
        expect(await quietly(() => main(['--repo', 'o/r', '--model', path.join(tmp(), 'model.json'), '--send', '--max-runs', '3']), said)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
      expect(posted).toEqual([[9, 10]]);
      expect(said.join('')).not.toContain('stopped the read');
    });

    it('sends from the newest stored run less two days, and writes the model over its own window', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const { posted } = stubBoth({ newestRun: '2026-10-22T08:00:00.000Z' });
      const out = path.join(tmp(), 'model.json');
      try {
        expect(await quietly(() => main(['--repo', 'o/r', '--model', out, '--send']))).toBe(0);
      } finally {
        vi.useRealTimers();
      }
      expect(posted).toEqual([[2]]);
      expect(existsSync(out)).toBe(true);
    });

    it('sends the oldest runs first, so a send stopped partway leaves the newest stored run before what it missed', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const { posted } = stubBoth();
      try {
        expect(await quietly(() => main(['--repo', 'o/r', '--model', path.join(tmp(), 'model.json'), '--send']))).toBe(0);
      } finally {
        vi.useRealTimers();
      }
      expect(posted).toEqual([[1, 2]]);
    });

    it('a refused send fails the run and keeps the model', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const { posted } = stubBoth({ answer: { status: 400, body: { error: 'Run 0 (2): has no conclusion.' } } });
      const out = path.join(tmp(), 'model.json');
      try {
        expect(await quietly(() => main(['--repo', 'o/r', '--model', out, '--send']))).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expect(posted).toEqual([[1, 2]]);
      expect(existsSync(out)).toBe(true);
    });

    it('a window given by hand is read as a range, sent whatever is stored, and writes nothing', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const { posted, asked } = stubBoth({ newestRun: '2026-10-22T08:00:00.000Z' });
      const out = path.join(tmp(), 'model.json');
      try {
        expect(await quietly(() => main(['--repo', 'o/r', '--model', out, '--send', '--from', '2026-10-01', '--to', '2026-10-20']))).toBe(0);
      } finally {
        vi.useRealTimers();
      }
      expect(decodeURIComponent(asked[0])).toContain('created=2026-10-01T00:00:00Z..2026-10-21T00:00:00Z');
      expect(posted).toEqual([[1]]);
      expect(existsSync(out)).toBe(false);
    });

    describe('every attempt of the runs is sent too, from the newest attempt the Monitor holds less two days', () => {
      /** Runs the tool with `--send` at NOW, for a Monitor and GitHub as `stubBoth` is given; returns its exit code, and what it said. */
      async function sending(options, extraArgs = []) {
        vi.useFakeTimers({ toFake: ['Date'], now: NOW });
        const said = [];
        const stubbed = stubBoth(options);
        const out = path.join(tmp(), 'model.json');
        try {
          const code = await quietly(() => main(['--repo', 'o/r', '--model', out, '--send', ...extraArgs]), said);
          return { code, said: said.join(''), out, ...stubbed };
        } finally {
          vi.useRealTimers();
        }
      }

      const rerun = (id, created) => rawRun({ id, created_at: `${created}T08:00:00Z`, run_attempt: 2 });

      it('reads and sends the attempts of the runs inside the window, and an earlier attempt of a run outside it is not read', async () => {
        const { code, postedAttempts, asked } = await sending({
          newestRun: '2026-10-23T08:00:00.000Z',
          newestAttempt: '2026-10-22T08:00:00.000Z',
          runs: [rawRun({ id: 3, created_at: '2026-10-23T08:00:00Z' }), rerun(2, '2026-10-22'), rerun(1, '2026-10-19')],
        });

        expect(code).toBe(0);
        expect(postedAttempts.flat().sort()).toEqual(['2/1', '2/2', '3/1']);
        expect(asked.filter((url) => url.includes('/attempts/'))).toEqual(['https://api.github.com/repos/o/r/actions/runs/2/attempts/1/jobs?per_page=100']);
      });

      it('with none held, reads the last 30 days as the runs do', async () => {
        const { code, posted, postedAttempts, asked } = await sending({
          newestRun: '2026-10-22T08:00:00.000Z',
          newestAttempt: null,
          runs: [rawRun({ id: 1, created_at: '2026-10-23T08:00:00Z' }), rerun(2, '2026-09-28')],
        });

        expect(code).toBe(0);
        expect(posted).toEqual([[1]]);
        expect(postedAttempts.flat().sort()).toEqual(['1/1', '2/1', '2/2']);
        expect(asked.some((url) => url.includes('/runs/2/attempts/1/jobs'))).toBe(true);
      });

      it('more attempts than one batch holds go as several batches, each stored', async () => {
        const runs = Array.from({ length: 120 }, (_, i) => rawRun({ id: 120 - i, created_at: '2026-10-23T08:00:00Z' }));
        const { code, postedAttempts } = await sending({ runs });

        expect(code).toBe(0);
        expect(postedAttempts.map((batch) => batch.length)).toEqual([50, 50, 20]);
        expect(new Set(postedAttempts.flat()).size).toBe(120);
      });

      it('a batch the Monitor refuses fails the run naming the attempt, and the batches before it stay stored', async () => {
        const runs = Array.from({ length: 120 }, (_, i) => rawRun({ id: 120 - i, created_at: '2026-10-23T08:00:00Z' }));
        const { code, said, posted, postedAttempts } = await sending({
          runs,
          attemptAnswer: (batch) => (batch === 2 ? { status: 400, body: { error: 'Attempt 0 (run 71, attempt 1): has no conclusion.' } } : { status: 200, body: { stored: 50 } }),
        });

        expect(code).toBe(1);
        expect(said).toContain('refused batch 2 of 3 (400: Attempt 0 (run 71, attempt 1): has no conclusion.). 1 batch of 3 was stored (50 attempts)');
        // The send stopped at the refusal, and the runs, sent before the attempts, were not held back by it.
        expect(postedAttempts).toHaveLength(2);
        expect(posted.map((batch) => batch.length)).toEqual([50, 50, 20]);
      });

      it('a Monitor that cannot say where the attempts start costs the attempts alone: the runs are sent and the model written', async () => {
        const { code, said, posted, postedAttempts, out } = await sending({ withoutAttempts: true });

        expect(code).toBe(1);
        expect(said).toContain('The Harness Monitor answered 404 when asked its newest attempt.');
        expect(posted).toEqual([[1, 2]]);
        expect(postedAttempts).toEqual([]);
        expect(existsSync(out)).toBe(true);
      });

      it('a failed job carries the tests its record names, read from the artifact its own run of the job uploaded', async () => {
        const { code, sentAttempts } = await sending({
          runs: [rawRun({ id: 5, created_at: '2026-10-23T08:00:00Z' })],
          jobs: (runId) => [
            rawJob({ run_id: runId, name: 'Test', started_at: '2026-10-23T10:00:00Z', completed_at: '2026-10-23T10:10:00Z', steps: [{ name: 'Run pnpm test', conclusion: 'failure' }] }),
          ],
          artifacts: [{ id: 11, name: 'test-selection-record', created_at: '2026-10-23T10:10:00Z', expired: false }],
          zips: { 11: zipOf({ failedTests: [{ file: 'apps/api/tests/triage.test.ts', name: 'Triage > a dismissed item leaves the lists', error: 'expected 1 to be 2' }], failedTestsMore: 2 }) },
        });

        expect(code).toBe(0);
        expect(sentAttempts).toHaveLength(1);
        expect(sentAttempts[0]).toMatchObject({ runId: 5, attempt: 1, workflow: 'CI', branch: 'main', onMain: true, outcome: 'fail' });
        expect(sentAttempts[0].failedJobs).toEqual([
          {
            name: 'Test',
            step: 'Run pnpm test',
            url: 'https://github.com/o/r/actions/runs/1/job/9',
            tests: [{ file: 'apps/api/tests/triage.test.ts', name: 'Triage > a dismissed item leaves the lists', project: null, error: 'expected 1 to be 2' }],
            testsMore: 2,
          },
        ]);
      });
    });
  });

  it('refuses the flags that used to choose a page, before fetching anything', async () => {
    const fetched = [];
    vi.stubGlobal('fetch', async (url) => {
      fetched.push(url);
      return ok({ workflow_runs: [] });
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['--repo', 'o/r', '--json'])).toBe(2);
      expect(await main(['--repo', 'o/r', '--out', 'a/index.html'])).toBe(2);
      expect(fetched).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      stderr.mockRestore();
    }
  });
});
