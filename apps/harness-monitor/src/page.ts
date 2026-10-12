import {
  categoryName,
  dayChart,
  firstDay,
  DEFAULT_GROUP,
  GROUPS,
  median,
  PAGE_SIZE,
  PERIODS,
  queryString,
  SPLITS,
  UNATTRIBUTED,
  WHOS,
  type CostGroup,
  type DayChart,
  type CostQuery,
  type CostsPage,
  type Group,
  type Period,
  type Series,
  type Split,
  type TrendLine,
  type Trends,
  type Who,
} from './costs';
import { type JobName, type JobStatus } from './jobs';
import type { UnpricedLine } from './store';
import { CATEGORIES, type Category } from './validate';

export const number = (n: number) => n.toLocaleString('en-US');
export const dollars = (micros: number) => `$${(micros / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Names, titles and logins come from outside, so they are escaped. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Colours by category, in the design's order. Every other colour is a token in the stylesheet. */
export const COLOURS: Record<Category, string> = {
  unphased: '#C9B79C',
  'scoping-planning': '#B9C4D6',
  building: '#2F5BEA',
  'local-code-review': '#F0A04B',
  'local-security-review': '#9A4A12',
  'after-push': '#6E3FA3',
  'ci-reviews': '#5F6672',
};
const SERIES_COLOURS: Record<string, string> = {
  local: '#2F5BEA',
  cloud: '#2B9A8A',
  actions: '#5F6672',
  merged: '#2E8B57',
  open: '#2F5BEA',
  closed: '#C0504D',
  'no-pr': '#B9C4D6',
  'on-main': '#9A4A12',
};
/** A model takes these by its place among every model on record, so it keeps its colour whatever the filters; they wrap past eight. */
const MODEL_COLOURS = ['#2F5BEA', '#F0A04B', '#6E3FA3', '#2B9A8A', '#C0504D', '#9A4A12', '#5F6672', '#B9C4D6'];
const colourOf = (split: Split, key: string, models: string[]) =>
  split === 'phase'
    ? COLOURS[key as Category]
    : split === 'model'
      ? MODEL_COLOURS[Math.max(models.indexOf(key), 0) % MODEL_COLOURS.length]!
      : SERIES_COLOURS[key]!;
export const PERIOD_LABELS: Record<Period, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', all: 'All time' };
const SPLIT_LABELS: Record<Split, string> = { phase: 'Phase', model: 'Model', where: 'Where', outcome: 'Outcome' };
export const WHO_LABELS: Record<Who, string> = { all: 'All', main: 'Main session', subagents: 'Subagents' };
const GROUP_LABELS: Record<Group, string> = { pr: 'Pull request', issue: 'Issue', engineer: 'Engineer', category: 'Category', day: 'Day' };
/** What the grouping's tab reads; the table's own first column keeps GROUP_LABELS. */
const TAB_LABELS: Record<Group, string> = { ...GROUP_LABELS, day: 'Over time' };
const UNITS: Record<Group, [string, string]> = {
  pr: ['pull request', 'pull requests'],
  issue: ['issue', 'issues'],
  engineer: ['engineer', 'engineers'],
  category: ['category', 'categories'],
  day: ['day', 'days'],
};

const JOB_LABELS: Record<JobName, string> = { linking: 'Branch linking', prices: 'Price list', rebuild: 'Daily totals' };
const NEVER_RAN: Record<JobName, string> = {
  linking: 'has not run yet.',
  prices: 'has not run yet; only the repository&rsquo;s own prices apply.',
  rebuild: 'has not run yet.',
};

/** What each job's last run did, scheduled or by hand: when, how it was started, and its outcome or error. */
function jobLines(statuses: JobStatus[]): string {
  const items = statuses.map(({ job, run, lastSucceededAt }) => {
    // A deployment from before runs were recorded knows only when the job last succeeded.
    const text = run
      ? `last run ${utc(run.ranAt)} (${run.startedBy === 'hand' ? 'by hand' : 'scheduled'}) &mdash; ${esc(run.message)}${
          run.ok ? '' : lastSucceededAt === null ? ' Never succeeded.' : ` Last succeeded ${utc(lastSucceededAt)}.`
        }`
      : lastSucceededAt === null
        ? NEVER_RAN[job]
        : `last succeeded ${utc(lastSucceededAt)}.`;
    return `<li data-job="${job}" class="${run && !run.ok ? 'failed' : ''}">${JOB_LABELS[job]}: ${text}</li>`;
  });
  return `<ul class="jobs muted">${items.join('')}</ul>`;
}

function warning(unpriced: UnpricedLine[]): string {
  if (unpriced.length === 0) return '';
  const requests = unpriced.reduce((sum, u) => sum + u.requests, 0);
  const rows = unpriced
    .map(
      (u) =>
        `<tr><td>${esc(u.model)}</td><td>${number(u.requests)}</td><td>${number(u.inputTokens)}</td><td>${number(u.outputTokens)}</td><td>${number(u.cacheCreationTokens)}</td><td>${number(u.cacheReadTokens)}</td><td>${number(u.branches)}</td></tr>`,
    )
    .join('\n');
  return `<section class="warning" role="status"><h2>Tokens with no price</h2>
