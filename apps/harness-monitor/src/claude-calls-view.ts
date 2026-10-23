import {
  callsQueryString,
  CALL_GROUPS,
  CALL_SPLITS,
  ENVIRONMENTS,
  ENVIRONMENT_NAMES,
  featureName,
  seriesName,
  type CallGroup,
  type CallGroupRow,
  type CallSplit,
  type CallsPage,
  type CallsQuery,
} from './claude-calls-page';
import { dayChart, firstDay, PERIODS, type DayChart, type Period } from './costs';
import { band, esc, selectField, shell } from './look';
import { costPerDay, dollars, jobLines, number, PERIOD_LABELS } from './page';

/** The repository as GitHub names it, `owner/name`; anything else is no repository and links nowhere. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const GROUP_LABELS: Record<CallGroup, string> = { day: 'Day', feature: 'Feature', environment: 'Environment', pr: 'Pull request', startedBy: 'Started by' };
/** What the grouping's tab reads; the table's own first column keeps GROUP_LABELS. */
const TAB_LABELS: Record<CallGroup, string> = { ...GROUP_LABELS, day: 'Over time' };
const SPLIT_LABELS: Record<CallSplit, string> = { environment: 'Environment', feature: 'Feature', model: 'Model', startedBy: 'Started by' };
const UNITS: Record<CallGroup, [string, string]> = { day: ['day', 'days'], feature: ['row', 'rows'], environment: ['row', 'rows'], pr: ['row', 'rows'], startedBy: ['row', 'rows'] };
const ORDERS: Record<CallGroup, string> = { day: 'newest first', pr: 'newest first', environment: 'production first', feature: 'dearest first', startedBy: 'dearest first' };

/** An environment takes its step on the violet ramp by name, so the dark appearance can swap them (src/look.ts). */
const ENVIRONMENT_COLOURS: Record<string, string> = {
  production: 'var(--cat-violet)',
  staging: 'var(--cat-teal)',
  ci: 'var(--cat-slate)',
  local: 'var(--cat-amber)',
};
/** Every other value takes one of these by its place among all on record, so it keeps its colour whatever the filters; they wrap past five, the ramp's steps. */
const RAMP = ['var(--cat-violet)', 'var(--cat-amber)', 'var(--cat-teal)', 'var(--cat-green)', 'var(--cat-slate)'];

/** The colour of a series: grey for a call with no starter, a step on the ramp otherwise. */
function colourOf(page: CallsPage, key: string): string {
  const { split } = page.query;
  if (split === 'environment') return ENVIRONMENT_COLOURS[key] ?? 'var(--cat-grey)';
  if (split === 'startedBy' && key === '') return 'var(--cat-grey)';
  const known = split === 'feature' ? page.features : split === 'model' ? page.models : page.startedBys.filter((s) => s !== '');
  return RAMP[Math.max(known.indexOf(key), 0) % RAMP.length]!;
}

/** A change under half a cent reads $0.00 either way, so it is no change. */
const SMALLEST_CHANGE_MICROS = 5_000;

const signed = (micros: number) => `${micros < 0 ? '−' : '+'}${dollars(Math.abs(micros))}`;

/** A group's tabs on the band; choosing one keeps every filter and the split. */
function groupTabs({ query }: CallsPage): string {
  return CALL_GROUPS.map((g) => `<a href="/claude-calls${callsQueryString(query, { group: g })}"${g === query.group ? ' aria-current="page"' : ''}>${TAB_LABELS[g]}</a>`).join('');
}

function filters({ query, features, models }: CallsPage): string {
  const featureOptions: [string, string][] = [['', 'Every feature'], ...features.map((f): [string, string] => [f, featureName(f)])];
  // A named feature or model no longer on record stays selectable, so the form never silently drops a filter.
  if (query.feature && !features.includes(query.feature)) featureOptions.push([query.feature, featureName(query.feature)]);
  const modelOptions: [string, string][] = [['', 'All models'], ...models.map((m): [string, string] => [m, m])];
  if (query.model && !models.includes(query.model)) modelOptions.push([query.model, query.model]);
  const splitButtons = CALL_SPLITS.map((v) => `<button type="submit" name="split" value="${v}" aria-pressed="${v === query.split}">${SPLIT_LABELS[v]}</button>`).join('');
  return `<form class="filters" method="get" action="/claude-calls">
${selectField('period', 'Period', (Object.keys(PERIODS) as Period[]).map((p): [string, string] => [p, PERIOD_LABELS[p]]), query.period, '30d')}
${selectField('environment', 'Environment', [['', 'Every environment'], ...ENVIRONMENTS.map((e): [string, string] => [e, ENVIRONMENT_NAMES[e]])], query.environment ?? '')}
${selectField('feature', 'Feature', featureOptions, query.feature ?? '')}
${selectField('model', 'Model', modelOptions, query.model ?? '')}
<div class="field"><span id="splitby">Split by</span><div class="toggles" role="group" aria-labelledby="splitby">${splitButtons}</div></div>
<input type="hidden" name="split" value="${query.split}">
<input type="hidden" name="group" value="${query.group}">
<noscript><button type="submit">Apply</button></noscript>
<a class="button" href="/claude-calls/export.csv${callsQueryString(query, { group: 'day', split: 'environment' })}" download>Export CSV</a>
</form>`;
}

