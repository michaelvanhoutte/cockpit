import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLike, giveTheWorkerTheReadToken, importTheCalls, theCallsPage, withoutExplanations } from './cockpit-support';
import { linked, pullRequest } from './github-support';
import { panelOf } from './series-colours';
import { emptyTheDatabase, send, spend, theBarePage, thePullRequest, usage, withPrices } from './support';

const text = (html: string) => html.replace(/<style>.*?<\/style>/s, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
/** The explanation an (i) opens, by its id; '' where the page draws none. */
const explanationOf = (html: string, id: string) => new RegExp(`<div id="x-${id}" popover="manual" class="explain-pop">.*?</div>`, 's').exec(html)?.[0] ?? '';
/** The parts of an explanation, by the name of each; null where the page draws none by that id. */
const partsOf = (html: string, id: string) => {
  const panel = explanationOf(html, id);
  return panel ? [...panel.matchAll(/<dt>(.*?)<\/dt>/g)].map((m) => m[1]) : null;
};
const THREE_PARTS = ['What it shows', 'How to read it', 'What to look for'];
/** A table's panel, by the name it is read out as. */
const tableOf = (html: string, name: string) => new RegExp(`<section class="panel" aria-label="${name}">.*?</section>`, 's').exec(html)?.[0] ?? '';
/** The (i) a panel carries first, beside its heading: the id of the explanation it opens, null where it has none. */
const firstInfo = (panel: string) => /<button [^>]*data-pop="x-([^"]*)"/.exec(panel)?.[1] ?? null;
/** Every (i) on the page by the explanation it opens, and every explanation drawn. */
const infosOf = (html: string) => ({
  buttons: [...html.matchAll(/<button [^>]*data-pop="(x-[^"]*)"/g)].map((m) => m[1]),
  panels: [...html.matchAll(/<div id="(x-[^"]*)" popover="manual"/g)].map((m) => m[1]),
});
/** A tile as drawn, up to the next one, found by what its label reads. */
const tileOf = (html: string, label: string) =>
  html
    .split('<div class="tile')
    .slice(1)
    .find((tile) => text(/class="tile-label">(.*?)<span class="tile-value"/s.exec(tile)?.[1] ?? '').trim().startsWith(label)) ?? '';
const leadOf = (html: string) => text(/<div class="lead">(.*?)<\/div>/s.exec(html)?.[1] ?? '');
/** Where the lead sits: after the band's sentence, if the page has one, and before the first panel. */
const leadPlace = (html: string) => ({
  afterTheSentence: html.indexOf('class="lead"') > html.indexOf('</form>', html.indexOf('class="sentence-form"')),
  beforeThePanels: html.indexOf('class="lead"') < html.indexOf('<section'),
});

/** Claude Code requests on 1 Oct 2026, seen on 5 Oct; with `pullRequest`, its branch is pull request 471's. */
async function costs(rows: unknown[] = [], pullRequest471 = false) {
  await emptyTheDatabase();
  await withPrices();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
  if (rows.length) await send(rows);
  if (pullRequest471) await linked(pullRequest({ number: 471, headRefName: 'claude/build-1' }));
}

/** Cockpit's calls as on 23 Oct 2026: one priced and one unpriced this period, one in the period before. */
async function calls() {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-23T12:00:00Z') });
  await emptyTheDatabase();
  const putBack = giveTheWorkerTheReadToken();
  await importTheCalls([
    callLike({ id: 1, at: '2026-10-21T08:15:00Z', costUsd: 3 }),
    callLike({ id: 2, at: '2026-10-22T09:00:00Z', feature: 'choose-a-panel', costUsd: null }),
    callLike({ id: 3, at: '2026-09-20T10:00:00Z', costUsd: 1 }),
  ]);
  return putBack;
}

let putBack: (() => void) | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  putBack?.();
  putBack = null;
});

