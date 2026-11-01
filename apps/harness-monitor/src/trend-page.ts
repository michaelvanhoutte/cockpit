import { categoryName, PERIODS, UNATTRIBUTED, WHOS, type Period, type TrendPage } from './costs';
import { LEAD_MORE, WHAT } from './costs-explain';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, lead } from './explain';
import { band, inline, questionOf, sentenceForm, shell } from './look';
import { VIOLET } from './palette';
import { compact, COLOURS, dollars, number, PERIOD_WORDS, trendChart, WHO_LABELS } from './page';
import { CATEGORIES, type Category } from './validate';

/** The Harness trend page's controls: the period, then the costs page's "Only" filters, each narrowing the charts as it does there. */
function controls({ query, engineers, models }: TrendPage): string {
  const engineerOptions: [string, string][] = [['', 'Everyone'], ...engineers.map((e): [string, string] => [e, e]), [UNATTRIBUTED, 'Unattributed']];
  // A named engineer who is no longer in the list stays selectable, so the form never silently drops a filter.
  if (query.engineer && !engineerOptions.some(([v]) => v === query.engineer)) engineerOptions.push([query.engineer, query.engineer]);
  const modelOptions: [string, string][] = [['', 'All models'], ...models.map((m): [string, string] => [m, m])];
  if (query.model && !models.includes(query.model)) modelOptions.push([query.model, query.model]);
  const periods = (Object.keys(PERIODS) as Period[]).map((p): [string, string] => [p, PERIOD_WORDS[p]]);
  return sentenceForm(
    '/harness-trend',
    `Show the trend over ${inline('period', 'Period', periods, query.period)}`,
    [
      inline('engineer', 'Engineer', engineerOptions, query.engineer ?? '', ''),
      inline('category', 'Phase', [['', 'All phases'], ...CATEGORIES.map((c): [string, string] => [c, categoryName(c)])], query.category ?? '', ''),
      inline('model', 'Model', modelOptions, query.model ?? '', ''),
      inline('who', 'Requests', WHOS.map((w): [string, string] => [w, w === 'all' ? 'All requests' : WHO_LABELS[w]]), query.who, 'all'),
    ],
  );
}

/** "Is the harness getting more expensive?": starting context, pull request size and cost per 1,000 lines changed. */
function charts({ trends: t }: TrendPage): string {
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
      lines: t.costPerThousandLines.map((l) => (l.key === 'total' ? { ...l, colour: 'var(--ink-strong)', dash: true } : { ...l, colour: COLOURS[l.key as Category] })),
      value: dollars,
      axis: dollars,
    }),
  ];
  const info = explain('trends', 'Is the harness getting more expensive?', WHAT.trends);
  return `<section class="panel" aria-labelledby="trends">${band('Is the harness getting more expensive?', '', 'trends', info.both)}<div class="well pad">${drawn.join('\n')}</div></section>`;
}

/** The public page: whether the same work is getting dearer. Counts and dollars only. */
export function renderTrendPage(page: TrendPage, now = Date.now()): string {
  const body = ['<h1 class="sr-only">Harness trend</h1>', lead(questionOf('harness-trend'), LEAD_MORE), charts(page), EXPLAIN_SCRIPT].join('\n');
  return shell({ current: 'harness-trend', controls: controls(page), body, style: EXPLAIN_STYLE }, now);
}
