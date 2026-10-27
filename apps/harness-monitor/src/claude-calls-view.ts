import {
  callsQueryString,
  CALL_GROUPS,
  CALL_SPLITS,
  ENVIRONMENTS,
  ENVIRONMENT_NAMES,
  FEATURE_ID,
  featureName,
  SAME_AS_ROWS,
  seriesName,
  type CallGroup,
  type CallGroupRow,
  type CallSplit,
  type CallsPage,
} from './claude-calls-page';
import { LEAD_MORE, TABLES, WHAT } from './claude-calls-explain';
import { dayChart, firstDay, MODEL_ID, PERIODS, type DayChart, type Period } from './costs';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, labelWithInfo, lead, type Info } from './explain';
import { band, esc, inline, questionOf, sentenceForm, shell } from './look';
import { costPerDay, dollars, jobLines, number, PERIOD_LABELS, PERIOD_WORDS, signed } from './page';
import { BLUE, colourByPlace, foldAmounts, foldSeries, GREY, isFolded, slot } from './palette';

/** The repository as GitHub names it, `owner/name`; anything else is no repository and links nowhere. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const GROUP_LABELS: Record<CallGroup, string> = { day: 'Day', feature: 'Feature', environment: 'Environment', pr: 'Pull request', startedBy: 'Started by' };
/** What the panel is headed when no row matches; the table's own first column keeps GROUP_LABELS. */
const TAB_LABELS: Record<CallGroup, string> = { ...GROUP_LABELS, day: 'Over time' };
const SPLIT_LABELS: Record<CallSplit, string> = { environment: 'Environment', feature: 'Feature', model: 'Model', startedBy: 'Started by' };
const UNITS: Record<CallGroup, [string, string]> = { day: ['day', 'days'], feature: ['row', 'rows'], environment: ['row', 'rows'], pr: ['row', 'rows'], startedBy: ['row', 'rows'] };
const ORDERS: Record<CallGroup, string> = { day: 'newest first', pr: 'newest first', environment: 'production first', feature: 'dearest first', startedBy: 'dearest first' };

/** An environment takes its slot by name, in stacking order; one the page does not know is grey and stacks last, so the last known one takes blue, a slot grey clears. */
const ENVIRONMENT_COLOURS: Record<string, string> = {
  production: slot(1),
  staging: slot(2),
  ci: slot(3),
  local: BLUE,
};

/** What a split counts by place on record: every feature, model or starter, a call with no starter being none of them. */
const knownOf = (page: CallsPage) => (page.query.split === 'feature' ? page.features : page.query.split === 'model' ? page.models : page.startedBys.filter((s) => s !== ''));

/** The colour of a series: its environment's, grey for a call with no starter, otherwise the slot of its place on record. */
function colourOf(page: CallsPage, key: string): string {
  const { split } = page.query;
  if (split === 'environment') return Object.hasOwn(ENVIRONMENT_COLOURS, key) ? ENVIRONMENT_COLOURS[key]! : GREY;
  if (split === 'startedBy' && key === '') return GREY;
  return colourByPlace(knownOf(page), key);
}

/** The page with every feature, model or starter past the eighth on record drawn as one Other, in the period before as well. */
function foldedPage(page: CallsPage): CallsPage {
  const { split } = page.query;
  if (split === 'environment') return page;
  const known = knownOf(page);
  const folded = (key: string) => !(split === 'startedBy' && key === '') && isFolded(known, key);
  return {
    ...page,
    series: foldSeries(page.series, folded),
    bySeries: foldAmounts(page.bySeries, folded),
    groups: page.groups.map((g) => ({ ...g, bySeries: foldAmounts(g.bySeries, folded) })),
    previous: page.previous === null ? null : { ...page.previous, bySeries: foldAmounts(page.previous.bySeries, folded) },
  };
}

/** A change under half a cent reads $0.00 either way, so it is no change. */
const SMALLEST_CALLS_CHANGE_MICROS = 5_000;

