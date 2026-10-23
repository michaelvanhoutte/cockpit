import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobLine, linked, pullRequest, startJob } from './github-support';
import { costRows, emptyTheDatabase, merged, send, spend, splitTotals, theBarePage, theExport, thePullRequest, totals, whereItWent, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The page is read at this moment: 15:05 in Brussels on 22 Oct. */
const NOW = '2026-10-22T13:05:00Z';
const at = (iso: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });

/** A request 90 minutes before Brussels midnight turned 21 Oct into 22 Oct: 00:30 on 22 Oct there. */
const AFTER_MIDNIGHT = '2026-10-21T22:30:00Z';

const updatedLine = (html: string) => /<span class="status">(.*?) · public/.exec(html)![1]!;
/** The cost-per-day chart alone: the trend charts below it draw lines of their own. */
const perDay = (html: string) => /<section class="panel" aria-labelledby="perday">.*?<\/section>/s.exec(html)![0];
const titles = (html: string) => [...html.matchAll(/<title>(.*?)<\/title>/g)].map((m) => m[1]!);
/** A trend chart's points ("22 Oct 2026 · 80 tokens"), whichever line draws them. */
function points(html: string, id: string): string[] {
  const section = new RegExp(`<section class="trend" aria-labelledby="${id}">(.*?)</section>`, 's').exec(html)![1]!;
  return titles(section).map((t) => t.split(' · ').slice(1).join(' · ').replace('week of ', ''));
}

