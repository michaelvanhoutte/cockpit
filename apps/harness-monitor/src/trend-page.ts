import { PERIODS, type Period, type TrendPage, trendQueryString } from './costs';
import { LEAD_MORE, WHAT } from './costs-explain';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, lead } from './explain';
import { band, inline, questionOf, sentenceForm, shell } from './look';
import { VIOLET } from './palette';
import { compact, COLOURS, dollars, number, onlyFilters, PERIOD_WORDS, trendChart } from './page';
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

/** "Is the harness getting more expensive?": starting context, pull request size and cost per 1,000 lines changed. */
function charts(page: TrendPage): string {
  const { trends: t } = page;
  // One phase chosen leaves the chart a single line, so there is nothing to switch.
  const total = page.lines === 'total' && page.query.category === null;
  const ink = VIOLET;
  const drawn = [
    trendChart(t, {
      id: 'starting-context',
      title: 'Starting context',
      what: WHAT.startingContext,
      lines: [{ key: 'starting-context', label: 'Starting context', values: t.startingContext, colour: ink }],
      value: (n) => `${number(n)} tokens`,
      axis: compact,
    }),
    trendChart(t, {
      id: 'pull-request-size',
      title: 'Pull request size',
      what: WHAT.prSize,
      lines: [{ key: 'pull-request-size', label: 'Lines changed', values: t.prSize, colour: ink }],
      value: (n) => `${number(n)} lines`,
      axis: compact,
    }),
    trendChart(t, {
      id: 'cost-per-line',
      title: 'Cost per 1,000 lines changed',
      what: WHAT.costPerLine,
      // Dashed means "the sum" while phase lines sit beside it; alone, the total is solid.
      lines: t.costPerThousandLines.filter((l) => !total || l.key === 'total').map((l) => (l.key === 'total' ? { ...l, colour: 'var(--ink-strong)', dash: !total } : { ...l, colour: COLOURS[l.key as Category] })),
      value: dollars,
      axis: dollars,
      ...(page.query.category === null ? { aside: linesSwitch(page, total) } : {}),
    }),
  ];
  const info = explain('trends', 'Is the harness getting more expensive?', WHAT.trends);
  return `<section class="panel" aria-labelledby="trends">${band('Is the harness getting more expensive?', '', 'trends', info.both)}<div class="well pad">${drawn.join('\n')}</div></section>`;
}

/** The public page: whether the same work is getting dearer. Counts and dollars only. */
export function renderTrendPage(page: TrendPage, now = Date.now()): string {
  const body = ['<h1 class="sr-only">Harness trend</h1>', lead(questionOf('harness-trend'), LEAD_MORE), charts(page), EXPLAIN_SCRIPT].join('\n');
  return shell({ current: 'harness-trend', controls: controls(page), body, style: EXPLAIN_STYLE + SWITCH_STYLE }, now);
}

const SWITCH_STYLE = `.lines-switch{margin-left:auto;padding-left:12px;display:inline-flex;flex-shrink:0}
.lines-switch a{padding:3px 10px;border:1px solid color-mix(in srgb,var(--shade) 24%,transparent);font-size:12px;color:var(--ink-soft);text-decoration:none;white-space:nowrap}
.lines-switch a:first-child{border-radius:var(--radius-sm) 0 0 var(--radius-sm)}
.lines-switch a:last-child{margin-left:-1px;border-radius:0 var(--radius-sm) var(--radius-sm) 0}
.lines-switch a:hover{color:var(--ink-strong)}
.lines-switch a[aria-current]{background:var(--bar);border-color:var(--bar);color:var(--chrome-ink);font-weight:600}
.lines-switch a:focus-visible{outline:2px solid var(--accent-deep);outline-offset:2px}`;