<p>${number(requests)} request${requests === 1 ? '' : 's'} could not be priced: the price list does not cover the model, or has no rate for a kind of token it used. They are left out of every dollar total and priced by the daily job once the list covers them.</p>
<div class="scroll"><table>
<thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache write</th><th>Cache read</th><th>Branches</th></tr></thead>
<tbody>
${rows}
</tbody></table></div></section>`;
}

function select(id: string, label: string, options: [value: string, text: string][], current: string): string {
  const opts = options
    .map(([value, text]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text)}</option>`)
    .join('');
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${id}" onchange="this.form.submit()">${opts}</select></div>`;
}

function filters({ query, engineers, models }: CostsPage): string {
  const engineerOptions: [string, string][] = [['', 'Everyone'], ...engineers.map((e): [string, string] => [e, e]), [UNATTRIBUTED, 'Unattributed']];
  // A named engineer who is no longer in the list stays selectable, so the form never silently drops a filter.
  if (query.engineer && !engineerOptions.some(([v]) => v === query.engineer)) engineerOptions.push([query.engineer, query.engineer]);
  const modelOptions: [string, string][] = [['', 'All models'], ...models.map((m): [string, string] => [m, m])];
  // A named model no longer on record stays selectable, so the form never silently drops a filter.
  if (query.model && !models.includes(query.model)) modelOptions.push([query.model, query.model]);
  const splitButtons = SPLITS.map(
    (v) =>
      `<button type="submit" name="split" value="${v}"${v === query.split ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${SPLIT_LABELS[v]}</button>`,
  ).join('');
  const buttons = GROUPS.map(
    (g) =>
      `<button type="submit" name="group" value="${g}"${g === query.group ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${TAB_LABELS[g]}</button>`,
  ).join('');
  return `<form class="filters" method="get" action="/">
${select('period', 'Period', (Object.keys(PERIODS) as Period[]).map((p): [string, string] => [p, PERIOD_LABELS[p]]), query.period)}
${select('engineer', 'Engineer', engineerOptions, query.engineer ?? '')}
${select('category', 'Category', [['', 'All categories'], ...CATEGORIES.map((c): [string, string] => [c, categoryName(c)])], query.category ?? '')}
${select('model', 'Model', modelOptions, query.model ?? '')}
${select('who', 'Requests', WHOS.map((w): [string, string] => [w, WHO_LABELS[w]]), query.who)}
<div class="field"><span id="splitby">Split by</span><div class="segmented" role="group" aria-labelledby="splitby">${splitButtons}</div></div>
<input type="hidden" name="split" value="${query.split}">
<div class="field"><span id="groupby">Group by</span><div class="segmented" role="group" aria-labelledby="groupby">${buttons}</div></div>
<input type="hidden" name="group" value="${query.group}">
<noscript><button type="submit">Apply</button></noscript>
<a class="button" href="/export.csv${queryString(query, { group: DEFAULT_GROUP, split: 'phase', page: 1 })}" download>Export CSV</a>
</form>`;
}