describe('Harness Monitor', () => {
  describe('every time it shows is Belgian time in Belgian format', () => {
    it('the costs page says when it was rendered', async () => {
      at(NOW);

      expect(updatedLine(await theBarePage('?period=all'))).toBe('Updated 22 Oct 2026, 15:05');
    });

    it('a job line says when the job last ran', async () => {
      // withPrices ran the daily job at the real time, which a run at an earlier time would not replace.
      await env.DB.prepare('DELETE FROM job_runs').run();
      at(NOW);
      await startJob('rebuild');

      expect(await jobLine('rebuild')).toBe('Daily totals: last run 22 Oct 2026, 15:05 (by hand) — Rebuilt the totals for 0 days.');
    });

    it('a pull request page says when the pull request merged and when the page was rendered', async () => {
      at(NOW);
      await send([spend('a', 1, { branch: 'b/1' })]);
      await linked(pullRequest({ number: 7, headRefName: 'b/1', state: 'MERGED', mergedAt: AFTER_MIDNIGHT, updatedAt: AFTER_MIDNIGHT }));

      const html = await (await thePullRequest(7, '?period=all')).text();

      expect(html).toContain('merged 22 Oct 2026');
      expect(updatedLine(html)).toBe('Updated 22 Oct 2026, 15:05');
    });

    it('the costs table says when a pull request merged', async () => {
      await send([spend('a', 1, { branch: 'b/1' })]);
      await linked(pullRequest({ number: 7, headRefName: 'b/1', state: 'MERGED', mergedAt: AFTER_MIDNIGHT, updatedAt: AFTER_MIDNIGHT }));

      const rows = costRows(await theBarePage('?period=all&group=pr'));

      expect(rows[0]!.details[1]).toBe('22 Oct 2026');
    });

    it('the export keeps every time as ISO UTC, since a machine reads it', async () => {
      await send([spend('a', 1, { time: AFTER_MIDNIGHT })]);

      expect((await theExport('?period=all')).rows.map((r) => r[0])).toEqual(['2026-10-21T22:30:00.000Z']);
    });
  });

  describe('every day it counts in is a Belgian day', () => {
    it('a request after Brussels midnight costs on the new day, in the Over time rows and in the cost-per-day chart', async () => {
      at(NOW);
      await send([spend('a', 2, { time: AFTER_MIDNIGHT })]);

      const html = await theBarePage('?period=all');

      expect(costRows(html).map((r) => [r.label, r.total])).toEqual([['22 Oct 2026', '$2.00']]);
      expect(titles(perDay(html)).filter((t) => t.startsWith('Total'))).toEqual(['Total · 22 Oct 2026 · $2.00']);
    });

    it('a session starting after Brussels midnight is in that day\'s starting-context bucket, and a pull request merged then in that day\'s bucket', async () => {
      at(NOW);
      await send([spend('s', 2, { time: AFTER_MIDNIGHT, branch: 'b/1', inputTokens: 700_000 })]);
      await merged(1, AFTER_MIDNIGHT, 1_000);

      const html = await theBarePage('?period=30d');

      expect(points(html, 'starting-context')).toEqual(['22 Oct 2026 · 700,000 tokens']);
      expect(points(html, 'pull-request-size')).toEqual(['22 Oct 2026 · 1,000 lines']);
    });

    it('a request at 00:30 on Monday in Brussels, still Sunday in UTC, is in that Monday\'s week on a weekly chart', async () => {
      at('2026-10-28T12:00:00Z');
      await send([spend('s', 2, { time: '2026-10-25T23:30:00Z', branch: 'b/1', inputTokens: 700_000 })]);
      await merged(1, '2026-10-25T23:30:00Z', 1_000);

      const html = await theBarePage('?period=90d');

      expect(points(html, 'starting-context')).toEqual(['26 Oct 2026 · 700,000 tokens']);
      expect(points(html, 'pull-request-size')).toEqual(['26 Oct 2026 · 1,000 lines']);
    });

    describe('Last 7 days, read at 14:00 in Brussels on 22 Oct, starts on the 16th', () => {
      beforeEach(async () => {
        at('2026-10-22T12:00:00Z');
        await send([
          spend('inside', 1, { time: '2026-10-15T22:30:00Z', branch: 'b/1', sessionId: 's-in' }),
          spend('outside', 4, { time: '2026-10-15T21:30:00Z', branch: 'b/1', sessionId: 's-out' }),
        ]);
        await linked(pullRequest({ number: 7, headRefName: 'b/1' }));
      });

      it('the costs page counts the request at 00:30 on the 16th and not the one at 23:30 on the 15th', async () => {
        const html = await theBarePage('?period=7d');

        expect(costRows(html).map((r) => [r.label, r.total])).toEqual([['16 Oct 2026', '$1.00']]);
        expect(whereItWent(html).heading).toBe("Where the period's $1.00 went, by phase");
      });

      it('the pull request page counts the same request', async () => {
        const html = await (await thePullRequest(7, '?period=7d')).text();

        expect(html).toContain('id="pr-total">$1.00');
      });

      it('the export has the same request', async () => {
        const { rows } = await theExport('?period=7d');

        expect(rows.map((r) => r[0])).toEqual(['2026-10-15T22:30:00.000Z']);
      });
    });

    it('a year of requests is exported whole past the first page, from the Belgian midnight that starts the period, whatever day their rows store', async () => {
      at('2026-01-10T12:00:00Z');
      // 45,000 requests, three to a minute from 2026-01-01T00:00Z. Every row stores a stale day, as rows from before the change may: the period is cut on the exact time.
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 44999)
         INSERT INTO usage_requests (request_id, session_id, occurred_at, day, branch, category, model, speed,
           input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, subagent, ran_where, source, ingest_id, received_at, cost_micros, price_basis)
         SELECT printf('r%06d', i), printf('s%06d', i), 1767225600000 + (i / 3) * 60000, '2000-01-01',
           'b/year', 'building', 'claude-sonnet-5', 'standard', 1, 1, 1, 1, 0, 'local', 'hook', 'seed', 0, 1000000, 'arrival'
         FROM n`,
      ).run();

      const { rows } = await theExport('?period=7d');

      // 7 days ending 10 Jan start at 00:00 on 4 Jan in Brussels, which is 3 Jan 23:00 UTC: minute 4,260, so request 12,780 onwards.
      expect(rows).toHaveLength(45_000 - 12_780);
      expect(rows[0]![0]).toBe('2026-01-03T23:00:00.000Z');
      expect(new Set(rows.map((r) => r[1])).size).toBe(45_000 - 12_780);
    });
  });

  describe('a request arriving after the change is filed under its Belgian day at once', () => {
    it('with no rebuild since, its cost, its session and the totals are on the new day', async () => {
      await send([spend('a', 2, { time: AFTER_MIDNIGHT, sessionId: 's1' })]);

      expect((await totals()).map((t) => t.day)).toEqual(['2026-10-22']);
      expect((await splitTotals()).map((t) => [t.day, t.cost_micros])).toEqual([['2026-10-22', 2_000_000]]);
      const starts = await env.DB.prepare('SELECT day FROM session_starts').all<{ day: string }>();
      expect(starts.results.map((r) => r.day)).toEqual(['2026-10-22']);
    });
  });

  describe('one rebuild files every existing total under its Belgian day', () => {
    const REQUESTS = [
      // Belgian day 22 Oct, UTC day 21 Oct.
      spend('summer', 2, { time: AFTER_MIDNIGHT, branch: 'b/a', category: 'building', sessionId: 's-summer' }),
      // The same UTC day and the Belgian one too.
      spend('noon', 1, { time: '2026-10-21T10:00:00Z', branch: 'b/b', category: 'after-push', sessionId: 's-noon' }),
      // Winter: Belgian 11 Jan, UTC 10 Jan.
      spend('winter', 4, { time: '2026-01-10T23:30:00Z', branch: 'b/c', category: 'ci-reviews', sessionId: 's-winter' }),
    ];
    const OLD_DAYS = [
      ['2026-10-22', '2026-10-21'],
      ['2026-01-11', '2026-01-10'],
    ] as const;

    /** The Monitor as it stood before the change: every total and every stored day under the UTC day. */
    async function asBeforeTheChange() {
      await send(REQUESTS);
      for (const table of ['daily_totals', 'daily_split_totals', 'session_starts', 'usage_requests']) {
        for (const [belgian, utc] of OLD_DAYS) await env.DB.prepare(`UPDATE ${table} SET day = ? WHERE day = ?`).bind(utc, belgian).run();
      }
    }
    const requestRows = async () => (await env.DB.prepare('SELECT * FROM usage_requests ORDER BY request_id').all()).results;
    const sessionDays = async () => (await env.DB.prepare('SELECT session_id, day FROM session_starts ORDER BY session_id').all()).results;
    const filed = async () => ({
      totals: await totals(),
      split: await splitTotals(),
      sessions: await sessionDays(),
    });

    it('each request\'s cost is under its Belgian day in every total, and its session starts on that day', async () => {
      await asBeforeTheChange();
      expect((await splitTotals()).map((t) => t.day)).toEqual(['2026-01-10', '2026-10-21', '2026-10-21']);

      expect((await startJob('rebuild')).status).toBe(200);

      expect((await splitTotals()).map((t) => [t.day, t.branch, t.cost_micros])).toEqual([
        ['2026-01-11', 'b/c', 4_000_000],
        ['2026-10-21', 'b/b', 1_000_000],
        ['2026-10-22', 'b/a', 2_000_000],
      ]);
      expect((await totals()).map((t) => [t.day, t.category])).toEqual([
        ['2026-01-11', 'ci-reviews'],
        ['2026-10-21', 'after-push'],
        ['2026-10-22', 'building'],
      ]);
      expect(await sessionDays()).toEqual([
        { session_id: 's-noon', day: '2026-10-21' },
        { session_id: 's-summer', day: '2026-10-22' },
        { session_id: 's-winter', day: '2026-01-11' },
      ]);
    });

    it('run twice, it gives the totals it gave once', async () => {
      await asBeforeTheChange();
      await startJob('rebuild');
      const once = await filed();

      await startJob('rebuild');

      expect(await filed()).toEqual(once);
    });

    it('run after a half-finished run, it gives what a whole run gives', async () => {
      await asBeforeTheChange();
      await startJob('rebuild');
      const whole = await filed();
      // A run that stopped part-way: one table re-filed, the others emptied or still under UTC days.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM daily_split_totals'),
        env.DB.prepare("UPDATE daily_totals SET day = '2026-10-21' WHERE day = '2026-10-22'"),
        env.DB.prepare("UPDATE session_starts SET day = '2026-01-10' WHERE day = '2026-01-11'"),
      ]);

      await startJob('rebuild');

      expect(await filed()).toEqual(whole);
    });

    it('leaves every request row exactly as it was', async () => {
      await asBeforeTheChange();
      const before = await requestRows();

      await startJob('rebuild');

      expect(await requestRows()).toEqual(before);
    });

    it('files the instants either side of every clock change under the day Brussels calls them', async () => {
      // 01:00 UTC on the last Sunday of March and of October: the minute before and the minute of each change.
      const instants = ['2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-03-28T22:59:00Z', '2026-03-28T23:00:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', '2026-10-24T21:59:00Z', '2026-10-24T22:00:00Z', '2026-10-25T22:59:00Z', '2026-10-25T23:00:00Z'];
      await send(instants.map((time, i) => spend(`r${i}`, 1, { time, branch: `b/${i}`, sessionId: `s${i}` })));
      const arrived = (await splitTotals()).map((t) => [t.branch, t.day]);

      await startJob('rebuild');

      expect((await splitTotals()).map((t) => [t.branch, t.day])).toEqual(arrived);
      expect(Object.fromEntries(arrived)).toEqual({
        'b/0': '2026-03-29',
        'b/1': '2026-03-29',
        'b/2': '2026-03-28',
        'b/3': '2026-03-29',
        'b/4': '2026-10-25',
        'b/5': '2026-10-25',
        'b/6': '2026-10-24',
        'b/7': '2026-10-25',
        'b/8': '2026-10-25',
        'b/9': '2026-10-26',
      });
    });
  });
});
