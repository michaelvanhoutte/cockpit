import { describe, expect, it } from 'vitest';
import { groupRows, parseQuery, seriesOf, type CostsPage, type TotalRow } from '../../src/costs';
import { renderPage, tokenCount } from '../../src/page';

describe('Harness Monitor', () => {
  describe('a token count reads as people say one', () => {
    it.each([
      { tokens: 9_946, reads: '9,946' },
      { tokens: 11_000, reads: '11k' },
      { tokens: 3_100_000, reads: '3.1M' },
      { tokens: 1_310_000_000, reads: '1.31B' },
      { tokens: 999_600, reads: '1.0M' },
      { tokens: 999_960_000, reads: '1.00B' },
    ])('$tokens reads $reads', ({ tokens, reads }) => {
      expect(tokenCount(tokens)).toBe(reads);
    });
  });
});

// ---- A day opens from the page, in every way the page offers

const NOW = Date.parse('2026-10-26T12:00:00Z');

const totalRow = (over: Partial<TotalRow>): TotalRow => ({
  day: '',
  branch: '',
  category: '',
  series: 'building',
  costMicros: 2e6,
  unpricedRequests: 0,
  inputTokens: 1000,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  lastAt: 0,
  prNumber: null,
  title: null,
  state: null,
  mergedAt: null,
  issue: null,
  engineer: null,
  linesAdded: null,
  linesRemoved: null,
  openedAt: null,
  issueTitle: null,
  issueParent: null,
  issueParentTitle: null,
  credited: 0,
  creditIssue: null,
  ...over,
});

/** The costs page for an address, holding `rows` (a day's, or each day's, to suit the address). */
function pageFor(address: string, rows: TotalRow[], now = NOW): string {
  const query = parseQuery(new URLSearchParams(address));
  const groups = groupRows(rows, query.group, null, query.sort);
  const bySeries: Record<string, number> = {};
  const tokens: Record<string, number> = {};
  for (const g of groups) {
    for (const [key, n] of Object.entries(g.bySeries)) bySeries[key] = (bySeries[key] ?? 0) + n;
    for (const [key, n] of Object.entries(g.tokensBySeries)) tokens[key] = (tokens[key] ?? 0) + n;
  }
  const page: CostsPage = {
    query,
    engineers: ['alice'],
    models: [],
    groups,
    series: seriesOf(query.split, bySeries),
    tokenSeries: seriesOf(query.split, tokens),
    bySeries,
    totalMicros: groups.reduce((sum, g) => sum + g.totalMicros, 0),
    lastLinkSuccessAt: null,
    creditedThrough: null,
    jobs: [],
    trends: null,
  };
  return renderPage(page, { unpriced: [], repository: 'acme/app' }, now);
}

const eachDay = (days: string[]) => days.map((day, i) => totalRow({ day, costMicros: (i + 1) * 1e6 }));
const pullRequests = (count: number) =>
  Array.from({ length: count }, (_, i) => totalRow({ day: '', branch: `b/${i + 1}`, prNumber: i + 1, title: `P${i + 1}`, costMicros: (i + 1) * 1e6, engineer: 'alice' }));

/** A chart's strips: where each links and what its tooltip says. */
const strips = (html: string, chart: string) =>
  [...new RegExp(`aria-labelledby="${chart}">.*?</section>`, 's').exec(html)![0].matchAll(/<a href="([^"]*)"><rect [^>]*><title>(.*?)<\/title><\/rect><\/a>/gs)].map((m) => ({ href: m[1]!.replace(/&#38;/g, '&'), says: m[2]!.split('\n') }));
const periodSelect = (html: string) => /<select[^>]*aria-label="Period"[^>]*>(.*?)<\/select>/s.exec(html)![1]!;
const optionTexts = (select: string) => [...select.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1]!);
const dayField = (html: string) => /<input type="date"[^>]*>/.exec(html)![0];