function whereItWent(page: CostsPage): string {
  const { query, groups, bySeries, totalMicros } = page;
  // A category filter leaves the bar and legend the one phase it keeps; the table keeps every column.
  const series = query.split === 'phase' && query.category !== null ? page.series.filter((s) => s.key === query.category) : page.series;
  const [one, many] = UNITS[query.group];
  const summary =
    groups.length === 0
      ? ''
      : `<span class="muted">${number(groups.length)} ${groups.length === 1 ? one : many} · median ${dollars(median(groups.map((g) => g.totalMicros)))} each · at API list price</span>`;
  const cost = (s: Series) => bySeries[s.key] ?? 0;
  const segments = series
    .map((s) => (cost(s) > 0 ? `<div style="width:${((cost(s) / totalMicros) * 100).toFixed(2)}%;background:${colourOf(query.split, s.key, page.models)}"></div>` : ''))
    .join('');
  const label = series.map((s) => `${s.label} ${dollars(cost(s))}`).join(', ');
  const legend = series
    .map(
      (s) =>
        `<div class="legend-item"><span class="swatch" style="background:${colourOf(query.split, s.key, page.models)}" aria-hidden="true"></span><span>${esc(s.label)}</span><span class="mono muted">${dollars(cost(s))}</span></div>`,
    )
    .join('');
  return `<section class="card where" aria-labelledby="where">
<div class="where-head"><h2 id="where">Where the period&rsquo;s ${dollars(totalMicros)} went</h2>${summary}</div>
<div class="bar" role="img" aria-label="${esc(label)}">${segments}</div>
<div class="legend">${legend}</div>
<p class="muted small">CI reviews counts the <span class="mono">@claude</span> runs in GitHub Actions only. Claude Code Review runs on Anthropic&rsquo;s side, is billed through claude.ai, and is <strong>not measured</strong>.</p>
</section>`;
}

const CHART = { width: 1000, height: 280, left: 72, right: 16, top: 16, bottom: 32 };

/**
 * Cost per day as lines, one per series of the split with a dashed total.
 * Every day of the range has a point, and each point's title carries its value.
 */
function overTime(page: CostsPage, now: number): string {
  const { query, models } = page;
  const chart: DayChart = dayChart(page.groups, page.series, firstDay(query.period, now), now);
  if (chart.days.length === 0) return '';
  const { width, height, left, right, top, bottom } = CHART;
  const peak = Math.max(...chart.total, 1);
  const x = (i: number) => (chart.days.length === 1 ? (left + width - right) / 2 : left + (i / (chart.days.length - 1)) * (width - left - right));
  const y = (micros: number) => top + (1 - micros / peak) * (height - top - bottom);
  const lines = [
    ...chart.lines.map((l) => ({ ...l, colour: colourOf(query.split, l.key, models), dash: false })),
    { key: 'total', label: 'Total', micros: chart.total, colour: 'var(--ink)', dash: true },
  ];
  const grid = [0, 0.5, 1]
    .map((f) => `<line x1="${left}" x2="${width - right}" y1="${y(peak * f).toFixed(1)}" y2="${y(peak * f).toFixed(1)}" stroke="var(--line-soft)"/><text x="${left - 8}" y="${(y(peak * f) + 4).toFixed(1)}" text-anchor="end" class="axis">${dollars(peak * f)}</text>`)
    .join('');
  const ends = [...new Set([0, Math.floor((chart.days.length - 1) / 2), chart.days.length - 1])];
  const dates = ends.map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 10}" text-anchor="${i === 0 && ends.length > 1 ? 'start' : i === chart.days.length - 1 && ends.length > 1 ? 'end' : 'middle'}" class="axis">${chart.days[i]}</text>`).join('');
  const drawn = lines
    .map((l) => {
      const points = l.micros.map((m, i) => `${x(i).toFixed(1)},${y(m).toFixed(1)}`).join(' ');
      const dots = l.micros
        .map((m, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(m).toFixed(1)}" r="3" fill="${l.colour}"><title>${esc(l.label)} · ${chart.days[i]} · ${dollars(m)}</title></circle>`)
        .join('');
      return `<g data-line="${esc(l.key)}"><polyline points="${points}" fill="none" stroke="${l.colour}" stroke-width="2"${l.dash ? ' stroke-dasharray="6 4"' : ''}/>${dots}</g>`;
    })
    .join('');
  const legend = lines
    .map((l) => `<div class="legend-item"><span class="swatch${l.dash ? ' dash' : ''}" style="background:${l.dash ? 'none' : l.colour}" aria-hidden="true"></span><span>${esc(l.label)}</span></div>`)
    .join('');
  return `<section class="card chart" aria-labelledby="perday">
<h2 id="perday">Cost per day</h2>
<div class="scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cost per day, ${chart.days[0]} to ${chart.days.at(-1)}: ${esc(lines.map((l) => l.label).join(', '))}">${grid}${dates}${drawn}</svg></div>
<div class="legend">${legend}</div>
</section>`;
}

