import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { emptyTheDatabase, groupTabs, send, spend, theBarePage, thePullRequest, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
  await send([spend('a', 2, { branch: 'b/1', model: 'claude-sonnet-5' }), spend('b', 1, { branch: 'b/1', model: 'claude-haiku-4-5', inputTokens: 1_000_000 })]);
  await linked(pullRequest({ number: 7, title: 'Mine', headRefName: 'b/1', author: { login: 'alice' } }));
});
afterEach(() => vi.restoreAllMocks());

/** The top bar as a visitor sees it: the name, and each page's tab with whether it is the one open. */
function topBar(html: string) {
  const bar = /<header class="topbar">(.*?)<\/header>/s.exec(html)![1]!;
  return {
    mark: bar.includes('<svg') && bar.includes('class="logo"'),
    name: /<span>Harness Monitor<\/span>/.test(bar),
    tabs: [...(/<nav class="pages"[^>]*>(.*?)<\/nav>/s.exec(bar)?.[1] ?? '').matchAll(/<a href="[^"]*"( aria-current="page")?>([^<]*)<\/a>/g)].map((m) => ({ label: m[2]!, current: m[1] !== undefined })),
  };
}

/** The filters that hold a value (wear the accent border), and the toggles that are pressed. */
const controls = (html: string) => ({
  held: [...html.matchAll(/<select id="(\w+)"[^>]*? data-set>/g)].map((m) => m[1]!),
  pressed: [...html.matchAll(/<button type="submit" name="split" value="\w+" aria-pressed="true">(.*?)<\/button>/g)].map((m) => m[1]!),
});

describe('Harness Monitor', () => {
  describe('every page opens under the same top bar, its own tab selected', () => {
    it.each([
      { situation: 'the costs page', page: () => theBarePage('?period=all') },
      { situation: "a pull request's page", page: async () => (await thePullRequest(7)).text() },
      { situation: 'the page for a pull request nothing knows', page: async () => (await thePullRequest(999)).text() },
    ])('$situation shows the mark, the name and the costs tab selected', async ({ page }) => {
      expect(topBar(await page())).toEqual({ mark: true, name: true, tabs: [{ label: 'Claude Code costs', current: true }] });
    });

    it.each([
      { situation: 'the costs page', page: () => theBarePage() },
      { situation: "a pull request's page", page: async () => (await thePullRequest(7)).text() },
      { situation: 'the page for a pull request nothing knows', page: async () => (await thePullRequest(999)).text() },
    ])('$situation has exactly one top-level heading', async ({ page }) => {
      expect((await page()).match(/<h1\b/g)).toHaveLength(1);
    });

    it("Cockpit's Claude calls is not a tab until its page exists", async () => {
      // The job list below names the import of those calls; only a tab would be the page.
      expect(topBar(await theBarePage()).tabs.map((t) => t.label)).not.toContainEqual(expect.stringContaining('Claude calls'));
    });
  });

  describe('the groupings are tabs on the band, the chosen one selected, and choosing one keeps the filters', () => {
    it('the bare address has Over time selected', async () => {
      expect(groupTabs(await theBarePage()).find((t) => t.current)?.label).toBe('Over time');
    });

    it('a grouping with a model chosen has that grouping selected and every tab keeping the model', async () => {
      const tabs = groupTabs(await theBarePage('?group=pr&model=claude-sonnet-5'));

      expect(tabs.find((t) => t.current)?.label).toBe('Pull request');
      expect(tabs).toHaveLength(5);
      expect(tabs.every((t) => t.href.includes('model=claude-sonnet-5'))).toBe(true);
    });

    it("a pull request's page has the band without groupings", async () => {
      const html = await (await thePullRequest(7)).text();

      expect(html).toContain('<div class="band"></div>');
      expect(groupTabs(html)).toEqual([]);
    });
  });

  describe('a control shows what it holds', () => {
    it.each([
      { situation: 'no filters set', query: '?group=pr', held: [], pressed: ['Phase'] },
      { situation: 'a model chosen', query: '?group=pr&model=claude-sonnet-5', held: ['model'], pressed: ['Phase'] },
      { situation: 'a period other than the last 30 days', query: '?group=pr&period=7d', held: ['period'], pressed: ['Phase'] },
      { situation: 'the requests narrowed to subagents', query: '?group=pr&who=subagents', held: ['who'], pressed: ['Phase'] },
      { situation: 'an engineer and a category chosen', query: '?group=pr&engineer=alice&category=building', held: ['engineer', 'category'], pressed: ['Phase'] },
      { situation: 'split by Model', query: '?group=pr&split=model', held: [], pressed: ['Model'] },
    ])('on the costs page, $situation: filters holding a value $held, toggles pressed $pressed', async ({ query, held, pressed }) => {
      expect(controls(await theBarePage(query))).toEqual({ held, pressed });
    });

    it.each([
      { situation: 'no filters set', query: '', held: [] },
      { situation: 'a model and a category chosen', query: '?model=claude-sonnet-5&category=building', held: ['category', 'model'] },
    ])("on a pull request's page, $situation: filters holding a value $held", async ({ query, held }) => {
      expect(controls(await (await thePullRequest(7, query)).text()).held).toEqual(held);
    });
  });

  describe('the font comes from the Monitor and is kept', () => {
    const fontOf = (html: string) => /<link rel="preload" href="([^"]*)" as="font"/.exec(html)![1]!;

    it.each([
      { situation: 'the costs page', page: () => theBarePage() },
      { situation: "a pull request's page", page: async () => (await thePullRequest(7)).text() },
    ])('the font $situation names is served by the Monitor as a font, cached for good', async ({ page }) => {
      // The platform answers a font's address from the Monitor's own files before the Worker runs, so the test asks that store.
      const font = await env.ASSETS.fetch(`https://monitor.test${fontOf(await page())}`);

      expect(font.status).toBe(200);
      expect(font.headers.get('content-type')).toMatch(/^(font\/woff2|application\/font-woff2)/);
      expect(font.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    });

    it.each([
      { situation: 'the costs page', page: () => theBarePage() },
      { situation: "a pull request's page", page: async () => (await thePullRequest(7)).text() },
    ])('$situation loads nothing from an outside host', async ({ page }) => {
      const html = await page();
      const loaded = [...html.matchAll(/(?:<link [^>]*href|<script [^>]*src|<img [^>]*src)="([^"]*)"|url\(([^)]*)\)|@import\s+([^;]*)/g)].map((m) => (m[1] ?? m[2] ?? m[3]!).replace(/^["']/, ''));

      expect(loaded.length).toBeGreaterThan(0);
      expect(loaded.filter((address) => !address.startsWith('/') && !address.startsWith('data:'))).toEqual([]);
    });
  });
});
