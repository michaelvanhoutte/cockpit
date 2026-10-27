import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { theCallsPage } from './cockpit-support';
import { emptyTheDatabase, send, spend, theBarePage, theSentence, thePullRequest, withPrices } from './support';

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
    tabs: [...(/<nav class="pages"[^>]*>(.*?)<\/nav>/s.exec(bar)?.[1] ?? '').matchAll(/<a href="[^"]*"(?: title="[^"]*")?( aria-current="page")?>([^<]*)<\/a>/g)].map((m) => ({ label: m[2]!.replace(/&rsquo;/g, "'"), current: m[1] !== undefined })),
  };
}

/** The top bar's appearance select as a visitor receives it: where it sits and each option with whether the page selected it. */
function appearanceChoice(html: string) {
  const bar = /<header class="topbar">(.*?)<\/header>/s.exec(html)![1]!;
  const select = /<select id="appearance"[^>]*>(.*?)<\/select>/s.exec(bar);
  return {
    afterTheStatus: bar.indexOf('class="status"') !== -1 && bar.indexOf('class="status"') < bar.indexOf('id="appearance"'),
    options: [...(select?.[1] ?? '').matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => ({ value: m[1], text: m[3], selected: m[2] !== undefined })),
  };
}

/** A page at its address, asked for the way a browser asks, with whatever else the request carries. */
const theMonitorAt = async (address: string, init: RequestInit = {}) => (await SELF.fetch(`https://monitor.test${address}`, init)).text();

/** The filters that hold a value (wear the accent border) on a pull request's page. */
const held = (html: string) => [...html.matchAll(/<select id="(\w+)"[^>]*? data-set>/g)].map((m) => m[1]!);

