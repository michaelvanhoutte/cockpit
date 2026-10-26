import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { cycleCheck, cyclePull, cycleRound, emptyTheDatabase, sendPulls, thePullRequest, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => vi.restoreAllMocks());

const MIN = 60_000;
const at = (time: string) => `2026-10-01T${time}Z`;

/** A job that ran in a round pushed at 10:00 UTC (12:00 in Brussels), starting `from` seconds into it. */
const job = (name: string, from: number, seconds: number, over: Record<string, unknown> = {}) => ({
  name,
  attempt: 1,
  rerun: false,
  outcome: 'pass',
  startedAt: new Date(Date.parse(at('10:00:00')) + from * 1000).toISOString(),
  endedAt: new Date(Date.parse(at('10:00:00')) + (from + seconds) * 1000).toISOString(),
  offsetMs: from * 1000,
  ms: seconds * 1000,
  leadMs: 0,
  queuedMs: 0,
  ...over,
});

/**
 * Two rounds: the first red, with a failed job after a wait for a runner and a re-run, the second green; coding from
 * 09:30 UTC (11:30 in Brussels) and a merge at 10:35. Its timeline holds the jobs of each.
 */
const twoRounds = (number: number, over: Record<string, unknown> = {}) =>
  cyclePull(number, {
    mergedAt: at('10:35:00'),
    start: { at: at('09:30:00'), from: 'session-record' },
    ciMs: 20 * MIN,
    totalMs: 65 * MIN,
    rounds: [
      cycleRound([cycleCheck('Test', 10 * MIN, { failure: 'red', last: true })], { pushedAt: at('10:00:00'), endedAt: at('10:10:00'), ms: 10 * MIN, red: true }),
      cycleRound([cycleCheck('Test', 10 * MIN, { last: true })], { pushedAt: at('10:20:00'), endedAt: at('10:30:00'), ms: 10 * MIN }),
    ],
    timeline: {
      lanes: [
        [job('Test', 30, 570, { outcome: 'fail', leadMs: 20_000, queuedMs: 20_000 }), job('E2E (F3)', 60, 540, { rerun: true, attempt: 2 })],
        [job('Test', 30, 570)],
      ],
      reviewSlices: [],
      runSlices: [],
    },
    ...over,
  });

