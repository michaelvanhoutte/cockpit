import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli.js';

const MONITOR = 'https://monitor.test';

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

/** A pull as the listing shows it, merged `merged` (ISO). */
const listed = (number, merged) => ({ number, merged_at: merged, updated_at: merged, base: { ref: 'main' }, head: { ref: `work-${number}` } });

/**
 * GitHub, holding `listing`'s merged pulls, each with one commit that one check ran on, and the
 * Harness Monitor, storing whatever it is sent. Every request the tool makes is kept, in order.
 * With `allowanceSpent`, the check belongs to a CI run, and the allowance runs out at the listing
 * of CI runs, the last read, so no job list is read.
 */
function stubNetwork(listing, { allowanceSpent = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { origin, pathname, searchParams } = new URL(url);
    if (origin === MONITOR) {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ to: 'monitor', method: init.method ?? 'GET', path: pathname, numbers: (body?.timelines ?? body?.pulls ?? []).map((row) => row.number) });
      return ok(init.method === 'POST' ? { stored: 1 } : { newestMerge: null });
    }
    calls.push({ to: 'github', path: pathname });
    if (pathname.endsWith('/pulls')) {
      const page = Number(searchParams.get('page') ?? 1);
      return ok(listing.slice((page - 1) * 100, page * 100));
    }
    const commits = pathname.match(/\/pulls\/(\d+)\/commits$/);
    if (commits) return ok([{ sha: `${commits[1]}a`, commit: { author: { date: '2026-09-10T09:00:00Z' } }, parents: [{}] }]);
    const detail = pathname.match(/\/pulls\/(\d+)$/);
    if (detail) {
      const pull = listing.find((entry) => entry.number === Number(detail[1]));
      return ok({ number: pull.number, title: `Pull ${pull.number}`, html_url: 'u', created_at: '2026-09-10T08:00:00Z', merged_at: pull.merged_at, body: '', base: pull.base, head: pull.head, additions: 1, deletions: 1, changed_files: 1, commits: 1 });
    }
    if (pathname.includes('/check-runs')) {
      const run = allowanceSpent ? { details_url: 'https://github.com/o/r/actions/runs/55/job/1' } : {};
      return ok({ total_count: 1, check_runs: [{ id: 1, name: 'Test', status: 'completed', conclusion: 'success', started_at: '2026-09-10T09:05:00Z', completed_at: '2026-09-10T09:15:00Z', check_suite: { id: 7 }, ...run }] });
    }
    if (allowanceSpent && pathname.endsWith('/actions/workflows/ci.yml/runs')) {
      return { ok: false, status: 403, headers: { get: (name) => (name === 'x-ratelimit-remaining' ? '0' : null) }, json: async () => ({}) };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  return { fetchImpl, monitorCalls: () => calls.filter((call) => call.to === 'monitor') };
}

const fourPulls = [listed(1, '2026-09-20T00:00:00Z'), listed(2, '2026-09-18T00:00:00Z'), listed(3, '2026-09-12T00:00:00Z'), listed(4, '2026-09-10T00:00:00Z')];

let stderr;
beforeEach(() => {
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
  vi.stubEnv('HARNESS_MONITOR_URL', MONITOR);
  vi.stubEnv('HARNESS_WRITE_KEY', 'test-write-key');
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  stderr.mockRestore();
});

const backfill = async (listing, extra = [], options = {}) => {
  const network = stubNetwork(listing, options);
  vi.stubGlobal('fetch', network.fetchImpl);
  const code = await main(['--repo', 'o/r', '--send', '--from', '2026-09-08', '--to', '2026-09-21', '--timelines-only', ...extra]);
  return { code, monitorCalls: network.monitorCalls(), said: stderr.mock.calls.map(([text]) => text).join('') };
};

describe('Cycle time', () => {
  describe('the backfill can send timelines alone, which writes nothing else to the Monitor', () => {
    it('a window sent as timelines only reaches the timeline address alone, with every pull request merged in it, oldest first', async () => {
      const { code, monitorCalls } = await backfill(fourPulls);

      expect(code).toBe(0);
      expect(monitorCalls).toEqual([{ to: 'monitor', method: 'POST', path: '/v1/cycle-time/timelines', numbers: [4, 3, 2, 1] }]);
    });

    it('stopped inside the window by the pull budget, it fails, naming the --from and --to that send the rest as timelines only', async () => {
      const { code, monitorCalls, said } = await backfill(fourPulls, ['--max-pulls', '2']);

      expect(code).toBe(1);
      expect(monitorCalls.map((call) => call.numbers)).toEqual([[2, 1]]);
      expect(said).toContain('Send them with --from 2026-09-08 --to 2026-09-18 --timelines-only.');
    });

    it('the allowance running out before the job lists were read fails it, after sending, saying to run the same window again', async () => {
      const { code, monitorCalls, said } = await backfill(fourPulls, [], { allowanceSpent: true });

      expect(code).toBe(1);
      expect(monitorCalls.map((call) => call.numbers)).toEqual([[4, 3, 2, 1]]);
      expect(said).toContain("GitHub's rate limit ran out before the job lists of 4 pull requests were read");
      expect(said).toContain('Run the same window again once it resets');
    });
  });
});
