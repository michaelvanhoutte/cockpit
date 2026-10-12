import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGitHub, jobLine, pageOf, recordedPullRequest, theLinks, theLinkState } from './github-support';
import { dollars, emptyTheDatabase, pricing, recordedFile, runTheDailyJob, send, theFileAnswers, usage, WRITE_KEY } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  env.GITHUB_TOKEN = 'test-token';
  env.GITHUB_REPOSITORY = 'owner/repo';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_REPOSITORY;
});

const start = (job: string, headers: Record<string, string> = { authorization: `Bearer ${WRITE_KEY}` }) =>
  SELF.fetch(`https://monitor.test/v1/jobs/${job}`, { method: 'POST', headers });

describe('Harness Monitor', () => {
  describe('a job started by hand does what its schedule does, and says so', () => {
    it('linking links as the hourly run would and answers with the count', async () => {
      fakeGitHub(() => pageOf([recordedPullRequest(979), recordedPullRequest(969)]));

      const response = await start('linking');

      expect(await response.json()).toEqual({ job: 'linking', ok: true, message: 'Linked 2 pull requests; caught up with GitHub.' });
      expect((await theLinks()).map((l) => l.pr_number)).toEqual(expect.arrayContaining([979, 969]));
      expect((await theLinkState())[0]!.last_success_at).not.toBeNull();
    });

    it('prices fetches the list and prices the waiting rows, answering with both counts', async () => {
      await send([usage('waiting', { model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })]);
      theFileAnswers(recordedFile);

      const body = (await (await start('prices')).json()) as { ok: boolean; message: string };

      expect(body.ok).toBe(true);
      expect(body.message).toMatch(/^Fetched \d+ model prices; priced 1 waiting request\.$/);
      expect((await pricing())[0]!.cost_micros).toBe(2_000_000);
    });

    it('rebuild rebuilds the daily totals and answers with the days', async () => {
      await send([usage('a', { time: '2026-03-01T10:00:00Z' }), usage('b', { time: '2026-03-02T10:00:00Z' })]);
      await env.DB.prepare('DELETE FROM daily_totals').run();

      const response = await start('rebuild');

      expect(await response.json()).toEqual({ job: 'rebuild', ok: true, message: 'Rebuilt the totals for 2 days.' });
      expect((await dollars()).unpriced).toBe(2);
    });

    it.each([
      { situation: 'refuses the token', status: 401, message: 'GitHub refused the token (401).' },
      { situation: 'errors', status: 502, message: 'GitHub answered 502.' },
    ])('linking with GitHub that $situation answers with that error and changes nothing', async ({ status, message }) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeGitHub(() => new Response('refused', { status }));

      const response = await start('linking');

      expect(await response.json()).toEqual({ job: 'linking', ok: false, message });
      expect(await theLinks()).toEqual([]);
      expect(await theLinkState()).toEqual([]);
    });

    it('an unknown job is refused, naming the three', async () => {
      const response = await start('everything');

      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: string }).error).toContain('linking, prices, rebuild');
    });
  });

  describe('only the write key starts a job', () => {
    it.each([
      { situation: 'no key', headers: {} },
      { situation: 'a wrong key', headers: { authorization: 'Bearer not-the-key' } },
    ])('$situation is refused and nothing runs', async ({ headers }) => {
      const calls = fakeGitHub(() => pageOf([recordedPullRequest(979)]));

      const response = await start('linking', headers);

      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
      expect(await theLinkState()).toEqual([]);
      expect(await jobLine('linking')).toBe('Branch linking: has not run yet.');
    });

    it('with no key configured on the Worker, a job is refused even with a key', async () => {
      const configured = env.HARNESS_WRITE_KEY;
      delete env.HARNESS_WRITE_KEY;
      try {
        const calls = fakeGitHub(() => pageOf([]));
        const response = await start('linking');

        expect(response.status).toBe(503);
        expect(calls).toHaveLength(0);
      } finally {
        if (configured !== undefined) env.HARNESS_WRITE_KEY = configured;
      }
    });
  });

  describe('the page says what each job last did', () => {
    it('a successful scheduled run shows its time, "scheduled" and what it did', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-04-01T12:00:00Z') });
      try {
        theFileAnswers(recordedFile);
        await runTheDailyJob();
      } finally {
        vi.useRealTimers();
      }

      expect(await jobLine('rebuild')).toBe('Daily totals: last run 2026-04-01 12:00 UTC (scheduled) — Rebuilt the totals for 0 days.');
      expect(await jobLine('prices')).toMatch(/^Price list: last run 2026-04-01 12:00 UTC \(scheduled\) — Fetched \d+ model prices; priced 0 waiting requests\.$/);
    });

    it('a failed run by hand shows its time, "by hand" and the error', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeGitHub(() => new Response('no', { status: 401 }));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-04-01T12:00:00Z') });
      try {
        await start('linking');
      } finally {
        vi.useRealTimers();
      }

      expect(await jobLine('linking')).toBe('Branch linking: last run 2026-04-01 12:00 UTC (by hand) — GitHub refused the token (401).');
    });

    it('a job that has never run says so', async () => {
      expect(await jobLine('linking')).toBe('Branch linking: has not run yet.');
      expect(await jobLine('prices')).toBe("Price list: has not run yet; only the repository's own prices apply.");
      expect(await jobLine('rebuild')).toBe('Daily totals: has not run yet.');
    });
  });
});
