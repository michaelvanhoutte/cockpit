import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, sized } from './github-support';
import { costRows, emptyTheDatabase, groupTabs, send, spend, thePage, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => vi.restoreAllMocks());

const pr = (number: number, state: 'OPEN' | 'MERGED', createdAt: string, mergedAt: string | null) =>
  sized({ number, title: `P${number}`, headRefName: `b/${number}`, state, createdAt, mergedAt, closingIssuesReferences: { nodes: [] } });

/** #1 merged on the 3rd (the dearest), #2 merged on the 5th, #3 open since the 1st (the cheapest), a branch no pull request names, and a session on no branch. */
async function pullRequestsAndBranches() {
  await send([
    spend('a', 5, { branch: 'b/1', category: 'building' }),
    spend('b', 3, { branch: 'b/2', category: 'after-push' }),
    spend('c', 1, { branch: 'b/3', category: 'scoping-planning' }),
    spend('d', 2, { branch: 'claude/nobody', category: 'building' }),
    spend('e', 9, { branch: null, category: 'ci-reviews' }),
  ]);
  await linked(
    pr(1, 'MERGED', '2026-09-01T00:00:00Z', '2026-10-03T00:00:00Z'),
    pr(2, 'MERGED', '2026-09-02T00:00:00Z', '2026-10-05T00:00:00Z'),
    pr(3, 'OPEN', '2026-10-01T00:00:00Z', null),
  );
}

/** The table's header cells and the footer's words, as the page draws them. */
const chrome = (html: string) => ({
  headers: [...html.matchAll(/<th scope="col" class="(?:first|num)">(.*?)<\/th>/g)].map((m) => m[1]!).filter((h) => /^(?:<a[^>]*>)?(?:Pull request|Issue|Engineer|Category|Day|Total)/.test(h)),
  footer: /sorted by ([^<]*)</.exec(html)![1]!,
});
const labels = async (query: string) => costRows(await thePage(`?period=all&${query}`)).map((r) => r.label);

describe('Harness Monitor', () => {
  describe('the chosen order is carried by the address and shown on the page', () => {
    beforeEach(pullRequestsAndBranches);

    it('by pull request it opens newest first, with Total a link to the dearest first', async () => {
      const html = await thePage('?period=all&group=pr');

      expect(await labels('group=pr')).toEqual(['#3 P3', '#2 P2', '#1 P1', 'claude/nobody', 'No branch']);
      expect(chrome(html)).toEqual({ headers: ['Pull request ▾', '<a href="/?period=all&group=pr&sort=total">Total</a>'], footer: 'newest first' });
    });

    it('sorted by total it is dearest first, with the first header a link back', async () => {
      const html = await thePage('?period=all&group=pr&sort=total');

      expect(await labels('group=pr&sort=total')).toEqual(['No branch', '#1 P1', '#2 P2', 'claude/nobody', '#3 P3']);
      expect(chrome(html)).toEqual({ headers: ['<a href="/?period=all&group=pr">Pull request</a>', 'Total ▾'], footer: 'total' });
    });

    it('by category it opens in pipeline order and says so', async () => {
      const html = await thePage('?period=all&group=category');

      expect(await labels('group=category')).toEqual(['Scoping & planning', 'Building', 'After push', 'CI reviews']);
      expect(chrome(html).footer).toBe('pipeline order');
    });

    it('by engineer it is by total, and neither header is a link', async () => {
      const html = await thePage('?period=all&group=engineer');

      expect(chrome(html)).toEqual({ headers: ['Engineer', 'Total ▾'], footer: 'total' });
      expect(await labels('group=engineer&sort=total')).toEqual(await labels('group=engineer'));
      expect(chrome(await thePage('?period=all&group=engineer&sort=total'))).toEqual(chrome(html));
    });

    it('a sort it does not know is the default order', async () => {
      expect(await labels('group=pr&sort=bogus')).toEqual(await labels('group=pr'));
    });

    it('a changed filter keeps the order, and a new grouping goes back to its own', async () => {
      const html = await thePage('?period=all&group=pr&sort=total&model=claude-sonnet-5');

      expect(html).toContain('<input type="hidden" name="sort" value="total">');
      expect(chrome(html).footer).toBe('total');
      // A grouping's tab keeps the filters and drops the sort, so it opens in its own order.
      expect(groupTabs(html).map((t) => t.href)).toEqual([
        '/?period=all&model=claude-sonnet-5',
        '/?period=all&model=claude-sonnet-5&group=pr',
        '/?period=all&model=claude-sonnet-5&group=issue',
        '/?period=all&model=claude-sonnet-5&group=engineer',
        '/?period=all&model=claude-sonnet-5&group=category',
      ]);
      expect(await thePage('?period=all&group=issue')).not.toContain('name="sort"');
    });

    it('a pull request’s Sessions link and the CSV export leave the order behind', async () => {
      const html = await thePage('?period=all&group=pr&sort=total');

      expect(html).toContain('href="/pr/1?period=all">Sessions</a>');
      expect(html).toContain('href="/export.csv?period=all"');
    });
  });

  describe('paging continues the order', () => {
    it('sorted by total, the second page carries on from the first', async () => {
      await send(Array.from({ length: 27 }, (_, i) => spend(`r${i}`, i + 1, { branch: `b/${String(i).padStart(2, '0')}` })));

      const first = await labels('group=pr&sort=total');
      const second = await labels('group=pr&sort=total&page=2');
      const html = await thePage('?period=all&group=pr&sort=total');

      expect(first).toHaveLength(25);
      expect([...first, ...second].map((l) => l.slice(2))).toEqual(Array.from({ length: 27 }, (_, i) => String(26 - i).padStart(2, '0')));
      expect(html).toContain('href="/?period=all&group=pr&sort=total&page=2"');
    });
  });
});
