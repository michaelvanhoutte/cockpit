import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import worker from '../../src/worker';
import { emptyTheDatabase, send, spend, theBarePage, usage, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => {
  vi.useRealTimers();
});

async function runTheNightlyJob() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '20 3 * * *' }), env, ctx);
  await waitOnExecutionContext(ctx);
}

interface Start {
  session_id: string;
  request_id: string;
  branch: string;
  model: string;
  input_tokens: number;
}

/** What each session started with, as the page's medians are taken from. */
async function sessionStarts(): Promise<Start[]> {
  const { results } = await env.DB.prepare('SELECT session_id, request_id, branch, model, input_tokens FROM session_starts ORDER BY session_id').all<Start>();
  return results;
}

/** A pull request merged on `mergedAt` that changed `lines` lines, on branch b/<number>. */
async function merged(number: number, mergedAt: string, lines: number, engineer = 'alice') {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO branch_links (branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at)
       VALUES (?1, ?2, 'T', 'MERGED', ?3, NULL, ?4, ?3, 0)`,
    ).bind(`b/${number}`, number, mergedAt, engineer),
    env.DB.prepare(`INSERT INTO pull_request_stats (pr_number, lines_added, lines_removed, pr_updated_at, read_at) VALUES (?1, ?2, ?3, ?4, 0)`).bind(
      number,
      lines - 100,
      100,
      mergedAt,
    ),
  ]);
}

/** Each line of a chart as its points read ("2026-10-05 · $2.00"), keyed by the line; 'empty' where the chart has nothing to draw. */
function chart(html: string, id: string): Record<string, string[]> | 'empty' {
  const section = new RegExp(`<section class="card chart" aria-labelledby="${id}">(.*?)</section>`, 's').exec(html)?.[1];
  if (section === undefined) throw new Error(`no chart ${id}`);
  if (section.includes(`data-empty="${id}"`)) return 'empty';
  return Object.fromEntries(
    [...section.matchAll(/<g data-line="([^"]*)">(.*?)<\/g>/gs)].map(([, key, body]) => [
      key!,
      [...body!.matchAll(/<title>(.*?)<\/title>/g)].map((t) => t[1]!.split(' · ').slice(1).join(' · ').replace('week of ', '')),
    ]),
  );
}

const WEEK = '2026-10-05';

describe('Harness Monitor', () => {
  describe("a session's starting context is its first main-agent request, whatever order its requests arrive in", () => {
    it('a later request arriving before an earlier one leaves the earlier one', async () => {
      await send([usage('late', { time: '2026-10-06T10:05:00Z', inputTokens: 999 })]);
      await send([usage('early', { time: '2026-10-06T10:00:00Z', inputTokens: 5 })]);

      expect((await sessionStarts()).map((s) => [s.request_id, s.input_tokens])).toEqual([['early', 5]]);
    });

    it('a subagent request earlier than the main agent first is ignored', async () => {
      await send([usage('sub', { time: '2026-10-06T09:00:00Z', subagent: true, inputTokens: 1 }), usage('main', { time: '2026-10-06T10:00:00Z', inputTokens: 7 })]);

      expect((await sessionStarts()).map((s) => [s.request_id, s.input_tokens])).toEqual([['main', 7]]);
    });

    it('the first request sent twice changes nothing', async () => {
      const rows = [usage('r1', { time: '2026-10-06T10:00:00Z' }), usage('r2', { time: '2026-10-06T10:01:00Z' })];
      await send(rows);
      const once = await sessionStarts();

      await send(rows);

      expect(await sessionStarts()).toEqual(once);
    });

    it('the nightly rebuild gives the row the requests wrote', async () => {
      await send([
        usage('b', { time: '2026-10-06T10:00:00Z', sessionId: 's1' }),
        usage('a', { time: '2026-10-06T10:00:00Z', sessionId: 's1' }),
        usage('c', { time: '2026-10-07T10:00:00Z', sessionId: 's2', model: 'claude-opus-4-8', branch: null }),
      ]);
      const written = await sessionStarts();
      await env.DB.prepare("UPDATE session_starts SET input_tokens = 99999, request_id = 'x'").run();
      await env.DB.prepare("INSERT INTO session_starts VALUES ('ghost', 'g', 1, '2020-01-01', '', 'm', 1, 1, 1)").run();

      await runTheNightlyJob();

      expect(await sessionStarts()).toEqual(written);
      expect(written.map((s) => [s.session_id, s.request_id, s.branch])).toEqual([
        ['s1', 'a', 'claude/build-1'],
        ['s2', 'c', ''],
      ]);
    });

    it('the migration over rows already stored builds the starts a rebuild would', async () => {
      await send([
        usage('b', { time: '2026-10-06T10:00:00Z', sessionId: 's1' }),
        usage('a', { time: '2026-10-06T10:00:00Z', sessionId: 's1' }),
        usage('sub', { time: '2026-10-06T09:00:00Z', sessionId: 's1', subagent: true }),
        usage('c', { time: '2026-10-07T10:00:00Z', sessionId: 's2', branch: null }),
      ]);
      const written = await sessionStarts();
      await env.DB.prepare('DROP TABLE session_starts').run();
      const migration = inject('migrations').find((m) => m.name.startsWith('0012_session_starts'))!;

      for (const query of migration.queries) await env.DB.prepare(query).run();

      expect(await sessionStarts()).toEqual(written);
      expect(written.map((s) => [s.session_id, s.request_id])).toEqual([['s1', 'a'], ['s2', 'c']]);
    });
  });

  describe('the Over time page charts starting context, pull request size and cost per 1,000 lines', () => {
    it('shows all three charts, with their values for the bucket', async () => {
      await send([usage('r1', { time: '2026-10-06T10:00:00Z', branch: 'b/1' }), spend('p1', 2, { time: '2026-10-06T11:00:00Z', branch: 'b/1' })]);
      await merged(1, '2026-10-07T10:00:00Z', 1_000);

      const html = await theBarePage('?period=all');

      expect(html).toContain('<h2 id="trends">Is the harness getting more expensive?</h2>');
      expect(chart(html, 'starting-context')).toEqual({ 'starting-context': [`${WEEK} · 80 tokens`] });
      expect(chart(html, 'pull-request-size')).toEqual({ 'pull-request-size': [`${WEEK} · 1,000 lines`] });
      expect(chart(html, 'cost-per-line')).toMatchObject({ total: [`${WEEK} · $2.00`], building: [`${WEEK} · $2.00`] });
    });

    it('other groupings do not carry the charts', async () => {
      expect(await theBarePage('?period=all&group=pr')).not.toContain('Is the harness getting more expensive?');
    });

    it('a period of 30 days has a point per day, and 90 days one per week', async () => {
      // Wednesday 2026-10-14, so the pull request is on Tuesday 2026-10-13 and its week starts on Monday 2026-10-12.
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-14T12:00:00Z') });
      const day = '2026-10-13';
      const monday = '2026-10-12';
      await send([spend('p1', 1, { time: `${day}T10:00:00Z`, branch: 'b/1' })]);
      await merged(1, `${day}T12:00:00Z`, 500);

      const thirty = chart(await theBarePage('?period=30d'), 'pull-request-size');
      const ninety = chart(await theBarePage('?period=90d'), 'pull-request-size');

      expect(thirty).toEqual({ 'pull-request-size': [`${day} · 500 lines`] });
      expect(ninety).toEqual({ 'pull-request-size': [`${monday} · 500 lines`] });
    });

    it('with nothing merged in the period the charts say so rather than drawing zero', async () => {
      const html = await theBarePage('?period=all');

      expect(['starting-context', 'pull-request-size', 'cost-per-line'].map((id) => chart(html, id))).toEqual(['empty', 'empty', 'empty']);
    });
  });

  describe('the trend charts follow the filters', () => {
    beforeEach(async () => {
      await send([
        spend('a1', 2, { time: '2026-10-06T10:00:00Z', branch: 'b/1', sessionId: 'sa', inputTokens: 1_000_000 }),
        spend('a2', 1, { time: '2026-10-06T10:30:00Z', branch: 'b/1', sessionId: 'sa', category: 'after-push', subagent: true, ranWhere: 'actions' }),
        spend('b1', 4, { time: '2026-10-06T10:00:00Z', branch: 'b/2', sessionId: 'sb', model: 'claude-opus-4-8', inputTokens: 800_000 }),
      ]);
      await merged(1, '2026-10-07T10:00:00Z', 1_000, 'alice');
      await merged(2, '2026-10-07T10:00:00Z', 3_000, 'bob');
    });

    it('Engineer narrows all three charts to that engineer', async () => {
      const html = await theBarePage('?period=all&engineer=bob');

      expect(chart(html, 'starting-context')).toEqual({ 'starting-context': [`${WEEK} · 800,000 tokens`] });
      expect(chart(html, 'pull-request-size')).toEqual({ 'pull-request-size': [`${WEEK} · 3,000 lines`] });
      expect(chart(html, 'cost-per-line')).toMatchObject({ total: [`${WEEK} · $1.33`] });
    });

    it('Model narrows starting context to sessions whose first request used it, and cost to that model', async () => {
      const html = await theBarePage('?period=all&model=claude-opus-4-8');

      expect(chart(html, 'starting-context')).toEqual({ 'starting-context': [`${WEEK} · 800,000 tokens`] });
      expect(chart(html, 'pull-request-size')).toEqual({ 'pull-request-size': [`${WEEK} · 3,000 lines`] });
      expect(chart(html, 'cost-per-line')).toMatchObject({ total: [`${WEEK} · $1.33`] });
    });

    it('Category narrows cost per line to that phase and leaves starting context alone', async () => {
      const html = await theBarePage('?period=all&category=after-push');

      expect(chart(html, 'starting-context')).toEqual({ 'starting-context': [`${WEEK} · 900,000 tokens`] });
      expect(chart(html, 'pull-request-size')).toEqual({ 'pull-request-size': [`${WEEK} · 1,000 lines`] });
      expect(chart(html, 'cost-per-line')).toMatchObject({ total: [`${WEEK} · $1.00`] });
    });

    it('Requests: Subagents narrows cost per line to subagent cost and leaves starting context alone', async () => {
      const html = await theBarePage('?period=all&who=subagents');

      expect(chart(html, 'starting-context')).toEqual({ 'starting-context': [`${WEEK} · 900,000 tokens`] });
      expect(chart(html, 'cost-per-line')).toMatchObject({ total: [`${WEEK} · $1.00`] });
    });
  });
});
