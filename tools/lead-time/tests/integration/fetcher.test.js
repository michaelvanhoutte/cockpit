import { describe, expect, it } from 'vitest';

import { collect, GitHubError } from '../../src/github.js';
import { buildModel } from '../../src/model.js';

const SINCE = new Date('2026-09-08T00:00:00Z');
const NOW = new Date('2026-09-22T00:00:00Z');

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const refuse = (status, headers = {}) => ({
  ok: false,
  status,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => ({}),
});

/** A pull as the listing shows it, updated `updated` and merged `merged` (both ISO). */
const listed = (number, merged, updated = merged) => ({ number, merged_at: merged, updated_at: updated });

/**
 * The API for a repository whose merged pulls are `pulls` (numbers), each with two
 * commits the second of which had one check run on it. `override` may answer a
 * request first — return undefined to let the repository answer it.
 */
function stubApi({ listing, override = () => undefined }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const early = override(url);
    if (early !== undefined) return early;

    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith('/pulls')) {
      const page = Number(searchParams.get('page') ?? 1);
      return ok(listing.slice((page - 1) * 100, page * 100));
    }
    const commits = pathname.match(/\/pulls\/(\d+)\/commits$/);
    if (commits) {
      return ok(['a', 'b'].map((suffix) => ({ sha: `${commits[1]}${suffix}`, commit: { author: { date: '2026-09-10T09:00:00Z' } }, parents: [{}] })));
    }
    const detail = pathname.match(/\/pulls\/(\d+)$/);
    if (detail) {
      const pull = listing.find((entry) => entry.number === Number(detail[1]));
      return ok({ number: pull.number, title: `Pull ${pull.number}`, html_url: 'u', created_at: '2026-09-10T08:00:00Z', merged_at: pull.merged_at, body: '', additions: 1, deletions: 1, changed_files: 1, commits: 2 });
    }
    if (pathname.includes('/check-runs')) {
      const onB = pathname.includes('b/check-runs');
      const runs = onB ? [{ id: 1, name: 'Test', status: 'completed', conclusion: 'success', started_at: '2026-09-10T09:05:00Z', completed_at: '2026-09-10T09:15:00Z', check_suite: { id: 7 } }] : [];
      return ok({ total_count: runs.length, check_runs: runs });
    }
    return refuse(404);
  };
  return { fetchImpl, calls };
}

const collectFrom = (api, options = {}) => collect({ repo: 'o/r', since: SINCE, now: NOW, fetchImpl: api.fetchImpl, retries: 0, ...options });

