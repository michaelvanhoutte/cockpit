import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GREY, panelOf, RED, slot, swatches } from './series-colours';
import { cycleCheck, cyclePull, cycleRound, emptyTheDatabase, send, sendPulls, spend, theSentence, withPrices } from './support';

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

/** The outline's rows as read: name, the time spent named under a phase's name, minutes and share, and whether the row is a part of a phase. */
const outlineOf = (html: string) =>
  [...(/<ul class="outline".*?<\/ul>/s.exec(html)?.[0] ?? '').matchAll(/<li class="o-row (o-pt|o-ph)"><span class="nm">(.*?)<\/span><div class="tr">.*?<span class="am[^"]*">(.*?)<\/span><span class="sh">(.*?)<\/span><\/li>/gs)].map((m) => {
    const [, name, spent] = /^(.*?)(?: <span class="spent">(.*)<\/span>)?$/s.exec(m[2]!)!;
    return { part: m[1] === 'o-pt', name: name!, ...(spent === undefined ? {} : { spent }), amount: m[3]!, share: m[4]! };
  });
const columnHeads = (html: string, id: string) => [...(new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '').matchAll(/<th scope="col"[^>]*>(?:<i[^>]*><\/i>)?([^<]+)<\/th>/g)].map((m) => m[1]);
/** What hovering each row's Split bar says, a row to an entry, in the table's order; undefined where the row has no hover. */
const hoversOf = (html: string, id: string) =>
  [...(new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '').matchAll(/<tr[ >].*?<\/tr>/gs)]
    .filter((row) => row[0].includes('class="split-cell"'))
    .map((row) => /<td class="split-cell"(?: title="([^"]*)")?>/.exec(row[0])![1]);
