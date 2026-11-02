import { PERIODS, type Period, type TrendPage, trendQueryString } from './costs';
import { LEAD_MORE, WHAT } from './costs-explain';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, lead, type Explanation } from './explain';
import { inline, questionOf, sentenceForm, shell } from './look';
import { AMBER, VIOLET } from './palette';
import { compact, COLOURS, dollars, number, onlyFilters, PERIOD_WORDS, trendChart, trendOf, trendWords } from './page';
import { section } from './report';
import { type Category } from './validate';

/** The Harness trend page's controls: the period, then the costs page's "Only" filters, each narrowing the charts as it does there. */
function controls(page: TrendPage): string {
  const periods = (Object.keys(PERIODS) as Period[]).map((p): [string, string] => [p, PERIOD_WORDS[p]]);
  // Changing the period or a filter reloads the page, so the cost chart's view rides along in the form.
  const hidden = page.lines === 'total' ? '<input type="hidden" name="lines" value="total">' : '';
  return sentenceForm('/harness-trend', `Show the trend over ${inline('period', 'Period', periods, page.query.period)}`, onlyFilters(page), [], hidden);
}

/** The Total / By phase switch: two links that keep the period and every filter, the current view marked. */
function linesSwitch({ query }: TrendPage, total: boolean): string {
  const link = (text: string, to: 'total' | 'phase') => `<a href="/harness-trend${trendQueryString(query, to)}"${(to === 'total') === total ? ' aria-current="true"' : ''}>${text}</a>`;
  return `<span class="lines-switch" role="group" aria-label="Cost per 1,000 lines changed shows">${link('Total', 'total')}${link('By phase', 'phase')}</span>`;
}

/** One panel per chart: its title and explanation on the band, then the trend's words and any `extra` beside them. */
function panel(id: string, title: string, what: Explanation, words: string, chart: string, extra = ''): string {
  const aside = (words === '' ? '' : `<span class="trend-words">${words}</span>`) + extra;
  return section(id, title, aside, `<div class="well pad">${chart}</div>`, 'panel', explain(id, title, what));
}

/** Starting context, pull request size and cost per 1,000 lines changed, each a panel with its trend line and the line's change in words. */
function charts(page: TrendPage): string {
  const { trends: t } = page;
  const { period, category } = page.query;
  // One phase chosen leaves the chart a single line, so there is nothing to switch.
  const total = page.lines === 'total' && category === null;
  const ink = VIOLET;
  // Phase lines sit beside the total, which the fit follows; with one phase chosen it follows that phase.
  const costKey = category ?? 'total';
  const wordsOf = (values: (number | null)[]) => trendWords(trendOf(values), period);
  return [
    panel(
      'starting-context',
      'Starting context',
      WHAT.startingContext,
      wordsOf(t.startingContext),
      trendChart(t, {
        id: 'starting-context',
        title: 'Starting context',
        what: WHAT.startingContext,
        bare: true,
        fit: 'starting-context',
        lines: [{ key: 'starting-context', label: 'Starting context', values: t.startingContext, colour: ink }],
        value: (n) => `${number(n)} tokens`,
        axis: compact,
      }),
    ),
    panel(
      'pull-request-size',
      'Pull request size',
      WHAT.prSize,
      wordsOf(t.prSize),
      trendChart(t, {
        id: 'pull-request-size',
        title: 'Pull request size',
        what: WHAT.prSize,
        bare: true,
        fit: 'pull-request-size',
        lines: [{ key: 'pull-request-size', label: 'Lines changed', values: t.prSize, colour: ink }],
        value: (n) => `${number(n)} lines`,
        axis: compact,
      }),
    ),
    panel(
      'cost-per-line',
      'Cost per 1,000 lines changed',
      WHAT.costPerLine,
      wordsOf(t.costPerThousandLines.find((l) => l.key === costKey)?.values ?? []),
      trendChart(t, {
        id: 'cost-per-line',
        title: 'Cost per 1,000 lines changed',
        what: WHAT.costPerLine,
        bare: true,
        fit: costKey,
        // Dashed means "the sum" while phase lines sit beside it; alone, the total is solid.
        lines: t.costPerThousandLines.filter((l) => !total || l.key === 'total').map((l) => (l.key === 'total' ? { ...l, colour: 'var(--ink-strong)', dash: !total } : { ...l, colour: COLOURS[l.key as Category] })),
        value: dollars,
        axis: dollars,
      }),
      category === null ? linesSwitch(page, total) : '',
    ),
  ].join('\n');
}

/** The public page: whether the same work is getting dearer. Counts and dollars only. */
export function renderTrendPage(page: TrendPage, now = Date.now()): string {
  const body = ['<h1 class="sr-only">Harness trend</h1>', lead(questionOf('harness-trend'), LEAD_MORE), charts(page), EXPLAIN_SCRIPT].join('\n');
  return shell({ current: 'harness-trend', controls: controls(page), body, style: EXPLAIN_STYLE + SWITCH_STYLE }, now);
}

const SWITCH_STYLE = `.trend-words{color:${AMBER};font-weight:600;font-size:13px;white-space:nowrap}
.lines-switch{margin-left:auto;padding-left:12px;display:inline-flex;flex-shrink:0}
.lines-switch a{padding:3px 10px;border:1px solid color-mix(in srgb,var(--shade) 24%,transparent);font-size:12px;color:var(--ink-soft);text-decoration:none;white-space:nowrap}
.lines-switch a:first-child{border-radius:var(--radius-sm) 0 0 var(--radius-sm)}
.lines-switch a:last-child{margin-left:-1px;border-radius:0 var(--radius-sm) var(--radius-sm) 0}
.lines-switch a:hover{color:var(--ink-strong)}
.lines-switch a[aria-current]{background:var(--bar);border-color:var(--bar);color:var(--chrome-ink);font-weight:600}
.lines-switch a:focus-visible{outline:2px solid var(--accent-deep);outline-offset:2px}`;