describe('Lead time', () => {
  describe('a refused or partial fetch is reported, never silently shortened', () => {
    it('reads a pull request in about five requests, its earlier check attempts included', async () => {
      const api = stubApi({ listing: [listed(1, '2026-09-11T00:00:00Z'), listed(2, '2026-09-10T00:00:00Z'), listed(3, '2026-08-01T00:00:00Z')] });
      const { pulls, requests, reachedWindowEdge } = await collectFrom(api);

      expect(pulls.map((pull) => pull.number)).toEqual([1, 2]);
      expect(reachedWindowEdge).toBe(true);
      // One listing, then per pull: its detail, its commits and one per commit for its check runs.
      expect(requests).toBe(1 + 2 * (1 + 1 + 2));
      expect(api.calls.filter((url) => url.includes('/check-runs')).every((url) => url.includes('filter=all'))).toBe(true);
      expect(pulls[0].commits[1].checks).toHaveLength(1);
    });

    it('fails the run, saying so, where the rate limit is spent mid-fetch, and stops asking', async () => {
      const spent = refuse(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' });
      const api = stubApi({
        listing: [1, 2, 3, 4, 5, 6].map((n) => listed(n, '2026-09-11T00:00:00Z')),
        override: (url) => (url.endsWith('/pulls/3') ? spent : undefined),
      });
      await expect(collectFrom(api)).rejects.toMatchObject({ name: 'GitHubError', reason: 'rate-limit', message: expect.stringContaining('rate limit is spent') });

      const asked = api.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Nothing was still spending the allowance once it had run out.
      expect(api.calls.length).toBe(asked);
      expect(api.calls.some((url) => url.endsWith('/pulls/6'))).toBe(false);
    });

    it('treats a throttled burst as the same failure as a spent allowance, not as a pull request it could not read', async () => {
      const throttled = refuse(403, { 'retry-after': '60' });
      const api = stubApi({
        listing: [1, 2].map((n) => listed(n, '2026-09-11T00:00:00Z')),
        override: (url) => (url.endsWith('/pulls/1') ? throttled : undefined),
      });
      await expect(collectFrom(api)).rejects.toMatchObject({ reason: 'rate-limit' });
    });

    it('reports the shorter period as the coverage where the listing ends before the window does', async () => {
      const api = stubApi({ listing: [listed(1, '2026-09-20T00:00:00Z'), listed(2, '2026-09-15T00:00:00Z')] });
      const collected = await collectFrom(api);
      expect(collected.reachedWindowEdge).toBe(false);
      expect(collected.coveredSince).toEqual(new Date('2026-09-15T00:00:00Z'));

      const model = buildModel({ pulls: collected.pulls, now: NOW, requestedDays: 14, coveredSince: collected.coveredSince, repo: 'o/r' });
      expect(model.coverage.partial).toBe(true);
      expect(model.coverage.actualDays).toBeCloseTo(7);
      expect(model.windows.map((window) => window.partial)).toEqual([false, true]);
    });

    it('names a pull request whose commits cannot be read, leaves it out, and answers the rest', async () => {
      const api = stubApi({
        listing: [1, 2, 3].map((n) => listed(n, '2026-09-11T00:00:00Z')),
        override: (url) => (url.endsWith('/pulls/2/commits?per_page=100&page=1') ? refuse(404) : undefined),
      });
      const { pulls, failed } = await collectFrom(api);
      expect(pulls.map((pull) => pull.number)).toEqual([1, 3]);
      expect(failed).toEqual([{ number: 2, reason: expect.stringContaining('404') }]);
    });

    it('names a pull request whose check runs cannot be read, the same way', async () => {
      const api = stubApi({
        listing: [1, 2].map((n) => listed(n, '2026-09-11T00:00:00Z')),
        override: (url) => (url.includes('/commits/1a/check-runs') ? refuse(500) : undefined),
      });
      const { pulls, failed } = await collectFrom(api);
      expect(pulls.map((pull) => pull.number)).toEqual([2]);
      expect(failed.map((each) => each.number)).toEqual([1]);
    });

    it('stops at --max-pulls, and names the period it reached as the coverage', async () => {
      const api = stubApi({
        listing: [listed(1, '2026-09-21T00:00:00Z'), listed(2, '2026-09-18T00:00:00Z'), listed(3, '2026-09-12T00:00:00Z'), listed(4, '2026-09-10T00:00:00Z')],
      });
      const collected = await collectFrom(api, { maxPulls: 2 });

      expect(collected.pulls.map((pull) => pull.number)).toEqual([1, 2]);
      expect(collected.truncated).toBe(true);
      expect(collected.coveredSince).toEqual(new Date('2026-09-18T00:00:00Z'));
      // The third and fourth were never spent on.
      expect(api.calls.some((url) => url.endsWith('/pulls/3'))).toBe(false);

      const model = buildModel({ pulls: collected.pulls, now: NOW, requestedDays: 14, coveredSince: collected.coveredSince, truncated: true, repo: 'o/r' });
      expect(model.coverage).toMatchObject({ partial: true, truncated: true });
      expect(model.coverage.actualDays).toBeCloseTo(3.99, 1);
    });

    it('drops a pull closed without merging, and one merged before the window that was only touched inside it', async () => {
      const api = stubApi({
        listing: [listed(1, null, '2026-09-20T00:00:00Z'), listed(2, '2026-09-01T00:00:00Z', '2026-09-19T00:00:00Z'), listed(3, '2026-09-18T00:00:00Z')],
      });
      const { pulls } = await collectFrom(api);
      expect(pulls.map((pull) => pull.number)).toEqual([3]);
    });

    it('throws a GitHubError, not a bare one, so the command line can print it plainly', async () => {
      const api = stubApi({ listing: [], override: () => refuse(401) });
      await expect(collectFrom(api)).rejects.toBeInstanceOf(GitHubError);
    });
  });

  describe('only a failed attempt costs a request, and it is read for what it failed on', () => {
    /** A minimal, uncompressed zip archive holding one `record.json`. */
    function zipOf(json) {
      const content = Buffer.from(JSON.stringify(json), 'utf8');
      const name = Buffer.from('record.json', 'utf8');
      const local = Buffer.alloc(30 + name.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt32LE(content.length, 18);
      local.writeUInt32LE(content.length, 22);
      local.writeUInt16LE(name.length, 26);
      name.copy(local, 30);
      const central = Buffer.alloc(46 + name.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt32LE(content.length, 20);
      central.writeUInt32LE(content.length, 24);
      central.writeUInt16LE(name.length, 28);
      name.copy(central, 46);
      const localData = Buffer.concat([local, content]);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(central.length, 12);
      eocd.writeUInt32LE(localData.length, 16);
      const zip = Buffer.concat([localData, central, eocd]);
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
    }

    const recordOf = (path) => ({ packages: [{ name: 'p', report: 'written', files: [{ path, status: 'failed' }] }] });
    const attempt = (id, name, conclusion, from, to) => ({
      id,
      name,
      status: 'completed',
      conclusion,
      started_at: `2026-09-10T${from}:00Z`,
      completed_at: `2026-09-10T${to}:00Z`,
      check_suite: { id: 7 },
    });

    /**
     * One merged pull request with one commit carrying `runs`. `jobs` maps a job id to its
     * detail, `artifacts` lists the run's artifacts, `zips` answers a download by artifact id.
     */
    function stub({ runs, jobs = {}, artifacts = [], zips = {} }) {
      return stubApi({
        listing: [listed(1, '2026-09-11T00:00:00Z')],
        override: (url) => {
          const { pathname } = new URL(url);
          if (pathname.endsWith('/pulls/1/commits')) return ok([{ sha: 'a', commit: { author: { date: '2026-09-10T09:00:00Z' } }, parents: [{}] }]);
          if (pathname.endsWith('/commits/a/check-runs')) return ok({ total_count: runs.length, check_runs: runs });
          const job = pathname.match(/\/actions\/jobs\/(\d+)$/);
          if (job) return jobs[job[1]] ? ok({ run_id: 50, ...jobs[job[1]] }) : refuse(404);
          if (pathname.endsWith('/actions/runs/50/artifacts')) {
            const named = artifacts.filter((each) => each.name === new URL(url).searchParams.get('name'));
            return ok({ total_count: named.length, artifacts: named });
          }
          const zip = pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/);
          if (zip) return zips[zip[1]] ?? refuse(500);
          return undefined;
        },
      });
    }
    const artifact = (id, created, name = 'test-selection-record', expired = false) => ({ id, name, created_at: created, expired, archive_download_url: 'x' });
    const kinds = (api, part) => api.calls.filter((url) => new URL(url).pathname.includes(part)).length;

    it('asks for no job, artifact or download where every attempt passed', async () => {
      const api = stub({ runs: [attempt(1, 'Test', 'success', '09:05', '09:15'), attempt(2, 'Checks', 'success', '09:05', '09:08')] });
      const { pulls } = await collectFrom(api);
      expect(pulls[0].commits[0].checks.every((check) => check.failure === undefined)).toBe(true);
      expect(kinds(api, '/actions/')).toBe(0);
    });

    it('asks for one job, one artifact list and one download for one failed Test attempt, and reads its record', async () => {
      const api = stub({
        runs: [attempt(11, 'Test', 'failure', '09:05', '09:15')],
        jobs: { 11: { started_at: '2026-09-10T09:05:00Z', completed_at: '2026-09-10T09:15:00Z', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run the tests', conclusion: 'failure' }] } },
        artifacts: [artifact(900, '2026-09-10T09:14:50Z')],
        zips: { 900: zipOf(recordOf('a.test.ts')) },
      });
      const { pulls } = await collectFrom(api);
      expect(pulls[0].commits[0].checks[0].failure).toEqual({ steps: ['Run the tests'], record: { state: 'read', value: recordOf('a.test.ts') } });
      expect([kinds(api, '/actions/jobs/'), kinds(api, '/runs/50/artifacts'), kinds(api, '/zip')]).toEqual([1, 1, 1]);
    });

    it('gives each attempt of a re-run its own record, though both artifacts share a name', async () => {
      const api = stub({
        runs: [attempt(11, 'E2E (F3)', 'failure', '09:05', '09:15'), attempt(12, 'E2E (F3)', 'failure', '09:20', '09:30')],
        jobs: {
          11: { started_at: '2026-09-10T09:05:00Z', completed_at: '2026-09-10T09:15:00Z', steps: [{ name: 'Walks', conclusion: 'failure' }] },
          12: { started_at: '2026-09-10T09:20:00Z', completed_at: '2026-09-10T09:30:00Z', steps: [{ name: 'Walks', conclusion: 'failure' }] },
        },
        artifacts: [artifact(901, '2026-09-10T09:14:55Z', 'e2e-selection-record'), artifact(902, '2026-09-10T09:29:55Z', 'e2e-selection-record')],
        zips: { 901: zipOf(recordOf('first.test.ts')), 902: zipOf(recordOf('second.test.ts')) },
      });
      const { pulls } = await collectFrom(api);
      const [first, second] = pulls[0].commits[0].checks;
      expect(first.failure.record.value).toEqual(recordOf('first.test.ts'));
      expect(second.failure.record.value).toEqual(recordOf('second.test.ts'));
      // The run's artifact list is asked once for both attempts.
      expect(api.calls.filter((url) => new URL(url).pathname.endsWith('/runs/50/artifacts')).length).toBe(1);
    });

    it.each([
      { situation: 'the artifact has expired', artifacts: [artifact(900, '2026-09-10T09:14:50Z', 'test-selection-record', true)], why: 'expired' },
      { situation: 'no artifact was created during the job', artifacts: [artifact(900, '2026-09-10T11:00:00Z')], why: 'absent' },
      { situation: 'two artifacts were created during the job', artifacts: [artifact(900, '2026-09-10T09:10:00Z'), artifact(901, '2026-09-10T09:14:50Z')], why: 'ambiguous' },
    ])('reads the attempt as not recorded, downloading nothing, where $situation', async ({ artifacts, why }) => {
      const api = stub({
        runs: [attempt(11, 'Test', 'failure', '09:05', '09:15')],
        jobs: { 11: { started_at: '2026-09-10T09:05:00Z', completed_at: '2026-09-10T09:15:00Z', steps: [{ name: 'Run the tests', conclusion: 'failure' }] } },
        artifacts,
      });
      const { pulls, failed } = await collectFrom(api);
      expect(failed).toEqual([]);
      expect(pulls[0].commits[0].checks[0].failure).toEqual({ steps: ['Run the tests'], record: { state: 'not-recorded', why } });
      expect(kinds(api, '/zip')).toBe(0);
    });

    it.each([
      { situation: 'the download errors', zips: { 900: refuse(404) }, steps: ['Run the tests'] },
      { situation: 'the archive is not a zip', zips: { 900: { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('nope').buffer } }, steps: ['Run the tests'] },
    ])('reads the attempt as unreadable and keeps the pull request in the figures where $situation', async ({ zips, steps }) => {
      const api = stub({
        runs: [attempt(11, 'Test', 'failure', '09:05', '09:15')],
        jobs: { 11: { started_at: '2026-09-10T09:05:00Z', completed_at: '2026-09-10T09:15:00Z', steps: [{ name: 'Run the tests', conclusion: 'failure' }] } },
        artifacts: [artifact(900, '2026-09-10T09:14:50Z')],
        zips,
      });
      const { pulls, failed } = await collectFrom(api);
      expect(failed).toEqual([]);
      expect(pulls.map((pull) => pull.number)).toEqual([1]);
      expect(pulls[0].commits[0].checks[0].failure).toEqual({ steps, record: { state: 'not-recorded', why: 'unreadable' }, unreadable: true });
    });

    it('reads the attempt as unreadable, with no steps, where its job cannot be read', async () => {
      const api = stub({ runs: [attempt(11, 'Test', 'failure', '09:05', '09:15')], jobs: {} });
      const { pulls, failed } = await collectFrom(api);
      expect(failed).toEqual([]);
      expect(pulls[0].commits[0].checks[0].failure).toEqual({ steps: [], record: { state: 'not-recorded', why: 'unreadable' }, unreadable: true });
    });

    it('marks a check that keeps no record unreadable too, where its job cannot be read', async () => {
      const api = stub({ runs: [attempt(11, 'Checks', 'failure', '09:05', '09:08')], jobs: {} });
      const { pulls, failed } = await collectFrom(api);
      expect(failed).toEqual([]);
      expect(pulls[0].commits[0].checks[0].failure).toEqual({ steps: [], record: null, unreadable: true });
    });

    it('does not swallow a programming error as an unreadable attempt', async () => {
      const api = stub({ runs: [attempt(11, 'Checks', 'failure', '09:05', '09:08')], jobs: {} });
      const inner = api.fetchImpl;
      // A job whose steps hold a hole: reading it is a bug in this code's assumptions, not a failure of GitHub.
      const fetchImpl = async (url) => (new URL(url).pathname.includes('/actions/jobs/') ? ok({ run_id: 50, steps: [undefined] }) : inner(url));
      await expect(collectFrom({ fetchImpl })).rejects.toBeInstanceOf(TypeError);
    });

    it('still fails the run where reading a failed attempt spends the rate limit', async () => {
      const spent = refuse(403, { 'x-ratelimit-remaining': '0' });
      const api = stub({ runs: [attempt(11, 'Test', 'failure', '09:05', '09:15')], jobs: {} });
      const inner = api.fetchImpl;
      const fetchImpl = async (url) => (new URL(url).pathname.includes('/actions/jobs/') ? spent : inner(url));
      await expect(collectFrom({ fetchImpl })).rejects.toMatchObject({ reason: 'rate-limit' });
    });

    it('reads only the failing step, and no record, for a check that keeps none', async () => {
      const api = stub({
        runs: [attempt(11, 'Checks', 'failure', '09:05', '09:08')],
        jobs: { 11: { started_at: '2026-09-10T09:05:00Z', completed_at: '2026-09-10T09:08:00Z', steps: [{ name: 'Lint', conclusion: 'failure' }, { name: 'Build', conclusion: 'skipped' }] } },
      });
      const { pulls } = await collectFrom(api);
      expect(pulls[0].commits[0].checks[0].failure).toEqual({ steps: ['Lint'], record: null });
      expect([kinds(api, '/runs/50/artifacts'), kinds(api, '/zip')]).toEqual([0, 0]);
    });
  });

  describe('a job waits for a runner, and that is read once per CI run', () => {
    const detailsUrl = (runId, jobId) => `https://github.com/o/r/actions/runs/${runId}/job/${jobId}`;
    const run = (id, name, runId, from, to, extra = {}) => ({
      id,
      name,
      status: 'completed',
      conclusion: 'success',
      started_at: `2026-09-10T${from}:00Z`,
      completed_at: `2026-09-10T${to}:00Z`,
      check_suite: { id: 7 },
      app: { slug: 'github-actions' },
      details_url: detailsUrl(runId, id),
      ...extra,
    });
    const job = (id, name, created, started) => ({ id, name, created_at: `2026-09-10T${created}Z`, started_at: `2026-09-10T${started}Z` });

    /** One pull with `commits` (sha -> check runs), CI runs `ci` (ids), and each run's jobs. */
    function stub({ commits, ci = [60], jobs = {}, listing = undefined }) {
      return stubApi({
        listing: [listed(1, '2026-09-11T00:00:00Z')],
        override: (url) => {
          const { pathname } = new URL(url);
          if (pathname.endsWith('/pulls/1/commits')) return ok(Object.keys(commits).map((sha) => ({ sha, commit: { author: { date: '2026-09-10T09:00:00Z' } }, parents: [{}] })));
          const checks = pathname.match(/\/commits\/(\w+)\/check-runs$/);
          if (checks) return ok({ total_count: commits[checks[1]].length, check_runs: commits[checks[1]] });
          if (pathname.endsWith('/actions/workflows/ci.yml/runs')) return listing ?? ok({ total_count: ci.length, workflow_runs: ci.map((id) => ({ id })) });
          const list = pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
          if (list) return jobs[list[1]] ? ok({ total_count: jobs[list[1]].length, jobs: jobs[list[1]] }) : refuse(404);
          return undefined;
        },
      });
    }
    const asked = (api, part) => api.calls.filter((url) => new URL(url).pathname.endsWith(part)).length;
    const jobLists = (api) => api.calls.filter((url) => /\/runs\/\d+\/jobs\?/.test(url));
    const ONE = { a: [run(11, 'Test', 60, '09:05', '09:15')] };

    it('puts the creation time of a CI job on its check run, read from the run it belongs to', async () => {
      const api = stub({ commits: ONE, jobs: { 60: [job(11, 'Test', '09:04:58', '09:05:00')] } });
      const { pulls } = await collectFrom(api);
      expect(pulls[0].commits[0].checks[0].queue).toEqual({ state: 'read', createdAt: '2026-09-10T09:04:58Z' });
      expect(jobLists(api)[0]).toContain('filter=all');

      const model = buildModel({ pulls, now: NOW, requestedDays: 14, coveredSince: SINCE, repo: 'o/r' });
      expect(model.pulls[0].rounds[0].queued).toEqual([{ name: 'Test', ms: 2000 }]);
    });

    it('reads the job list of a round whose checks come from a CI run and a review run once, for the CI run', async () => {
      const api = stub({
        commits: { a: [run(11, 'Test', 60, '09:05', '09:15'), run(12, 'claude-review', 61, '09:05', '09:20')] },
        jobs: { 60: [job(11, 'Test', '09:04:58', '09:05:00')], 61: [job(12, 'claude-review', '09:04:00', '09:05:00')] },
      });
      const { pulls } = await collectFrom(api);
      expect(jobLists(api).map((url) => new URL(url).pathname)).toEqual(['/repos/o/r/actions/runs/60/jobs']);
      expect(pulls[0].commits[0].checks.map((check) => check.queue?.state)).toEqual(['read', undefined]);
    });

    it('reads the job list of two rounds on the same CI run once, a re-run included', async () => {
      const api = stub({
        commits: { a: [run(11, 'Test', 60, '09:05', '09:15', { conclusion: 'failure' }), run(21, 'Test', 60, '09:20', '09:30')] },
        jobs: { 60: [job(11, 'Test', '09:04:58', '09:05:00'), job(21, 'Test', '09:19:50', '09:20:00')] },
      });
      const { pulls } = await collectFrom(api);
      expect(jobLists(api)).toHaveLength(1);
      expect(pulls[0].commits[0].checks.map((check) => check.queue?.createdAt)).toEqual(['2026-09-10T09:04:58Z', '2026-09-10T09:19:50Z']);
    });

    it('lists the CI runs once, whatever the number of pull requests and commits', async () => {
      const api = stub({ commits: { a: [run(11, 'Test', 60, '09:05', '09:15')], b: [run(12, 'Test', 61, '09:25', '09:35')] }, ci: [60, 61], jobs: { 60: [job(11, 'Test', '09:05:00', '09:05:00')], 61: [job(12, 'Test', '09:25:00', '09:25:00')] } });
      await collectFrom(api);
      expect(asked(api, '/actions/workflows/ci.yml/runs')).toBe(1);
      expect(jobLists(api)).toHaveLength(2);
    });

    it.each([
      { situation: 'the job list answers 404', jobs: {}, ci: [60], why: 'unreadable' },
      { situation: 'the job list lacks the job', jobs: { 60: [job(99, 'Other', '09:00:00', '09:00:01')] }, ci: [60], why: 'absent' },
    ])('leaves queue not recorded on the round, keeping the pull request in the figures, where $situation', async ({ jobs, ci, why }) => {
      const api = stub({ commits: ONE, ci, jobs });
      const { pulls, failed } = await collectFrom(api);
      expect(failed).toEqual([]);
      expect(pulls[0].commits[0].checks[0].queue).toEqual({ state: 'not-recorded', why });

      const model = buildModel({ pulls, now: NOW, requestedDays: 14, coveredSince: SINCE, repo: 'o/r' });
      expect(model.pulls[0].rounds[0]).toMatchObject({ queued: [], queueNotRecorded: true, ms: 10 * 60_000 });
      expect(model.windows[1]).toMatchObject({ pulls: { total: 1 }, queue: null });
    });

    it('leaves queue not recorded, rather than dropping the pull request, where the list of CI runs cannot be read', async () => {
      const api = stub({ commits: ONE, listing: refuse(500) });
      const { pulls, failed } = await collectFrom(api);
      expect(failed).toEqual([]);
      expect(pulls[0].commits[0].checks[0].queue).toEqual({ state: 'not-recorded', why: 'unreadable' });
    });

    it.each([
      { situation: 'listing the CI runs', spendAt: '/actions/workflows/ci.yml/runs' },
      { situation: 'listing the jobs of a run', spendAt: '/actions/runs/60/jobs' },
    ])('still fails the run where $situation spends the rate limit', async ({ spendAt }) => {
      const spent = refuse(403, { 'x-ratelimit-remaining': '0' });
      const api = stub({ commits: ONE, jobs: { 60: [job(11, 'Test', '09:04:58', '09:05:00')] } });
      const inner = api.fetchImpl;
      await expect(collectFrom({ fetchImpl: async (url) => (new URL(url).pathname.endsWith(spendAt) ? spent : inner(url)) })).rejects.toMatchObject({ reason: 'rate-limit' });
    });
  });
});