function warning(unpriced: number): string {
  if (unpriced === 0) return '';
  return `<section class="panel warning" role="status" aria-labelledby="unpriced">${band('Calls with no price', '', 'unpriced')}<div class="well pad">
<p>${number(unpriced)} call${unpriced === 1 ? '' : 's'} could not be priced: Cockpit&rsquo;s record has no price for the model, or for a kind of token it used. ${unpriced === 1 ? 'It is' : 'They are'} counted in Calls and left out of every dollar total.</p>
</div></section>`;
}

function tiles({ query, totalMicros, calls, unpriced, previous }: CallsPage): string {
  const tile = (label: string, value: string, note: string, cls = '') => `<div class="tile${cls}"><span class="tile-label">${label}</span><span class="tile-value">${value}</span><span class="tile-note">${note}</span></div>`;
  const priced = calls - unpriced;
  const diff = previous === null || Math.abs(totalMicros - previous.micros) < SMALLEST_CHANGE_MICROS ? 0 : totalMicros - previous.micros;
  return `<div class="tiles">
${tile('Spent', dollars(totalMicros), `${esc(PERIOD_LABELS[query.period])} · at API list price`)}
${tile('Calls', number(calls), calls === 0 ? 'none in this period' : priced === 0 ? 'none could be priced' : `${dollars(totalMicros / priced)} a priced call on average`)}
${previous === null ? '' : tile('Against the previous period', diff === 0 ? 'No change' : signed(diff), `${dollars(previous.micros)} before`, diff > 0 ? ' up' : diff < 0 ? ' down' : '')}
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
  return `<section class="panel" aria-labelledby="where">${band(`Where the ${dollars(totalMicros)} went`, `by ${SPLIT_LABELS[query.split].toLowerCase()}`, 'where')}<div class="well pad">
<div class="bar" role="img" aria-label="${esc(label)}">${segments}</div>
<ul class="shares">${legend}</ul>
<p class="note">Every call made with Cockpit&rsquo;s Anthropic key, from production, staging, CI and local development. Workers AI and Claude Code routines are billed elsewhere and are not here. Compare with the Anthropic Console&rsquo;s Cost page for the same days: a gap is spend no row records.</p>
</div></section>`;
}

/** The four series whose dollars moved most against the period before, absent for all time. */
function changes({ query, bySeries, previous }: CallsPage): string {
  if (previous === null) return '';
  const list = [...new Set([...Object.keys(bySeries), ...Object.keys(previous.bySeries)])]
    .map((key) => ({ key, now: bySeries[key] ?? 0, before: previous.bySeries[key] ?? 0 }))
    .filter((x) => Math.abs(x.now - x.before) >= SMALLEST_CHANGE_MICROS)
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
  return `<section class="panel" aria-labelledby="changes">${band(`Largest changes by ${SPLIT_LABELS[query.split].toLowerCase()}`, '', 'changes')}<ul class="well changes">${items}</ul></section>`;
}

/** Cost per day, from the Over time rows: a point for every day of the range, even a day with no call. */
function overTime(page: CallsPage, now: number): string {
  const chart: DayChart = dayChart(
    page.groups.map((g) => ({ key: g.key, bySeries: g.bySeries, totalMicros: g.micros })),
    page.series,
    firstDay(page.query.period, now),
    now,
  );
  return costPerDay(chart, (key) => colourOf(page, key));
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
  if (groups.length === 0) return `<section class="panel" aria-label="Calls by ${GROUP_LABELS[query.group].toLowerCase()}">${band(TAB_LABELS[query.group])}<p class="well empty">Nothing in this period. No Claude calls match the filters.</p></section>`;
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
  return `<section class="panel" aria-label="Calls by ${GROUP_LABELS[query.group].toLowerCase()}">${band(`By ${GROUP_LABELS[query.group].toLowerCase()}`, `${number(groups.length)} ${groups.length === 1 ? one : many} · ${ORDERS[query.group]}`)}<div class="well">
<div class="scroll"><table class="calls">
<thead><tr><th scope="col" class="first">${GROUP_LABELS[query.group]}</th><th scope="col" class="num">Calls</th><th scope="col" class="split-head">Split</th>${heads}<th scope="col" class="num">Total</th></tr></thead>
<tbody>
${body}
</tbody></table></div>
</div></section>`;
}

/** The public page: Cockpit's own Claude calls, grouped and filtered. Counts and dollars only; the copies hold no user, account or item. */
export function renderClaudeCalls(page: CallsPage, report: { repository?: string | undefined }, now = Date.now()): string {
  const repository = report.repository !== undefined && REPOSITORY.test(report.repository) ? report.repository : null;
  const body = [
    '<h1 class="sr-only">Cockpit&rsquo;s Claude calls</h1>',
    filters(page),
    warning(page.unpriced),
    tiles(page),
    `<div class="row${page.previous === null ? ' alone' : ''}">${whereItWent(page)}${changes(page)}</div>`,
    page.query.group === 'day' ? overTime(page, now) : '',
    table(page, repository),
    jobLines([page.job]),
  ].join('\n');
  return shell({ current: 'claude-calls', tabs: groupTabs(page), body }, now);
}