const ROW_WORDS: Record<CallGroup, string> = { day: 'each day', feature: 'each feature', environment: 'each environment', pr: 'each pull request', startedBy: 'each starter' };
const COLOUR_WORDS: Record<CallSplit, string> = { environment: 'environment', feature: 'feature', model: 'model', startedBy: 'starter' };

/**
 * The controls as one sentence on the band, as the costs page's: the rows, what
 * colours them and over when, then the filters after "Only". A colouring that
 * repeats the rows is offered but disabled, and a filter that does is not offered.
 */
function controls({ query, features, models }: CallsPage): string {
  features = features.filter((f) => FEATURE_ID.test(f));
  models = models.filter((m) => MODEL_ID.test(m));
  const featureOptions: [string, string][] = [['', 'All features'], ...features.map((f): [string, string] => [f, featureName(f)])];
  // A named feature or model no longer on record stays selectable, so the form never silently drops a filter.
  if (query.feature && !features.includes(query.feature)) featureOptions.push([query.feature, featureName(query.feature)]);
  const modelOptions: [string, string][] = [['', 'All models'], ...models.map((m): [string, string] => [m, m])];
  if (query.model && !models.includes(query.model)) modelOptions.push([query.model, query.model]);
  const sentence = `Show cost for ${inline('group', 'Rows', CALL_GROUPS.map((g): [string, string] => [g, ROW_WORDS[g]]), query.group)}
coloured by ${inline('split', 'Colours', CALL_SPLITS.map((v): [string, string, boolean] => [v, COLOUR_WORDS[v], SAME_AS_ROWS[query.group] === v]), query.split)}
over ${inline('period', 'Period', (Object.keys(PERIODS) as Period[]).map((p): [string, string] => [p, PERIOD_WORDS[p]]), query.period)}`;
  return sentenceForm(
    '/claude-calls',
    sentence,
    [
      query.group === 'environment' ? '' : inline('environment', 'Environment', [['', 'All environments'], ...ENVIRONMENTS.map((e): [string, string] => [e, ENVIRONMENT_NAMES[e]])], query.environment ?? '', ''),
      query.group === 'feature' ? '' : inline('feature', 'Feature', featureOptions, query.feature ?? '', ''),
      inline('model', 'Model', modelOptions, query.model ?? '', ''),
    ],
    [`<a class="button" href="/claude-calls/export.csv${callsQueryString(query, { group: 'day', split: 'environment' })}" download>Export CSV</a>`],
  );
}

function warning(unpriced: number): string {
  if (unpriced === 0) return '';
  return `<section class="panel warning" role="status" aria-labelledby="unpriced">${band('Calls with no price', '', 'unpriced')}<div class="well pad">
<p>${number(unpriced)} call${unpriced === 1 ? '' : 's'} could not be priced: Cockpit&rsquo;s record has no price for the model, or for a kind of token it used. ${unpriced === 1 ? 'It is' : 'They are'} counted in Calls and left out of every dollar total.</p>
</div></section>`;
}

function tiles({ query, totalMicros, calls, unpriced, previous }: CallsPage): string {
  // The (i) stays on the label's line, bound to its last word.
  const tile = (label: string, value: string, note: string, info: Info, cls = '') =>
    `<div class="tile${cls}"><span class="tile-label">${labelWithInfo(label, info.button)}</span><span class="tile-value">${value}</span><span class="tile-note">${note}</span>${info.panel}</div>`;
  const priced = calls - unpriced;
  const diff = previous === null || Math.abs(totalMicros - previous.micros) < SMALLEST_CALLS_CHANGE_MICROS ? 0 : totalMicros - previous.micros;
  return `<div class="tiles">
${tile('Spent', dollars(totalMicros), `${esc(PERIOD_LABELS[query.period])} · at API list price`, explain('t-spent', 'Spent', WHAT.spent))}
${tile('Calls', number(calls), calls === 0 ? 'none in this period' : priced === 0 ? 'none could be priced' : `${dollars(totalMicros / priced)} a priced call on average`, explain('t-calls', 'Calls', WHAT.calls))}
${previous === null ? '' : tile('Against the previous period', diff === 0 ? 'No change' : signed(diff), `${dollars(previous.micros)} before`, explain('t-previous', 'Against the previous period', WHAT.previous), diff > 0 ? ' up' : diff < 0 ? ' down' : '')}
</div>`;
}

