import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import {
  callLike,
  callsChanges,
  callsChart,
  callsColumns,
  callsJobLine,
  callsRows,
  callsTiles,
  callsWarning,
  callsWhereItWent,
  fakeCockpit,
  giveTheWorkerTheReadToken,
  importTheCalls,
  runTheImport,
  theCallsExport,
  theCallsPage,
  theRoute,
  type Call,
} from './cockpit-support';
import { GREY, panelOf, slot, swatches } from './series-colours';
import { linked, pullRequest } from './github-support';
import { emptyTheDatabase, send, spend, theSentence, thePage, withPrices } from './support';

/** CI's contract run: the calls a pull request's run makes, started by the run. */
const CI = { environment: 'ci', startedBy: 'contract-run' };

/**
 * Today is 23 Oct 2026, so the last 30 days run from 24 Sep and the 30 before them from 25 Aug.
 * Every call is priced at the dollars given, except 4 and 8, which production has no price for.
 * The base call is production's captured note, cleaned up by Sonnet.
 */
const CALLS: Call[] = [
  callLike({ id: 1, at: '2026-10-21T08:15:00Z', costUsd: 3 }),
  callLike({ id: 2, at: '2026-10-22T09:00:00Z', feature: 'choose-a-panel', model: 'claude-haiku-4-5', costUsd: 1 }),
  callLike({ id: 3, at: '2026-10-22T09:02:00Z', ...CI, pullRequest: 1505, runId: 100, costUsd: 2 }),
  callLike({ id: 4, at: '2026-10-22T09:03:00Z', ...CI, feature: 'resolve-a-place', pullRequest: 1505, runId: 100, costUsd: null }),
  callLike({ id: 5, at: '2026-10-23T07:00:00Z', ...CI, pullRequest: 1505, runId: 101, costUsd: 1.5 }),
  callLike({ id: 6, at: '2026-10-23T03:00:00Z', ...CI, runId: 200, costUsd: 0.25 }),
  callLike({ id: 7, at: '2026-10-22T14:40:00Z', environment: 'local', startedBy: 'contract-run', feature: 'propose-for-claude', model: 'claude-opus-4-1', branch: 'claude/x', costUsd: 4 }),
  callLike({ id: 8, at: '2026-10-23T07:45:00Z', environment: 'staging', feature: 'remember-a-sentence', model: 'claude-haiku-4-5', costUsd: null }),
  callLike({ id: 9, at: '2026-10-10T10:00:00Z', costUsd: 6 }),
  // The 30 days before the last 30: 5 and 2 dollars.
  callLike({ id: 10, at: '2026-09-20T10:00:00Z', costUsd: 5 }),
  // Older than 90 days, so only All time holds it.
  callLike({ id: 11, at: '2026-05-01T10:00:00Z', feature: 'choose-a-panel', model: 'claude-haiku-4-5', costUsd: 10 }),
  callLike({ id: 12, at: '2026-10-09T10:00:00Z', ...CI, pullRequest: 1400, runId: 50, costUsd: 1 }),
  callLike({ id: 13, at: '2026-10-05T10:00:00Z', feature: 'transcribe-a-recording', costUsd: 0.75 }),
  callLike({ id: 14, at: '2026-10-06T10:00:00Z', feature: 'read-what-a-note-means', costUsd: 0.5 }),
  callLike({ id: 15, at: '2026-09-22T10:00:00Z', feature: 'resolve-a-place', costUsd: 2 }),
];

let putBack: () => void;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-23T12:00:00Z') });
  await emptyTheDatabase();
  putBack = giveTheWorkerTheReadToken();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  putBack();
});

/** Dollars in a page's words ("$12.50") as millionths. */
const micros = (text: string) => Math.round(Number(/\$([\d,]+\.\d\d)/.exec(text)![1]!.replace(/,/g, '')) * 1e6);

