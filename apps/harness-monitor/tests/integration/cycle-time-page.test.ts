import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GREY, panelOf, RED, slot, swatches } from './series-colours';
import { cycleCheck, cyclePull, cycleRound, emptyTheDatabase, send, sendPulls, spend, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
});
afterEach(() => vi.useRealTimers());

const thePage = async (query = '') => {
  const response = await SELF.fetch(`https://monitor.test/cycle-time${query}`);
  expect(response.status).toBe(200);
  return response.text();
};

/** The text of a section's table rows, one array of cell texts per row, the header row left out. */
function rowsOf(html: string, id: string): string[][] {
  const panel = new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '';
  return [...panel.matchAll(/<tr[ >].*?<\/tr>/gs)]
    .map((row) => [...row[0].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((cell) => cell[1]!.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter((cells) => cells.length > 0)
    .slice(1);
}

/** The outline's rows as read: name, minutes and share, and whether the row is a part of a phase. */
const outlineOf = (html: string) =>
  [...(/<ul class="outline".*?<\/ul>/s.exec(html)?.[0] ?? '').matchAll(/<li class="o-row (o-pt|o-ph)"><span class="nm">(.*?)<\/span>.*?<span class="am">(.*?)<\/span><span class="sh">(.*?)<\/span><\/li>/gs)].map((m) => ({
    part: m[1] === 'o-pt',
    name: m[2]!,
    amount: m[3]!,
    share: m[4]!,
  }));
const columnHeads = (html: string, id: string) => [...(new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '').matchAll(/<th scope="col"[^>]*>(?:<i[^>]*><\/i>)?([^<]+)<\/th>/g)].map((m) => m[1]);
/** What hovering each row's Split bar says, a row to an entry, in the table's order; undefined where the row has no hover. */
const hoversOf = (html: string, id: string) =>
  [...(new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '').matchAll(/<tr[ >].*?<\/tr>/gs)]
    .filter((row) => row[0].includes('class="split-cell"'))
    .map((row) => /<td class="split-cell"(?: title="([^"]*)")?>/.exec(row[0])![1]);
const hasSection = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}"`).test(html);
const text = (html: string) => html.replace(/<style>.*?<\/style>/s, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
const MIN = 60_000;

/** A tile as drawn, up to the next one, found by what its label reads. */
const tileOf = (html: string, label: string) =>
  html
    .split('<div class="tile ')
    .slice(1)
    .find((tile) => text(/class="tile-label">(.*?)<span class="tile-value"/s.exec(tile)![1]!).trim().startsWith(label)) ?? '';
/** The parts of the explanation an (i) opens, by the name of each; null where the page draws none by that id. */
const partsOf = (html: string, id: string) => {
  const panel = new RegExp(`<div id="x-${id}" popover="manual" class="explain-pop">(.*?)</div>`, 's').exec(html);
  return panel ? [...panel[1]!.matchAll(/<dt>(.*?)<\/dt>/g)].map((m) => m[1]) : null;
};
const THREE_PARTS = ['What it shows', 'How to read it', 'What to look for'];
/** The (i) a panel carries beside its heading: the id of the explanation it opens, null where it has none. */
const infoOfPanel = (html: string, id: string) => /<button [^>]*data-pop="x-([^"]*)"/.exec(panelOf(html, id))?.[1] ?? null;

/** One green round of the `Test` check, `ms` long. */
const green = (minutes = 5) => cycleRound([cycleCheck('Test', minutes * MIN, { last: true })], { ms: minutes * MIN });
/** One round of `Test` that went red at the step `Run the tests`. */
const red = (minutes = 5) => cycleRound([cycleCheck('Test', minutes * MIN, { last: true, failure: 'red', failedSteps: ['Run the tests'] })], { ms: minutes * MIN, red: true });

/** A recorded pull request: 10 minutes of writing, 5 of local checks, the rounds, a minute waiting to merge. */
const recorded = (number: number, mergedAt: string, over: Record<string, unknown> = {}) => {
  const rounds = (over.rounds as unknown[] | undefined) ?? [green()];
  return cyclePull(number, { mergedAt, rounds, ciMs: 5 * MIN * rounds.length, totalMs: (16 + 5 * rounds.length) * MIN, ...over });
};

/** The pull request is linked to its branch and issue as the hourly job would, and the sessions on its branch cost `dollars`. */
async function costing(number: number, dollars: number | null, issue: number | null = null) {
  if (dollars !== null) await send([spend(`cost-${number}`, dollars, { branch: `claude/${number}-work` })]);
  await env.DB.prepare(
    `INSERT INTO branch_links (branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at)
     VALUES (?1, ?2, ?3, 'MERGED', '2026-10-30T10:00:00Z', ?4, 'alice', '2026-10-30T10:00:00Z', 0)`,
  )
    .bind(`claude/${number}-work`, number, `Pull request ${number}`, issue)
    .run();
}

describe('Harness Monitor', () => {
  describe("cycle time's stored pull requests are a page, and the same address answers JSON to a request that asks", () => {
    it('opens as a page from its own tab in the top bar, between the Claude calls and CI stability', async () => {
      const html = await thePage();

      expect(html).toMatch(/<a href="\/cycle-time" title="[^"]*" aria-current="page">Cycle time<\/a>/);
      expect([...html.matchAll(/<nav class="pages".*?<\/nav>/gs)][0]![0].match(/>([^<]+)<\/a>/g)).toEqual(['>Claude Code costs</a>', '>Cockpit&rsquo;s Claude calls</a>', '>Cycle time</a>', '>Test selection</a>', '>Tests</a>', '>CI stability</a>']);
      expect(html.match(/<h1\b/g) ?? []).toHaveLength(0);
    });

    it.each([
      { situation: 'format=json in the address', url: 'https://monitor.test/cycle-time?format=json', headers: {} },
      { situation: 'an Accept header for JSON', url: 'https://monitor.test/cycle-time', headers: { accept: 'application/json' } },
    ])('answers JSON for $situation', async ({ url, headers }) => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z')]);

      const response = await SELF.fetch(url, { headers });

      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ period: '30d', windows: expect.any(Array), pulls: [{ number: 1 }] });
    });

    it('answers a browser, which accepts HTML first, with the page', async () => {
      const response = await SELF.fetch('https://monitor.test/cycle-time', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });

      expect(response.headers.get('content-type')).toContain('text/html');
    });
  });

  describe('a pull request or issue row shows the Claude Code cost the Monitor holds for it, and links to its Sessions page', () => {
    beforeEach(withPrices);

    it('a pull request with $4.20 of cost shows $4.20 and a Sessions link', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z')]);
      await costing(1, 4.2);

      const html = await thePage('?group=pr');
      const [row] = rowsOf(html, 'cycle-table');

      expect(row![row!.length - 1]).toBe('$4.20');
      expect(row![0]).toContain('Sessions');
      expect(html).toContain('<a href="/pr/1">Sessions</a>');
      expect(html).toContain('<a href="/pr/1">$4.20</a>');
    });

    it('an issue with two pull requests sums their costs on its row and lists each with its Sessions', async () => {
      await sendPulls([recorded(1, '2026-10-29T10:00:00Z'), recorded(2, '2026-10-30T10:00:00Z')]);
      await costing(1, 4.2, 7);
      await costing(2, 1, 7);

      const html = await thePage('?group=issue');
      const [row] = rowsOf(html, 'cycle-table');

      expect(rowsOf(html, 'cycle-table')).toHaveLength(1);
      expect(row![0]).toContain('#7');
      expect(row![1]).toBe('2');
      expect(row![row!.length - 1]).toBe('$5.20');
      expect(html).toContain('<a href="/pr/1">Sessions</a>');
      expect(html).toContain('<a href="/pr/2">Sessions</a>');
    });

    it('a pull request with no recorded cost shows no figure, never $0.00', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z'), recorded(2, '2026-10-29T10:00:00Z')]);
      await costing(2, null);

      const html = await thePage('?group=pr');
      const rows = rowsOf(html, 'cycle-table');

      expect(rows.map((r) => r[r.length - 1])).toEqual(['—', '—']);
      expect(html).not.toContain('$0.00');
    });

    it('the cost tile reads — and not $0.00 where no pull request in the list has a recorded request', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z')]);
      await costing(1, null);

      const html = await thePage();

      expect(text(tileOf(html, 'Claude Code cost'))).toContain('Claude Code cost i — none priced');
      expect(html).not.toContain('$0.00');
    });

    it("an issue row is named by the issue's own title, not by the title of a pull request", async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { title: 'Fix the review findings (#7)' })]);
      await costing(1, 2, 7);
      await env.DB.prepare(
        `INSERT INTO pull_request_stats (pr_number, lines_added, lines_removed, opened_at, ci_rounds, issue_title, pr_updated_at, read_at)
         VALUES (1, 1, 1, '2026-10-30T09:00:00Z', 1, 'Show cycle time as a page', '2026-10-30T10:00:00Z', 0)`,
      ).run();

      const [row] = rowsOf(await thePage('?group=issue'), 'cycle-table');

      expect(row![0]).toContain('Show cycle time as a page');
      expect(row![0]).not.toContain('Fix the review findings');
    });

    it('a pull request the Monitor has no branch link for has no Sessions link, which would be nothing found', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z'), recorded(2, '2026-10-29T10:00:00Z')]);
      await costing(1, 4.2);

      const html = await thePage('?group=pr');

      expect(html).toContain('<a href="/pr/1">Sessions</a>');
      expect(html).not.toContain('/pr/2');
    });

    it('the Over time tiles name how many pull requests are priced and what each cost', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z'), recorded(2, '2026-10-29T10:00:00Z'), recorded(3, '2026-10-28T10:00:00Z')]);
      await costing(1, 4);
      await costing(2, 2);

      expect(text(await thePage())).toContain('$6.00 $3.00 a pull request · 2 of 3 priced');
    });
  });

  describe('Merged, Size and Rounds keep only matching pull requests, on every tab', () => {
    // 1: merged yesterday, small, green. 2: merged eleven days ago, small, red then green. 3: merged two days ago, 2,000 lines, green.
    beforeEach(async () => {
      await sendPulls([
        recorded(1, '2026-10-30T10:00:00Z'),
        recorded(2, '2026-10-20T10:00:00Z', { rounds: [red(), green()] }),
        recorded(3, '2026-10-29T10:00:00Z', { size: { additions: 1900, deletions: 100, files: 20, commits: 3, mainMerges: 0 } }),
      ]);
    });

    /** What a tab accounts for: the pull requests it lists or counts, or on the Check tab the CI rounds. */
    async function accounted(query: string, group: string) {
      const html = await thePage(`?group=${group}${query}`);
      const rows = rowsOf(html, group === 'check' ? 'by-check' : 'cycle-table');
      if (group === 'pr') return rows.map((r) => /#(\d+)/.exec(r[0]!)![1]).sort();
      if (group === 'check') return rows.map((r) => [r[0], r[1]]);
      return rows.reduce((total, r) => total + Number(r[1]), 0);
    }

    it.each([
      { situation: 'Last 3 days keeps those merged in it', query: '&period=3d', pulls: ['1', '3'], count: 2, checks: [['Test', '2']] },
      { situation: 'Size: 1,500 lines or more keeps only that size', query: '&size=l', pulls: ['3'], count: 1, checks: [['Test', '1']] },
      { situation: 'Rounds: had a red round keeps only those', query: '&outcome=red', pulls: ['2'], count: 1, checks: [['Test red on #2', '2']] },
    ])('$situation', async ({ query, pulls, count, checks }) => {
      expect(await accounted(query, 'pr')).toEqual(pulls);
      for (const group of ['day', 'issue', 'size']) expect(await accounted(query, group)).toBe(count);
      expect(await accounted(query, 'check')).toEqual(checks);
    });

    it('every tab keeps the filters in the address of the others', async () => {
      const html = await thePage('?period=7d&size=xs&outcome=green');

      const links = [...html.matchAll(/<nav class="band".*?<\/nav>/gs)][0]![0].match(/href="([^"]+)"/g)!;

      expect(links).toHaveLength(5);
      for (const link of links) expect(link).toMatch(/period=7d.*size=xs.*outcome=green/);
    });
  });

  describe('a pull request with no session record says so by its tag, and reads "not recorded" nowhere in its row', () => {
    it('its sub-line carries the tag, its row never says not recorded, and its writing is the time left of start to merge', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { recorded: false, codingMs: null, localMs: null, localReviews: null, totalMs: 21 * MIN, start: { at: '2026-10-30T09:39:00Z', from: 'first-commit' } })]);

      const html = await thePage('?group=pr');
      const [row] = rowsOf(html, 'cycle-table');

      // Label, split, start to merge, rounds, Claude Code.
      expect(row!.slice(2, 4)).toEqual(['21m', '1']);
      expect(row![0]).toContain('no session record');
      expect(row!.join(' ')).not.toContain('not recorded');
      expect(hoversOf(html, 'cycle-table')).toEqual(['Writing 15m · CI rounds 5m · Waiting to merge 1m']);
      expect(text(await thePage())).toContain('1 pull request here carries no session record');
    });
  });

  describe("hovering a row's Split bar names each phase's time, in phase order, on the row's own measure, and they add up to its start to merge", () => {
    const minutes = (hover: string | undefined) => (hover ?? '').split(' · ').reduce((total, part) => total + Number(/(\d+)m$/.exec(part)![1]), 0);

    it('a pull request names its writing, local checks, CI rounds and wait, which add up to its start to merge', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { totalMs: 21 * MIN })]);

      const html = await thePage('?group=pr');
      const [row] = rowsOf(html, 'cycle-table');
      const [hover] = hoversOf(html, 'cycle-table');

      expect(hover).toBe('Writing 10m · Local checks 5m · CI rounds 5m · Waiting to merge 1m');
      expect(minutes(hover)).toBe(21);
      expect(row!.at(-3)).toBe('21m');
    });

    it('a pull request with time away names Away last', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { awayMs: 3 * MIN, totalMs: 24 * MIN })]);

      expect(hoversOf(await thePage('?group=pr'), 'cycle-table')).toEqual(['Writing 10m · Local checks 5m · CI rounds 5m · Waiting to merge 1m · Away 3m']);
    });

    it("a day of two pull requests names each phase's average, as its start to merge is", async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { codingMs: 6 * MIN, totalMs: 17 * MIN }), recorded(2, '2026-10-30T11:00:00Z', { codingMs: 14 * MIN, totalMs: 25 * MIN })]);

      const html = await thePage();
      const [row] = rowsOf(html, 'cycle-table');

      expect(hoversOf(html, 'cycle-table')).toEqual(['Writing 10m · Local checks 5m · CI rounds 5m · Waiting to merge 1m']);
      expect(row!.at(-3)).toBe('21m');
    });

    it("an issue of two pull requests names each phase's sum", async () => {
      await sendPulls([recorded(1, '2026-10-29T10:00:00Z', { totalMs: 21 * MIN }), recorded(2, '2026-10-30T10:00:00Z', { totalMs: 21 * MIN })]);
      await costing(1, null, 7);
      await costing(2, null, 7);

      const html = await thePage('?group=issue');

      expect(hoversOf(html, 'cycle-table')).toEqual(['Writing 20m · Local checks 10m · CI rounds 10m · Waiting to merge 2m']);
      expect(rowsOf(html, 'cycle-table')[0]!.at(-3)).toBe('42m');
    });

    it('a row with no minutes at all has no hover', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { rounds: [cycleRound([cycleCheck('Test', 0, { last: true })])], ciMs: 0, totalMs: 0, codingMs: 0, localMs: 0, waitingToMergeMs: 0, awayMs: 0, localReviews: { count: 0, ms: 0, byKind: { 'code-review': { count: 0, ms: 0 }, 'security-review': { count: 0, ms: 0 } } } })]);

      const html = await thePage('?group=pr');

      expect(hoversOf(html, 'cycle-table')).toEqual([undefined]);
      expect(html).not.toContain('title=""');
    });
  });

  describe('the page has one view: every chart and table in phases, with no column per phase and no Split by', () => {
    const heads = (first: string, withCount = true) => [first, ...(withCount ? ['Pull requests'] : []), 'Split', 'Start to merge', 'Rounds', 'Claude Code'];
    beforeEach(async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z'), recorded(2, '2026-10-29T10:00:00Z', { size: { additions: 1900, deletions: 100, files: 20, commits: 3, mainMerges: 0 } })]);
    });

    it('draws the By day table and the per-pull-request chart in phases on Over time', async () => {
      const html = await thePage();

      expect(columnHeads(html, 'cycle-table')).toEqual(heads('Day merged'));
      expect(html).toContain('Start to merge, each pull request as it merged');
      const chart = /<section[^>]*aria-labelledby="per-pull-request".*?<\/section>/s.exec(html)![0];
      expect([...chart.matchAll(/<span class="key"><i[^>]*><\/i>([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(['Writing', 'Local checks', 'CI rounds', 'Waiting to merge', 'Away']);
    });

    it.each([
      { tab: 'pr', first: 'Pull request', withCount: false },
      { tab: 'issue', first: 'Issue', withCount: true },
      { tab: 'size', first: 'Size', withCount: true },
    ])('draws the $tab tab with no column per phase', async ({ tab, first, withCount }) => {
      expect(columnHeads(await thePage(`?group=${tab}`), 'cycle-table')).toEqual(heads(first, withCount));
    });

    it.each([[''], ['?group=pr'], ['?group=issue'], ['?group=size'], ['?group=check']])('has no Split by control at %s', async (query) => {
      const html = await thePage(query);

      expect(text(html)).not.toContain('Split by');
      expect(html).not.toContain('name="split"');
    });

    it.each([['?split=harness'], ['?split=check'], ['?group=pr&split=harness'], ['?period=7d&group=size&split=check&outcome=green']])('opens the same page for an old link at %s as without its split', async (query) => {
      const without = query.replace(/&?split=[a-z]+/, '').replace('?&', '?').replace(/\?$/, '');

      expect(await thePage(query)).toBe(await thePage(without));
    });
  });

  describe("Where the time went is one outline: every phase, with Local checks and CI rounds opened into their parts", () => {
    // Two pull requests merged within the day, 21 minutes each: 10 writing, 5 local checks (3 + 2 of reviews), 5 of Test, a minute waiting.
    const split = (number: number, parts: Record<string, number>) => recorded(number, '2026-10-30T10:00:00Z', { localParts: parts });
    const kinds = { 'code-review': 3 * MIN, 'security-review': 2 * MIN, test: 0, browser: 0 };

    it('lists the phases in order, the local checks opened into their kinds and CI rounds into its checks, each with its minutes and share', async () => {
      await sendPulls([split(1, kinds), split(2, kinds)]);

      expect(outlineOf(await thePage())).toEqual([
        { part: false, name: 'Writing', amount: '20m', share: '48%' },
        { part: false, name: 'Local checks', amount: '10m', share: '24%' },
        { part: true, name: 'Code review', amount: '6m', share: '60%' },
        { part: true, name: 'Security review', amount: '4m', share: '40%' },
        { part: false, name: 'CI rounds', amount: '10m', share: '24%' },
        { part: true, name: 'Test', amount: '10m', share: '100%' },
        { part: false, name: 'Waiting to merge', amount: '2m', share: '5%' },
      ]);
    });

    it('draws a pull request stored without its kinds as Not split by kind under Local checks, so the parts still add up', async () => {
      await sendPulls([split(1, kinds), recorded(2, '2026-10-30T10:00:00Z')]);

      const rows = outlineOf(await thePage());

      expect(rows.filter((r) => r.part).map((r) => [r.name, r.amount])).toEqual([
        ['Code review', '3m'],
        ['Security review', '2m'],
        ['Not split by kind', '5m'],
        ['Test', '10m'],
      ]);
      expect(text(await thePage())).toContain('1 pull request here was stored without the kinds of local check');
    });

    it('titles the panel with the time it covers and counts the pull requests', async () => {
      await sendPulls([split(1, kinds), split(2, kinds)]);

      const panel = panelOf(await thePage(), 'where-it-went');

      expect(panel).toContain('<h2 id="where-it-went">Where the 42m went</h2>');
      expect(panel).toContain('<span class="aside">2 pull requests</span>');
    });

    it('sets each part inside its phase on the one scale', async () => {
      await sendPulls([split(1, kinds)]);

      const html = await thePage();
      const left = (name: string) => Number(new RegExp(`<span class="nm">${name}</span>.*?<div class="b" style="left:([\\d.]+)%`, 's').exec(html)![1]);

      // Writing 10m of 21m starts Local checks, whose first kind starts with it; CI rounds start after its 5m.
      expect(left('Local checks')).toBeCloseTo(47.62, 1);
      expect(left('Code review')).toBeCloseTo(47.62, 1);
      expect(left('Security review')).toBeCloseTo(47.62 + (3 / 21) * 100, 1);
      expect(left('CI rounds')).toBeCloseTo(((10 + 5) / 21) * 100, 1);
      expect(html).toContain('class="band"');
    });

    it('is drawn on Over time only', async () => {
      await sendPulls([split(1, kinds)]);

      expect(outlineOf(await thePage('?group=pr'))).toEqual([]);
    });
  });

  describe("any row of Over time, Pull request, Issue and Size opens to its own outline, on the table's measure", () => {
    /** Each row's figures as the page carries them, in minutes, named for the outline row each belongs to; a row with no minutes in it has no entry. */
    function stripsOf(html: string): Record<string, number>[] {
      const slots = JSON.parse(/<script type="application\/json" id="outline-slots">(.*?)<\/script>/s.exec(html)![1]!) as [string, number, number, string][];
      return [...html.matchAll(/<tr data-figures="([^"]*)">/g)].map((m) => Object.fromEntries(m[1]!.split(',').flatMap((figure, i) => (figure === '' ? [] : [[slots[i]![0], parseInt(figure, 36) / MIN]]))));
    }
    /** A recorded pull request of `writing` minutes whose time adds up to its own start to merge. */
    const writing = (number: number, minutes: number, mergedAt = '2026-10-30T10:00:00Z', over: Record<string, unknown> = {}) => recorded(number, mergedAt, { codingMs: minutes * MIN, totalMs: (minutes + 11) * MIN, ...over });
    const startToMerge = (row: string[]) => row[row.length - 3];

    it("a day's row is its pull requests' outline on average, which adds up to the row's own start to merge", async () => {
      await sendPulls([writing(1, 3), writing(2, 9), writing(3, 18)]);

      const html = await thePage();
      const [row] = rowsOf(html, 'cycle-table');
      const [strip] = stripsOf(html);

      expect(startToMerge(row!)).toBe('21m');
      expect(strip).toEqual({ Writing: 10, 'Local checks': 5, 'Not split by kind': 5, 'CI rounds': 5, Test: 5, 'Waiting to merge': 1 });
      expect(strip!.Writing! + strip!['Local checks']! + strip!['CI rounds']! + strip!['Waiting to merge']!).toBe(21);
    });

    it("a pull request's row is its own outline, its local checks split by kind", async () => {
      await sendPulls([writing(1, 10, '2026-10-30T10:00:00Z', { localParts: { 'code-review': 3 * MIN, 'security-review': 2 * MIN, test: 0, browser: 0 } })]);

      const [strip] = stripsOf(await thePage('?group=pr'));

      expect(strip).toEqual({ Writing: 10, 'Local checks': 5, 'Code review': 3, 'Security review': 2, 'CI rounds': 5, Test: 5, 'Waiting to merge': 1 });
    });

    it('a row with no minutes in it carries no figures, so it is not offered to open to an empty strip', async () => {
      const sent = await sendPulls([writing(1, 10), recorded(2, '2026-10-29T10:00:00Z', { rounds: [cycleRound([cycleCheck('Test', 0, { last: true })])], ciMs: 0, totalMs: 0, codingMs: 0, localMs: 0, waitingToMergeMs: 0, awayMs: 0, localReviews: { count: 0, ms: 0, byKind: { 'code-review': { count: 0, ms: 0 }, 'security-review': { count: 0, ms: 0 } } } })]);
      expect(sent.status).toBe(200);

      const html = await thePage('?group=pr');

      const row = (number: number) => html.match(new RegExp(`<tr[^>]*>(?:(?!</tr>).)*?#${number}\\b.*?</tr>`, 's'))?.[0];

      expect(row(1)).toMatch(/^<tr data-figures="[^"]+">/);
      expect(row(2)).toMatch(/^<tr>/);
    });

    it("an issue's row adds its two pull requests up, not averages them", async () => {
      await sendPulls([writing(1, 4, '2026-10-29T10:00:00Z'), writing(2, 8)]);
      await costing(1, null, 7);
      await costing(2, null, 7);

      const html = await thePage('?group=issue');
      const [strip] = stripsOf(html);

      expect(rowsOf(html, 'cycle-table')).toHaveLength(1);
      expect(strip).toEqual({ Writing: 12, 'Local checks': 10, 'Not split by kind': 10, 'CI rounds': 10, Test: 10, 'Waiting to merge': 2 });
    });

    it("a size's row is its pull requests' outline on average, one row to each size", async () => {
      const large = { size: { additions: 1900, deletions: 100, files: 20, commits: 3, mainMerges: 0 } };
      await sendPulls([writing(1, 4), writing(2, 8), writing(3, 20, '2026-10-30T10:00:00Z', large)]);

      const strips = stripsOf(await thePage('?group=size'));

      expect(strips.map((s) => s.Writing)).toEqual([6, 20]);
      expect(strips.map((s) => s['CI rounds'])).toEqual([5, 5]);
    });

    it('a row whose pull requests were stored without their kinds has its local minutes as Not split by kind, and a mixed day counts only those', async () => {
      await sendPulls([
        writing(1, 10, '2026-10-30T10:00:00Z', { localParts: { 'code-review': 3 * MIN, 'security-review': 2 * MIN, test: 0, browser: 0 } }),
        writing(2, 10),
      ]);

      const [strip] = stripsOf(await thePage());

      expect(strip).toMatchObject({ 'Local checks': 5, 'Code review': 1.5, 'Security review': 1, 'Not split by kind': 2.5 });
    });

    it.each([
      { tab: 'day', query: '' },
      { tab: 'pr', query: '?group=pr' },
      { tab: 'issue', query: '?group=issue' },
      { tab: 'size', query: '?group=size' },
    ])('the $tab tab sends each row with its figures and nothing else to open: the strips and the chevrons are drawn in the browser, so a page without it is as it was', async ({ query }) => {
      await sendPulls([writing(1, 10), writing(2, 10, '2026-10-29T10:00:00Z')]);

      const html = await thePage(query);
      const markup = html.replace(/<style>.*?<\/style>/s, '').replace(/<script>.*?<\/script>/gs, '');

      expect(html.match(/<tr data-figures="/g)?.length).toBeGreaterThan(0);
      expect(html).toContain('<table class="openable">');
      for (const part of ['class="chev"', 'class="detail"', 'open-cell']) expect(markup).not.toContain(part);
    });

    it('carries a pull request’s figures in under a hundred characters, a row of the page weighing little for being openable', async () => {
      await sendPulls([writing(1, 10, '2026-10-30T10:00:00Z', { localParts: { 'code-review': 3 * MIN, 'security-review': 2 * MIN, test: 0, browser: 0 } })]);

      const [figures] = [...(await thePage('?group=pr')).matchAll(/<tr data-figures="([^"]*)">/g)].map((m) => m[1]!);

      expect(figures!.length).toBeLessThan(100);
    });

    it.each([['?group=check'], ['?group=check&period=3d']])('the Check tab’s rows do not open, at %s', async (query) => {
      await sendPulls([writing(1, 10)]);

      const html = await thePage(query);
      const markup = html.replace(/<style>.*?<\/style>/s, '');

      expect(hasSection(html, 'by-check')).toBe(true);
      // The only script it carries is the (i)'s: the rows' own, which names `openable`, is not sent where nothing opens.
      for (const part of ['data-figures', 'openable', 'outline-slots']) expect(markup).not.toContain(part);
    });
  });

  describe('tiles and overview panels are on Over time only', () => {
    beforeEach(async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z'), recorded(2, '2026-10-29T10:00:00Z', { rounds: [red(), green()] })]);
    });

    it('Over time draws the four tiles, where the time went, the writing against the harness and the per-pull-request chart', async () => {
      const html = await thePage();

      expect([...html.matchAll(/class="tile-label">(.*?)<button/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''))).toEqual(['Start to merge', 'In the harness', 'CI rounds', 'Claude Code cost']);
      for (const id of ['where-it-went', 'writing-against-harness', 'per-pull-request']) expect(hasSection(html, id)).toBe(true);
    });

    it.each([['pr'], ['issue'], ['size'], ['check']])('the %s tab draws none of them', async (group) => {
      const html = await thePage(`?group=${group}`);

      expect(html).not.toContain('class="tile');
      for (const id of ['where-it-went', 'writing-against-harness', 'per-pull-request']) expect(hasSection(html, id)).toBe(false);
    });
  });

  describe('nothing merged in the period shows "nothing in this period"', () => {
    it.each([['day'], ['pr'], ['issue'], ['size'], ['check']])('on the %s tab', async (group) => {
      await sendPulls([recorded(1, '2026-10-01T10:00:00Z')]);

      expect(text(await thePage(`?group=${group}&period=3d`))).toContain('Nothing in this period');
    });

    it('with nothing stored at all', async () => {
      expect(text(await thePage())).toContain('Nothing in this period');
    });

    it('says how few of the period’s days are stored while the store is young', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z')]);

      expect(text(await thePage('?period=7d'))).toContain('Only 2 of the period s 7 days are stored so far');
    });
  });

  describe('the Check tab gives each check the rounds it held and the rounds it finished last', () => {
    it('reads a check held in 3 rounds and finishing last in 2, beside one held in 3 and finishing last in 1', async () => {
      await sendPulls([
        recorded(1, '2026-10-30T10:00:00Z', { rounds: [cycleRound([cycleCheck('E2E (F3)', 8 * MIN), cycleCheck('Test', 6 * MIN, { last: true })], { ms: 8 * MIN })] }),
        recorded(2, '2026-10-29T10:00:00Z', {
          rounds: [
            cycleRound([cycleCheck('Test', 3 * MIN), cycleCheck('E2E (F3)', 9 * MIN, { last: true, failure: 'red', failedSteps: ['Run the walks'] })], { ms: 9 * MIN, red: true }),
            cycleRound([cycleCheck('Test', 3 * MIN), cycleCheck('E2E (F3)', 7 * MIN, { last: true })], { ms: 7 * MIN }),
          ],
        }),
      ]);

      const rows = rowsOf(await thePage('?group=check'), 'by-check');

      // Check, rounds held, finished last, bar, minutes, share, median, red rounds, flukes, queue.
      expect(rows.map((r) => [r[0], r[1], r[2], r[7]])).toEqual([
        ['E2E (F3) red on #2', '3', '2', '1'],
        ['Test', '3', '1', '—'],
      ]);
    });
  });

  describe('each part of a pull request’s time has its own colour, and what is neither is grey and stacks last', () => {
    it('by phase, writing, local checks and CI rounds take the first three slots, waiting to merge blue and away grey', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { awayMs: 3 * MIN, totalMs: 24 * MIN })]);

      const html = await thePage();
      const phases = [['Writing', slot(1)], ['Local checks', slot(2)], ['CI rounds', slot(3)], ['Waiting to merge', slot(6)], ['Away', GREY]];

      expect(swatches(panelOf(html, 'per-pull-request'))).toEqual(phases);
      // The table has no swatch column: its Split bar draws the same colours, in the same order.
      const bar = /<div class="split">(.*?)<\/div><\/td>/s.exec(panelOf(html, 'cycle-table'))![1]!;
      expect([...bar.matchAll(/background:([^";]*)/g)].map((m) => m[1])).toEqual(phases.map(([, colour]) => colour));
    });

    it('a dot of the scatter is violet, and red from three rounds', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z'), recorded(2, '2026-10-29T10:00:00Z', { rounds: [red(), red(), green()] })]);

      const scatter = panelOf(await thePage(), 'writing-against-harness');

      expect([...scatter.matchAll(/<circle [^>]*stroke="([^"]*)" class="dot"><title>#(\d+)/g)].map((m) => [m[2], m[1]])).toEqual(expect.arrayContaining([['1', slot(1)], ['2', RED]]));
      expect(swatches(scatter).slice(0, 2)).toEqual([['a pull request', slot(1)], ['3 rounds or more', RED]]);
    });

    it('in the outline, each phase is in its slot and a part is in its phase’s colour, grey where it is not a named part', async () => {
      const kinds = { 'code-review': 3 * MIN, 'security-review': 2 * MIN, test: 0, browser: 0 };
      const checks = ['Test', 'Mystery check'].map((name, i) => cycleCheck(name, 3 * MIN, { last: i === 1 }));
      await sendPulls([
        recorded(1, '2026-10-30T10:00:00Z', { localParts: kinds, awayMs: MIN, totalMs: 22 * MIN, rounds: [cycleRound(checks, { ms: 6 * MIN })], ciMs: 6 * MIN }),
        recorded(2, '2026-10-29T10:00:00Z'),
      ]);

      const rows = [...(/<ul class="outline".*?<\/ul>/s.exec(await thePage())?.[0] ?? '').matchAll(/<span class="nm">(.*?)<\/span>.*?class="b" style="[^"]*background:([^";]*)"/gs)].map((m) => [m[1], m[2]]);

      expect(rows).toEqual([
        ['Writing', slot(1)],
        ['Local checks', slot(2)],
        ['Code review', slot(2)],
        ['Security review', slot(2)],
        ['Not split by kind', GREY],
        ['CI rounds', slot(3)],
        ['Test', slot(3)],
        ['Other checks', GREY],
        ['Waiting to merge', slot(6)],
        ['Away', GREY],
      ]);
    });
    it('on the Check tab, a check CI does not run today is grey, and each of the others is in its slot, Contract tests in blue', async () => {
      const checks = ['E2E (F3)', 'Test', 'Checks', 'Test Explorer', 'Contract tests', 'Mystery check'].map((name, i) => cycleCheck(name, (6 - i) * MIN, { last: i === 5 }));
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { rounds: [cycleRound(checks, { ms: 21 * MIN })] })]);

      const byCheck = swatches(panelOf(await thePage('?group=check'), 'by-check'));

      expect(byCheck).toEqual([
        ['E2E (F3)', slot(1)],
        ['Test', slot(2)],
        ['Checks', slot(3)],
        ['Test Explorer', slot(4)],
        ['Contract tests', slot(6)],
        ['Mystery check', GREY],
      ]);
    });
  });

  describe('every tile, chart and table of Cycle time explains itself behind an (i) beside its heading or label', () => {
    beforeEach(async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z'), recorded(2, '2026-10-29T10:00:00Z', { rounds: [red(), green()] })]);
    });

    it.each([
      { tile: 'Start to merge', id: 't-start' },
      { tile: 'In the harness', id: 't-harness' },
      { tile: 'CI rounds', id: 't-rounds' },
      { tile: 'Claude Code cost', id: 't-cost' },
    ])('the $tile tile carries its own (i), whose explanation says what it shows, how to read it and what to look for', async ({ tile, id }) => {
      const html = await thePage();

      expect(tileOf(html, tile)).toContain(`data-pop="x-${id}"`);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { panel: 'where-it-went', id: 'where' },
      { panel: 'writing-against-harness', id: 'scatter' },
      { panel: 'per-pull-request', id: 'over-time' },
    ])('the $panel chart carries its own (i), with the three parts', async ({ panel, id }) => {
      const html = await thePage();

      expect(infoOfPanel(html, panel)).toBe(id);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { tab: 'Over time', query: '', id: 't-day' },
      { tab: 'Pull request', query: '?group=pr', id: 't-pr' },
      { tab: 'Issue', query: '?group=issue', id: 't-issue' },
      { tab: 'Size', query: '?group=size', id: 't-size' },
    ])('the $tab tab’s table carries an (i) saying what it shows', async ({ query, id }) => {
      const html = await thePage(query);

      expect(infoOfPanel(html, 'cycle-table')).toBe(id);
      expect(partsOf(html, id)).toEqual(['What it shows']);
    });

    it('the Check tab’s table, drawn apart from the others, carries one too', async () => {
      const html = await thePage('?group=check');

      expect(infoOfPanel(html, 'by-check')).toBe('t-check');
      expect(partsOf(html, 't-check')).toEqual(['What it shows']);
    });

    it('draws each (i) once, each to an explanation of its own on the page', async () => {
      const html = await thePage();
      const buttons = [...html.matchAll(/<button [^>]*data-pop="(x-[^"]*)"/g)].map((m) => m[1]);
      const panels = [...html.matchAll(/<div id="(x-[^"]*)" popover="manual"/g)].map((m) => m[1]);

      // Four tiles, three charts and the table.
      expect(buttons).toHaveLength(8);
      expect(new Set(buttons).size).toBe(8);
      expect(panels.sort()).toEqual([...buttons].sort());
    });
  });

  describe('a table with nothing to list still carries its (i) over the empty panel', () => {
    it.each([
      { situation: 'Over time, in a period with no merged pull request', query: '?period=3d', panel: 'cycle-table', id: 't-day', says: 'Nothing in this period' },
      { situation: 'Pull request, in a period with no merged pull request', query: '?group=pr&period=3d', panel: 'cycle-table', id: 't-pr', says: 'Nothing in this period' },
      { situation: 'Check, in a period with no merged pull request', query: '?group=check&period=3d', panel: 'by-check', id: 't-check', says: 'Nothing in this period' },
    ])('$situation', async ({ query, panel, id, says }) => {
      await sendPulls([recorded(3, '2026-10-01T10:00:00Z')]);

      const html = await thePage(query);

      expect(text(panelOf(html, panel))).toContain(says);
      expect(infoOfPanel(html, panel)).toBe(id);
      expect(partsOf(html, id)).toEqual(['What it shows']);
    });

    it('Check, over pull requests that held no CI round', async () => {
      await sendPulls([recorded(3, '2026-10-30T11:00:00Z', { rounds: [], ciMs: 0 })]);

      const html = await thePage('?group=check');

      expect(text(panelOf(html, 'by-check'))).toContain('No CI round in these pull requests');
      expect(infoOfPanel(html, 'by-check')).toBe('t-check');
      expect(partsOf(html, 't-check')).toEqual(['What it shows']);
    });
  });

  describe('a section is named for a screen reader by its title alone, not by the (i) beside it or the explanation it opens', () => {
    beforeEach(async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z')]);
    });

    it.each([
      { situation: 'Where the time went', query: '', id: 'where-it-went', title: 'Where the 21m went' },
      { situation: 'Writing against the harness', query: '', id: 'writing-against-harness', title: 'Writing against the harness' },
      { situation: 'the per-pull-request chart', query: '', id: 'per-pull-request', title: 'Start to merge, each pull request as it merged' },
      { situation: 'the Over time table', query: '', id: 'cycle-table', title: 'By day merged' },
      { situation: 'the Check table', query: '?group=check', id: 'by-check', title: 'By check' },
    ])('$situation is labelled by a heading that holds only its title', async ({ query, id, title }) => {
      const html = await thePage(query);

      expect(html).toContain(`aria-labelledby="${id}"`);
      expect(new RegExp(`<h2 id="${id}">([^<]*)</h2>`).exec(html)?.[1]).toBe(title);
    });
  });

  describe('each top tab names the question its page answers on pointing', () => {
    it.each([
      { tab: 'Claude Code costs', question: 'What does building this app with Claude Code cost, and where does the money go?' },
      { tab: 'Cockpit’s Claude calls', question: 'What do the app’s own AI features cost to run?' },
      { tab: 'Cycle time', question: 'How long does a change take to land, and how much of that is waiting on checks rather than writing?' },
      { tab: 'Test selection', question: 'Does CI run only the tests a change can affect?' },
      { tab: 'Tests', question: 'What do the tests cover, and at which level?' },
      { tab: 'CI stability', question: 'How often do the automated checks fail, and which ones?' },
    ])('the $tab tab carries its question', async ({ tab, question }) => {
      const bar = [...(await thePage()).matchAll(/<nav class="pages".*?<\/nav>/gs)][0]![0];
      const tabs = [...bar.matchAll(/<a [^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[2]!.replace(/&rsquo;/g, '’'), m[1]!.replace(/&rsquo;/g, '’')]);

      expect(tabs).toContainEqual([tab, question]);
      expect(tabs).toHaveLength(6);
    });
  });

  describe('Cycle time opens with the question its tab names and what “the harness” means, above the filters, on every tab', () => {
    it.each([[''], ['?group=pr'], ['?group=issue'], ['?group=size'], ['?group=check']])('at %s', async (query) => {
      const html = await thePage(query);
      const [lead] = [...html.matchAll(/<div class="lead">(.*?)<\/div>/gs)];

      expect(text(lead![1]!)).toContain('How long does a change take to land, and how much of that is waiting on checks rather than writing?');
      expect(text(lead![1]!)).toContain('The harness is everything that checks the agent s work before it lands');
      expect(html.indexOf('class="lead"')).toBeGreaterThan(html.indexOf('</header>'));
      expect(html.indexOf('class="lead"')).toBeLessThan(html.indexOf('<form class="filters"'));
    });
  });

  describe('a fixed note is said once, in its explanation; a note read from the figures stays on its chart', () => {
    it('Where the time went no longer has the fixed note under it, and its explanation says it', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { localParts: { 'code-review': 3 * MIN, 'security-review': 2 * MIN, test: 0, browser: 0 } })]);

      const html = await thePage();
      const well = /<div class="well where">.*?<\/section>/s.exec(html)![0];

      expect(text(well)).not.toContain('Every bar is on one scale');
      expect(text(well)).not.toContain('Each minute counts once');
      expect(well).not.toContain('class="note"');
      expect(text(html.match(/<div id="x-where".*?<\/div>/s)![0])).toContain('Each minute counts once: time two local checks shared goes to the one that finished last.');
    });

    it('a pull request carrying no session record still has its note under Where the time went', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { recorded: false, codingMs: null, localMs: null, localReviews: null, totalMs: 21 * MIN, start: { at: '2026-10-30T09:39:00Z', from: 'first-commit' } })]);

      const well = /<div class="well where">.*?<\/section>/s.exec(await thePage())![0];

      expect(text(well)).toContain('1 pull request here carries no session record');
      expect(well).toContain('<p class="note">');
    });

    it('the scatter still says under it how many pull requests spent longer in the harness than writing', async () => {
      // 4 minutes of writing against 10 of checking, and 30 against 10.
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { codingMs: 4 * MIN, totalMs: 15 * MIN }), recorded(2, '2026-10-29T10:00:00Z', { codingMs: 30 * MIN, totalMs: 41 * MIN })]);

      const well = /<div class="well scatter-well">.*?<\/section>/s.exec(await thePage())![0];

      expect(text(well)).toContain('1 of 2 pull requests spent longer in the harness than writing');
    });
  });
});