describe('Harness Monitor', () => {
  describe('every page opens under the same top bar, its own tab selected', () => {
    it.each([
      { situation: 'the costs page', page: () => theBarePage('?period=all'), current: 'Claude Code costs' },
      { situation: "a pull request's page", page: async () => (await thePullRequest(7)).text(), current: 'Claude Code costs' },
      { situation: 'the page for a pull request nothing knows', page: async () => (await thePullRequest(999)).text(), current: 'Claude Code costs' },
      { situation: "Cockpit's Claude calls", page: () => theCallsPage(), current: "Cockpit's Claude calls" },
    ])('$situation shows the mark, the name and every tab, its own selected', async ({ page, current }) => {
      expect(topBar(await page())).toEqual({
        mark: true,
        name: true,
        tabs: [
          { label: 'Claude Code costs', current: current === 'Claude Code costs' },
          { label: "Cockpit's Claude calls", current: current === "Cockpit's Claude calls" },
          { label: 'Cycle time', current: false },
          { label: 'Test selection', current: false },
          { label: 'Test coverage', current: false },
          { label: 'CI stability', current: false },
        ],
      });
    });

    it.each([
      { situation: 'the costs page', page: () => theBarePage() },
      { situation: "a pull request's page", page: async () => (await thePullRequest(7)).text() },
      { situation: 'the page for a pull request nothing knows', page: async () => (await thePullRequest(999)).text() },
      { situation: "Cockpit's Claude calls", page: () => theCallsPage() },
    ])('$situation has exactly one top-level heading', async ({ page }) => {
      expect((await page()).match(/<h1\b/g)).toHaveLength(1);
    });

    it("the tabs lead to the costs page, Cockpit's Claude calls, cycle time, test selection, test coverage and CI stability", async () => {
      const bar = /<nav class="pages"[^>]*>(.*?)<\/nav>/s.exec(await theBarePage())![1]!;

      expect([...bar.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/', '/claude-calls', '/cycle-time', '/selection', '/tests', '/stability']);
    });
  });

  describe('every viewer is sent the same page, and every page offers the choice', () => {
    it.each([
      { situation: 'the costs page', page: () => theMonitorAt('/') },
      { situation: "a pull request's page", page: () => theMonitorAt('/pr/7') },
      { situation: "Cockpit's Claude calls", page: () => theMonitorAt('/claude-calls') },
      { situation: 'Cycle time', page: () => theMonitorAt('/cycle-time') },
      { situation: 'Test selection', page: () => theMonitorAt('/selection') },
      { situation: 'Test coverage', page: () => theMonitorAt('/tests') },
      { situation: 'CI stability', page: () => theMonitorAt('/stability') },
    ])('$situation offers Match device, Light and Dark in the top bar after the status, with no option selected by the page', async ({ page }) => {
      expect(appearanceChoice(await page())).toEqual({
        afterTheStatus: true,
        options: [
          { value: '', text: 'Match device', selected: false },
          { value: 'light', text: 'Light', selected: false },
          { value: 'dark', text: 'Dark', selected: false },
        ],
      });
    });

    it.each([
      { situation: 'a cookie naming Light', address: '/', init: { headers: { cookie: 'appearance=light; monitor.appearance=light' } } },
      { situation: 'an address naming Light', address: '/?appearance=light&monitor.appearance=light', init: {} },
    ])('a request carrying $situation gets the costs page byte for byte as one carrying neither', async ({ address, init }) => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-23T12:00:00Z') });

      expect(await theMonitorAt(address, init)).toBe(await theMonitorAt('/'));
    });

    it('the choice is applied before the page’s styles, in the head', async () => {
      const html = await theMonitorAt('/');
      const head = /<head>(.*?)<\/head>/s.exec(html)![1]!;

      expect(head.indexOf('monitor.appearance')).toBeGreaterThan(-1);
      expect(head.indexOf('monitor.appearance')).toBeLessThan(head.indexOf('<style>'));
      expect(head.indexOf('<script>')).toBeLessThan(head.indexOf('<style>'));
    });
  });

  describe("the costs page's band carries its controls, and a pull request's page keeps a bare band", () => {
    it('the costs page has the sentence on the band, pinned to the top as the page scrolls', async () => {
      const html = await theBarePage();

      expect(html).toMatch(/<div class="band band-controls"><form class="sentence-form"/);
      expect(theSentence(html).pinned).toBe(true);
      expect(html).not.toContain('class="band-tabs"');
    });

    it("a pull request's page has the band without controls", async () => {
      const html = await (await thePullRequest(7)).text();

      expect(html).toContain('<div class="band"></div>');
      expect(html).not.toContain('class="sentence"');
    });
  });

  describe('a control shows what it holds', () => {
    it.each([
      { situation: 'no filters set', query: '?group=pr', held: [] },
      { situation: 'a model chosen', query: '?group=pr&model=claude-sonnet-5', held: ['model'] },
      { situation: 'the requests narrowed to subagents', query: '?group=pr&who=subagents', held: ['who'] },
      { situation: 'an engineer and a phase chosen', query: '?group=pr&engineer=alice&category=building', held: ['engineer', 'category'] },
      { situation: 'a period other than the last 30 days, a colouring and rows of the sentence, which hold no value', query: '?group=pr&period=7d&split=model', held: [] },
    ])('on the costs page, $situation: filters holding a value $held', async ({ query, held }) => {
      const choices = theSentence(await theBarePage(query)).choices;

      expect(Object.keys(choices).filter((name) => choices[name]!.held)).toEqual(held);
    });

    it.each([
      { situation: 'no filters set', query: '', expected: [] },
      { situation: 'a model and a category chosen', query: '?model=claude-sonnet-5&category=building', expected: ['category', 'model'] },
    ])("on a pull request's page, $situation: filters holding a value $expected", async ({ query, expected }) => {
      expect(held(await (await thePullRequest(7, query)).text())).toEqual(expected);
    });
  });

  describe('the font comes from the Monitor and is kept', () => {
    const fontOf = (html: string) => /<link rel="preload" href="([^"]*)" as="font"/.exec(html)![1]!;

    it.each([
      { situation: 'the costs page', page: () => theBarePage() },
      { situation: "a pull request's page", page: async () => (await thePullRequest(7)).text() },
      { situation: "Cockpit's Claude calls", page: () => theCallsPage() },
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
      { situation: "Cockpit's Claude calls", page: () => theCallsPage() },
    ])('$situation loads nothing from an outside host', async ({ page }) => {
      const html = await page();
      const loaded = [...html.matchAll(/(?:<link [^>]*href|<script [^>]*src|<img [^>]*src)="([^"]*)"|url\(([^)]*)\)|@import\s+([^;]*)/g)].map((m) => (m[1] ?? m[2] ?? m[3]!).replace(/^["']/, ''));

      expect(loaded.length).toBeGreaterThan(0);
      expect(loaded.filter((address) => !address.startsWith('/') && !address.startsWith('data:'))).toEqual([]);
    });
  });
});
