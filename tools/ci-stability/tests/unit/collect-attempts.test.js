import { describe, expect, it } from 'vitest';

import { collectAttempts, GitHubError, listRuns } from '../../src/github.js';
import { zipOf } from '../support/zip.js';

const SINCE = new Date('2026-10-18T00:00:00Z');

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const refuse = (status, headers = {}) => ({ ok: false, status, headers: { get: (name) => headers[name] ?? null }, json: async () => ({}) });

const run = (overrides = {}) => ({
  id: 1,
  workflow: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'push',
  branch: 'main',
  pullRequest: null,
  conclusion: 'failure',
  status: 'completed',
  headSha: 'deadbeef1234',
  createdAt: '2026-10-20T08:00:00Z',
  startedAt: '2026-10-20T08:00:00Z',
  attempt: 1,
  url: 'https://github.com/o/r/actions/runs/1',
  ...overrides,
});

/** A job as `listJobs` hands it over, run from `from` to `to` on 20 Oct. */
const job = (name, conclusion, from = '08:01', to = '08:11', overrides = {}) => ({
  runId: 1,
  name,
  conclusion,
  status: 'completed',
  startedAt: `2026-10-20T${from}:00Z`,
  completedAt: `2026-10-20T${to}:00Z`,
  failedStep: conclusion === 'failure' ? 'Run pnpm test' : null,
  steps: [],
  url: 'https://github.com/o/r/actions/runs/1/job/9',
  ...overrides,
});

const rawJob = (name, conclusion, from, to) => ({
  run_id: 1,
  name,
  conclusion,
  status: 'completed',
  started_at: `2026-10-20T${from}:00Z`,
  completed_at: `2026-10-20T${to}:00Z`,
  html_url: 'https://github.com/o/r/actions/runs/1/job/9',
  steps: [],
});

const artifact = (id, created, name = 'test-selection-record', expired = false) => ({ id, name, created_at: `2026-10-20T${created}:00Z`, expired });
const record = (...names) => ({ failedTests: names.map((name) => ({ file: 'apps/api/tests/x.test.ts', name, error: 'boom' })), failedTestsMore: 0 });

/**
 * GitHub with `attempts` (runs/1/attempts/N/jobs by attempt), the run's `artifacts`, and the zips
 * by artifact id. Keeps every request it was asked.
 */
function stubGithub({ attempts = {}, artifacts = [], zips = {}, failOn = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.replace('https://api.github.com', ''));
    if (failOn && url.includes(failOn.part)) return failOn.answer;
    const earlier = url.match(/\/runs\/(\d+)\/attempts\/(\d+)\/jobs/);
    if (earlier) return attempts[earlier[2]] ? ok({ jobs: attempts[earlier[2]] }) : refuse(404);
    if (url.includes('/jobs')) return ok({ jobs: [] });
    if (url.includes('/artifacts?')) {
      const wanted = new URL(url).searchParams.get('name');
      return ok({ artifacts: artifacts.filter((each) => each.name === wanted) });
    }
    const zip = url.match(/\/artifacts\/(\d+)\/zip$/);
    if (zip) return zips[zip[1]] ?? refuse(500);
    return ok({ workflow_runs: [] });
  };
  return { fetchImpl, calls };
}

const collect = (stub, runs, jobs = [], extra = {}) => collectAttempts({ repo: 'o/r', runs, jobs, since: SINCE, fetchImpl: stub.fetchImpl, retries: 0, ...extra });
const asked = (stub, part) => stub.calls.filter((call) => call.includes(part));