describe('Harness Monitor', () => {
  describe('every way in leads to the day, as each pull request dearest first, with the colouring and filters kept', () => {
    const days = ['2026-10-23', '2026-10-24', '2026-10-25'];
    const overDays = (address: string) => pageFor(address, eachDay(days));

    it.each([
      { chart: 'perday', total: 'Total $2.00' },
      { chart: 'tokensperday', total: 'Total 1,000 tokens' },
    ])('each day of $chart is a full-height strip to that day, naming the day, its total and "Click to see this day"', ({ chart, total }) => {
      const found = strips(overDays('period=all&split=model&who=main'), chart);

      // The chart runs to today, the 26th, which spent nothing.
      expect(found.map((s) => s.href)).toEqual([...days, '2026-10-26'].map((d) => `/?period=all&day=${d}&who=main&group=pr&split=model`));
      expect(found[1]!.says[0]).toBe(`24 Oct 2026 · ${total}`);
      expect(found[1]!.says.at(-1)).toBe('Click to see this day');
    });

    it('a "By day" row\'s date links to the address its strip does', () => {
      const html = overDays('period=7d&split=where&category=building');
      const dates = [...html.matchAll(/<td class="first"><a href="([^"]*)">([^<]*)<\/a><\/td>/g)].map((m) => [m[2]!, m[1]!.replace(/&amp;/g, '&')]);

      expect(dates).toEqual([...days].reverse().map((d) => [`${d.slice(8)} Oct 2026`, `/?period=7d&day=${d}&category=building&group=pr&split=where`]));
      const address = (d: string) => `/?period=7d&day=${d}&category=building&group=pr&split=where`;
      expect(strips(html, 'perday').map((s) => s.href)).toEqual(['20', '21', '22', '23', '24', '25', '26'].map((d) => address(`2026-10-${d}`)));
      expect(strips(html, 'perday').filter((s) => dates.some(([, href]) => href === s.href))).toHaveLength(3);
    });

    it('over a period, the period select offers the four periods, then "Pick a day…"', () => {
      const html = overDays('period=7d');

      expect(optionTexts(periodSelect(html))).toEqual(['the last 7 days', 'the last 30 days', 'the last 90 days', 'all time', 'Pick a day…']);
      expect(periodSelect(html)).toContain('<option value="7d" selected>');
      expect(html).toContain('<select name="period"');
    });

    it('on a day, that day comes first, the four periods follow, "Pick a day…" is last, and the picker stops at the Belgian today', () => {
      const html = pageFor('period=90d&day=2026-10-24&group=pr', pullRequests(2));

      expect(optionTexts(periodSelect(html))).toEqual(['24 Oct 2026', 'the last 7 days', 'the last 30 days', 'the last 90 days', 'all time', 'Pick a day…']);
      expect(periodSelect(html)).toContain('<option value="2026-10-24" selected>');
      expect(dayField(html)).toContain('max="2026-10-26"');
      expect(dayField(html)).toContain('value="2026-10-24"');
      // The select sends nothing while a day is shown; the period the day was opened from rides along.
      expect(html).toContain('<input type="hidden" name="period" value="90d">');
      expect(html).not.toContain('<select name="period"');
    });

    it('the picker allows no day after the Belgian today, which can be a day ahead of UTC', () => {
      const html = pageFor('day=2026-10-24&group=pr', pullRequests(1), Date.parse('2026-10-26T23:30:00Z'));

      expect(dayField(html)).toContain('max="2026-10-27"');
    });

    it('more than 25 pull requests on a day: the pager\'s Next keeps the day', () => {
      const html = pageFor('period=7d&day=2026-10-24&group=pr', pullRequests(30));

      expect(html).toContain('<a href="/?period=7d&day=2026-10-24&group=pr&page=2">Next 25</a>');
    });

    it('Export CSV on a day carries the day, although it resets the rows', () => {
      const html = pageFor('period=7d&day=2026-10-24&group=issue&split=model&who=main', pullRequests(1));

      expect(/class="button" href="([^"]*)"/.exec(html)![1]!.replace(/&amp;/g, '&')).toBe('/export.csv?period=7d&day=2026-10-24&who=main&group=pr');
    });

    it('Export CSV over a period resets the rows as it always did', () => {
      const html = overDays('period=7d&group=pr&split=model');

      expect(/class="button" href="([^"]*)"/.exec(html)![1]!.replace(/&amp;/g, '&')).toBe('/export.csv?period=7d');
    });

    it('a pull request\'s Sessions link on a day carries the period, not the day', () => {
      const html = pageFor('period=7d&day=2026-10-24&group=pr', [totalRow({ branch: 'b/1', prNumber: 1, title: 'P1', issue: 5, engineer: 'alice' })]);

      expect(/<a href="(\/pr\/1[^"]*)">Sessions/.exec(html)![1]).toBe('/pr/1?period=7d');
    });
  });

  describe('on a day, the page speaks of the day', () => {
    it.each([
      { situation: 'by phase', address: 'day=2026-10-24&group=pr', heading: 'Where 24 Oct&rsquo;s $2.00 went, by phase' },
      { situation: 'coloured by engineer', address: 'day=2026-10-24&group=issue&split=engineer', heading: 'Where 24 Oct&rsquo;s $2.00 went, by engineer' },
    ])('the cost bar, $situation, names the day', ({ address, heading }) => {
      const html = pageFor(address, pullRequests(1).map((r) => ({ ...r, costMicros: 2e6 })));

      expect(html).toContain(`>${heading}</h2>`);
      expect(html).not.toContain('the period&rsquo;s');
    });

    it('over a period it is still the period\'s', () => {
      expect(pageFor('period=7d&group=pr', pullRequests(1))).toContain('Where the period&rsquo;s $1.00 went, by phase');
    });
  });
});