describe('Harness Monitor', () => {
  describe('every chart, panel and table of Claude Code costs explains itself behind an (i) beside its heading', () => {
    beforeEach(() => costs([spend('a', 2, { category: 'building' }), spend('b', 1, { category: 'after-push' })], true));

    it.each([
      { panel: 'Where the period’s cost went', id: 'where' },
      { panel: 'Cost per day', id: 'perday' },
      { panel: 'Tokens per day', id: 'tokensperday' },
      { panel: 'Is the harness getting more expensive?', id: 'trends' },
      { panel: 'Starting context', id: 'starting-context' },
      { panel: 'Pull request size', id: 'pull-request-size' },
      { panel: 'Cost per 1,000 lines changed', id: 'cost-per-line' },
    ])('for each day, $panel carries its own (i), whose explanation says what it shows, how to read it and what to look for', async ({ id }) => {
      const html = await theBarePage();

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { rows: 'each day', query: '', name: 'Cost by day', id: 't-day' },
      { rows: 'each pull request', query: '?group=pr', name: 'Cost by pull request', id: 't-pr' },
    ])('for $rows, the table carries an (i) saying what it shows', async ({ query, name, id }) => {
      const html = await theBarePage(query);

      expect(firstInfo(tableOf(html, name))).toBe(id);
      expect(partsOf(html, id)).toEqual(['What it shows']);
    });

    it('draws each (i) once, each to an explanation of its own on the page', async () => {
      const { buttons, panels } = infosOf(await theBarePage());

      // Where it went, the two per-day charts, the table, the trends panel and its three charts.
      expect(buttons).toHaveLength(8);
      expect(new Set(buttons).size).toBe(8);
      expect(panels.sort()).toEqual([...buttons].sort());
    });

    it('a period with nothing in it keeps the (i) on every panel it still draws', async () => {
      await emptyTheDatabase();

      const html = await theBarePage();

      expect(html).toContain('Nothing in this period');
      expect(firstInfo(panelOf(html, 'where'))).toBe('where');
      expect(firstInfo(/<section class="panel">.*?<\/section>/s.exec(html)![0])).toBe('t-day');
      for (const id of ['trends', 'starting-context', 'pull-request-size', 'cost-per-line']) expect(firstInfo(panelOf(html, id))).toBe(id);
    });
  });

  describe('a pull request’s page explains its panels', () => {
    beforeEach(() => costs([spend('a', 2, { category: 'building' })], true));

    it.each([
      { panel: 'By category', id: 'bycat', parts: THREE_PARTS },
      { panel: 'Sessions', id: 'sessions', parts: ['What it shows'] },
    ])('$panel carries an (i) saying what it shows', async ({ id, parts }) => {
      const html = await (await thePullRequest(471, '?period=all')).text();

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(parts);
    });
  });

  describe('every tile, panel and table of Cockpit’s Claude calls explains itself behind an (i) beside its heading or label', () => {
    beforeEach(async () => {
      putBack = await calls();
    });

    it.each([
      { tile: 'Spent', id: 't-spent' },
      { tile: 'Calls', id: 't-calls' },
      { tile: 'Against the previous period', id: 't-previous' },
    ])('the $tile tile carries its own (i), with the three parts', async ({ tile, id }) => {
      const html = await theCallsPage();

      expect(tileOf(html, tile)).toContain(`data-pop="x-${id}"`);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { panel: 'Where the cost went', id: 'where' },
      { panel: 'Largest changes', id: 'changes' },
      { panel: 'Cost per day', id: 'perday' },
    ])('over time, $panel carries its own (i), with the three parts', async ({ id }) => {
      const html = await theCallsPage();

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { tab: 'Over time', query: '', name: 'Calls by day', id: 't-day' },
      { tab: 'Feature', query: '?group=feature', name: 'Calls by feature', id: 't-feature' },
      { tab: 'Over time, with no call in the period', query: '?feature=resolve-a-place', name: 'Calls by day', id: 't-day' },
    ])('the $tab tab’s table carries an (i) saying what it shows', async ({ query, name, id }) => {
      const html = await theCallsPage(query);

      expect(firstInfo(tableOf(html, name))).toBe(id);
      expect(partsOf(html, id)).toEqual(['What it shows']);
    });

    it('draws each (i) once, each to an explanation of its own on the page', async () => {
      const { buttons, panels } = infosOf(await theCallsPage());

      // Three tiles, where it went, the changes, the chart and the table.
      expect(buttons).toHaveLength(7);
      expect(new Set(buttons).size).toBe(7);
      expect(panels.sort()).toEqual([...buttons].sort());
    });
  });

  describe('each cost page opens with its question and the words it defines', () => {
    it.each([[''], ['?group=pr'], ['?group=issue'], ['?group=engineer'], ['?group=category']])('Claude Code costs, under the band’s sentence, at %s', async (query) => {
      await costs([spend('a', 2)], true);

      const html = await theBarePage(query);

      expect(leadOf(html)).toContain('What does building this app with Claude Code cost, and where does the money go?');
      for (const words of ['list price', 'A phase is', 'Unphased is', 'The main session is', 'a subagent is']) expect(leadOf(html)).toContain(words);
      expect(leadPlace(html)).toEqual({ afterTheSentence: true, beforeThePanels: true });
    });

    it('a pull request’s page, reached from that tab, with the same lead before the pull request', async () => {
      await costs([spend('a', 2)], true);

      const html = await (await thePullRequest(471, '?period=all')).text();

      expect(leadOf(html)).toContain('What does building this app with Claude Code cost, and where does the money go?');
      expect(leadOf(html)).toContain('a subagent is');
      expect(html.indexOf('class="lead"')).toBeLessThan(html.indexOf('<h1>#471'));
      expect(leadPlace(html).beforeThePanels).toBe(true);
    });

    it.each([[''], ['?group=feature']])('Cockpit’s Claude calls, under the band’s sentence, at %s', async (query) => {
      putBack = await calls();

      const html = await theCallsPage(query);

      expect(leadOf(html)).toContain('What do the app s own AI features cost to run?');
      for (const words of ['not the Claude Code sessions that build it', 'An environment is', 'A starter is']) expect(leadOf(html)).toContain(words);
      expect(leadPlace(html)).toEqual({ afterTheSentence: true, beforeThePanels: true });
    });
  });

  describe('a fixed note on a cost page is said once, in its explanation; a note read from the figures stays', () => {
    it.each([
      { panel: 'Where the period’s cost went', id: 'where', gone: 'Claude Code Review runs on Anthropic', said: 'Claude Code Review runs on Anthropic' },
      { panel: 'Tokens per day', id: 'tokensperday', gone: 'tokens summed, priced or not', said: 'cache write and cache read tokens' },
      { panel: 'Starting context', id: 'starting-context', gone: 'Median tokens (input, cache write and cache read)', said: 'first main-agent request' },
      { panel: 'Pull request size', id: 'pull-request-size', gone: 'Median lines changed per merged pull request', said: 'lines added plus removed' },
      { panel: 'Cost per 1,000 lines changed', id: 'cost-per-line', gone: 'divided by thousands of lines', said: 'divided by thousands of lines' },
      { panel: 'Cost per 1,000 lines changed, its phase cut-off', id: 'cost-per-line', gone: 'A phase is not drawn before it was recorded', said: 'Phases were first recorded on 21 Sep 2026' },
    ])('Claude Code costs: $panel no longer says it under its heading, and its explanation does', async ({ id, gone, said }) => {
      await costs([spend('a', 2)]);

      const html = await theBarePage();

      expect(text(withoutExplanations(panelOf(html, id)))).not.toContain(gone);
      expect(text(explanationOf(html, id))).toContain(said);
    });

    it('Cockpit’s Claude calls: where the cost went no longer says under it which calls it holds, and its explanation does', async () => {
      putBack = await calls();

      const html = await theCallsPage();

      expect(text(withoutExplanations(panelOf(html, 'where')))).not.toContain('Anthropic key');
      expect(text(explanationOf(html, 'where'))).toContain('Every call made with Cockpit s Anthropic key is here');
    });

    it('Claude Code costs: the warning about requests with no price still opens the page, under its lead', async () => {
      await costs([spend('a', 2), usage('unpriced', { model: 'no-such-model' })]);

      const html = await theBarePage();

      expect(text(panelOf(html, 'unpriced'))).toContain('1 request could not be priced');
      expect(html.indexOf('aria-labelledby="unpriced"')).toBeGreaterThan(html.indexOf('class="lead"'));
      expect(html.indexOf('aria-labelledby="unpriced"')).toBeLessThan(html.indexOf('aria-labelledby="where"'));
    });

    it('Cockpit’s Claude calls: the warning about calls with no price still opens the page, under its lead', async () => {
      putBack = await calls();

      const html = await theCallsPage();

      expect(text(panelOf(html, 'unpriced'))).toContain('1 call could not be priced');
      expect(html.indexOf('aria-labelledby="unpriced"')).toBeGreaterThan(html.indexOf('class="lead"'));
      expect(html.indexOf('aria-labelledby="unpriced"')).toBeLessThan(html.indexOf('class="tiles"'));
    });
  });
});
