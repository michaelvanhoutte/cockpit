import { describe, expect, it } from 'vitest';
import { callSeries, groupCalls, type CallsPage, type CallSplit } from '../../src/claude-calls-page';
import { renderClaudeCalls } from '../../src/claude-calls-view';
import { groupRows, parseQuery, seriesOf, type CostsPage, type Split, type TotalRow } from '../../src/costs';
import { renderPage } from '../../src/page';
import { apart, apartColourBlind, contrast, paletteOf, type Theme } from '../fixtures/colour-checks';

const THEMES: Theme[] = ['light', 'dark'];
const HUES = ['violet', 'orange', 'raspberry', 'teal', 'brown', 'blue', 'olive', 'purple'];
const NORMAL_FLOOR = 15;
const COLOUR_BLIND_FLOOR = 8;
const MARK_CONTRAST = 3;

describe('Harness Monitor', () => {
  describe('a chart tells every series apart from the next, in light and in dark', () => {
    describe.each(THEMES)('in %s', (theme) => {
      const { well, slots, grey } = paletteOf(theme);

      it.each(HUES.map((hue, i) => ({ hue, colour: slots[i]! })))('$hue stands out from the chart at 3:1 or more', ({ colour }) => {
        expect(contrast(colour, well)).toBeGreaterThanOrEqual(MARK_CONTRAST);
      });

      it('grey stands out from the chart at 3:1 or more', () => {
        expect(contrast(grey, well)).toBeGreaterThanOrEqual(MARK_CONTRAST);
      });

      // Beside each other in a stack, then any two among a chart's first six.
      const adjacent = HUES.slice(1).map((hue, i) => ({ pair: `${HUES[i]} and ${hue}`, a: i, b: i + 1 }));
      const firstSix = HUES.slice(0, 6).flatMap((hue, a) => HUES.slice(a + 1, 6).map((other, k) => ({ pair: `${hue} and ${other}`, a, b: a + 1 + k })));

      it.each(adjacent)('$pair, side by side, read apart', ({ a, b }) => {
        expect(apart(slots[a]!, slots[b]!)).toBeGreaterThanOrEqual(NORMAL_FLOOR);
        expect(apartColourBlind(slots[a]!, slots[b]!)).toBeGreaterThanOrEqual(COLOUR_BLIND_FLOOR);
      });

      it.each(firstSix)('$pair, among the first six, read apart', ({ a, b }) => {
        expect(apart(slots[a]!, slots[b]!)).toBeGreaterThanOrEqual(NORMAL_FLOOR);
        expect(apartColourBlind(slots[a]!, slots[b]!)).toBeGreaterThanOrEqual(COLOUR_BLIND_FLOOR);
      });

      // Grey reads as neutral, so it is held to the series beside it and no others: the three it clears.
      it.each([0, 1, 5].map((i) => ({ hue: HUES[i]!, colour: slots[i]! })))('grey beside $hue reads apart', ({ colour }) => {
        expect(apart(grey, colour)).toBeGreaterThanOrEqual(NORMAL_FLOOR);
        expect(apartColourBlind(grey, colour)).toBeGreaterThanOrEqual(COLOUR_BLIND_FLOOR);
      });
    });
  });
});

// ---- A chart counts its series by place on record

const now = Date.parse('2026-10-24T12:00:00Z');
const slot = (n: number) => `var(--series-${n})`;
const GREY = 'var(--series-grey)';