const hasSection = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}"`).test(html);
const text = (html: string) => html.replace(/<style>.*?<\/style>/s, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
const MIN = 60_000;

/** A check attempt that held a round `minutes` and ran for `running` of them, which defaults to all. */
const ran = (name: string, minutes: number, over: Record<string, unknown> = {}) => cycleCheck(name, minutes * MIN, { runningMs: minutes * MIN, ...over });
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
const green = (minutes = 5) => cycleRound([ran('Test', minutes, { last: true })], { ms: minutes * MIN });
/** One round of `Test` that went red at the step `Run the tests`. */
const red = (minutes = 5) => cycleRound([ran('Test', minutes, { last: true, failure: 'red', failedSteps: ['Run the tests'] })], { ms: minutes * MIN, red: true });

/** A recorded pull request: 10 minutes of writing, 5 of local checks, the rounds, a minute waiting to merge. */
const recorded = (number: number, mergedAt: string, over: Record<string, unknown> = {}) => {
  const rounds = (over.rounds as unknown[] | undefined) ?? [green()];
  return cyclePull(number, { mergedAt, rounds, ciMs: 5 * MIN * rounds.length, totalMs: (16 + 5 * rounds.length) * MIN, ...over });
};

/** Local reviews stored without their split by kind: what a pull request recorded before the kinds has. */
const NO_KINDS = { localReviews: { count: 2, ms: 5 * MIN, byKind: null } };

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
      expect([...html.matchAll(/<nav class="pages".*?<\/nav>/gs)][0]![0].match(/>([^<]+)<\/a>/g)).toEqual(['>Claude Code costs</a>', '>Cockpit&rsquo;s Claude calls</a>', '>Cycle time</a>', '>Test selection</a>', '>Test coverage</a>', '>CI stability</a>']);
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
      // A Size filter repeats the rows of the Size tab, so that tab does not take it.
      for (const group of query.includes('size=') ? ['day', 'issue'] : ['day', 'issue', 'size']) expect(await accounted(query, group)).toBe(count);
      expect(await accounted(query, 'check')).toEqual(checks);
    });

    it('the Size tab lists every size whatever Size the address names', async () => {
      expect(await accounted('&size=l', 'size')).toBe(3);
    });

    it('choosing other rows submits the period and the filters with them, in the one form', async () => {
      const html = await thePage('?period=7d&size=xs&outcome=green&group=pr');
      const { choices } = theSentence(html);

      expect(html.match(/<form /g)).toHaveLength(1);
      expect(Object.keys(choices)).toEqual(['group', 'period', 'size', 'outcome']);
      expect(choices.period).toMatchObject({ chosen: 'in the last 7 days', held: false });
      expect([choices.size!.held, choices.outcome!.held]).toEqual([true, true]);
    });
  });

  describe('the sentence says what the page shows, and offers only what it can', () => {
    it('the bare address reads each day merged at any time held, with Size and Rounds under Only, neither holding a value', async () => {
      const { text, choices } = theSentence(await thePage());

      expect(text).toBe('Show cycle time for [each day] merged [at any time held]');
      expect(choices.group!.offered).toEqual(['each day', 'each pull request', 'each issue', 'each size', 'each check']);
      expect(choices.period!.offered).toEqual(['in the last 3 days', 'in the last 7 days', 'at any time held']);
      expect(Object.keys(choices)).toEqual(['group', 'period', 'size', 'outcome']);
      expect(Object.values(choices).filter((c) => c.held)).toEqual([]);
    });

    it('each size has no Size filter, and each pull request has one', async () => {
      expect(Object.keys(theSentence(await thePage('?group=size&size=l')).choices)).toEqual(['group', 'period', 'outcome']);
      expect(Object.keys(theSentence(await thePage('?group=pr&size=l')).choices)).toEqual(['group', 'period', 'size', 'outcome']);
    });

    it.each(['', '?group=pr', '?group=issue', '?group=size', '?group=check'])('has no grouping tabs and no labelled filter row at %s', async (query) => {
      const html = await thePage(query);

      for (const gone of ['band-tabs', 'aria-label="Group by"', 'class="filters"', 'class="toggles"', '<label ']) expect(html).not.toContain(gone);
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

  describe("Where the time went is one outline: phases as time waited, with Local checks and CI rounds opened into their parts as time spent", () => {
    // Two pull requests merged within the day, 21 minutes each: 10 writing, 5 local checks (3 + 2 of reviews), 5 of Test, a minute waiting.
    const split = (number: number, parts: Record<string, number>, over: Record<string, unknown> = {}) => recorded(number, '2026-10-30T10:00:00Z', { localParts: parts, ...over });
    const kinds = { 'code-review': 3 * MIN, 'security-review': 2 * MIN, test: 0, browser: 0 };
    /** The outline's row of a name, as drawn: its markup, from its list item to the next. */
    const rowOf = (html: string, name: string) => new RegExp(`<li class="o-row [^"]*"><span class="nm">${name}[ <].*?</li>`, 's').exec(/<ul class="outline".*?<\/ul>/s.exec(html)![0])![0];
    const styleOf = (markup: string, cls: string) => {
      const m = new RegExp(`<div class="${cls}" style="left:([\\d.]+)%;width:([\\d.]+)%`).exec(markup);
      return m === null ? null : { left: Number(m[1]), width: Number(m[2]) };
    };

    it('lists the phases in order as time waited, the local checks opened into their kinds and CI rounds into its checks as time spent, each with its minutes and share', async () => {
      await sendPulls([split(1, kinds), split(2, kinds)]);

      expect(outlineOf(await thePage())).toEqual([
        { part: false, name: 'Writing', amount: '20m', share: '48%' },
        { part: false, name: 'Local checks', spent: '10m spent', amount: '10m waited', share: '24%' },
        { part: true, name: 'Code review', amount: '6m spent', share: '60%' },
        { part: true, name: 'Security review', amount: '4m spent', share: '40%' },
        { part: false, name: 'CI rounds', spent: '10m spent', amount: '10m waited', share: '24%' },
        { part: true, name: 'Test', amount: '10m spent', share: '100%' },
        { part: false, name: 'Waiting to merge', amount: '2m', share: '5%' },
      ]);
    });

    it("reads each kind's own minutes as the session recorded them, so a phase's time spent is more than the minutes waited where kinds ran at once", async () => {
      // A code review of 5 minutes, a test run of 4 and a browser pass of 1, all inside the 5 minutes the checks ran.
      await sendPulls([
        split(1, { 'code-review': 5 * MIN, 'security-review': 0, test: 0, browser: 0 }, { localReviews: { count: 1, ms: 5 * MIN, byKind: { 'code-review': { count: 1, ms: 5 * MIN }, 'security-review': { count: 0, ms: 0 } } }, localRuns: { test: { count: 1, ms: 4 * MIN }, browser: { count: 1, ms: MIN } } }),
      ]);

      expect(outlineOf(await thePage()).filter((r) => r.name === 'Local checks' || r.part).slice(0, 4)).toEqual([
        { part: false, name: 'Local checks', spent: '10m spent side by side', amount: '5m waited', share: '24%' },
        { part: true, name: 'Code review', amount: '5m spent', share: '50%' },
        { part: true, name: 'Test runs', amount: '4m spent', share: '40%' },
        { part: true, name: 'Browser pass', amount: '1m spent', share: '10%' },
      ]);
    });

    it('draws a pull request stored without its kinds as Not split by kind under Local checks, as time spent', async () => {
      await sendPulls([split(1, kinds), recorded(2, '2026-10-30T10:00:00Z', NO_KINDS)]);

      const rows = outlineOf(await thePage());

      expect(rows.filter((r) => r.part).map((r) => [r.name, r.amount])).toEqual([
        ['Code review', '3m spent'],
        ['Security review', '2m spent'],
        ['Not split by kind', '5m spent'],
        ['Test', '10m spent'],
      ]);
      expect(text(await thePage())).toContain('1 pull request here was stored without the kinds of local check');
    });

    it('titles the panel with the time it covers and counts the pull requests', async () => {
      await sendPulls([split(1, kinds), split(2, kinds)]);

      const panel = panelOf(await thePage(), 'where-it-went');

      expect(panel).toContain('<h2 id="where-it-went">Where the 42m went</h2>');
      expect(panel).toContain('<span class="aside">2 pull requests</span>');
    });

    it('starts each part where its phase starts at its own length, with a dashed line where the phase ends', async () => {
      await sendPulls([split(1, kinds)]);

      const html = await thePage();
      const local = styleOf(rowOf(html, 'Local checks'), 'b')!;
      const review = rowOf(html, 'Code review');
      const security = rowOf(html, 'Security review');

      // Writing is 10 of 21 minutes, Local checks wait 5 of them; code review spent 3 and security review 2.
      expect(local.left).toBeCloseTo((10 / 21) * 100, 1);
      expect(styleOf(review, 'b')!.left).toBeCloseTo(local.left, 1);
      expect(styleOf(security, 'b')!.left).toBeCloseTo(local.left, 1);
      expect(styleOf(review, 'b')!.width).toBeCloseTo((3 / 21) * 100, 1);
      expect(styleOf(security, 'b')!.width).toBeCloseTo((2 / 21) * 100, 1);
      expect(styleOf(review, 'band')).toEqual({ left: local.left, width: local.width });
      expect(Number(/<div class="edge" style="left:([\d.]+)%/.exec(review)![1])).toBeCloseTo(((10 + 5) / 21) * 100, 1);
      expect(rowOf(html, 'Local checks')).not.toContain('class="edge"');
    });

    it("runs a check that ran longer in total than the round waited past the dashed line, and one longer than the rest of the scale to the scale's end with its minutes in full", async () => {
      // A round that held the pull request 5 minutes, in which E2E ran four shards of 10 minutes and Test an hour.
      const shards = [1, 2, 3, 4].map((n) => ran('E2E (F3)', 5, { attempt: n, runningMs: 10 * MIN }));
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { rounds: [cycleRound([...shards, ran('Test', 5, { runningMs: 60 * MIN, last: true })], { ms: 5 * MIN })] })]);

      const html = await thePage();
      const e2e = rowOf(html, 'E2E \\(F3\\)');
      const test = rowOf(html, 'Test');
      const edge = Number(/<div class="edge" style="left:([\d.]+)%/.exec(e2e)![1]);
      const long = styleOf(test, 'b')!;

      expect(styleOf(e2e, 'b')!.left + styleOf(e2e, 'b')!.width).toBeGreaterThan(edge);
      expect(long.left + long.width).toBeCloseTo(100, 1);
      expect(outlineOf(html).find((r) => r.name === 'Test')!.amount).toBe('1h 00m spent');
    });

    it('draws a check whose running time is not recorded as not recorded, with no bar and no share, and its phase with no time spent to name', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { rounds: [cycleRound([cycleCheck('Test', 5 * MIN, { last: true })], { ms: 5 * MIN })] })]);

      const html = await thePage();

      expect(outlineOf(html).filter((r) => r.name === 'CI rounds' || r.name === 'Test')).toEqual([
        { part: false, name: 'CI rounds', spent: 'time spent not recorded', amount: '5m waited', share: '24%' },
        { part: true, name: 'Test', amount: 'not recorded', share: '—' },
      ]);
      expect(rowOf(html, 'Test')).not.toContain('class="b"');
      expect(rowOf(html, 'Test')).toContain('class="edge"');
      expect(text(html)).toContain('1 pull request here has a check with no running time recorded');
    });

    it('is drawn on Over time only', async () => {
      await sendPulls([split(1, kinds)]);

      expect(outlineOf(await thePage('?group=pr'))).toEqual([]);
    });
  });

  describe("any row of Over time, Pull request, Issue and Size opens to its own outline, on the table's measure", () => {
    /** Each row's figures as the page carries them, in minutes, named for the outline row each belongs to, null for a part's time spent not recorded; a row with no minutes in it has no entry. */
    function stripsOf(html: string): Record<string, number | null>[] {
      const slots = JSON.parse(/<script type="application\/json" id="outline-slots">(.*?)<\/script>/s.exec(html)![1]!) as [string, number, number, string][];
      return [...html.matchAll(/<tr data-figures="([^"]*)"[^>]*>/g)].map((m) => Object.fromEntries(m[1]!.split(',').flatMap((figure, i) => (figure === '' ? [] : [[slots[i]![0], figure === '-' ? null : parseInt(figure, 36) / MIN]]))));
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
      expect(strip).toEqual({ Writing: 10, 'Local checks': 5, 'Code review': 3, 'Security review': 2, 'CI rounds': 5, Test: 5, 'Waiting to merge': 1 });
      expect(strip!.Writing! + strip!['Local checks']! + strip!['CI rounds']! + strip!['Waiting to merge']!).toBe(21);
    });

    it("a pull request's row is its own outline, its local checks split by kind", async () => {
      await sendPulls([writing(1, 10, '2026-10-30T10:00:00Z', { localParts: { 'code-review': 3 * MIN, 'security-review': 2 * MIN, test: 0, browser: 0 } })]);

      const [strip] = stripsOf(await thePage('?group=pr'));

      expect(strip).toEqual({ Writing: 10, 'Local checks': 5, 'Code review': 3, 'Security review': 2, 'CI rounds': 5, Test: 5, 'Waiting to merge': 1 });
    });

    it.each([
      { tab: 'pull request', query: '?group=pr', named: [2, 1], count: 'both' },
      { tab: 'day', query: '', named: [], count: 'none' },
      { tab: 'issue', query: '?group=issue', named: [], count: 'none' },
      { tab: 'size', query: '?group=size', named: [], count: 'none' },
    ])('only a pull request’s row names its pull request, for its E2E (F3) and Test lines to open what they selected: the $tab tab names $count', async ({ query, named }) => {
      await sendPulls([writing(1, 10, '2026-10-29T10:00:00Z'), writing(2, 10)]);
      await costing(1, null, 7);
      await costing(2, null, 7);

      const html = await thePage(query);

      expect([...html.matchAll(/<tr data-figures="[^"]*" data-pr="(\d+)">/g)].map((m) => Number(m[1]))).toEqual(named);
      expect(html.match(/<tr data-figures="/g)?.length).toBeGreaterThan(0);
    });

    it('a row with no minutes in it carries no figures, so it is not offered to open to an empty strip', async () => {
      const sent = await sendPulls([writing(1, 10), recorded(2, '2026-10-29T10:00:00Z', { rounds: [cycleRound([cycleCheck('Test', 0, { last: true })])], ciMs: 0, totalMs: 0, codingMs: 0, localMs: 0, waitingToMergeMs: 0, awayMs: 0, localReviews: { count: 0, ms: 0, byKind: { 'code-review': { count: 0, ms: 0 }, 'security-review': { count: 0, ms: 0 } } } })]);
      expect(sent.status).toBe(200);

      const html = await thePage('?group=pr');

      const row = (number: number) => html.match(new RegExp(`<tr[^>]*>(?:(?!</tr>).)*?#${number}\\b.*?</tr>`, 's'))?.[0];

      expect(row(1)).toMatch(/^<tr data-figures="[^"]+"( data-pr="1")?>/);
      expect(row(2)).toMatch(/^<tr>/);
    });

    it("an issue's row adds its two pull requests up, not averages them", async () => {
      await sendPulls([writing(1, 4, '2026-10-29T10:00:00Z'), writing(2, 8)]);
      await costing(1, null, 7);
      await costing(2, null, 7);

      const html = await thePage('?group=issue');
      const [strip] = stripsOf(html);

      expect(rowsOf(html, 'cycle-table')).toHaveLength(1);
      expect(strip).toEqual({ Writing: 12, 'Local checks': 10, 'Code review': 6, 'Security review': 4, 'CI rounds': 10, Test: 10, 'Waiting to merge': 2 });
    });

    it("a size's row is its pull requests' outline on average, one row to each size", async () => {
      const large = { size: { additions: 1900, deletions: 100, files: 20, commits: 3, mainMerges: 0 } };
      await sendPulls([writing(1, 4), writing(2, 8), writing(3, 20, '2026-10-30T10:00:00Z', large)]);

      const strips = stripsOf(await thePage('?group=size'));

      expect(strips.map((s) => s.Writing)).toEqual([6, 20]);
      expect(strips.map((s) => s['CI rounds'])).toEqual([5, 5]);
    });

    it('a row whose pull requests were stored without their kinds has its local minutes as Not split by kind, and a mixed day counts only those', async () => {
      await sendPulls([writing(1, 10), writing(2, 10, '2026-10-30T10:00:00Z', NO_KINDS)]);

      const [strip] = stripsOf(await thePage());

      expect(strip).toMatchObject({ 'Local checks': 5, 'Code review': 1.5, 'Security review': 1, 'Not split by kind': 2.5 });
    });

    it('a row carries a check’s time spent as it ran, which can be more than its phase waited, and a dash for one not recorded', async () => {
      // A round that held 5 minutes in which E2E ran four shards of 10 minutes; and a pull request whose Test attempt was stored without a running time.
      const shards = [1, 2, 3, 4].map((n) => ran('E2E (F3)', 5, { attempt: n, runningMs: 10 * MIN, last: n === 4 }));
      await sendPulls([writing(1, 10, '2026-10-30T10:00:00Z', { rounds: [cycleRound(shards, { ms: 5 * MIN })] }), writing(2, 10, '2026-10-29T10:00:00Z', { rounds: [cycleRound([cycleCheck('Test', 5 * MIN, { last: true })], { ms: 5 * MIN })] })]);

      const html = await thePage('?group=pr');
      const [newer, older] = stripsOf(html);
      const raw = [...html.matchAll(/<tr data-figures="([^"]*)"[^>]*>/g)].map((m) => m[1]!);

      expect(newer).toMatchObject({ 'CI rounds': 5, 'E2E (F3)': 40 });
      expect(older).toMatchObject({ 'CI rounds': 5, Test: null });
      expect(raw[1]).toContain('-');
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

      const [figures] = [...(await thePage('?group=pr')).matchAll(/<tr data-figures="([^"]*)"[^>]*>/g)].map((m) => m[1]!);

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
      const checks = ['Test', 'Mystery check'].map((name, i) => ran(name, 3, { last: i === 1 }));
      await sendPulls([
        recorded(1, '2026-10-30T10:00:00Z', { localParts: kinds, awayMs: MIN, totalMs: 22 * MIN, rounds: [cycleRound(checks, { ms: 6 * MIN })], ciMs: 6 * MIN }),
        recorded(2, '2026-10-29T10:00:00Z', NO_KINDS),
      ]);

      const rows = [...(/<ul class="outline".*?<\/ul>/s.exec(await thePage())?.[0] ?? '').matchAll(/<span class="nm">([^<]*).*?class="b" style="[^"]*background:([^";]*)"/gs)].map((m) => [m[1]!.trim(), m[2]]);

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
      { tab: 'Issue', query: '?group=issue', id: 't-issue' },
      { tab: 'Size', query: '?group=size', id: 't-size' },
    ])('the $tab tab’s table carries an (i) saying what it shows', async ({ query, id }) => {
      const html = await thePage(query);

      expect(infoOfPanel(html, 'cycle-table')).toBe(id);
      expect(partsOf(html, id)).toEqual(['What it shows']);
    });

    it('the Pull request tab’s (i) says what the timeline under an opened row shows and how to read it', async () => {
      const html = await thePage('?group=pr');
      const panel = new RegExp('<div id="x-t-pr" popover="manual" class="explain-pop">(.*?)</div>', 's').exec(html)![1]!;

      expect(infoOfPanel(html, 'cycle-table')).toBe('t-pr');
      expect(partsOf(html, 't-pr')).toEqual(THREE_PARTS);
      for (const said of ['its timeline', 'scale of up to four hours', 'CI Round is a push', 'a dotted lead', 'clock-time axis in Belgian time']) expect(panel.replace(/<[^>]+>/g, '')).toContain(said);
    });

    it('only the Pull request tab carries the timeline’s styles, since only its rows open one', async () => {
      const styled = async (query: string) => (await thePage(query)).includes('.tl-strip{');

      expect(await styled('?group=pr')).toBe(true);
      for (const query of ['', '?group=issue', '?group=size', '?group=check']) expect(await styled(query)).toBe(false);
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
      { situation: 'Over time, in a period with no merged pull request', query: '?period=3d', panel: 'cycle-table', id: 't-day', named: 'Over time', says: 'Nothing in this period' },
      { situation: 'Pull request, in a period with no merged pull request', query: '?group=pr&period=3d', panel: 'cycle-table', id: 't-pr', named: 'Pull request', says: 'Nothing in this period' },
      { situation: 'Check, in a period with no merged pull request', query: '?group=check&period=3d', panel: 'by-check', id: 't-check', named: 'By check', says: 'Nothing in this period' },
    ])('$situation', async ({ query, panel, id, named, says }) => {
      await sendPulls([recorded(3, '2026-10-01T10:00:00Z')]);

      const html = await thePage(query);

      expect(text(panelOf(html, panel))).toContain(says);
      // Named for the heading the empty panel wears, which a screen reader hears beside it.
      expect(panelOf(html, panel)).toContain(`aria-label="How to read ${named}"`);
      expect(infoOfPanel(html, panel)).toBe(id);
      expect(partsOf(html, id)).toEqual(id === 't-pr' ? THREE_PARTS : ['What it shows']);
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
      { tab: 'Test coverage', question: 'What do the tests cover, and at which level?' },
      { tab: 'CI stability', question: 'How often do the automated checks fail, and which ones?' },
    ])('the $tab tab carries its question', async ({ tab, question }) => {
      const bar = [...(await thePage()).matchAll(/<nav class="pages".*?<\/nav>/gs)][0]![0];
      const tabs = [...bar.matchAll(/<a [^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[2]!.replace(/&rsquo;/g, '’'), m[1]!.replace(/&rsquo;/g, '’')]);

      expect(tabs).toContainEqual([tab, question]);
      expect(tabs).toHaveLength(6);
    });
  });

  describe('Cycle time opens with the question its tab names and what “the harness” means, under the band’s sentence, on every tab', () => {
    it.each([[''], ['?group=pr'], ['?group=issue'], ['?group=size'], ['?group=check']])('at %s', async (query) => {
      const html = await thePage(query);
      const [lead] = [...html.matchAll(/<div class="lead">(.*?)<\/div>/gs)];

      expect(text(lead![1]!)).toContain('How long does a change take to land, and how much of that is waiting on checks rather than writing?');
      expect(text(lead![1]!)).toContain('The harness is everything that checks the agent s work before it lands');
      // Under the band's sentence, and before the first panel.
      expect(html.indexOf('class="lead"')).toBeGreaterThan(html.indexOf('</form>', html.indexOf('class="sentence-form"')));
      expect(html.indexOf('class="lead"')).toBeLessThan(html.indexOf('<section'));
    });
  });

  describe('a fixed note is said once, in its explanation; a note read from the figures stays on its chart', () => {
    it('Where the time went no longer has the fixed note under it, and its explanation says it', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { localParts: { 'code-review': 3 * MIN, 'security-review': 2 * MIN, test: 0, browser: 0 } })]);

      const html = await thePage();
      const well = /<div class="well where">.*?<\/section>/s.exec(html)![0];

      expect(text(well)).not.toContain('Phases are the time you waited');
      expect(text(well)).not.toContain('the dashed line is where the wait ended');
      expect(well).not.toContain('class="note"');
      const explanation = text(html.match(/<div id="x-where".*?<\/div>/s)![0]);
      expect(explanation).toContain('is as long as the time you waited, so the phases add up to start to merge');
      expect(explanation).toContain('The indented rows are the parts of the phase above them, as time spent: each starts where its phase starts and is drawn at its own length.');
      expect(explanation).toContain('The dashed line is where the phase s wait ended');
      expect(explanation).not.toContain('Each minute counts once');
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
