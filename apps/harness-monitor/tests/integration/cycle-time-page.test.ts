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
const hasSection = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}"`).test(html);
const text = (html: string) => html.replace(/<style>.*?<\/style>/s, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
const MIN = 60_000;

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

      expect(html).toContain('<a href="/cycle-time" aria-current="page">Cycle time</a>');
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

      expect(row![9]).toBe('$4.20');
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

      expect(rows.map((r) => r[9])).toEqual(['—', '—']);
      expect(html).not.toContain('$0.00');
    });

    it('the cost tile reads — and not $0.00 where no pull request in the list has a recorded request', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z')]);
      await costing(1, null);

      const html = await thePage();

      expect(html).toMatch(/Claude Code cost<\/span><span class="tile-value">—</);
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

  describe('a pull request with no session record says "not recorded" in its times, never 0', () => {
    it('its local checks read not recorded and its writing is the time left of start to merge', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { recorded: false, codingMs: null, localMs: null, localReviews: null, totalMs: 21 * MIN, start: { at: '2026-10-30T09:39:00Z', from: 'first-commit' } })]);

      const html = await thePage('?group=pr');
      const [row] = rowsOf(html, 'cycle-table');

      // Label, split, writing, local checks, CI rounds, waiting to merge, away, start to merge, rounds, Claude Code.
      expect(row!.slice(2, 9)).toEqual(['15m', 'not recorded', '5m', '1m', '—', '21m', '1']);
      expect(row![0]).toContain('no session record');
      expect(text(await thePage())).toContain('1 pull request here carries no session record');
    });
  });

  describe("a pull request's phases add up to its start to merge", () => {
    it('writing, local checks, CI rounds, waiting to merge and away add up to its start to merge', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { totalMs: 21 * MIN })]);

      const [row] = rowsOf(await thePage('?group=pr'), 'cycle-table');

      expect(row!.slice(2, 8)).toEqual(['10m', '5m', '5m', '1m', '—', '21m']);
    });
  });

  describe('the page has one view: every chart and table in phases, with no Split by', () => {
    const phaseHeads = ['Day merged', 'Pull requests', 'Split', 'Writing', 'Local checks', 'CI rounds', 'Waiting to merge', 'Away', 'Start to merge', 'Rounds', 'Claude Code'];
    beforeEach(async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z'), recorded(2, '2026-10-29T10:00:00Z', { size: { additions: 1900, deletions: 100, files: 20, commits: 3, mainMerges: 0 } })]);
    });

    it('draws the By day table and the per-pull-request chart in phases on Over time', async () => {
      const html = await thePage();

      expect(columnHeads(html, 'cycle-table')).toEqual(phaseHeads);
      expect(html).toContain('Start to merge, each pull request as it merged');
      const chart = /<section[^>]*aria-labelledby="per-pull-request".*?<\/section>/s.exec(html)![0];
      expect([...chart.matchAll(/<span class="key"><i[^>]*><\/i>([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(['Writing', 'Local checks', 'CI rounds', 'Waiting to merge', 'Away']);
    });

    it.each([
      { tab: 'pr', first: 'Pull request' },
      { tab: 'issue', first: 'Issue' },
      { tab: 'size', first: 'Size' },
    ])('draws the $tab tab in phases', async ({ tab, first }) => {
      const heads = columnHeads(await thePage(`?group=${tab}`), 'cycle-table');

      expect(heads[0]).toBe(first);
      expect(heads.slice(heads.indexOf('Writing'))).toEqual(['Writing', 'Local checks', 'CI rounds', 'Waiting to merge', 'Away', 'Start to merge', 'Rounds', 'Claude Code']);
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

    it('titles the panel with the time it covers, counts the pull requests, and states how each minute counts once', async () => {
      await sendPulls([split(1, kinds), split(2, kinds)]);

      const html = text(await thePage());

      expect(html).toContain('Where the 42m went 2 pull requests');
      expect(html).toContain('time two local checks shared goes to the one that finished last.');
      expect(html).not.toContain('as a CI round');
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
      for (const part of ['data-figures', 'openable', 'outline-slots', '<script']) expect(markup).not.toContain(part);
    });
  });

  describe('tiles and overview panels are on Over time only', () => {
    beforeEach(async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z'), recorded(2, '2026-10-29T10:00:00Z', { rounds: [red(), green()] })]);
    });

    it('Over time draws the four tiles, where the time went, the writing against the harness and the per-pull-request chart', async () => {
      const html = await thePage();

      expect([...html.matchAll(/class="tile-label">([^<]+)</g)].map((m) => m[1])).toEqual(['Start to merge', 'In the harness', 'CI rounds', 'Claude Code cost']);
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
      expect(swatches(panelOf(html, 'cycle-table'))).toEqual(phases);
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
});
