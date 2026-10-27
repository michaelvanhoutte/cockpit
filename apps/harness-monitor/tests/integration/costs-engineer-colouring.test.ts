import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, send, spend, theBarePage, whereItWent, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => vi.restoreAllMocks());

/** One day: alice's pull request ($5), bob's ($3), one whose author is not known ($1), a branch no pull request names ($2) and a request on no branch ($4). */
async function oneDay() {
  await send([
    spend('a', 5, { branch: 'b/alice' }),
    spend('b', 3, { branch: 'b/bob' }),
    spend('n', 1, { branch: 'b/nobody' }),
    spend('x', 2, { branch: 'claude/stray' }),
    spend('m', 4, { branch: null }),
  ]);
  await linked(
    pullRequest({ number: 1, title: 'Alice’s', headRefName: 'b/alice', author: { login: 'alice' } }),
    pullRequest({ number: 2, title: 'Bob’s', headRefName: 'b/bob', author: { login: 'bob' } }),
    pullRequest({ number: 3, title: 'Nobody’s', headRefName: 'b/nobody', author: null }),
  );
}

const html = (query: string) => theBarePage(`?period=all&split=engineer${query}`);
const GREY = 'var(--series-grey)';
const VIOLET = 'var(--series-1)';
const ORANGE = 'var(--series-2)';

/** The legend under the bar: each colour's name, its swatch and its dollars. */
const legend = (page: string) => [...page.matchAll(/<li><i style="background:([^"]*)" aria-hidden="true"><\/i><span class="name">(.*?)<\/span><span class="amount">(.*?)<\/span><\/li>/g)].map((m) => [m[2]!, m[1]!, m[3]!]);
/** The lines of one per-day chart, in the order drawn. */
const lines = (page: string, chart: 'perday' | 'tokensperday') => [...new RegExp(`<section class="panel" aria-labelledby="${chart}">.*?</section>`, 's').exec(page)![0].matchAll(/<g data-line="([^"]*)">/g)].map((m) => m[1]);

describe('Harness Monitor', () => {
  describe("coloured by engineer splits every section by the pull request's author", () => {
    beforeEach(oneDay);

    it('the bar and its legend name each engineer dearest first, then the author nobody knows, then Unattributed last in grey', async () => {
      const page = await html('');

      expect(whereItWent(page)).toEqual({ heading: "Where the period's $15.00 went, by engineer", bar: 'alice $5.00, bob $3.00, unknown $1.00, Unattributed $6.00' });
      expect(legend(page)).toEqual([
        ['alice', VIOLET, '$5.00'],
        ['bob', ORANGE, '$3.00'],
        ['unknown', GREY, '$1.00'],
        ['Unattributed', GREY, '$6.00'],
      ]);
    });

    it('Cost per day and Tokens per day draw a line per engineer, Unattributed, and the total', async () => {
      const page = await html('');

      expect(lines(page, 'perday')).toEqual(['alice', 'bob', '~unknown', '~unattributed', 'total']);
      expect(lines(page, 'tokensperday')).toEqual(['alice', 'bob', '~unknown', '~unattributed', 'total']);
    });

    it("each pull request's bar is its author's colour, and its hover names the author's dollars", async () => {
      const rows = costRows(await html('&group=pr&sort=total'));

      expect(rows.map((r) => [r.label, r.fills, r.colours])).toEqual([
        ['#1 Alice’s', [VIOLET], 'alice $5.00'],
        ['No branch', [], ''],
        ['#2 Bob’s', [ORANGE], 'bob $3.00'],
        ['claude/stray', [GREY], 'Unattributed $2.00'],
        ['#3 Nobody’s', [GREY], 'unknown $1.00'],
      ]);
    });

    it('a day with all of them is one bar of every colour', async () => {
      const [day] = costRows(await html(''));

      expect(day!.fills).toEqual([VIOLET, ORANGE, GREY, GREY]);
      expect(day!.colours).toBe('alice $5.00 · bob $3.00 · unknown $1.00 · Unattributed $6.00');
    });

    it('an engineer filter leaves that engineer’s colour as it was without it', async () => {
      const filtered = await html('&engineer=bob');

      expect(legend(filtered)).toEqual([['bob', ORANGE, '$3.00']]);
      expect(legend(await html('')).find((l) => l[0] === 'bob')![1]).toBe(ORANGE);
    });

    it('the tokens follow the same colours', async () => {
      const page = await html('');
      const tokens = /<g data-line="alice">(.*?)<\/g>/s.exec(/<section class="panel" aria-labelledby="tokensperday">.*?<\/section>/s.exec(page)![0])![1]!;

      expect(tokens).toContain('alice · 1 Oct 2026 · 2.5M tokens');
    });
  });

  describe('requests no pull request claims are Unattributed', () => {
    it('with only such requests, Unattributed is the one colour', async () => {
      await send([spend('m', 2, { branch: null })]);

      expect(legend(await html('')).map((l) => [l[0], l[1]])).toEqual([['Unattributed', GREY]]);
    });
  });
});
