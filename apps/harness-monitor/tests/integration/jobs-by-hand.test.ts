import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REQUESTS } from '../../src/github';
import { fakeGitHub, jobLine, pageOf, pullRequest, recordedPullRequest, theLinks, theLinkState } from './github-support';
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

    it('linking stopped by its budget says there is more to read, and the next run continues from the cursor and catches up', async () => {
      let next = 0;
      fakeGitHub(() => {
        next += 1;
        return pageOf([pullRequest({ number: next, headRefName: `b/${next}`, updatedAt: `2026-10-01T10:00:${String(next).padStart(2, '0')}Z` })], true);
      });

      const first = await (await start('linking')).json();

      expect(first).toEqual({ job: 'linking', ok: true, message: `Linked ${MAX_REQUESTS} pull requests; more to read — run it again.` });
      expect(await jobLine('linking')).toContain('more to read — run it again.');
      const cursor = (await theLinkState())[0]!.cursor;
      expect(cursor).toBe(`2026-10-01T10:00:${String(MAX_REQUESTS).padStart(2, '0')}Z`);

      vi.restoreAllMocks();
      const calls = fakeGitHub(() => pageOf([pullRequest({ number: 500, headRefName: 'b/500', updatedAt: '2026-10-02T10:00:00Z' })]));
      const second = await (await start('linking')).json();

      expect(calls[0]!.q).toContain(`updated:>=${cursor}`);
      expect(second).toEqual({ job: 'linking', ok: true, message: 'Linked 1 pull request; caught up with GitHub.' });
    });

    it.each([
      { situation: '504', answer: () => new Response('timeout', { status: 504 }), said: 'GitHub did not answer in time (504). More to read' },
      { situation: '502', answer: () => new Response('bad gateway', { status: 502 }), said: 'GitHub failed to answer (502); usually the query took too long. More to read' },
      {
        situation: 'our own limit on waiting',
        answer: (): Response => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        },
        said: 'GitHub did not answer in time. More to read',
      },
    ])('linking that GitHub times out on ($situation) after a page was read keeps that page, moves the cursor, and says to run it again', async ({ answer, said }) => {
      fakeGitHub((call) =>
        call.after === null ? pageOf([pullRequest({ number: 1, headRefName: 'b/1', updatedAt: '2026-10-01T10:00:00Z' })], true) : answer(),
      );

      const body = await (await start('linking')).json();

      expect(body).toEqual({ job: 'linking', ok: true, message: `Linked 1 pull request; ${said} — run it again.` });
      expect((await theLinks()).map((l) => l.pr_number)).toEqual([1]);
      const state = (await theLinkState())[0]!;
      expect(state.cursor).toBe('2026-10-01T10:00:00Z');
      expect(state.last_success_at).toBeNull();
    });

    it('prices fetches the list and prices the waiting rows, answering with both counts', async () => {
      await send([usage('waiting', { model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })]);
      theFileAnswers(recordedFile);

      const body = (await (await start('prices')).json()) as { ok: boolean; message: string };

      expect(body.ok).toBe(true);
      expect(body.message).toMatch(/^Fetched \d+ model prices; priced 1 waiting request; run rebuild next so the page's dollars include them\.$/);
      expect((await pricing())[0]!.cost_micros).toBe(2_000_000);
    });

    it('prices answers with how many requests it priced', async () => {
      await send([usage('a', { model: 'claude-sonnet-5' }), usage('b', { model: 'claude-sonnet-5' })]);
      theFileAnswers(recordedFile);

      expect(await (await start('prices')).json()).toMatchObject({ job: 'prices', ok: true, priced: 2 });

      theFileAnswers(recordedFile);
      expect(await (await start('prices')).json()).toMatchObject({ ok: true, priced: 0 });
    });

    it('prices that still has rows waiting after its cap counts the cap, and the next run prices the rest', async () => {
      const cap = 20 * 1000;
      await env.DB
        .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
          INSERT INTO usage_requests (request_id, session_id, occurred_at, day, category, model, speed, input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens, subagent, ran_where, source, ingest_id, received_at)
          SELECT 'r' || printf('%06d', i), 's', 0, '2026-01-01', 'other', 'claude-sonnet-5', 'standard', 1, 0, 0, 0, 0, 'local', 'hook', 'i', 0 FROM n`)
        .bind(cap + 5)
        .run();
      theFileAnswers(recordedFile);
      const first = (await (await start('prices')).json()) as { priced: number };
      theFileAnswers(recordedFile);
      const second = (await (await start('prices')).json()) as { priced: number };

      expect([first.priced, second.priced]).toEqual([cap, 5]);
    });

    it('prices counts the rows it priced from the last good list when the fetch fails', async () => {
      await send([usage('a', { model: 'claude-sonnet-5' })]);
      theFileAnswers(recordedFile);
      await start('prices');
      await send([usage('b', { model: 'claude-sonnet-5' })]);
      await env.DB.prepare("UPDATE usage_requests SET cost_micros = NULL WHERE request_id = 'b'").run();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', async () => new Response('down', { status: 500 }));

      expect(await (await start('prices')).json()).toMatchObject({ ok: false, priced: 1 });
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
      { situation: 'errors', status: 500, message: 'GitHub answered 500.' },
      { situation: 'times out', status: 502, message: 'GitHub failed to answer (502); usually the query took too long.' },
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

      expect(await jobLine('linking')).toBe('Branch linking: last run 2026-04-01 12:00 UTC (by hand) — GitHub refused the token (401). Never succeeded.');
    });

    it('a failed run also says when the job last succeeded', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-04-01T12:00:00Z') });
      try {
        fakeGitHub(() => pageOf([recordedPullRequest(979)]));
        await start('linking');
        vi.restoreAllMocks();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        fakeGitHub(() => new Response('no', { status: 401 }));
        vi.setSystemTime(new Date('2026-04-01T13:00:00Z'));
        await start('linking');
      } finally {
        vi.useRealTimers();
      }

      expect(await jobLine('linking')).toBe(
        'Branch linking: last run 2026-04-01 13:00 UTC (by hand) — GitHub refused the token (401). Last succeeded 2026-04-01 12:00 UTC.',
      );
    });

    it('a run that finished late never replaces a newer one on the page', async () => {
      try {
        vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-04-01T12:00:00Z') });
        await start('rebuild');
        vi.setSystemTime(new Date('2026-04-01T11:00:00Z'));
        await start('rebuild');
      } finally {
        vi.useRealTimers();
      }

      expect(await jobLine('rebuild')).toMatch(/^Daily totals: last run 2026-04-01 12:00 UTC/);
    });

    it('a success recorded late is kept beside a newer failure', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const record = async (at: string, answer: () => Response) => {
        vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) });
        fakeGitHub(answer);
        await start('linking');
        vi.restoreAllMocks();
        vi.spyOn(console, 'error').mockImplementation(() => {});
      };
      try {
        await record('2026-04-01T13:00:00Z', () => new Response('no', { status: 401 }));
        await record('2026-04-01T12:00:00Z', () => pageOf([recordedPullRequest(979)]));
      } finally {
        vi.useRealTimers();
      }

      // The link cursor's own success time would answer too; only the run record may.
      await env.DB.prepare('DELETE FROM link_state').run();

      expect(await jobLine('linking')).toBe(
        'Branch linking: last run 2026-04-01 13:00 UTC (by hand) — GitHub refused the token (401). Last succeeded 2026-04-01 12:00 UTC.',
      );
    });

    it('a deployment from before runs were recorded shows what the jobs stored, not "has not run yet"', async () => {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO link_state (id, cursor, last_success_at) VALUES (1, NULL, ?)').bind(Date.parse('2026-03-01T08:00:00Z')),
        env.DB.prepare('INSERT INTO price_list (id, models, fetched_at, last_attempt_at) VALUES (1, ?, ?, ?)').bind('{}', Date.parse('2026-03-02T03:10:00Z'), Date.parse('2026-03-02T03:10:00Z')),
      ]);

      expect(await jobLine('linking')).toBe('Branch linking: last succeeded 2026-03-01 08:00 UTC.');
      expect(await jobLine('prices')).toBe('Price list: last succeeded 2026-03-02 03:10 UTC.');
      expect(await jobLine('rebuild')).toBe('Daily totals: has not run yet.');
    });

    it('a failed first run on such a deployment names the earlier success', async () => {
      await env.DB.prepare('INSERT INTO link_state (id, cursor, last_success_at) VALUES (1, NULL, ?)').bind(Date.parse('2026-03-01T08:00:00Z')).run();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeGitHub(() => new Response('no', { status: 401 }));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-04-01T12:00:00Z') });
      try {
        await start('linking');
      } finally {
        vi.useRealTimers();
      }

      expect(await jobLine('linking')).toContain('Last succeeded 2026-03-01 08:00 UTC.');
    });

    it('a schedule no job answers to runs nothing and says so', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { default: worker } = await import('../../src/worker');
      const ctx = createExecutionContext();

      await worker.scheduled(createScheduledController({ cron: '5 5 * * *' }), env, ctx);
      await waitOnExecutionContext(ctx);

      expect(error).toHaveBeenCalledWith(expect.stringContaining('5 5 * * *'));
      expect(await jobLine('linking')).toBe('Branch linking: has not run yet.');
    });

    it('a run that cannot be recorded still does its work and answers', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await send([usage('a')]);
      await env.DB.prepare('DELETE FROM daily_totals').run();
      const failing = new Proxy(env.DB, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === 'prepare') {
            return (sql: string) => {
              if (sql.includes('job_runs')) throw new Error('cannot record');
              return target.prepare(sql);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const { default: worker } = await import('../../src/worker');
      const ctx = createExecutionContext();

      await worker.scheduled(createScheduledController({ cron: '20 3 * * *' }), { ...env, DB: failing }, ctx);
      await waitOnExecutionContext(ctx);

      expect((await dollars()).unpriced).toBe(1);
    });

    it('a job that has never run says so', async () => {
      expect(await jobLine('linking')).toBe('Branch linking: has not run yet.');
      expect(await jobLine('prices')).toBe("Price list: has not run yet; only the repository's own prices apply.");
      expect(await jobLine('rebuild')).toBe('Daily totals: has not run yet.');
    });
  });
});