/** The legend under a bar: each row's colour, name and amount. */
const legend = (html: string) => [...html.matchAll(/<li><i style="background:([^"]*)" aria-hidden="true"><\/i><span class="name">(.*?)<\/span><span class="amount">(.*?)<\/span>/g)].map((m) => [m[2]!, m[1]!, m[3]!]);
/** The colours of the bar's segments, left to right. */
const segments = (html: string) => [...(/<div class="bar" role="img"[^>]*>(.*?)<\/div>\s*<ul/s.exec(html)?.[1] ?? '').matchAll(/background:([^"]*)"/g)].map((m) => m[1]!);
/** A per-day chart's lines: key, stroke and the title of its first point. */
const lines = (html: string, chart: string) =>
  [...new RegExp(`aria-labelledby="${chart}">.*?</section>`, 's').exec(html)![0].matchAll(/<g data-line="([^"]*)"><polyline [^>]*stroke="([^"]*)"[^>]*\/>(?:<circle [^>]*><title>(.*?)<\/title>)?/g)].map((m) => [m[1]!, m[2]!, m[3] ?? '']);

const names = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);

const costRow = (series: string, dollars: number): TotalRow => ({
  day: '2026-10-20',
  branch: '',
  category: '',
  series,
  costMicros: dollars * 1e6,
  unpricedRequests: 0,
  inputTokens: dollars * 1000,
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
});

/** The costs page of one day, coloured by `split`, holding one request per key at $1, $2, $3 and so on in the order given. */
function costsOf(split: Split, onRecord: { engineers?: string[]; models?: string[] }, drawn: string[]): CostsPage {
  const groups = groupRows(drawn.map((key, i) => costRow(key, i + 1)), 'day', null);
  const bySeries = Object.fromEntries(Object.entries(groups[0]!.bySeries));
  const tokens = Object.fromEntries(Object.entries(groups[0]!.tokensBySeries));
  return {
    query: parseQuery(new URLSearchParams(`period=all&split=${split}`)),
    engineers: onRecord.engineers ?? [],
    models: onRecord.models ?? [],
    groups,
    series: seriesOf(split, bySeries),
    tokenSeries: seriesOf(split, tokens),
    bySeries,
    totalMicros: groups[0]!.totalMicros,
    lastLinkSuccessAt: null,
    jobs: [],
    trends: null,
  };
}

const callRow = (series: string, dollars: number) => ({ g: '2026-10-20', s: series, calls: 1, micros: dollars * 1e6, unpriced: 0, title: null });

/** Cockpit's Claude calls of one day, coloured by `split`, with every value on record and the ones drawn at $1, $2, $3 and so on. */
function callsOf(split: CallSplit, onRecord: { features?: string[]; models?: string[]; startedBys?: string[] }, drawn: string[]): CallsPage {
  const groups = groupCalls(drawn.map((key, i) => callRow(key, i + 1)), 'day', new Map());
  const bySeries = Object.fromEntries(Object.entries(groups[0]!.bySeries));
  return {
    query: { period: 'all', environment: null, feature: null, model: null, group: 'day', split },
    features: onRecord.features ?? [],
    models: onRecord.models ?? [],
    startedBys: onRecord.startedBys ?? [],
    groups,
    series: callSeries(split, bySeries),
    bySeries,
    totalMicros: groups[0]!.micros,
    calls: drawn.length,
    unpriced: 0,
    previous: null,
    job: { job: 'claude-calls', run: null, lastSucceededAt: null },
  };
}

describe('Harness Monitor', () => {
  describe('a model or an engineer takes the slot of its place on record, and the ninth onward are drawn together as Other', () => {
    const models = names(10, 'model-');
    const html = (page: CostsPage) => renderPage(page, { unpriced: [] }, now);

    it('eight models on record are eight slots and no Other', () => {
      const eight = models.slice(0, 8);
      const page = html(costsOf('model', { models: eight }, eight));

      expect(legend(page).map(([, colour]) => colour)).toEqual([8, 7, 6, 5, 4, 3, 2, 1].map(slot));
      expect(legend(page).map(([name]) => name)).toEqual([...eight].reverse());
    });

    it('ten on record draw the first eight in their slots and the ninth and tenth as one grey Other carrying their sum', () => {
      // $1 to $10 in the order the keys are given, so the dearest come first in the legend: model-10 ($10), model-9 ($9), then the rest.
      const page = html(costsOf('model', { models }, models));
      const rows = legend(page);

      expect(rows.map(([name]) => name)).toEqual(['model-8', 'model-7', 'model-6', 'model-5', 'model-4', 'model-3', 'model-2', 'model-1', 'Other']);
      expect(rows.map(([, colour]) => colour)).toEqual([...[8, 7, 6, 5, 4, 3, 2, 1].map(slot), GREY]);
      expect(rows.at(-1)![2]).toBe('$19.00');
      // One grey segment in the bar, and one grey line in each per-day chart, with the summed amount on its point.
      expect(segments(page).filter((c) => c === GREY)).toHaveLength(1);
      const cost = lines(page, 'perday');
      expect(cost.filter(([, stroke]) => stroke === GREY)).toEqual([['~other', GREY, expect.stringContaining('Other · 20 Oct 2026 · $19.00')]]);
      expect(lines(page, 'tokensperday').filter(([, stroke]) => stroke === GREY)).toHaveLength(1);
      expect(cost.map(([key]) => key)).toEqual(['model-8', 'model-7', 'model-6', 'model-5', 'model-4', 'model-3', 'model-2', 'model-1', '~other', 'total']);
    });

    it('nine engineers on record put the ninth in Other', () => {
      const engineers = names(9, 'eng-');
      const page = html(costsOf('engineer', { engineers }, engineers));

      expect(legend(page).map(([name, colour]) => [name, colour])).toEqual([
        ...[8, 7, 6, 5, 4, 3, 2, 1].map((n) => [`eng-${n}`, slot(n)]),
        ['Other', GREY],
      ]);
      expect(legend(page).at(-1)![2]).toBe('$9.00');
    });

    it('a filter that leaves only the ninth model still draws it as Other, since its place on record has not moved', () => {
      const page = html(costsOf('model', { models }, ['model-9']));

      expect(legend(page)).toEqual([['Other', GREY, '$1.00']]);
      expect(segments(page)).toEqual([GREY]);
    });

    it('the requests no pull request claims, and the authors nobody knows, stay Unattributed and unknown rather than joining Other', () => {
      const engineers = names(9, 'eng-');
      const page = html(costsOf('engineer', { engineers }, [...engineers, '~unattributed', '~unknown']));

      expect(legend(page).map(([name]) => name)).toEqual(['unknown', 'eng-8', 'eng-7', 'eng-6', 'eng-5', 'eng-4', 'eng-3', 'eng-2', 'eng-1', 'Unattributed', 'Other']);
    });
  });

  describe("a feature or a starter takes the slot of its place on record on Cockpit's Claude calls, and the ninth onward are drawn together as Other", () => {
    const html = (page: CallsPage) => renderClaudeCalls(page, {}, now);

    it.each([
      { situation: 'features', split: 'feature' as const, onRecord: (keys: string[]) => ({ features: keys }) },
      { situation: 'starters', split: 'startedBy' as const, onRecord: (keys: string[]) => ({ startedBys: keys }) },
    ])('nine $situation on record put the ninth in Other', ({ split, onRecord }) => {
      const keys = names(9, 'kind-');
      const page = html(callsOf(split, onRecord(keys), keys));
      const rows = [...page.matchAll(/<li><i style="background:([^"]*)" aria-hidden="true"><\/i><span class="name">(.*?)<\/span><span class="amount">(.*?)<\/span>/g)].map((m) => [m[2], m[1], m[3]]);

      expect(rows.at(-1)).toEqual(['Other', GREY, '$9.00']);
      expect(rows.slice(0, 8).map((r) => r![1])).toEqual([8, 7, 6, 5, 4, 3, 2, 1].map(slot));
    });

    it('a call with no starter is grey on its own, not Other', () => {
      const keys = ['', ...names(2, 'kind-')];
      const page = html(callsOf('startedBy', { startedBys: ['', ...keys.slice(1)] }, keys));

      expect(page).toContain('Not recorded');
      expect(page).not.toContain('>Other<');
    });
  });
});
