import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyTheDatabase, send, spend, theBarePage, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});

/** `daysAgo` days before today, at midday, as an ISO time. */
const ago = (daysAgo: number) => `${new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`;

/** A pull request merged `daysAgo` days ago that changed `lines` lines, on branch b/<number>. */
async function merged(number: number, daysAgo: number, lines: number, engineer = 'alice') {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO branch_links (branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at)
       VALUES (?1, ?2, 'T', 'MERGED', ?3, NULL, ?4, ?3, 0)`,
    ).bind(`b/${number}`, number, ago(daysAgo), engineer),
    env.DB.prepare(`INSERT INTO pull_request_stats (pr_number, lines_added, lines_removed, pr_updated_at, read_at) VALUES (?1, ?2, 0, ?3, 0)`).bind(number, lines, ago(daysAgo)),
  ]);
}

/** The card as a person reads it: its sentence, the drivers by key, and each dimension's lines. */
function card(html: string) {
  const section = /<section class="panel change"[^>]*>(.*?)<\/section>/s.exec(html)?.[1];
  if (section === undefined) return null;
  const text = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return {
    sentence: text(/<p>(.*?)<\/p>/s.exec(section)![1]!),
    drivers: Object.fromEntries([...section.matchAll(/<tr data-driver="([^"]*)"><th[^>]*>.*?<\/th><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td>/g)].map((m) => [m[1]!, [m[2]!, m[3]!]])),
    dimensions: Object.fromEntries([...section.matchAll(/<div data-dimension="([^"]*)">.*?<ul>(.*?)<\/ul>/gs)].map((m) => [m[1]!, [...m[2]!.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((li) => text(li[1]!).replace(/\s+/g, ' ').trim())])),
  };
}

describe('Harness Monitor', () => {
  describe('every tab except All time compares the period with the one before it, under the same filters', () => {
    beforeEach(async () => {
      await send([
        spend('now1', 6, { time: ago(2), branch: 'b/1', sessionId: 's1' }),
        spend('now2', 4, { time: ago(3), branch: 'b/2', sessionId: 's2', model: 'claude-opus-4-8', category: 'after-push', inputTokens: 800_000 }),
        spend('before1', 5, { time: ago(33), branch: 'b/3', sessionId: 's3' }),
      ]);
      await merged(1, 2, 2_000);
      await merged(2, 3, 1_000, 'bob');
      await merged(3, 33, 500);
    });

    it('the last 30 days with cost in both give both totals, the change in dollars and percent, the drivers and the changes', async () => {
      const found = card(await theBarePage('?period=30d'));

      expect(found!.sentence).toContain('cost $10.00 against $5.00');
      expect(found!.sentence).toContain('+$5.00 (+100.0%)');
      expect(found!.drivers).toEqual({
        merged: ['2', '1'],
        'cost-per-pr': ['$5.00', '$5.00'],
        'lines-per-pr': ['1,500 lines', '500 lines'],
        'cost-per-line': ['$3.33', '$10.00'],
        'starting-context': ['1,900,000 tokens', '2,500,000 tokens'],
      });
      // Building before phase marks existed (21 Sep 2026) reads as Unphased, so the period before shows it as a decrease.
      expect(found!.dimensions.phase).toEqual(['▲ Building +$6.00 $0.00 → $6.00', '▼ Unphased −$5.00 $5.00 → $0.00', '▲ After push +$4.00 $0.00 → $4.00']);
    });

    it('nothing in the previous period gives the change in dollars and no percent', async () => {
      const found = card(await theBarePage('?period=7d'));

      expect(found!.sentence).toContain('+$10.00.');
      expect(found!.sentence).not.toContain('%');
    });

    it('every tab carries the card', async () => {
      for (const group of ['day', 'pr', 'issue', 'engineer', 'category']) expect(card(await theBarePage(`?period=30d&group=${group}`)), group).not.toBeNull();
    });

    it('All time has no card', async () => {
      expect(card(await theBarePage('?period=all'))).toBeNull();
    });

    it('an engineer narrows both periods to that engineer', async () => {
      const found = card(await theBarePage('?period=30d&engineer=bob'));

      expect(found!.sentence).toContain('cost $4.00 against $0.00');
      expect(found!.drivers.merged).toEqual(['1', '0']);
    });
  });

  describe('the comparison names Outside the process and Process review by their change', () => {
    it('over two periods, each phase appears with the dollars it moved', async () => {
      await send([
        spend('now1', 7, { time: ago(2), branch: 'b/1', category: 'outside-process' }),
        spend('now2', 3, { time: ago(3), branch: 'b/1', category: 'process-review' }),
        spend('before1', 2, { time: ago(33), branch: 'b/1', category: 'outside-process' }),
      ]);

      const found = card(await theBarePage('?period=30d'));

      expect(found!.dimensions.phase).toEqual(['▲ Outside the process +$5.00 $2.00 → $7.00', '▲ Process review +$3.00 $0.00 → $3.00']);
    });
  });
});
