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
      const base = stubApi({
        listing: [listed(1, '2026-09-11T00:00:00Z')],
        override: (url) => {
          const { pathname } = new URL(url);
          if (pathname.endsWith('/pulls/1/commits')) return ok([{ sha: 'a', commit: { author: { date: '2026-09-10T09:00:00Z' } }, parents: [{}] }]);
          if (pathname.endsWith('/commits/a/check-runs')) return ok({ total_count: runs.length, check_runs: runs });
          const job = pathname.match(/\/actions\/jobs\/(\d+)$/);
          if (job) return jobs[job[1]] ? ok({ run_id: 50, ...jobs[job[1]] }) : refuse(404);
          if (pathname.endsWith('/actions/runs/50/artifacts')) return ok({ total_count: artifacts.length, artifacts });
          const zip = pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/);
          if (zip) return zips[zip[1]] ?? refuse(500);
          return undefined;
        },
      });
      return base;
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

    it('names the pull request in the coverage, leaving it out, where the download errors', async () => {
      const api = stub({
        runs: [attempt(11, 'Test', 'failure', '09:05', '09:15')],
        jobs: { 11: { started_at: '2026-09-10T09:05:00Z', completed_at: '2026-09-10T09:15:00Z', steps: [] } },
        artifacts: [artifact(900, '2026-09-10T09:14:50Z')],
        zips: { 900: refuse(403) },
      });
      const { pulls, failed } = await collectFrom(api);
      expect(pulls).toEqual([]);
      expect(failed).toEqual([{ number: 1, reason: expect.stringContaining('403') }]);
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
});