/** A count as an axis reads it: 120,000 is "120k". */
const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000).toLocaleString('en-US')}k` : n.toLocaleString('en-US', { maximumFractionDigits: 0 }));

interface TrendDrawing {
  id: string;
  title: string;
  /** What the chart measures, in a sentence. */
  note: string;
  lines: (TrendLine & { colour: string; dash?: boolean })[];
  /** A value as a point's title reads it, and as the axis does. */
  value: (n: number) => string;
  axis: (n: number) => string;
}

/** One trend chart: a line per series over the buckets, broken where a bucket has no value rather than dropped to zero. */
function trendChart(t: Trends, d: TrendDrawing): string {
  const { width, height, left, right, top, bottom } = CHART;
  const shown = d.lines.filter((l) => l.values.some((v) => v !== null));
  const head = `<section class="card chart" aria-labelledby="${d.id}"><h2 id="${d.id}">${d.title}</h2><p class="muted small">${d.note}</p>`;
  if (shown.length === 0) return `${head}<p class="empty" data-empty="${d.id}">Nothing to chart in this period.</p></section>`;
  const peak = Math.max(...shown.flatMap((l) => l.values.map((v) => v ?? 0)), 1);
  const x = (i: number) => (t.buckets.length === 1 ? (left + width - right) / 2 : left + (i / (t.buckets.length - 1)) * (width - left - right));
  const y = (v: number) => top + (1 - v / peak) * (height - top - bottom);
  const grid = [0, 0.5, 1]
    .map((f) => `<line x1="${left}" x2="${width - right}" y1="${y(peak * f).toFixed(1)}" y2="${y(peak * f).toFixed(1)}" stroke="var(--line-soft)"/><text x="${left - 8}" y="${(y(peak * f) + 4).toFixed(1)}" text-anchor="end" class="axis">${d.axis(peak * f)}</text>`)
    .join('');
  const ends = [...new Set([0, Math.floor((t.buckets.length - 1) / 2), t.buckets.length - 1])];
  const dates = ends.map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 10}" text-anchor="${i === 0 && ends.length > 1 ? 'start' : i === t.buckets.length - 1 && ends.length > 1 ? 'end' : 'middle'}" class="axis">${t.weekly ? 'Week of ' : ''}${t.buckets[i]}</text>`).join('');
  const drawn = shown
    .map((l) => {
      // A run of buckets with values is one segment; a bucket with none ends it.
      const segments: string[][] = [[]];
      l.values.forEach((v, i) => {
        if (v === null) segments.push([]);
        else segments.at(-1)!.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      });
      const paths = segments.filter((s) => s.length > 1).map((s) => `<polyline points="${s.join(' ')}" fill="none" stroke="${l.colour}" stroke-width="2"${l.dash ? ' stroke-dasharray="6 4"' : ''}/>`).join('');
      const dots = l.values
        .map((v, i) => (v === null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${l.colour}"><title>${esc(l.label)} · ${t.weekly ? 'week of ' : ''}${t.buckets[i]} · ${d.value(v)}</title></circle>`))
        .join('');
      return `<g data-line="${esc(l.key)}">${paths}${dots}</g>`;
    })
    .join('');
  const legend = shown.length === 1 ? '' : `<div class="legend">${shown.map((l) => `<div class="legend-item"><span class="swatch${l.dash ? ' dash' : ''}" style="background:${l.dash ? 'none' : l.colour}" aria-hidden="true"></span><span>${esc(l.label)}</span></div>`).join('')}</div>`;
  return `${head}<div class="scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${d.title}, ${t.buckets[0]} to ${t.buckets.at(-1)}">${grid}${dates}${drawn}</svg></div>${legend}</section>`;
}

/** "Is the harness getting more expensive?": starting context, pull request size and cost per 1,000 lines changed. */
function harnessTrends(page: CostsPage): string {
  const t = page.trends;
  if (t === null) return '';
  const ink = '#2F5BEA';
  const per = t.weekly ? 'week' : 'day';
  const charts = [
    trendChart(t, {
      id: 'starting-context',
      title: 'Starting context',
      note: `Median tokens (input, cache write and cache read) in each session&rsquo;s first main-agent request, by ${per}.`,
      lines: [{ key: 'starting-context', label: 'Starting context', values: t.startingContext, colour: ink }],
      value: (n) => `${number(n)} tokens`,
      axis: compact,
    }),
    trendChart(t, {
      id: 'pull-request-size',
      title: 'Pull request size',
      note: `Median lines changed per merged pull request, by ${per} merged.`,
      lines: [{ key: 'pull-request-size', label: 'Lines changed', values: t.prSize, colour: ink }],
      value: (n) => `${number(n)} lines`,
      axis: compact,
    }),
    trendChart(t, {
      id: 'cost-per-line',
      title: 'Cost per 1,000 lines changed',
      note: `Merged pull requests&rsquo; cost divided by thousands of lines added plus removed, by ${per} merged. A phase is not drawn before it was recorded (21 Sep 2026).`,
      lines: t.costPerThousandLines.map((l) => (l.key === 'total' ? { ...l, colour: 'var(--ink)', dash: true } : { ...l, colour: COLOURS[l.key as Category] })),
      value: dollars,
      axis: dollars,
    }),
  ];
  return `<section class="trends" aria-labelledby="trends"><h2 id="trends">Is the harness getting more expensive?</h2>${charts.join('\n')}</section>`;
}

/** The repository as GitHub names it, `owner/name`; anything else is no repository and links nowhere. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A link that opens on GitHub in a new tab. */
const github = (repository: string, path: string, text: string) =>
  `<a href="https://github.com/${repository}/${path}" target="_blank" rel="noopener noreferrer">${text}</a>`;

/**
 * The first cell: a pull request's number and title open it on GitHub, the
 * issue under it opens on GitHub, and "Sessions" opens the monitor's own page.
 * An issue row opens its issue; a branch no pull request names, "No issue",
 * "Unattributed" and the rest link nowhere.
 */
function firstCell(g: CostGroup, query: CostQuery, repository: string | null): string {
  const text = esc(g.label);
  const label = repository === null ? text : g.prNumber !== null ? github(repository, `pull/${g.prNumber}`, text) : g.issue !== null && query.group === 'issue' ? github(repository, `issues/${g.issue}`, text) : text;
  if (g.sub === null) return `<td class="first">${label}</td>`;
  const issue = repository !== null && g.prNumber !== null && g.issue !== null ? github(repository, `issues/${g.issue}`, esc(g.sub)) : esc(g.sub);
  const sessions = g.prNumber === null ? '' : ` · <a href="/pr/${g.prNumber}${queryString(query, { engineer: null, group: DEFAULT_GROUP, page: 1 })}">Sessions</a>`;
  return `<td class="first">${label}<div class="muted small">${issue}${sessions}</div></td>`;
}

function row(g: CostGroup, group: Group, max: number, query: CostQuery, series: Series[], models: string[], repository: string | null): string {
  const first = firstCell(g, query, repository);
  const extra =
    group === 'pr'
      ? `<td>${g.engineer === null ? '' : esc(g.engineer)}</td><td class="nowrap">${g.merged === null ? '' : esc(g.merged)}</td>` +
        // Blank, not zero, for what linking has not read.
        `<td class="nowrap mono">${g.lines === null ? '' : `+${number(g.lines.added)} −${number(g.lines.removed)}`}</td>` +
        `<td class="nowrap">${g.openToMerged ?? ''}</td><td class="num mono">${g.ciRounds === null ? '' : number(g.ciRounds)}</td>` +
        `<td class="num mono">${g.rounds === null ? '' : number(g.rounds)}</td><td class="num mono">${g.findings === null ? '' : number(g.findings)}</td>`
      : group === 'issue' || group === 'engineer'
        ? `<td>${number(g.pullRequests)}</td>`
        : '';
  const cost = (s: Series) => g.bySeries[s.key] ?? 0;
  const split = series
    .map((s) => (cost(s) > 0 ? `<div style="width:${((cost(s) / max) * 100).toFixed(1)}%;background:${colourOf(query.split, s.key, models)}"></div>` : ''))
    .join('');
  const cells = series.map((s) => `<td class="num mono${s.key === 'ci-reviews' ? ' muted' : ''}">${cost(s) > 0 ? dollars(cost(s)) : '—'}</td>`).join('');
  const unpriced = g.unpricedRequests > 0 ? ` <span class="unpriced">+ ${number(g.unpricedRequests)} unpriced</span>` : '';
  return `<tr>${first}${extra}<td><div class="split">${split}</div></td>${cells}<td class="num mono total">${dollars(g.totalMicros)}${unpriced}</td></tr>`;
}

function table(page: CostsPage, repository: string | null): string {
  const { query, groups } = page;
  if (groups.length === 0) return `<section class="card"><p class="empty">Nothing in this period. No Claude Code requests match the filters.</p></section>`;
  // A page past the end shows the last one, rather than an empty table.
  const pageNo = Math.min(query.page, Math.ceil(groups.length / PAGE_SIZE));
  const start = (pageNo - 1) * PAGE_SIZE;
  const shown = groups.slice(start, start + PAGE_SIZE);
  const max = Math.max(...shown.map((g) => g.totalMicros), 1);
  const extraHeads = query.group === 'pr' ? '<th scope="col">Engineer</th><th scope="col">Merged</th><th scope="col">Lines</th><th scope="col">Open → merged</th><th scope="col" class="num">CI rounds</th><th scope="col" class="num">Rounds</th><th scope="col" class="num">Findings</th>' : query.group === 'issue' || query.group === 'engineer' ? '<th scope="col">Pull requests</th>' : '';
  const heads = page.series.map((s) => `<th scope="col" class="num">${esc(s.short)}</th>`).join('');
  const link = (to: number, text: string) => `<a href="/${queryString(query, { page: to })}">${text}</a>`;
  const pager = [pageNo > 1 ? link(pageNo - 1, 'Previous') : '', start + PAGE_SIZE < groups.length ? link(pageNo + 1, `Next ${PAGE_SIZE}`) : '']
    .filter(Boolean)
    .join(' · ');
  return `<section class="card table-card" aria-label="Cost by ${GROUP_LABELS[query.group].toLowerCase()}">
<div class="scroll"><table class="costs">
<thead><tr><th scope="col" class="first">${GROUP_LABELS[query.group]}</th>${extraHeads}<th scope="col" class="split-head">Split</th>${heads}<th scope="col" class="num">Total${query.group === 'day' ? '' : ' ▾'}</th></tr></thead>
<tbody>
${shown.map((g) => row(g, query.group, max, query, page.series, page.models, repository)).join('\n')}
</tbody></table></div>
<div class="foot"><span>Showing ${shown.length === groups.length ? number(groups.length) : `${number(start + 1)}–${number(start + shown.length)} of ${number(groups.length)}`} · sorted by ${query.group === 'day' ? 'day, newest first' : 'total'}</span><span>${pager}</span></div>
</section>`;
}

export const STYLE = `
:root{--bg:#F6F6F3;--card:#FFF;--ink:#1B1D21;--muted:#5A5E66;--line:#DCDCD6;--line-soft:#EDEDE8;--control:#C9CAC3;--accent:#EEF1FB;--link:#2448C8;--warn-bg:#FDF5E6;--warn-line:#E3B25A;--warn-ink:#8A5A00;--track:#F0F0EC}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 'IBM Plex Sans',system-ui,sans-serif}
a{color:var(--link)}
.mono{font-family:'IBM Plex Mono',ui-monospace,monospace}.muted{color:var(--muted)}.small{font-size:13px}.nowrap{white-space:nowrap}
header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px;padding:16px;border-bottom:1px solid var(--line);background:var(--card)}
header .name{font-weight:600;font-size:16px}header .section{padding:8px 12px;border-radius:6px;background:var(--accent);font-weight:500}
header .status{margin-left:auto;color:var(--muted);font-size:13px}
main{max-width:1376px;margin:0 auto;padding:24px 16px 48px;display:flex;flex-direction:column;gap:20px}
h1,h2,p{margin:0}h2{font-size:16px;font-weight:600}
.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px}
.field{display:flex;flex-direction:column;gap:4px}.field label,.field>span{font-size:12px;color:var(--muted)}
select,button{height:40px;font:inherit;color:inherit}
select{padding:0 12px;border:1px solid var(--control);border-radius:6px;background:var(--card)}
.segmented{display:flex;border:1px solid var(--control);border-radius:6px;overflow:hidden;background:var(--card);flex-wrap:wrap}
.segmented button{padding:0 14px;border:0;border-left:1px solid var(--control);background:var(--card);cursor:pointer}
.segmented button:first-child{border-left:0}
.segmented button[aria-pressed=true]{background:var(--ink);color:#FFF}
a.button{display:inline-flex;align-items:center;height:40px;padding:0 14px;border:1px solid var(--control);border-radius:6px;background:var(--card);color:var(--ink);text-decoration:none;margin-left:auto}
:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.warning{border:1px solid var(--warn-line);border-radius:8px;background:var(--warn-bg);padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.warning h2{color:var(--warn-ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px}
.where{display:flex;flex-direction:column;gap:12px;padding:20px}
.where-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 24px}
.bar{display:flex;height:28px;border-radius:4px;overflow:hidden;background:var(--track)}
.legend{display:flex;flex-wrap:wrap;gap:8px 28px}.legend-item{display:flex;align-items:center;gap:8px}
.swatch{width:12px;height:12px;border-radius:2px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.costs{min-width:1100px}
th,td{padding:12px 8px;text-align:left;border-bottom:1px solid var(--line-soft);vertical-align:top}
th{font-size:12px;font-weight:500;color:var(--muted);border-bottom-color:var(--line)}
th:first-child,td:first-child{padding-left:16px}th:last-child,td:last-child{padding-right:16px}
.num{text-align:right}.total{font-weight:500}.first{max-width:380px}
.split-head{width:220px}.split{display:flex;height:10px;background:var(--track);border-radius:2px;overflow:hidden;margin-top:4px}
.unpriced{color:var(--warn-ink);font-size:.85em;white-space:nowrap}
.foot{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px 16px;color:var(--muted);font-size:13px}
.jobs{list-style:none;margin:12px 16px;padding:0;font-size:13px}
.jobs .failed{color:var(--warn-ink)}
.empty{padding:24px;color:var(--muted)}
.chart{display:flex;flex-direction:column;gap:12px;padding:20px}.chart svg{display:block;width:100%;min-width:640px;height:auto}.axis{font-size:12px;fill:var(--muted)}
.trends{display:flex;flex-direction:column;gap:12px}
.swatch.dash{width:18px;height:0;border-top:2px dashed var(--ink);border-radius:0}
@media (max-width:640px){.segmented button{flex:1 1 auto}}
`;

/** The public page: Claude Code's cost, grouped and filtered. Counts and dollars only; never an email or any content. */
export function renderPage(
  page: CostsPage,
  report: { unpriced: UnpricedLine[]; repository?: string | undefined },
  now = Date.now(),
): string {
  const repository = report.repository !== undefined && REPOSITORY.test(report.repository) ? report.repository : null;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Monitor</title>
<style>${STYLE}</style>
</head><body>
<header><h1 class="name">Harness Monitor</h1><span class="section">Claude Code costs</span>
<span class="status">Updated ${utc(now)} · Public, read-only.</span></header>
<main>
${filters(page)}
${warning(report.unpriced)}
${whereItWent(page)}
${page.query.group === 'day' ? overTime(page, now) : ''}
${harnessTrends(page)}
${table(page, repository)}
${jobLines(page.jobs)}
</main>
</body></html>`;
}