describe('CI stability', () => {
  describe("every attempt of a run is read, and a request is spent only where a re-run or a failed job's record needs one", () => {
    it('a run never re-run asks for nothing beyond the jobs already read', async () => {
      const stub = stubGithub();
      const entries = await collect(stub, [run({ conclusion: 'success' })], [job('Test', 'success')]);

      expect(entries.map((each) => [each.attempt, each.jobs.map((j) => j.name)])).toEqual([[1, ['Test']]]);
      expect(stub.calls).toEqual([]);
    });

    it("a run re-run twice reads each earlier attempt's own jobs, one request each, and the latest from the jobs already read", async () => {
      const stub = stubGithub({ attempts: { 1: [rawJob('Test', 'failure', '08:01', '08:11')], 2: [rawJob('Test', 'failure', '09:01', '09:11')] } });
      const entries = await collect(stub, [run({ attempt: 3 })], [job('Test', 'success', '10:01', '10:11')]);

      expect(entries.map((each) => [each.attempt, each.jobs.map((j) => j.conclusion)])).toEqual([[1, ['failure']], [2, ['failure']], [3, ['success']]]);
      expect(asked(stub, '/attempts/')).toEqual(['/repos/o/r/actions/runs/1/attempts/1/jobs?per_page=100', '/repos/o/r/actions/runs/1/attempts/2/jobs?per_page=100']);
    });

    it('an earlier attempt GitHub no longer holds is read as having no job, not as a failure of the send', async () => {
      const stub = stubGithub({ attempts: {} });
      const entries = await collect(stub, [run({ attempt: 2 })], [job('Test', 'success')]);

      expect(entries.map((each) => [each.attempt, each.jobs])).toEqual([[1, []], [2, expect.any(Array)]]);
    });

    it('a run created before the window is not read at all', async () => {
      const stub = stubGithub();
      const entries = await collect(stub, [run({ createdAt: '2026-10-10T08:00:00Z', attempt: 2 })], []);

      expect(entries).toEqual([]);
      expect(stub.calls).toEqual([]);
    });

    it.each([
      { situation: 'one that failed', conclusion: 'failure', requests: 1 },
      { situation: 'one that passed', conclusion: 'success', requests: 0 },
      { situation: 'one that was cancelled', conclusion: 'cancelled', requests: 0 },
    ])("a Dependabot run, $situation, costs $requests request(s) for its jobs", async ({ conclusion, requests }) => {
      const stub = stubGithub();
      const dependabot = run({ path: 'dynamic/dependabot/dependabot-updates', event: 'dynamic', workflow: 'npm_and_yarn in /. for esbuild - Update #5', conclusion });
      await collect(stub, [dependabot], []);

      expect(asked(stub, '/jobs')).toHaveLength(requests);
    });

    it('a run listed with the attempt number, event, branch and pull request GitHub gives it carries them', async () => {
      const raw = {
        id: 9, name: 'CI', path: '.github/workflows/ci.yml', event: 'pull_request', head_branch: 'claude/1581', run_attempt: 2, run_started_at: '2026-10-20T09:00:00Z',
        pull_requests: [{ number: 1604 }], conclusion: 'success', status: 'completed', head_sha: 'abc', created_at: '2026-10-20T08:00:00Z', html_url: 'https://github.com/o/r/actions/runs/9',
      };
      const { runs } = await listRuns({ repo: 'o/r', since: SINCE, maxRuns: 10, fetchImpl: async () => ok({ workflow_runs: [raw] }) });

      expect(runs[0]).toMatchObject({ event: 'pull_request', branch: 'claude/1581', attempt: 2, pullRequest: 1604, startedAt: '2026-10-20T09:00:00Z' });
    });

    it("a Dependabot run, which belongs to no workflow file, is handed over beside the runs but is not one of them", async () => {
      const dependabot = { id: 5, name: 'npm_and_yarn in /. for esbuild - Update #5', path: 'dynamic/dependabot/dependabot-updates', event: 'dynamic', head_branch: 'main', conclusion: 'failure', status: 'completed', head_sha: 'a', created_at: '2026-10-20T08:00:00Z', html_url: 'u' };
      const other = { ...dependabot, id: 6, name: 'Running Copilot', path: 'dynamic/copilot-swe-agent/copilot' };
      const { runs, ignored, dependabot: found } = await listRuns({ repo: 'o/r', since: SINCE, maxRuns: 10, fetchImpl: async () => ok({ workflow_runs: [dependabot, other] }) });

      expect(runs).toEqual([]);
      expect(ignored).toBe(2);
      expect(found.map((each) => each.id)).toEqual([5]);
    });
  });

  describe('a failed job that keeps a record is read for the tests it names, from the artifact its own attempt uploaded', () => {
    const failedTest = job('Test', 'failure', '08:01', '08:11');

    it('one artifact list and one download for a failed Test job, and its record read', async () => {
      const stub = stubGithub({ artifacts: [artifact(11, '08:11')], zips: { 11: zipOf({ ...record('Triage > a'), packages: ['too big to keep'] }) } });
      const [entry] = await collect(stub, [run()], [failedTest]);

      expect(entry.jobs[0].record).toEqual({ state: 'read', value: { failedTests: [expect.objectContaining({ name: 'Triage > a' })], failedTestsMore: 0 } });
      expect(asked(stub, '/artifacts?')).toEqual(['/repos/o/r/actions/runs/1/artifacts?name=test-selection-record&per_page=100']);
      expect(asked(stub, '/zip')).toHaveLength(1);
    });

    it('the fan-in of the shards reads the merged record, and a job that keeps none asks for no artifact', async () => {
      const stub = stubGithub({ artifacts: [artifact(21, '08:11', 'e2e-selection-record')], zips: { 21: zipOf(record('Capture > a')) } });
      const [entry] = await collect(stub, [run()], [job('E2E (F3) (1)', 'failure'), job('E2E (F3)', 'failure'), job('Lint', 'failure')]);

      expect(entry.jobs.map((each) => [each.name, each.record?.state ?? null])).toEqual([['E2E (F3) (1)', null], ['E2E (F3)', 'read'], ['Lint', null]]);
      expect(asked(stub, 'name=e2e-selection-record')).toHaveLength(1);
      expect(asked(stub, 'name=test-selection-record')).toHaveLength(0);
    });

    it('a job that passed asks for no artifact', async () => {
      const stub = stubGithub({ artifacts: [artifact(11, '08:11')] });
      await collect(stub, [run({ conclusion: 'success' })], [job('Test', 'success')]);

      expect(asked(stub, '/artifacts')).toEqual([]);
    });

    it("a re-run's two attempts each read the artifact created during their own job, from one list of the run's artifacts", async () => {
      const stub = stubGithub({
        attempts: { 1: [rawJob('Test', 'failure', '08:01', '08:11')] },
        artifacts: [artifact(11, '08:11'), artifact(12, '09:11')],
        zips: { 11: zipOf(record('first attempt')), 12: zipOf(record('second attempt')) },
      });
      const entries = await collect(stub, [run({ attempt: 2 })], [job('Test', 'failure', '09:01', '09:11')]);

      expect(entries.map((each) => each.jobs[0].record.value.failedTests[0].name)).toEqual(['first attempt', 'second attempt']);
      expect(asked(stub, '/artifacts?')).toHaveLength(1);
    });

    it.each([
      { situation: 'no artifact of that name', artifacts: [], why: 'absent' },
      { situation: 'one that expired', artifacts: [artifact(11, '08:11', 'test-selection-record', true)], why: 'expired' },
      { situation: 'two created during the job', artifacts: [artifact(11, '08:10'), artifact(12, '08:11')], why: 'ambiguous' },
      { situation: 'only one from another attempt', artifacts: [artifact(11, '07:00')], why: 'absent' },
    ])('$situation reads as not recorded ($why), naming no test', async ({ artifacts, why }) => {
      const stub = stubGithub({ artifacts });
      const [entry] = await collect(stub, [run()], [failedTest]);

      expect(entry.jobs[0].record).toEqual({ state: 'not-recorded', why });
      expect(asked(stub, '/zip')).toEqual([]);
    });

    it.each([
      { situation: 'a download GitHub fails', zips: {}, },
      { situation: 'a download that breaks off mid-body', zips: { 11: { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => { throw new TypeError('terminated'); } } } },
      { situation: 'a download that is not an archive', zips: { 11: { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('not a zip').buffer } } },
    ])('$situation leaves the job unreadable rather than failing the send', async ({ zips }) => {
      const stub = stubGithub({ artifacts: [artifact(11, '08:11')], zips });
      const [entry] = await collect(stub, [run()], [failedTest]);

      expect(entry.jobs[0].record).toEqual({ state: 'not-recorded', why: 'unreadable' });
    });

    it('a download that breaks off mid-body is asked again, and read when the next answer is whole', async () => {
      const whole = zipOf(record('Triage > a'));
      let answers = 0;
      const zips = { 11: { ...whole, arrayBuffer: async () => (answers++ === 0 ? Promise.reject(new TypeError('terminated')) : whole.arrayBuffer()) } };
      const stub = stubGithub({ artifacts: [artifact(11, '08:11')], zips });
      const [entry] = await collect(stub, [run()], [failedTest], { retries: 1, retryDelayMs: 0 });

      expect(entry.jobs[0].record.state).toBe('read');
      expect(asked(stub, '/zip')).toHaveLength(2);
    });

    it('a spent allowance fails the read, since asking again is what spent it', async () => {
      const stub = stubGithub({ artifacts: [artifact(11, '08:11')], failOn: { part: '/artifacts?', answer: refuse(403, { 'x-ratelimit-remaining': '0' }) } });

      await expect(collect(stub, [run()], [failedTest])).rejects.toMatchObject({ reason: 'rate-limit' });
      await expect(collect(stub, [run()], [failedTest])).rejects.toBeInstanceOf(GitHubError);
    });
  });
});
