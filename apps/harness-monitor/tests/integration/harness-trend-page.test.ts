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

/** A chart's panel, band and chart together, by its id. */
const panelOf = (html: string, id: string) => new RegExp(`<section class="panel" aria-labelledby="${id}">(.*?)</section>`, 's').exec(html)?.[1] ?? '';
const bandOf = (panel: string) => panel.slice(0, panel.indexOf('<div class="well pad">'));
const wordsOf = (panel: string) => /<span class="trend-words">(.*?)<\/span>/.exec(panel)?.[1] ?? null;
/** What pointing at each trend line reads, one per line drawn. */
const trendTitles = (panel: string) => [...panel.matchAll(/<line [^>]*data-trend[^>]*><title>(.*?)<\/title>/g)].map((m) => m[1]!);
const explanationOf = (html: string, id: string) => new RegExp(`<div id="x-${id}" popover="manual" class="explain-pop">.*?</div>`, 's').exec(html)?.[0] ?? '';
const IDS = ['starting-context', 'pull-request-size', 'cost-per-line'];

/** One session and one merged pull request a day from 3 Oct 2026: `dollars` of building, `lines` changed and `later` dollars of after-push work. */
async function dailyWork(days: { dollars: number; lines: number; later?: number }[]) {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-14T12:00:00Z') });
  for (const [i, d] of days.entries()) {
    const day = `2026-10-${String(3 + i).padStart(2, '0')}`;
    const rows = [spend(`s${i}`, d.dollars, { time: `${day}T10:00:00Z`, branch: `b/${i + 1}`, sessionId: `s${i}` })];
    if (d.later) rows.push(spend(`l${i}`, d.later, { time: `${day}T11:00:00Z`, branch: `b/${i + 1}`, sessionId: `s${i}`, category: 'after-push' }));
    await send(rows);
    await merged(i + 1, `${day}T12:00:00Z`, d.lines);
  }
}
const rising = Array.from({ length: 6 }, (_, i) => ({ dollars: 2 + i, lines: 1000, later: 1 }));

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

  describe('Cost per 1,000 lines changed switches between the total alone and a line per phase', () => {
    beforeEach(async () => {
      await send([spend('a', 2, { time: '2026-10-06T11:00:00Z', branch: 'b/1' })]);
      await merged(1, '2026-10-07T10:00:00Z', 1_000);
      // A second week, so each line is a drawn segment rather than a lone dot.
      await send([spend('b', 3, { time: '2026-10-13T11:00:00Z', branch: 'b/2' })]);
      await merged(2, '2026-10-14T10:00:00Z', 1_000);
    });

    const section = (html: string, id: string) => new RegExp(`<section class="panel" aria-labelledby="${id}">(.*?)</section>`, 's').exec(html)![1]!;
    const lines = (html: string, id: string) => [...section(html, id).matchAll(/<g data-line="([^"]*)">(.*?)<\/g>/gs)].map(([, key, body]) => ({ key: key!, dashed: body!.includes('stroke-dasharray') }));
    const switchOf = (html: string) => /<span class="lines-switch"[^>]*>(.*?)<\/span>/s.exec(html)?.[1];
    const links = (html: string) => [...switchOf(html)!.matchAll(/<a href="([^"]*)"( aria-current="true")?>([^<]*)<\/a>/g)].map(([, href, current, text]) => ({ text, href, current: current !== undefined }));

    it('Total draws the All phases line alone, solid, with no legend', async () => {
      const html = await theTrendPage('?period=all&lines=total');

      expect(lines(html, 'cost-per-line')).toEqual([{ key: 'total', dashed: false }]);
      expect(section(html, 'cost-per-line')).toContain('<polyline');
      expect(section(html, 'cost-per-line')).not.toContain('class="legend"');
    });

    it('By phase, by default, draws the dashed total beside each phase line', async () => {
      const drawn = lines(await theTrendPage('?period=all'), 'cost-per-line');

      expect(drawn.map((l) => l.key)).toEqual(expect.arrayContaining(['total', 'building']));
      expect(drawn.filter((l) => l.dashed).map((l) => l.key)).toEqual(['total']);
    });

    it('Total leaves Starting context and Pull request size as they were', async () => {
      const plain = await theTrendPage('?period=all');
      const total = await theTrendPage('?period=all&lines=total');

      for (const id of ['starting-context', 'pull-request-size']) expect(section(total, id)).toBe(section(plain, id));
    });

    it('an unknown lines value draws by phase, as an unknown filter value falls back', async () => {
      const html = await theTrendPage('?period=all&lines=everything');

      expect(lines(html, 'cost-per-line').length).toBeGreaterThan(1);
      expect(links(html).find((l) => l.current)!.text).toBe('By phase');
    });

    it('the switch marks the current view', async () => {
      expect(links(await theTrendPage('?period=all')).map((l) => [l.text, l.current])).toEqual([['Total', false], ['By phase', true]]);
      expect(links(await theTrendPage('?period=all&lines=total')).map((l) => [l.text, l.current])).toEqual([['Total', true], ['By phase', false]]);
    });

    it('the Total link keeps the period and every filter and adds lines; the By phase link keeps them and drops it', async () => {
      const html = await theTrendPage('?period=90d&engineer=alice&model=claude-opus-4-8&who=main&lines=total');
      const [total, byPhase] = links(html);

      expect(new URL(total!.href!, 'https://monitor.test').searchParams.toString()).toBe('period=90d&engineer=alice&model=claude-opus-4-8&who=main&lines=total');
      expect(new URL(byPhase!.href!, 'https://monitor.test').searchParams.toString()).toBe('period=90d&engineer=alice&model=claude-opus-4-8&who=main');
    });

    it('the Total link on the default period is just lines=total', async () => {
      expect(links(await theTrendPage()).map((l) => l.href)).toEqual(['/harness-trend?lines=total', '/harness-trend']);
    });

    it('changing the period or a filter while on Total keeps Total, and by phase carries nothing extra', async () => {
      const total = await theTrendPage('?lines=total');
      const plain = await theTrendPage();

      expect(/<form class="sentence-form".*?<\/form>/s.exec(total)![0]).toContain('<input type="hidden" name="lines" value="total">');
      expect(/<form class="sentence-form".*?<\/form>/s.exec(plain)![0]).not.toContain('name="lines"');
    });

    it('with one phase chosen there is no switch, even with lines=total in the address, and the chart is drawn as ever', async () => {
      const html = await theTrendPage('?period=all&category=building&lines=total');

      expect(switchOf(html)).toBeUndefined();
      expect(lines(html, 'cost-per-line').map((l) => l.key)).toContain('building');
    });

    it('its explanation names Total and By phase', async () => {
      const explanation = /<div id="x-cost-per-line" popover="manual" class="explain-pop">.*?<\/div>/s.exec(await theTrendPage())![0];

      expect(explanation).toContain('Total');
      expect(explanation).toContain('By phase');
    });
  });

  describe('Harness trend draws its three charts as three panels, each with its title and explanation on its own band', () => {
    it('with data, they are Starting context, Pull request size and Cost per 1,000 lines changed, in that order', async () => {
      await dailyWork(rising);

      const html = await theTrendPage();

      expect([...html.matchAll(/<section class="panel" aria-labelledby="([^"]*)"/g)].map((m) => m[1])).toEqual(IDS);
      expect(IDS.map((id) => new RegExp(`<h2 id="${id}">(.*?)</h2>`).exec(bandOf(panelOf(html, id)))?.[1])).toEqual(['Starting context', 'Pull request size', 'Cost per 1,000 lines changed']);
    });

    it.each(IDS)('the band of %s opens that chart’s explanation', async (id) => {
      await dailyWork(rising);

      const band = bandOf(panelOf(await theTrendPage(), id));

      expect(/<button [^>]*data-pop="x-([^"]*)"/.exec(band)?.[1]).toBe(id);
    });

    it('no band asks the question, though the opening text still does', async () => {
      await dailyWork(rising);

      const html = await theTrendPage();

      expect([...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1])).not.toContain(QUESTION);
      expect(/<div class="lead">(.*?)<\/div>/s.exec(html)![1]).toContain(QUESTION);
    });

    it('a period with nothing to chart still has the three panels, each saying so, with no words and no line', async () => {
      const html = await theTrendPage();

      for (const id of IDS) {
        const panel = panelOf(html, id);
        expect(panel).toContain('Nothing to chart in this period.');
        expect(wordsOf(panel)).toBeNull();
        expect(trendTitles(panel)).toEqual([]);
      }
    });
  });

  describe('each chart draws its trend line and its band’s words from its own values', () => {
    it('Starting context and Pull request size draw one trend line through their one line, with words on each band', async () => {
      await dailyWork(rising);

      const html = await theTrendPage();

      expect(trendTitles(panelOf(html, 'starting-context'))).toEqual(['Trend · 1,000,000 tokens to 3,500,000 tokens']);
      expect(wordsOf(bandOf(panelOf(html, 'starting-context')))).toBe('Trending up 250% over the last 30 days');
      expect(trendTitles(panelOf(html, 'pull-request-size'))).toEqual(['Trend · 1,000 lines to 1,000 lines']);
      expect(wordsOf(bandOf(panelOf(html, 'pull-request-size')))).toBe('Flat over the last 30 days');
    });

    it('a shrinking pull request reads as trending down', async () => {
      await dailyWork(Array.from({ length: 6 }, (_, i) => ({ dollars: 2, lines: 1000 - 100 * i })));

      const html = await theTrendPage();

      expect(wordsOf(bandOf(panelOf(html, 'pull-request-size')))).toBe('Trending down 50% over the last 30 days');
    });

    it('Cost per 1,000 lines changed on Total fits the All phases line', async () => {
      await dailyWork(rising);

      const panel = panelOf(await theTrendPage('?lines=total'), 'cost-per-line');

      expect(trendTitles(panel)).toEqual(['Trend · $3.00 to $8.00']);
      expect(wordsOf(bandOf(panel))).toBe('Trending up 167% over the last 30 days');
    });

    it('Cost per 1,000 lines changed on By phase draws exactly one trend line, on the All phases line, though phase lines are drawn', async () => {
      await dailyWork(rising);

      const panel = panelOf(await theTrendPage(), 'cost-per-line');

      expect(panel).toContain('data-line="building"');
      expect(trendTitles(panel)).toEqual(['Trend · $3.00 to $8.00']);
    });

    it('with one phase filtered the fit is on that phase’s line', async () => {
      await dailyWork(rising);

      const panel = panelOf(await theTrendPage('?category=building'), 'cost-per-line');

      expect(trendTitles(panel)).toEqual(['Trend · $2.00 to $7.00']);
      expect(wordsOf(bandOf(panel))).toBe('Trending up 250% over the last 30 days');
    });

    it('a chart with one point in the period is drawn as ever, with no trend line and no words, and the other panels are unaffected', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-14T12:00:00Z') });
      // Only the first session starts inside the period, so Starting context has one point; both pull requests merge inside it.
      await send([spend('in', 2, { time: '2026-10-05T10:00:00Z', branch: 'b/1', sessionId: 'in' }), spend('before', 2, { time: '2026-08-01T10:00:00Z', branch: 'b/2', sessionId: 'before' })]);
      await merged(1, '2026-10-05T12:00:00Z', 1_000);
      await merged(2, '2026-10-08T12:00:00Z', 2_000);

      const html = await theTrendPage();

      expect(panelOf(html, 'starting-context')).toContain('<circle');
      expect(trendTitles(panelOf(html, 'starting-context'))).toEqual([]);
      expect(wordsOf(panelOf(html, 'starting-context'))).toBeNull();
      expect(trendTitles(panelOf(html, 'pull-request-size'))).toEqual(['Trend · 1,000 lines to 2,000 lines']);
      expect(wordsOf(panelOf(html, 'pull-request-size'))).toBe('Trending up 100% over the last 30 days');
    });

    it('over the last 90 days the fit has one point per week and the words say so', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-14T12:00:00Z') });
      for (const [i, day] of ['2026-09-29', '2026-10-06', '2026-10-13'].entries()) {
        await send([spend(`w${i}`, 2 * (i + 1), { time: `${day}T10:00:00Z`, branch: `b/${i + 1}`, sessionId: `w${i}` })]);
        await merged(i + 1, `${day}T12:00:00Z`, 1_000);
      }

      const panel = panelOf(await theTrendPage('?period=90d&lines=total'), 'cost-per-line');

      expect(trendTitles(panel)).toEqual(['Trend · $2.00 to $6.00']);
      expect(wordsOf(bandOf(panel))).toBe('Trending up 200% over the last 90 days');
    });

    it('a fit that ends below zero is clipped to the chart’s plot area', async () => {
      await dailyWork([1000, 850, 700, 550, 400, 250, 100, 100, 100, 100].map((lines) => ({ dollars: 2, lines })));

      const panel = panelOf(await theTrendPage(), 'pull-request-size');
      const line = /<line clip-path="url\(#([^)]*)\)"[^>]*y2="([^"]*)"[^>]*data-trend/.exec(panel)!;

      // The line runs past the bottom of the plot area (248 of 280), and the clip it is drawn through stops there.
      expect(Number(line[2])).toBeGreaterThan(248);
      expect(new RegExp(`<clipPath id="${line[1]}"><rect [^>]*y="16" [^>]*height="232"`).test(panel)).toBe(true);
    });

    it('a fit that starts at zero draws no trend line and no words, the chart drawn as ever', async () => {
      // A straight rise from 0 at 300 a day, the first point 1 off it: the fit starts at exactly 0.
      await dailyWork([1, 300, 600, 900, 1200].map((lines) => ({ dollars: 2, lines })));

      const panel = panelOf(await theTrendPage(), 'pull-request-size');

      expect(panel).toContain('data-line="pull-request-size"');
      expect(panel).not.toContain('data-trend');
      expect(panel).not.toContain('class="trend-words"');
    });
  });

  describe('the Total / By phase switch sits on Cost per 1,000 lines changed’s band, after its words', () => {
    beforeEach(() => dailyWork(rising));

    it('with no phase filtered, the switch is on that panel’s band after the words, the current view marked', async () => {
      const band = bandOf(panelOf(await theTrendPage(), 'cost-per-line'));

      expect(band.indexOf('class="trend-words"')).toBeGreaterThan(-1);
      expect(band.indexOf('class="lines-switch"')).toBeGreaterThan(band.indexOf('class="trend-words"'));
      expect(band).toContain('<a href="/harness-trend" aria-current="true">By phase</a>');
    });

    it('with one phase filtered there is no switch, and the words are still shown', async () => {
      const band = bandOf(panelOf(await theTrendPage('?category=after-push'), 'cost-per-line'));

      expect(band).not.toContain('lines-switch');
      expect(wordsOf(band)).toBe('Flat over the last 30 days');
    });
  });

  describe('each chart’s explanation says how its trend line is fitted', () => {
    it.each(IDS)('%s says the line is straight, not tilted by a single spike, and that the words are its change over the period', async (id) => {
      const explanation = explanationOf(await theTrendPage(), id);

      expect(explanation).toContain('straight');
      expect(explanation).toContain('a single spike does not tilt it');
      expect(explanation).toContain('its change over the period');
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

    it('By phase then Total for the same period and filters is not answered from the first entry', async () => {
      await send([spend('a', 1, { time: '2026-10-13T10:00:00Z', branch: 'b/1' })]);
      await merged(1, '2026-10-13T12:00:00Z', 500);
      const cached = { PAGE_CACHE_SECONDS: '300' };
      const byPhase = await (await viewWith('?period=90d', cached)).text();

      const total = await (await viewWith('?period=90d&lines=total', cached)).text();

      expect(byPhase).toContain('data-line="building"');
      expect(total).not.toContain('data-line="building"');
      expect(await (await viewWith('?period=90d&lines=total&junk=1', cached)).text()).toBe(total);
    });
  });
});
