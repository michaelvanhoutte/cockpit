import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, groupTabs, send, spend, theBarePage, thePullRequest, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => vi.restoreAllMocks());

const github = `https://github.com/${env.GITHUB_REPOSITORY}`;

/** The first cell of each row of the cost table, as the page writes it: links included. */
const firstCells = (html: string) => [...html.matchAll(/<tr>(<td class="first">.*?<\/td>)/gs)].map((m) => m[1]!);
const hrefs = (cell: string) => [...cell.matchAll(/<a href="([^"]*)"([^>]*)>(.*?)<\/a>/gs)].map(([, href, attributes, text]) => ({ href: href!, newTab: attributes!.includes('target="_blank"'), text: text! }));
/** The cost-per-day chart alone: the trend charts below it draw lines of their own. */
const perDay = (html: string) => /<section class="panel" aria-labelledby="perday">.*?<\/section>/s.exec(html)![0];

describe('Harness Monitor', () => {
  describe('the page opens on Over time, newest day first; every other grouping keeps its own address', () => {
    it('the bare address has Over time pressed and its table shown, the newer cheaper day above the older dearer one', async () => {
      await send([spend('old', 5, { time: '2026-10-01T10:00:00Z' }), spend('new', 1, { time: '2026-10-02T10:00:00Z' })]);

      const html = await theBarePage('?period=all');

      expect(groupTabs(html).find((t) => t.current)?.label).toBe('Over time');
      expect(html).toContain('aria-label="Cost by day"');
      expect(html).toContain('<th scope="col" class="first">Day ▾</th>');
      expect(costRows(html).map((r) => [r.label, r.total])).toEqual([
        ['2 Oct 2026', '$1.00'],
        ['1 Oct 2026', '$5.00'],
      ]);
    });

    it('Over time is the first of the groupings', async () => {
      const html = await theBarePage();

      expect(groupTabs(html).map((t) => t.label)).toEqual(['Over time', 'Pull request', 'Issue', 'Engineer', 'Category']);
    });

    it('?group=pr is the pull request grouping, as before', async () => {
      await send([spend('a', 2, { branch: 'b/1' })]);
      await linked(pullRequest({ number: 7, title: 'Mine', headRefName: 'b/1', author: { login: 'alice' } }));

      const html = await theBarePage('?period=all&group=pr');

      expect(html).toContain('aria-label="Cost by pull request"');
      expect(costRows(html).map((r) => r.label)).toEqual(['#7 Mine']);
    });
  });

  describe('Over time draws a line per series of the split and a dashed total', () => {
    it('shows the chart with a legend of the series that cost something and the total', async () => {
      await send([spend('a', 2, { category: 'building' }), spend('b', 1, { category: 'after-push' })]);

      const html = await theBarePage('?period=all');

      expect(html).toContain('<h2 id="perday">Cost per day</h2>');
      expect(html).toContain('<svg viewBox=');
      expect([...perDay(html).matchAll(/<g data-line="([^"]*)">/g)].map((m) => m[1])).toEqual(['building', 'after-push', 'total']);
      expect([...perDay(html).matchAll(/<span class="key">.*?<\/i>(.*?)<\/span>/g)].map((m) => m[1])).toEqual(['Building', 'After push', 'Total']);
    });

    it('a day with no cost between two that have some is a zero point, and each point carries its value', async () => {
      await send([spend('a', 2, { time: '2026-10-01T10:00:00Z' }), spend('b', 3, { time: '2026-10-03T10:00:00Z' })]);

      const html = await theBarePage('?period=all');

      const total = /<g data-line="total">(.*?)<\/g>/s.exec(html)![1]!;
      expect([...total.matchAll(/<title>(.*?)<\/title>/g)].slice(0, 3).map((m) => m[1])).toEqual(['Total · 1 Oct 2026 · $2.00', 'Total · 2 Oct 2026 · $0.00', 'Total · 3 Oct 2026 · $3.00']);
    });

    it('the chart follows the split: a line per model', async () => {
      await send([spend('a', 2, { model: 'claude-sonnet-5' }), spend('b', 1, { model: 'claude-haiku-4-5', inputTokens: 1_000_000 })]);

      const html = await theBarePage('?period=all&split=model');

      expect([...perDay(html).matchAll(/<g data-line="([^"]*)">/g)].map((m) => m[1]).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'total']);
    });

    it('is on Over time only', async () => {
      await send([spend('a', 2)]);

      expect(await theBarePage('?period=all&group=pr')).not.toContain('id="perday"');
      expect(await theBarePage('?period=all&group=day')).toContain('id="perday"');
    });
  });

  describe('rows open GitHub in a new tab where a pull request or issue is known', () => {
    const seed = async () => {
      await send([spend('a', 2, { branch: 'b/1' }), spend('b', 1, { branch: 'b/2' }), spend('c', 1, { branch: 'claude/nobody' }), spend('d', 1, { branch: null })]);
      await linked(
        pullRequest({ number: 7, title: 'Mine', headRefName: 'b/1', author: { login: 'alice' }, closingIssuesReferences: { nodes: [{ number: 5, title: 'The ask' }] } }),
        pullRequest({ number: 8, title: 'Loose', headRefName: 'b/2', author: { login: 'alice' }, closingIssuesReferences: { nodes: [] } }),
      );
    };

    it('a linked pull request: its title opens GitHub, its issue opens the GitHub issue, and Sessions opens the monitor page', async () => {
      await seed();

      const cell = firstCells(await theBarePage('?period=all&group=pr')).find((c) => c.includes('#7'))!;

      expect(hrefs(cell)).toEqual([
        { href: `${github}/pull/7`, newTab: true, text: '#7 Mine' },
        { href: `${github}/issues/5`, newTab: true, text: 'Issue #5' },
        { href: '/pr/7?period=all', newTab: false, text: 'Sessions' },
      ]);
      expect(cell).toContain('rel="noopener noreferrer"');
    });

    it('a pull request closing nothing links its title and Sessions, and "No issue" nowhere', async () => {
      await seed();

      const cell = firstCells(await theBarePage('?period=all&group=pr')).find((c) => c.includes('#8'))!;

      expect(hrefs(cell).map((h) => h.text)).toEqual(['#8 Loose', 'Sessions']);
      expect(cell).toContain('No issue');
    });

    it('an unlinked branch and a request with no branch link nowhere', async () => {
      await seed();

      const cells = firstCells(await theBarePage('?period=all&group=pr')).filter((c) => !c.includes('#7') && !c.includes('#8'));

      expect(cells).toHaveLength(2);
      for (const cell of cells) expect(hrefs(cell)).toEqual([]);
    });

    it('an issue row opens the GitHub issue; "No issue" and "Unattributed" link nowhere', async () => {
      await seed();

      const cells = firstCells(await theBarePage('?period=all&group=issue'));

      expect(hrefs(cells.find((c) => c.includes('#5'))!)).toEqual([{ href: `${github}/issues/5`, newTab: true, text: '#5 The ask' }]);
      for (const cell of cells.filter((c) => c.includes('No issue') || c.includes('Unattributed'))) expect(hrefs(cell)).toEqual([]);
      expect(cells).toHaveLength(3);
    });

    it('a day and an engineer link nowhere', async () => {
      await seed();

      for (const group of ['day', 'engineer', 'category']) for (const cell of firstCells(await theBarePage(`?period=all&group=${group}`))) expect(hrefs(cell)).toEqual([]);
    });

    it('with no repository configured, nothing links to GitHub but Sessions still opens the monitor page', async () => {
      await seed();
      const { default: worker } = await import('../../src/worker');
      const { createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
      const ctx = createExecutionContext();
      const { GITHUB_REPOSITORY, ...rest } = env;
      void GITHUB_REPOSITORY;
      const html = await (await worker.fetch(new Request('https://monitor.test/?period=all&group=pr'), rest as typeof env, ctx)).text();
      await waitOnExecutionContext(ctx);

      expect(html).not.toContain('github.com');
      expect(html).toContain('>Sessions</a>');
    });
  });

  describe("the pull request page's back link", () => {
    it('reads "All costs" and leads to the page that opens on Over time', async () => {
      await send([spend('a', 2, { branch: 'b/1' })]);
      await linked(pullRequest({ number: 7, title: 'Mine', headRefName: 'b/1', author: { login: 'alice' } }));

      const html = await (await thePullRequest(7)).text();

      expect(html).toContain('<a class="back" href="/">&larr; All costs</a>');
    });
  });
});