/** The Worker's own entry, with `db` in place of its database, so what the page asks of it can be read. */
async function viewWith(db: D1Database, path: string, over: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://monitor.test/${path}`), { ...env, ...over, DB: db }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('Harness Monitor', () => {
  describe("Cockpit's Claude calls shows the period's calls in the chosen grouping, each row split by the chosen series", () => {
    beforeEach(() => importTheCalls(CALLS));

    it('the bare address is Over time for the last 30 days, split by environment: a row per day, newest first, and the cost per day', async () => {
      const html = await theCallsPage();

      expect(theSentence(html).text).toBe('Show cost for [each day] coloured by [environment] over [the last 30 days]');
      expect(callsColumns(html)).toEqual(['Production', 'Staging', 'CI', 'Local']);
      expect(callsRows(html).map((r) => [r.label, r.calls, ...r.cells, r.total])).toEqual([
        ['23 Oct 2026', '3', '—', '—', '$1.75', '—', '$1.75'],
        ['22 Oct 2026', '4', '$1.00', '—', '$2.00', '$4.00', '$7.00'],
        ['21 Oct 2026', '1', '$3.00', '—', '—', '—', '$3.00'],
        ['10 Oct 2026', '1', '$6.00', '—', '—', '—', '$6.00'],
        ['9 Oct 2026', '1', '—', '—', '$1.00', '—', '$1.00'],
        ['6 Oct 2026', '1', '$0.50', '—', '—', '—', '$0.50'],
        ['5 Oct 2026', '1', '$0.75', '—', '—', '—', '$0.75'],
      ]);
      expect(callsChart(html)).toBe('Cost per day, 24 Sept 2026 to 23 Oct 2026: Production, CI, Local, Total');
    });

    it.each([
      {
        situation: 'Feature: a row per feature, in the product words, dearest first',
        query: '?group=feature',
        rows: [
          ['Clean up a note', '6', '$13.75'],
          ['Propose for Claude', '1', '$4.00'],
          ['Choose a panel', '1', '$1.00'],
          ['Transcribe a recording', '1', '$0.75'],
          ['Read what a note means', '1', '$0.50'],
          ['Remember a sentence', '1', '$0.00'],
          ['Resolve a place', '1', '$0.00'],
        ],
      },
      {
        situation: 'Environment: production, staging, CI and local in that order, whatever they cost',
        query: '?group=environment',
        rows: [
          ['Production', '5', '$11.25'],
          ['Staging', '1', '$0.00'],
          ['CI', '5', '$4.75'],
          ['Local', '1', '$4.00'],
        ],
      },
      {
        situation: 'Started by: a row per starter, in words, dearest first',
        query: '?group=startedBy',
        rows: [
          ['Captured in app', '6', '$11.25'],
          ['Contract run', '6', '$8.75'],
        ],
      },
    ])('grouped by $situation', async ({ query, rows }) => {
      const html = await theCallsPage(query);

      expect(callsRows(html).map((r) => [r.label, r.calls, r.total])).toEqual(rows);
      expect(callsChart(html)).toBeNull();
    });

    it('split by Model, a column and a legend entry per model, dearest first, that sum to each row and to the total', async () => {
      const html = await theCallsPage('?split=model');

      expect(callsColumns(html)).toEqual(['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']);
      expect(callsWhereItWent(html).shares).toEqual([
        { name: 'claude-sonnet-4-5', amount: '$15.00', share: '75%' },
        { name: 'claude-opus-4-1', amount: '$4.00', share: '20%' },
        { name: 'claude-haiku-4-5', amount: '$1.00', share: '5%' },
      ]);
      const rows = callsRows(html);
      expect(rows[1]!.cells).toEqual(['$2.00', '$4.00', '$1.00']);
      for (const row of rows) expect(row.cells.reduce((sum, c) => sum + (c === '—' ? 0 : micros(c)), 0)).toBe(micros(row.total));
    });

    it('split by Feature and by Started by, the columns follow the split', async () => {
      expect(callsColumns(await theCallsPage('?split=feature'))).toEqual([
        'Clean up a note',
        'Propose for Claude',
        'Choose a panel',
        'Transcribe a recording',
        'Read what a note means',
        'Remember a sentence',
        'Resolve a place',
      ]);
      expect(callsColumns(await theCallsPage('?split=startedBy'))).toEqual(['Captured in app', 'Contract run']);
    });

    it('where the dollars went is told by the split, each series with its dollars and share, and points to the Console', async () => {
      const where = callsWhereItWent(await theCallsPage());

      expect(where.heading).toBe('Where the $20.00 went');
      expect(where.shares).toEqual([
        { name: 'Production', amount: '$11.25', share: '56%' },
        { name: 'Staging', amount: '$0.00', share: '0%' },
        { name: 'CI', amount: '$4.75', share: '24%' },
        { name: 'Local', amount: '$4.00', share: '20%' },
      ]);
      expect(where.note).toContain("Compare with the Anthropic Console's Cost page for the same days: a gap is spend no row records.");
    });

    it('an address naming nothing the page knows is the bare address', async () => {
      const bare = await theCallsPage();

      for (const query of ['?group=toString&period=__proto__&split=nope&environment=ghost&feature=Not%20A%20Slug&model=%3Cscript%3E', '?period=&group=&junk=1']) {
        expect(callsRows(await theCallsPage(query))).toEqual(callsRows(bare));
      }
    });

    it('with no calls in the period it says so rather than drawing an empty table or a chart', async () => {
      const html = await theCallsPage('?feature=clean-up-a-note&model=claude-opus-4-1');

      expect(html).toContain('Nothing in this period. No Claude calls match the filters.');
      expect(callsRows(html)).toEqual([]);
      expect(callsChart(html)).toBeNull();
      expect(callsWhereItWent(html).heading).toBe('Where the $0.00 went');
      expect(callsTiles(html)[1]).toEqual({ label: 'Calls', value: '0', note: 'none in this period' });
    });

    it('a filter shows what it holds, and the rows, the colours and the period hold no value', async () => {
      const held = (html: string) => Object.entries(theSentence(html).choices).filter(([, c]) => c.held).map(([name]) => name);

      expect(held(await theCallsPage())).toEqual([]);
      expect(held(await theCallsPage('?period=7d&environment=ci&feature=clean-up-a-note&model=claude-sonnet-4-5&split=model'))).toEqual(['environment', 'feature', 'model']);
    });
  });

  describe("Cockpit's Claude calls names a feature, a starter and an environment as words, and keeps what it has none for", () => {
    it('known features and starters are words, an unknown feature stays as recorded, no starter is Not recorded, and an unknown environment follows the four', async () => {
      await importTheCalls([
        callLike({ id: 1, at: '2026-10-22T09:00:00Z', feature: 'brand-new-thing', startedBy: 'connector:teams', costUsd: 4 }),
        callLike({ id: 2, at: '2026-10-22T09:01:00Z', feature: 'clean-up-a-note', startedBy: null, costUsd: 2 }),
        callLike({ id: 3, at: '2026-10-22T09:02:00Z', environment: 'preview', startedBy: 'panel-settled', costUsd: 1 }),
        callLike({ id: 4, at: '2026-10-22T09:03:00Z', startedBy: 'mcp', costUsd: 0.5 }),
      ]);

      expect(callsRows(await theCallsPage('?group=feature')).map((r) => r.label)).toEqual(['brand-new-thing', 'Clean up a note']);
      expect(callsRows(await theCallsPage('?group=startedBy')).map((r) => r.label)).toEqual(['Teams', 'Not recorded', 'Panel settled', 'MCP']);
      expect(callsRows(await theCallsPage('?group=environment')).map((r) => r.label)).toEqual(['Production', 'preview']);
      expect(callsColumns(await theCallsPage())).toEqual(['Production', 'preview']);
    });

    it('a feature or environment named like an object property stays as recorded, and a feature the address cannot name is not offered as a filter', async () => {
      await importTheCalls([
        callLike({ id: 1, at: '2026-10-22T09:00:00Z', feature: 'constructor', environment: 'valueOf', costUsd: 4 }),
        callLike({ id: 2, at: '2026-10-22T09:01:00Z', feature: 'Has_Upper', costUsd: 2 }),
      ]);

      const features = await theCallsPage('?group=feature');
      const dropdown = await theCallsPage();
      expect(callsRows(features).map((r) => r.label)).toEqual(['constructor', 'Has_Upper']);
      expect(callsColumns(await theCallsPage('?group=environment&split=feature'))).toEqual(['constructor', 'Has_Upper']);
      // A feature the dropdown leaves out still has a colour of its own.
      const heads = [...(await theCallsPage('?group=environment&split=feature')).matchAll(/<th scope="col" class="num"><i style="background:([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(heads).size).toBe(2);
      expect(callsColumns(await theCallsPage())).toEqual(['Production', 'valueOf']);
      expect(dropdown).toContain('<option value="constructor">');
      expect(dropdown).not.toContain('Has_Upper</option>');
    });
  });

  describe('a filter narrows every panel alike', () => {
    beforeEach(() => importTheCalls(CALLS));

    it('Environment: CI leaves the tiles, the bar, the changes, the chart and the table with CI calls alone', async () => {
      const html = await theCallsPage('?environment=ci');

      expect(callsTiles(html)).toEqual([
        { label: 'Spent', value: '$4.75', note: 'Last 30 days · at API list price' },
        { label: 'Calls', value: '5', note: '$1.19 a priced call on average' },
        { label: 'Against the previous period', value: '+$4.75', note: '$0.00 before' },
      ]);
      expect(callsWhereItWent(html).heading).toBe('Where the $4.75 went');
      expect(callsWhereItWent(html).shares).toEqual([{ name: 'CI', amount: '$4.75', share: '100%' }]);
      expect(callsChanges(html)!.items).toEqual([{ name: 'CI', direction: 'up', delta: '+$4.75', from: '$0.00 → $4.75' }]);
      expect(callsChart(html)).toBe('Cost per day, 24 Sept 2026 to 23 Oct 2026: CI, Total');
      expect(callsRows(html).map((r) => [r.label, r.calls, r.total])).toEqual([
        ['23 Oct 2026', '2', '$1.75'],
        ['22 Oct 2026', '2', '$2.00'],
        ['9 Oct 2026', '1', '$1.00'],
      ]);
    });

    it.each([
      { situation: 'a feature and a model that match a call', query: '?feature=clean-up-a-note&model=claude-sonnet-4-5', spent: '$13.75', calls: '6' },
      { situation: 'a feature and a model no call has together', query: '?feature=propose-for-claude&model=claude-sonnet-4-5', spent: '$0.00', calls: '0' },
      { situation: 'a feature alone', query: '?feature=choose-a-panel', spent: '$1.00', calls: '1' },
      { situation: 'a model alone', query: '?model=claude-haiku-4-5', spent: '$1.00', calls: '2' },
      { situation: 'an environment and a feature', query: '?environment=ci&feature=resolve-a-place', spent: '$0.00', calls: '1' },
    ])('$situation: only the calls matching every filter', async ({ query, spent, calls }) => {
      const html = await theCallsPage(query);

      expect(callsTiles(html).slice(0, 2).map((t) => t.value)).toEqual([spent, calls]);
      expect(callsWhereItWent(html).heading).toBe(`Where the ${spent} went`);
      expect(callsRows(html).reduce((sum, r) => sum + Number(r.calls), 0)).toBe(Number(calls));
    });

    it('a period of 7 days keeps the calls of the last 7 Belgian days, cut at Belgian midnight', async () => {
      await emptyTheDatabase();
      await importTheCalls([
        // 23:59 on 16 Oct in Brussels, the day before the week begins; and two minutes later, its first minute.
        callLike({ id: 1, at: '2026-10-16T21:59:00Z', costUsd: 5 }),
        callLike({ id: 2, at: '2026-10-16T22:01:00Z', costUsd: 1 }),
        callLike({ id: 3, at: '2026-10-23T08:00:00Z', costUsd: 2 }),
      ]);

      const html = await theCallsPage('?period=7d');

      expect(callsTiles(html).slice(0, 2)).toEqual([
        { label: 'Spent', value: '$3.00', note: 'Last 7 days · at API list price' },
        { label: 'Calls', value: '2', note: '$1.50 a priced call on average' },
      ]);
      expect(callsRows(html).map((r) => r.label)).toEqual(['23 Oct 2026', '17 Oct 2026']);
    });

    it('All time reaches past 90 days, and the other periods do not', async () => {
      expect(callsTiles(await theCallsPage('?period=all'))[0]!.value).toBe('$37.00');
      expect(callsTiles(await theCallsPage('?period=90d'))[0]!.value).toBe('$27.00');
      expect(callsTiles(await theCallsPage('?period=30d'))[0]!.value).toBe('$20.00');
    });
  });

  describe("a pull request's contract runs are one row that leads to it", () => {
    beforeEach(() => importTheCalls(CALLS));

    it('CI calls from two runs of one pull request are one row: its title, 2 contract runs, GitHub and Sessions', async () => {
      await linked(pullRequest({ number: 1505, title: 'Name the thing', headRefName: 'claude/1505-name-the-thing' }));

      const [row] = callsRows(await theCallsPage('?group=pr'));

      expect(row).toMatchObject({ label: '#1505 Name the thing', sub: '2 contract runs · Sessions', calls: '3', total: '$3.50', cells: ['—', '—', '$3.50', '—'] });
      expect(row!.links).toEqual([expect.stringMatching(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/1505$/), '/pr/1505']);
      expect(row!.segments).toBeGreaterThan(0);
    });

    it('a pull request the Monitor has no title for is its number alone, still a link, with the one run it had', async () => {
      const rows = callsRows(await theCallsPage('?group=pr'));

      expect(rows.map((r) => r.label)).toEqual(['#1505', '#1400', 'Nightly and by-hand runs on main', 'No pull request']);
      expect(rows[1]).toMatchObject({ sub: '1 contract run · Sessions', calls: '1', total: '$1.00' });
      expect(rows[1]!.links[1]).toBe('/pr/1400');
    });

    it('CI runs on main are a row of their own, and production, staging and local calls are No pull request, which draws no split bar', async () => {
      const [, , main, none] = callsRows(await theCallsPage('?group=pr'));

      expect(main).toMatchObject({ label: 'Nightly and by-hand runs on main', sub: null, links: [], calls: '1', total: '$0.25' });
      expect(main!.segments).toBeGreaterThan(0);
      expect(none).toMatchObject({ label: 'No pull request', sub: null, links: [], calls: '7', cells: ['$11.25', '—', '—', '$4.00'], total: '$15.25' });
      expect(none!.segments).toBe(0);
    });

    it('contract runs are counted within the filters', async () => {
      const rows = callsRows(await theCallsPage('?group=pr&period=7d'));

      expect(rows.map((r) => [r.label, r.sub])).toEqual([
        ['#1505', '2 contract runs · Sessions'],
        ['Nightly and by-hand runs on main', null],
        ['No pull request', null],
      ]);
      expect(callsRows(await theCallsPage('?group=pr&environment=production')).map((r) => r.label)).toEqual(['No pull request']);
    });
  });

  describe('this period is set against the one before it', () => {
    beforeEach(() => importTheCalls(CALLS));

    it('the last 30 days show the change in dollars and the four largest changes by the split', async () => {
      const html = await theCallsPage('?split=feature');

      expect(callsTiles(html)[2]).toEqual({ label: 'Against the previous period', value: '+$13.00', note: '$7.00 before' });
      expect(callsChanges(html)).toMatchObject({
        heading: 'Largest changes by feature',
        items: [
          { name: 'Clean up a note', direction: 'up', delta: '+$8.75', from: '$5.00 → $13.75' },
          { name: 'Propose for Claude', direction: 'up', delta: '+$4.00', from: '$0.00 → $4.00' },
          { name: 'Resolve a place', direction: 'down', delta: '−$2.00', from: '$2.00 → $0.00' },
          { name: 'Choose a panel', direction: 'up', delta: '+$1.00', from: '$0.00 → $1.00' },
        ],
      });
    });

    it('the changes follow the split, and a series that did not move is left out', async () => {
      expect(callsChanges(await theCallsPage())!.items.map((i) => [i.name, i.delta])).toEqual([
        ['CI', '+$4.75'],
        ['Production', '+$4.25'],
        ['Local', '+$4.00'],
      ]);
    });

    it('a period that cost less than the one before shows a fall', async () => {
      await emptyTheDatabase();
      await importTheCalls([callLike({ id: 1, at: '2026-10-22T09:00:00Z', costUsd: 1 }), callLike({ id: 2, at: '2026-09-20T09:00:00Z', costUsd: 4 })]);

      const html = await theCallsPage();

      expect(callsTiles(html)[2]).toEqual({ label: 'Against the previous period', value: '−$3.00', note: '$4.00 before' });
      expect(html).toContain('<div class="tile down">');
    });

    it('a change under half a cent is no change, since it would read $0.00 either way', async () => {
      await emptyTheDatabase();
      await importTheCalls([callLike({ id: 1, at: '2026-10-22T09:00:00Z', costUsd: 1.004 }), callLike({ id: 2, at: '2026-09-20T09:00:00Z', costUsd: 1 })]);

      const html = await theCallsPage();

      expect(callsTiles(html)[2]).toEqual({ label: 'Against the previous period', value: 'No change', note: '$1.00 before' });
      expect(callsChanges(html)).toMatchObject({ items: [], none: true });
    });

    it('All time has no comparison tile and no changes panel', async () => {
      const html = await theCallsPage('?period=all');

      expect(callsTiles(html).map((t) => t.label)).toEqual(['Spent', 'Calls']);
      expect(callsChanges(html)).toBeNull();
      expect(html).not.toContain('Largest changes');
    });
  });

  describe('a call with no price is counted and named, never priced at zero', () => {
    beforeEach(() => importTheCalls(CALLS));

    it('the warning names the 2 unpriced calls, Spent leaves them out and Calls counts them', async () => {
      const html = await theCallsPage();

      expect(callsWarning(html)).toBe(
        "2 calls could not be priced: Cockpit's record has no price for the model, or for a kind of token it used. They are counted in Calls and left out of every dollar total.",
      );
      expect(callsTiles(html).slice(0, 2)).toEqual([
        { label: 'Spent', value: '$20.00', note: 'Last 30 days · at API list price' },
        { label: 'Calls', value: '12', note: '$2.00 a priced call on average' },
      ]);
    });

    it('a period with none has no warning, and one call is named in the singular', async () => {
      expect(callsWarning(await theCallsPage('?environment=production'))).toBeNull();
      expect(callsWarning(await theCallsPage('?environment=staging'))).toBe(
        "1 call could not be priced: Cockpit's record has no price for the model, or for a kind of token it used. It is counted in Calls and left out of every dollar total.",
      );
      expect(callsTiles(await theCallsPage('?environment=staging')).slice(0, 2)).toEqual([
        { label: 'Spent', value: '$0.00', note: 'Last 30 days · at API list price' },
        { label: 'Calls', value: '1', note: 'none could be priced' },
      ]);
    });
  });

  describe('the Claude Code costs page is untouched by these calls', () => {
    it("the costs page's total equals its requests' alone, and the calls page holds the calls alone", async () => {
      await withPrices();
      await send([spend('a', 2, { branch: 'b/1' })]);
      await importTheCalls(CALLS);

      expect(await thePage('?period=all')).toContain('Where the period&rsquo;s $2.00 went');
      expect(callsWhereItWent(await theCallsPage('?period=all')).heading).toBe('Where the $37.00 went');
    });
  });

  describe("Cockpit's Claude calls reads the daily totals, never the copies, in one round trip", () => {
    it.each([
      { situation: 'over time', query: '?group=day' },
      { situation: 'by pull request', query: '?group=pr&period=all' },
      { situation: 'by feature, split by model', query: '?group=feature&split=model&environment=ci' },
    ])('a view $situation asks the database once, and never for the copies', async ({ query }) => {
      await importTheCalls(CALLS);
      const asked: string[] = [];
      const trips = { batches: 0, singles: 0 };
      const real = new WeakMap<object, D1PreparedStatement>();
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const watched: D1PreparedStatement = new Proxy(statement, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === 'bind') return (...binds: unknown[]) => wrap(target.bind(...binds));
            if (property === 'first' || property === 'all' || property === 'run' || property === 'raw') trips.singles++;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        real.set(watched, statement);
        return watched;
      };
      const proxy = new Proxy(env.DB, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === 'prepare') return (sql: string) => (asked.push(sql), wrap(target.prepare(sql)));
          if (property === 'batch') return (statements: D1PreparedStatement[]) => (trips.batches++, target.batch(statements.map((s) => real.get(s) ?? s)));
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const response = await viewWith(proxy, `claude-calls${query}`);

      expect(response.status).toBe(200);
      expect(trips).toEqual({ batches: 1, singles: 0 });
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.filter((sql) => /\bclaude_calls\b|\busage_requests\b/.test(sql))).toEqual([]);
    });
  });

  describe("the export carries the page's calls and nothing that names a person", () => {
    beforeEach(() => importTheCalls(CALLS));

    it('under Environment: CI it holds only CI calls, oldest first, in the fixed columns, a call with no price having no cost', async () => {
      const { response, header, rows } = await theCallsExport('?environment=ci');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('content-disposition')).toBe('attachment; filename="cockpit-claude-calls.csv"');
      expect(header).toEqual([
        'time',
        'environment',
        'feature',
        'prompt_version',
        'started_by',
        'model',
        'outcome',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'cost_usd',
        'pull_request',
        'run_id',
        'branch',
      ]);
      expect(rows.map((r) => [r[0], r[1], r[2], r[11], r[12], r[13]])).toEqual([
        ['2026-10-09T10:00:00.000Z', 'ci', 'clean-up-a-note', '1.000000', '1400', '50'],
        ['2026-10-22T09:02:00.000Z', 'ci', 'clean-up-a-note', '2.000000', '1505', '100'],
        ['2026-10-22T09:03:00.000Z', 'ci', 'resolve-a-place', '', '1505', '100'],
        ['2026-10-23T03:00:00.000Z', 'ci', 'clean-up-a-note', '0.250000', '', '200'],
        ['2026-10-23T07:00:00.000Z', 'ci', 'clean-up-a-note', '1.500000', '1505', '101'],
      ]);
    });

    it.each([
      { situation: 'the period', query: '?period=7d', ids: 8 },
      { situation: 'a feature and a model together', query: '?feature=clean-up-a-note&model=claude-sonnet-4-5', ids: 6 },
      { situation: 'all time', query: '?period=all', ids: 15 },
      { situation: 'a grouping and a split, which a list of calls has none of', query: '?group=pr&split=model&period=7d', ids: 8 },
    ])('under $situation it holds the calls the page counts', async ({ query, ids }) => {
      const { rows } = await theCallsExport(query);
      const tiles = callsTiles(await theCallsPage(query));

      expect(rows).toHaveLength(ids);
      expect(tiles[1]!.value).toBe(String(ids));
    });

    it('cuts the period on the call\'s exact time, as the page cuts its days', async () => {
      await emptyTheDatabase();
      await importTheCalls([callLike({ id: 1, at: '2026-10-16T21:59:00Z' }), callLike({ id: 2, at: '2026-10-16T22:01:00Z' })]);

      expect((await theCallsExport('?period=7d')).rows.map((r) => r[0])).toEqual(['2026-10-16T22:01:00.000Z']);
    });

    it('has no column that names a user, an account or an item, and is never cached', async () => {
      const { header, text } = await theCallsExport();

      expect(header.filter((name) => /user|account|item|email/.test(name))).toEqual([]);
      expect(text).not.toMatch(/user|account|@/i);
      const cached = await viewWith(env.DB, 'claude-calls/export.csv?environment=ci', { PAGE_CACHE_SECONDS: '300' });
      expect(cached.headers.get('cache-control')).toBe('no-store');
    });

    it('is the whole record however many reads of the database it takes, in order, none twice', async () => {
      await emptyTheDatabase();
      // 45,000 calls, three to a moment, so a page boundary falls inside a moment. Seeded as rows: the import copies at most 10,000 a run, and this is about the export's reads.
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 44999)
         INSERT INTO claude_calls (id, occurred_at, environment, feature, prompt_version, started_by, model, outcome, tokens_in, cache_read, cache_write, tokens_out, cost_micros, pull_request, run_id, branch, ingest_id, copied_at)
         SELECT i + 1, 1767225600000 + (i / 3) * 60000, 'production', 'clean-up-a-note', 'v1', 'captured-in-app', 'claude-sonnet-4-5', 'ok', i + 1, 1, 1, 1, 1000000, NULL, NULL, NULL, 'seed', 0
         FROM n`,
      ).run();

      const { rows } = await theCallsExport('?period=all');

      expect(rows).toHaveLength(45_000);
      expect(new Set(rows.map((r) => r[7])).size).toBe(rows.length);
      const times = rows.map((r) => r[0]!);
      expect(times).toEqual([...times].sort());
      expect(rows.reduce((sum, r) => sum + Number(r[11]), 0)).toBe(45_000);
    });
  });

  describe('the page is cached like the costs page', () => {
    it('two spellings of the same filters share one entry, so a page viewed again within minutes is the one the edge kept', async () => {
      await importTheCalls([callLike({ id: 1, at: '2026-10-22T09:00:00Z', costUsd: 1 })]);
      const cached = { PAGE_CACHE_SECONDS: '300' };
      const first = await viewWith(env.DB, 'claude-calls?period=all', cached);
      await importTheCalls([callLike({ id: 1, at: '2026-10-22T09:00:00Z', costUsd: 1 }), callLike({ id: 2, at: '2026-10-22T10:00:00Z', costUsd: 5 })]);

      const second = await viewWith(env.DB, 'claude-calls?period=all', cached);
      const another = await viewWith(env.DB, 'claude-calls?junk=1&period=all&group=day&environment=&split=environment', cached);

      expect(first.headers.get('cache-control')).toBe('public, max-age=300');
      expect(callsWhereItWent(await second.text()).heading).toBe('Where the $1.00 went');
      expect(callsWhereItWent(await another.text()).heading).toBe('Where the $1.00 went');
      expect(callsWhereItWent(await theCallsPage('?period=all')).heading).toBe('Where the $6.00 went');
    });
  });

  describe("the import's last run is on the page", () => {
    it('before the first run it says the import has not run', async () => {
      expect(await callsJobLine(await theCallsPage())).toBe("Cockpit's Claude calls: has not run yet.");
    });

    it('after a run it says when and how it was started and what it copied', async () => {
      await importTheCalls(CALLS);

      expect(await callsJobLine(await theCallsPage())).toBe("Cockpit's Claude calls: last run 23 Oct 2026, 14:00 (scheduled) — Copied 15 Claude calls; caught up with Cockpit.");
    });

    it('after a failed import it says what went wrong and when the import last succeeded', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await importTheCalls(CALLS);
      vi.setSystemTime(new Date('2026-10-23T20:00:00Z'));
      fakeCockpit(() => new Response('down', { status: 500 }));

      await runTheImport();

      expect(await callsJobLine(await theCallsPage())).toBe(
        "Cockpit's Claude calls: last run 23 Oct 2026, 22:00 (scheduled) — Cockpit answered 500. Nothing was copied. Last succeeded 23 Oct 2026, 14:00.",
      );
    });

    it('a failure before any success says it never succeeded', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeCockpit(() => new Response('down', { status: 500 }));

      await runTheImport();

      expect(await callsJobLine(await theCallsPage())).toContain('Nothing was copied. Never succeeded.');
    });
  });

  describe('an environment has its own colour by name, and one the page does not know is grey and follows the four', () => {
    it('production, staging, CI and local take the first three slots and blue, an unknown environment grey', async () => {
      await importTheCalls([...CALLS, callLike({ id: 20, at: '2026-10-22T09:00:00Z', environment: 'preview', costUsd: 1 })]);

      expect(swatches(panelOf(await theCallsPage(), 'where'))).toEqual([
        ['Production', slot(1)],
        ['Staging', slot(2)],
        ['CI', slot(3)],
        ['Local', slot(6)],
        ['preview', GREY],
      ]);
    });
  });

});