function whereItWent(page: CallsPage): string {
  const { query, series, bySeries, totalMicros } = page;
  const cost = (key: string) => bySeries[key] ?? 0;
  const segments = series.filter((s) => cost(s.key) > 0).map((s) => `<div style="flex:${cost(s.key)};background:${colourOf(page, s.key)}"></div>`).join('');
  const label = series.map((s) => `${s.label} ${dollars(cost(s.key))}`).join(', ');
  const legend = series
    .map(
      (s) =>
        `<li><i style="background:${colourOf(page, s.key)}" aria-hidden="true"></i><span class="name">${esc(s.label)}</span><span class="amount">${dollars(cost(s.key))}</span><span class="share">${totalMicros === 0 ? 0 : Math.round((cost(s.key) / totalMicros) * 100)}%</span></li>`,
    )
    .join('');
  return `<section class="panel" aria-labelledby="where">${band(`Where the ${dollars(totalMicros)} went`, `by ${SPLIT_LABELS[query.split].toLowerCase()}`, 'where', explain('where', 'Where the cost went', WHAT.where).both)}<div class="well pad">
<div class="bar" role="img" aria-label="${esc(label)}">${segments}</div>
<ul class="shares">${legend}</ul>
</div></section>`;
}

/** The four series whose dollars moved most against the period before, absent for all time. */
function changes({ query, bySeries, previous }: CallsPage): string {
  if (previous === null) return '';
  const list = [...new Set([...Object.keys(bySeries), ...Object.keys(previous.bySeries)])]
    .map((key) => ({ key, now: bySeries[key] ?? 0, before: previous.bySeries[key] ?? 0 }))
    .filter((x) => Math.abs(x.now - x.before) >= SMALLEST_CALLS_CHANGE_MICROS)
    .sort((a, b) => Math.abs(b.now - b.before) - Math.abs(a.now - a.before) || seriesName(a.key, query.split).localeCompare(seriesName(b.key, query.split)))
    .slice(0, 4);
  const items = list.length
    ? list
        .map(
          (x) =>
            `<li><span class="name">${esc(seriesName(x.key, query.split))}</span><span class="delta ${x.now > x.before ? 'up' : 'down'}"><span aria-hidden="true">${x.now > x.before ? '▲' : '▼'}</span> ${signed(x.now - x.before)}</span><span class="from">${dollars(x.before)} → ${dollars(x.now)}</span></li>`,
        )
        .join('')
    : '<li class="muted">No change</li>';
  const title = `Largest changes by ${SPLIT_LABELS[query.split].toLowerCase()}`;
  return `<section class="panel" aria-labelledby="changes">${band(title, '', 'changes', explain('changes', title, WHAT.changes).both)}<ul class="well changes">${items}</ul></section>`;
}

/** Cost per day, from the Over time rows: a point for every day of the range, even a day with no call. */
function overTime(page: CallsPage, now: number): string {
  const chart: DayChart = dayChart(
    page.groups.map((g) => ({ key: g.key, bySeries: g.bySeries, totalMicros: g.micros })),
    page.series,
    firstDay(page.query.period, now),
    now,
  );
  return costPerDay(chart, (key) => colourOf(page, key), 'cost', explain('perday', 'Cost per day', WHAT.perDay));
}