const timelineOf = (html: string) => /<section class="panel tl" aria-labelledby="timeline">.*?<\/section>/s.exec(html)?.[0] ?? '';
const textOf = (html: string) => html.replace(/<style>.*?<\/style>/gs, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ');
const pageOf = async (number: number, query = '') => (await thePullRequest(number, query)).text();
const withoutATimeline = (number: number) => {
  const pull: Record<string, unknown> = { ...twoRounds(number) };
  delete pull.timeline;
  return pull;
};

describe('Harness Monitor', () => {
  describe("a pull request's page shows its timeline from the stored rows", () => {
    it('a stored pull request with a timeline and a branch link shows its strip above its sessions', async () => {
      await sendPulls([twoRounds(31)]);
      await linked(pullRequest({ number: 31, title: 'Pull request 31', headRefName: 'claude/31-work' }));

      const html = await pageOf(31, '?period=all');
      const strip = timelineOf(html);

      expect(strip).toContain('class="tl-strip"');
      expect([...strip.matchAll(/class="tl-seg round/g)]).toHaveLength(4);
      expect(html.indexOf('id="timeline"')).toBeLessThan(html.indexOf('aria-labelledby="sessions"'));
    });

    it('draws a failed job ringed, a re-run hatched, a wait for a runner as a lead, and names each round', async () => {
      await sendPulls([twoRounds(31)]);

      const strip = timelineOf(await pageOf(31));

      expect(strip).toContain('class="tl-lane tl-job failed"');
      expect(strip).toContain('class="tl-lane tl-job rerun"');
      expect(strip).toContain('class="tl-lane tl-lead"');
      expect(strip).toContain('<span class="tl-cilong">CI Round 1');
      expect(strip).toContain('<span class="tl-cilong">CI Round 2');
      expect(strip).toContain('<i class="tl-mark red"');
    });

    it('reads a job in Belgian time to the second, with the round it ran in under it', async () => {
      await sendPulls([twoRounds(31)]);

      const strip = timelineOf(await pageOf(31));

      expect(strip).toContain('<p class="tl-dhead">Test</p><p class="tl-dline">started 12:00:30, stopped 12:10:00 · ran 9m 30s · waited 20s for a runner · failed</p><p class="tl-dctx">in CI Round 1 · pushed 1 Oct 2026, 12:00</p>');
      expect(strip).toContain('re-run (attempt 2)');
    });

    it('puts the zoomed strip’s axis on Belgian clock times from the start to the merge', async () => {
      await sendPulls([twoRounds(31)]);

      const axis = /<span class="tl-clockaxis".*?<\/span><\/span>/s.exec(timelineOf(await pageOf(31)))![0];
      const labels = [...axis.matchAll(/<span class="tl-clocktick[^"]*"[^>]*>(.*?)<\/span>/g)].map((m) => m[1]);

      // 09:30 UTC is 11:30 in Brussels in October, and the merge at 10:35 is 12:35.
      expect(labels[0]).toBe('11:30');
      expect(labels[labels.length - 1]).toBe('12:35');
    });

    it('a stored pull request with no timeline reads timeline not recorded, with no strip', async () => {
      await sendPulls([withoutATimeline(32)]);

      const html = await pageOf(32);

      expect(textOf(html)).toContain('Timeline not recorded.');
      expect(html).not.toContain('tl-strip');
      expect(html).not.toContain('tl-seg');
    });

    it('a timeline whose round count no longer matches the stored pull request reads timeline not recorded, never a misdrawn strip', async () => {
      // The API refuses such a timeline whole, so only a write around it reaches this: the rule the page keeps when one is stored anyway.
      await sendPulls([twoRounds(33)]);
      const three = { lanes: [null, null, null], reviewSlices: [], runSlices: [] };
      await env.DB.prepare('UPDATE cycle_time_timelines SET timeline = ?1 WHERE pull_number = 33').bind(JSON.stringify(three)).run();

      const html = await pageOf(33);

      expect(textOf(html)).toContain('Timeline not recorded.');
      expect(html).not.toContain('tl-seg');
    });

    it('a pull request with no session record has its first part hatched and tagged not recorded', async () => {
      await sendPulls([twoRounds(34, { recorded: false, codingMs: null, localMs: null, localReviews: null, start: { at: at('09:55:00'), from: 'first-commit' } })]);

      const html = await pageOf(34);
      const strip = timelineOf(html);

      expect(strip).toContain('class="tl-seg coding unrecorded"');
      expect(strip).toContain('<span class="tl-tag unrecorded"');
      expect(textOf(strip)).toContain('No session record: the time starts at the first commit');
    });

    it('a round whose lanes are null is one block split by what held it, saying on hover that its lanes are not recorded', async () => {
      const held = [cycleCheck('Test', 4 * MIN), cycleCheck('claude-review', 6 * MIN, { last: true })];
      await sendPulls([twoRounds(35, { rounds: [cycleRound(held, { pushedAt: at('10:00:00'), endedAt: at('10:10:00'), ms: 10 * MIN })], timeline: { lanes: [null], reviewSlices: [], runSlices: [] } })]);

      const strip = timelineOf(await pageOf(35));

      expect([...strip.matchAll(/<span class="tl-piece"/g)]).toHaveLength(4);
      expect(strip).toContain('Tests and checks (Test) · held it 4m 00s');
      expect(strip).toContain('lanes not recorded: its job list could not be read');
      expect(strip).not.toContain('tl-lane tl-job');
    });

    it('a strip longer than four hours is cut at the edge of the scale, saying how much it cut, and zooms to all of it', async () => {
      const long = (ms: number) => cycleRound([cycleCheck('Test', ms, { last: true })], { pushedAt: at('10:00:00'), endedAt: at('15:00:00'), ms });
      await sendPulls([twoRounds(36, { mergedAt: at('15:00:00'), start: { at: at('10:00:00'), from: 'session-record' }, rounds: [long(5 * 60 * MIN)], timeline: { lanes: [null], reviewSlices: [], runSlices: [] }, totalMs: 300 * MIN })]);

      const strip = timelineOf(await pageOf(36));

      expect(strip).toContain('Clipped: 5h 00m on the scale in all (time away is not counted), the first 4h 00m shown.');
      expect(strip).toContain('<span class="tl-tag clip">clipped</span>');
      expect(strip).toContain('<span class="tl-clipmark"');
    });

    it('local work that overlaps is drawn in as few rows as ever run at once', async () => {
      const slices = {
        lanes: [null, null],
        reviewSlices: [{ kind: 'code-review', level: 'high', gap: 0, at: at('09:32:00'), ms: 6 * MIN }],
        runSlices: [
          { kind: 'test', scopes: ['api'], gap: 0, at: at('09:33:00'), ms: 2 * MIN },
          { kind: 'test', scopes: ['web'], gap: 0, at: at('09:35:00'), ms: 2 * MIN },
        ],
      };
      await sendPulls([twoRounds(37, { timeline: slices })]);

      const strip = timelineOf(await pageOf(37));

      // The review is the busiest row, on the line; the two runs, one after the other, share the row above. The strip is drawn closed and zoomed, so each twice.
      expect([...strip.matchAll(/class="tl-lane code-review" style="left:0.000%;width:100.000%;top:0%"/g)]).toHaveLength(2);
      expect([...strip.matchAll(/class="tl-lane test" style="[^"]*top:-100%"/g)]).toHaveLength(4);
      expect(strip).not.toContain('top:100%');
    });
  });

  describe('every pull request cycle time holds has a page', () => {
    it('a stored pull request with no branch link answers with its timeline and says no sessions are linked', async () => {
      await sendPulls([twoRounds(41)]);

      const response = await thePullRequest(41);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(timelineOf(html)).toContain('class="tl-strip"');
      expect([...textOf(html).matchAll(/No Claude Code sessions are linked to this pull request\./g)]).toHaveLength(2);
      expect(html).not.toContain('id="pr-total"');
      expect(html).toContain('Pull request 41');
    });

    it('a branch link with no stored pull request answers as before, with no timeline section', async () => {
      await linked(pullRequest({ number: 42, title: 'Only linked', headRefName: 'claude/42-work' }));

      const response = await thePullRequest(42, '?period=all');
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('Only linked');
      expect(html).not.toContain('id="timeline"');
    });

    it('a number neither holds is nothing found', async () => {
      const response = await thePullRequest(43);

      expect(response.status).toBe(404);
      expect(textOf(await response.text())).toContain('Nothing found.');
    });
  });
});
