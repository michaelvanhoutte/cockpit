import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      expect([...html.matchAll(/<nav class="pages".*?<\/nav>/gs)][0]![0].match(/>([^<]+)<\/a>/g)).toEqual(['>Claude Code costs</a>', '>Cockpit&rsquo;s Claude calls</a>', '>Cycle time</a>', '>CI stability</a>']);
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
      const html = await thePage('?period=7d&size=xs&outcome=green&split=harness');

      const links = [...html.matchAll(/<nav class="band".*?<\/nav>/gs)][0]![0].match(/href="([^"]+)"/g)!;

      expect(links).toHaveLength(5);
      for (const link of links) expect(link).toMatch(/period=7d.*size=xs.*outcome=green.*split=harness|group=check/);
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

    it('is the same under Split by Harness, where each local kind reads not recorded', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { recorded: false, codingMs: null, localMs: null, localReviews: null, totalMs: 21 * MIN })]);

      const [row] = rowsOf(await thePage('?group=pr&split=harness'), 'cycle-table');

      expect(row!.slice(2, 6)).toEqual(['5m', 'not recorded', 'not recorded', 'not recorded']);
    });
  });

  describe('Split by Phase reads a recorded pull request as the record has it', () => {
    it('writing, local checks, CI rounds, waiting to merge and away add up to its start to merge', async () => {
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { totalMs: 21 * MIN })]);

      const [row] = rowsOf(await thePage('?group=pr'), 'cycle-table');

      expect(row!.slice(2, 8)).toEqual(['10m', '5m', '5m', '1m', '—', '21m']);
    });

    it('Split by Harness says by how much the columns exceed the harness total', async () => {
      // A 15 minute review and a 15 minute test run that overlapped by 10 minutes: 20 minutes of local time.
      await sendPulls([recorded(1, '2026-10-30T10:00:00Z', { localMs: 20 * MIN, localReviews: { count: 1, ms: 15 * MIN, byKind: { 'code-review': { count: 1, ms: 15 * MIN }, 'security-review': { count: 0, ms: 0 } } }, localRuns: { test: { count: 1, ms: 15 * MIN }, browser: null } })]);

      expect(text(await thePage('?split=harness'))).toContain('they add up to 10m more than the 25m the harness took');
    });
  });

  describe('Split by Harness draws Code review and Security review, and a pull request stored with its reviews combined only has them named as such', () => {
    const reviewed = (number: number, mergedAt: string, localReviews: unknown) => recorded(number, mergedAt, { localMs: 10 * MIN, localReviews, totalMs: 31 * MIN });

    it('reads each review kind in its own column of a pull request', async () => {
      await sendPulls([reviewed(1, '2026-10-30T10:00:00Z', { count: 2, ms: 10 * MIN, byKind: { 'code-review': { count: 1, ms: 10 * MIN }, 'security-review': { count: 1, ms: 4 * MIN } } })]);

      const html = await thePage('?group=pr&split=harness');
      const [row] = rowsOf(html, 'cycle-table');

      expect([...html.matchAll(/<th scope="col" class="num"><i[^>]*><\/i>([^<]+)<\/th>/g)].map((m) => m[1])).toEqual(['Tests and checks', 'Code review', 'Security review', 'Test runs', 'Browser pass']);
      expect(row!.slice(2, 7)).toEqual(['5m', '10m', '4m', '—', '—']);
    });

    it('draws the combined figure as Reviews, not split by kind, beside the others, only where a pull request has no kinds', async () => {
      await sendPulls([
        reviewed(1, '2026-10-30T10:00:00Z', { count: 2, ms: 10 * MIN, byKind: { 'code-review': { count: 1, ms: 10 * MIN }, 'security-review': { count: 1, ms: 4 * MIN } } }),
        reviewed(2, '2026-10-29T10:00:00Z', { count: 2, ms: 8 * MIN }),
      ]);

      const html = await thePage('?group=pr&split=harness');
      const rows = rowsOf(html, 'cycle-table');

      expect(html).toContain('Reviews, not split by kind</th>');
      // Newest first: the one with kinds has none combined, the other has its 8 minutes there and none under either kind.
      expect(rows.map((r) => r.slice(2, 8))).toEqual([['5m', '10m', '4m', '—', '—', '—'], ['5m', '—', '—', '8m', '—', '—']]);
      expect(text(await thePage('?split=harness'))).toContain('stored before the review kinds were kept');
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
});