/** The first cell: a pull request's number and title open it on GitHub, and "Sessions" opens the Monitor's own page. */
function firstCell(g: CallGroupRow, repository: string | null): string {
  if (g.prNumber === null) return `<td class="first">${esc(g.label)}</td>`;
  const text = `<span class="pr-no">#${g.prNumber}</span>${g.title ? ` ${esc(g.title)}` : ''}`;
  const label = repository === null ? text : `<a href="https://github.com/${repository}/pull/${g.prNumber}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  const runs = g.runs ? `${number(g.runs)} contract run${g.runs === 1 ? '' : 's'} · ` : '';
  return `<td class="first">${label}<div class="muted small">${runs}<a href="/pr/${g.prNumber}">Sessions</a></div></td>`;
}

function table(page: CallsPage, repository: string | null): string {
  const { query, groups, series } = page;
  // The heading the panel wears, which names its (i): the tab's name while empty, the table's title otherwise.
  const title = groups.length === 0 ? TAB_LABELS[query.group] : `By ${GROUP_LABELS[query.group].toLowerCase()}`;
  const info = explain(`t-${query.group}`, title, TABLES[query.group]);
  if (groups.length === 0) return `<section class="panel" aria-label="Calls by ${GROUP_LABELS[query.group].toLowerCase()}">${band(title, '', '', info.both)}<p class="well empty">Nothing in this period. No Claude calls match the filters.</p></section>`;
  // The bars scale to the largest row that draws one: a catch-all is left out, so it cannot shrink every other bar.
  const max = Math.max(...groups.filter((g) => !g.catchAll).map((g) => g.micros), 1);
  const heads = series.map((s) => `<th scope="col" class="num"><i style="background:${colourOf(page, s.key)}" aria-hidden="true"></i>${esc(s.short)}</th>`).join('');
  const body = groups
    .map((g) => {
      const split = g.catchAll ? '' : series.map((s) => ((g.bySeries[s.key] ?? 0) > 0 ? `<div style="width:${(((g.bySeries[s.key] ?? 0) / max) * 100).toFixed(1)}%;background:${colourOf(page, s.key)}"></div>` : '')).join('');
      const cells = series.map((s) => `<td class="num">${(g.bySeries[s.key] ?? 0) > 0 ? dollars(g.bySeries[s.key]!) : '<span class="muted">—</span>'}</td>`).join('');
      return `<tr>${firstCell(g, repository)}<td class="num muted">${number(g.calls)}</td><td class="split-cell"><div class="split${g.catchAll ? ' bare' : ''}">${split}</div></td>${cells}<td class="num total">${dollars(g.micros)}</td></tr>`;
    })
    .join('\n');
  const [one, many] = UNITS[query.group];
  return `<section class="panel" aria-label="Calls by ${GROUP_LABELS[query.group].toLowerCase()}">${band(title, `${number(groups.length)} ${groups.length === 1 ? one : many} · ${ORDERS[query.group]}`, '', info.both)}<div class="well">
<div class="scroll"><table class="calls">
<thead><tr><th scope="col" class="first">${GROUP_LABELS[query.group]}</th><th scope="col" class="num">Calls</th><th scope="col" class="split-head">Split</th>${heads}<th scope="col" class="num">Total</th></tr></thead>
<tbody>
${body}
</tbody></table></div>
</div></section>`;
}

/** The public page: Cockpit's own Claude calls, grouped and filtered. Counts and dollars only; the copies hold no user, account or item. */
export function renderClaudeCalls(unfolded: CallsPage, report: { repository?: string | undefined }, now = Date.now()): string {
  const page = foldedPage(unfolded);
  const repository = report.repository !== undefined && REPOSITORY.test(report.repository) ? report.repository : null;
  const body = [
    '<h1 class="sr-only">Cockpit&rsquo;s Claude calls</h1>',
    // The question its tab names, and the words a newcomer will not know, open the page on every grouping.
    lead(questionOf('claude-calls'), LEAD_MORE),
    warning(page.unpriced),
    tiles(page),
    `<div class="row${page.previous === null ? ' alone' : ''}">${whereItWent(page)}${changes(page)}</div>`,
    page.query.group === 'day' ? overTime(page, now) : '',
    table(page, repository),
    jobLines([page.job]),
    EXPLAIN_SCRIPT,
  ].join('\n');
  return shell({ current: 'claude-calls', controls: controls(page), body, style: EXPLAIN_STYLE }, now);
}
