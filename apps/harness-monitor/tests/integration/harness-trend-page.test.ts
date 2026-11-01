import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { emptyTheDatabase, merged, send, spend, theBarePage, theSentence, theTrendPage, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => vi.useRealTimers());

const QUESTION = 'Is the harness getting more expensive?';
const nav = (html: string) => /<nav class="pages"[^>]*>(.*?)<\/nav>/s.exec(html)![1]!;

async function viewWith(query: string, over: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://monitor.test/harness-trend${query}`), { ...env, ...over }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('Harness Monitor', () => {
  describe('Harness trend is a tab like the others', () => {
    it('comes right after Claude Code costs in any page’s top bar, named by its question on pointing', async () => {
      const labels = [...nav(await theBarePage()).matchAll(/<a href="([^"]*)" title="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[3], m[1], m[2]]);

      expect(labels.slice(0, 2)).toEqual([
        ['Claude Code costs', '/', 'What does building this app with Claude Code cost, and where does the money go?'],
        ['Harness trend', '/harness-trend', QUESTION],
      ]);
    });

    it('on its own page its tab is the current one and the page opens with its question', async () => {
      const html = await theTrendPage();

      expect(nav(html)).toMatch(/<a href="\/harness-trend" title="[^"]*" aria-current="page">Harness trend<\/a>/);
      expect(/<div class="lead">(.*?)<\/div>/s.exec(html)![1]).toContain(QUESTION);
    });
  });

  describe('Claude Code costs no longer carries the charts, on any grouping', () => {
    beforeEach(() => send([spend('a', 2, { branch: 'b/1' })]));

    it.each([[''], ['?group=day&period=all'], ['?group=pr'], ['?group=pr&period=all']])('at %s there is no trends panel and no link to one', async (query) => {
      const html = await theBarePage(query);

      expect(html.replace(nav(html), '')).not.toContain(QUESTION);
      expect(html).not.toContain('id="trends"');
      for (const id of ['starting-context', 'pull-request-size', 'cost-per-line']) expect(html).not.toContain(`aria-labelledby="${id}"`);
      expect(html.replace(nav(html), '')).not.toContain('/harness-trend');
    });
  });

  describe("Harness trend's sentence offers the period and the “Only” filters, nothing else", () => {
    it('the band offers the four periods and the engineer, phase, model and requests filters', async () => {
      const { text, choices } = theSentence(await theTrendPage());

      expect(text).toBe('Show the trend over [the last 30 days]');
      expect(Object.keys(choices)).toEqual(['period', 'engineer', 'category', 'model', 'who']);
      expect(choices.period!.offered).toEqual(['the last 7 days', 'the last 30 days', 'the last 90 days', 'all time']);
    });

    it('an address carrying a costs-page row, colouring, day or page is ignored', async () => {
      const html = await theTrendPage('?period=7d&group=pr&split=model&day=2026-10-05&sort=total&page=3');
      const { text, choices } = theSentence(html);

      expect(text).toBe('Show the trend over [the last 7 days]');
      expect(Object.keys(choices)).not.toContain('group');
      const shown = html.replace(/<style>.*?<\/style>/s, '');
      expect(shown).not.toContain('Pick a day');
      expect(shown).not.toContain('coloured by');
      expect(shown).not.toContain('Export CSV');
    });

    it('a group of engineer does not drop the engineer filter, as it would on the costs page', async () => {
      const { choices } = theSentence(await theTrendPage('?group=engineer&engineer=alice'));

      expect(choices.engineer!.chosen).toBe('alice');
    });

    it('an unknown period or filter value falls back to the default', async () => {
      const { text, choices } = theSentence(await theTrendPage('?period=forever&who=nobody&category=nonsense'));

      expect(text).toBe('Show the trend over [the last 30 days]');
      expect([choices.who!.chosen, choices.category!.chosen]).toEqual(['All requests', 'All phases']);
    });
  });

  describe('each Harness trend address is cached at the edge as the other pages are', () => {
    it('the same address twice within the cache time is answered from the cache, whatever was reported since; spellings share one entry', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-14T12:00:00Z') });
      await send([spend('first', 1, { time: '2026-10-13T10:00:00Z', branch: 'b/1' })]);
      await merged(1, '2026-10-13T12:00:00Z', 500);
      const cached = { PAGE_CACHE_SECONDS: '300' };
      const first = await viewWith('?period=30d', cached);
      const before = await first.text();
      await send([spend('second', 1, { time: '2026-10-13T11:00:00Z', branch: 'b/2' })]);
      await merged(2, '2026-10-13T12:00:00Z', 9_000);

      const again = await viewWith('?period=30d&junk=1&group=pr', cached);

      expect(first.headers.get('cache-control')).toBe('public, max-age=300');
      expect(await again.text()).toBe(before);
      expect(await (await viewWith('?period=30d')).text()).not.toBe(before);
    });
  });
});
