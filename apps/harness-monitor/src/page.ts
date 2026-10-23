import { formatDateTime, formatDay } from './belgium';
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
  SAME_AS_ROWS,
  SPLITS,
  UNATTRIBUTED,
  UNKNOWN_ENGINEER,
  WHOS,
  type CostGroup,
  type DayChart,
  type CostQuery,
  type CostsPage,
  type Group,
  type Measure,
  type Period,
  type Series,
  type Split,
  type TrendLine,
  type Trends,
  type Who,
} from './costs';
import { type JobName, type JobStatus } from './jobs';
import { band, esc, shell } from './look';
import type { UnpricedLine } from './store';
import { CATEGORIES, type Category } from './validate';

export const number = (n: number) => n.toLocaleString('en-US');
export const dollars = (micros: number) => `$${(micros / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Cockpit's category colours, by name, so the dark appearance can swap them (src/look.ts). */
export const COLOURS: Record<Category, string> = {
  unphased: 'var(--cat-grey)',
  'outside-process': 'var(--cat-amber)',
  'scoping-planning': 'var(--cat-slate)',
  building: 'var(--cat-violet)',
  'local-code-review': 'var(--cat-amber)',
  'local-security-review': 'var(--cat-slate)',
  'after-push': 'var(--cat-teal)',
  'ci-reviews': 'var(--cat-green)',
  'process-review': 'var(--cat-violet)',
};
const SERIES_COLOURS: Record<string, string> = {
  local: 'var(--cat-violet)',
  cloud: 'var(--cat-teal)',
  actions: 'var(--cat-slate)',
  merged: 'var(--cat-green)',
  open: 'var(--cat-violet)',
  closed: 'var(--over)',
  'no-pr': 'var(--cat-grey)',
  'on-main': 'var(--cat-amber)',
};
/** A model or an engineer takes these by its place among all on record, so it keeps its colour whatever the filters; they wrap past five, the ramp's steps. The requests no pull request claims and the pull requests with no known author take the ramp's grey, for "other or none". */
const MODEL_COLOURS = ['var(--cat-violet)', 'var(--cat-amber)', 'var(--cat-teal)', 'var(--cat-green)', 'var(--cat-slate)'];
const colourOf = (split: Split, key: string, known: string[]) =>
  split === 'phase'
    ? COLOURS[key as Category]
    : split === 'model' || split === 'engineer'
      ? key === UNATTRIBUTED || key === UNKNOWN_ENGINEER
        ? 'var(--cat-grey)'
        : MODEL_COLOURS[Math.max(known.indexOf(key), 0) % MODEL_COLOURS.length]!
      : SERIES_COLOURS[key]!;
/** The keys a colouring takes its colours from: every engineer on record, or every model. */
const knownKeys = (page: CostsPage) => (page.query.split === 'engineer' ? page.engineers : page.models);
export const PERIOD_LABELS: Record<Period, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', all: 'All time' };
export const WHO_LABELS: Record<Who, string> = { all: 'All', main: 'Main session', subagents: 'Subagents' };
const GROUP_LABELS: Record<Group, string> = { pr: 'Pull request', issue: 'Issue', engineer: 'Engineer', category: 'Category', day: 'Day' };
/** What the footer calls each grouping's own order. */
const SORTED_BY: Record<Group, string> = { pr: 'newest first', issue: 'newest first', engineer: 'total', category: 'pipeline order', day: 'day, newest first' };
const UNITS: Record<Group, [string, string]> = {
  pr: ['pull request', 'pull requests'],
  issue: ['issue', 'issues'],
  engineer: ['engineer', 'engineers'],
  category: ['category', 'categories'],
  day: ['day', 'days'],
};

const JOB_LABELS: Record<JobName, string> = {
  linking: 'Branch linking',
  prices: 'Price list',
  rebuild: 'Daily totals',
  'claude-calls': 'Cockpit&rsquo;s Claude calls',
};
const NEVER_RAN: Record<JobName, string> = {
  linking: 'has not run yet.',
  prices: 'has not run yet; only the repository&rsquo;s own prices apply.',
  rebuild: 'has not run yet.',
  'claude-calls': 'has not run yet.',
};

/** What each job's last run did, scheduled or by hand: when, how it was started, and its outcome or error. */
export function jobLines(statuses: JobStatus[]): string {
  const items = statuses.map(({ job, run, lastSucceededAt }) => {
    // A deployment from before runs were recorded knows only when the job last succeeded.
    const text = run
      ? `last run ${formatDateTime(run.ranAt)} (${run.startedBy === 'hand' ? 'by hand' : 'scheduled'}) &mdash; ${esc(run.message)}${
          run.ok ? '' : lastSucceededAt === null ? ' Never succeeded.' : ` Last succeeded ${formatDateTime(lastSucceededAt)}.`
        }`
      : lastSucceededAt === null
        ? NEVER_RAN[job]
        : `last succeeded ${formatDateTime(lastSucceededAt)}.`;
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
  return `<section class="panel warning" role="status" aria-labelledby="unpriced">${band('Tokens with no price', '', 'unpriced')}<div class="well pad">
<p>${number(requests)} request${requests === 1 ? '' : 's'} could not be priced: the price list does not cover the model, or has no rate for a kind of token it used. They are left out of every dollar total and priced by the daily job once the list covers them.</p>
<div class="scroll"><table>
<thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache write</th><th>Cache read</th><th>Branches</th></tr></thead>
<tbody>
${rows}
</tbody></table></div></div></section>`;
}

const ROW_WORDS: Record<Group, string> = { day: 'each day', pr: 'each pull request', issue: 'each issue', engineer: 'each engineer', category: 'each phase' };
const COLOUR_WORDS: Record<Split, string> = { phase: 'phase', engineer: 'engineer', model: 'model', where: 'where it ran', outcome: 'outcome' };
const PERIOD_WORDS: Record<Period, string> = { '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days', all: 'all time' };

/** A select inside the sentence: its name read by assistive technology, its value shown as a word of the sentence. A filter that holds a value wears `data-set`. */
function inline(name: string, label: string, options: [value: string, text: string, off?: boolean][], current: string, resting: string | null = null): string {
  const opts = options.map(([v, t, off]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}${off ? ' disabled' : ''}>${esc(t)}</option>`).join('');
  // New rows start in their own order, so choosing them leaves the form's sort behind; every other choice keeps it.
  const leave = name === 'group' ? 'if(this.form.elements.sort)this.form.elements.sort.disabled=true;' : '';
  return `<select name="${name}" aria-label="${label}" onchange="${leave}this.form.submit()"${resting !== null && current !== resting ? ' data-set' : ''}>${opts}</select>`;
}

/**
 * The page's controls as one sentence on the band, pinned to the top: what the
 * rows are, what colours them and over when; then the filters that narrow it.
 * Everything below follows them. A colouring that would repeat the rows is
 * offered but disabled.
 */
function controls({ query, engineers, models }: CostsPage): string {
  const engineerOptions: [string, string][] = [['', 'Everyone'], ...engineers.map((e): [string, string] => [e, e]), [UNATTRIBUTED, 'Unattributed']];
  // A named engineer who is no longer in the list stays selectable, so the form never silently drops a filter.
  if (query.engineer && !engineerOptions.some(([v]) => v === query.engineer)) engineerOptions.push([query.engineer, query.engineer]);
  const modelOptions: [string, string][] = [['', 'All models'], ...models.map((m): [string, string] => [m, m])];
  // A named model no longer on record stays selectable, so the form never silently drops a filter.
  if (query.model && !models.includes(query.model)) modelOptions.push([query.model, query.model]);
  return `<form class="sentence-form" method="get" action="/">
<p class="sentence">Show cost for ${inline('group', 'Rows', GROUPS.map((g): [string, string] => [g, ROW_WORDS[g]]), query.group)}
coloured by ${inline('split', 'Colours', SPLITS.map((v): [string, string, boolean] => [v, COLOUR_WORDS[v], SAME_AS_ROWS[query.group] === v]), query.split)}
over ${inline('period', 'Period', (Object.keys(PERIODS) as Period[]).map((p): [string, string] => [p, PERIOD_WORDS[p]]), query.period)}</p>
<div class="only"><span>Only</span>
${inline('engineer', 'Engineer', engineerOptions, query.engineer ?? '', '')}
${inline('category', 'Phase', [['', 'All phases'], ...CATEGORIES.map((c): [string, string] => [c, categoryName(c)])], query.category ?? '', '')}
${inline('model', 'Model', modelOptions, query.model ?? '', '')}
${inline('who', 'Requests', WHOS.map((w): [string, string] => [w, w === 'all' ? 'All requests' : WHO_LABELS[w]]), query.who, 'all')}
<a class="button" href="/export.csv${queryString(query, { group: DEFAULT_GROUP, split: 'phase', sort: 'default', page: 1 })}" download>Export CSV</a></div>
${query.sort === 'total' ? '<input type="hidden" name="sort" value="total">' : ''}
<noscript><button type="submit">Apply</button></noscript>
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
      : `${number(groups.length)} ${groups.length === 1 ? one : many} · median ${dollars(median(groups.map((g) => g.totalMicros)))} each · at API list price`;
  const cost = (s: Series) => bySeries[s.key] ?? 0;
  const segments = series
    .map((s) => (cost(s) > 0 ? `<div style="width:${((cost(s) / totalMicros) * 100).toFixed(2)}%;background:${colourOf(query.split, s.key, knownKeys(page))}"></div>` : ''))
    .join('');
  const label = series.map((s) => `${s.label} ${dollars(cost(s))}`).join(', ');
  const legend = series
    .map(
      (s) =>
        `<li><i style="background:${colourOf(query.split, s.key, knownKeys(page))}" aria-hidden="true"></i><span class="name">${esc(s.label)}</span><span class="amount">${dollars(cost(s))}</span></li>`,
    )
    .join('');
  return `<section class="panel" aria-labelledby="where">${band(`Where the period&rsquo;s ${dollars(totalMicros)} went, by ${COLOUR_WORDS[query.split]}`, summary, 'where')}<div class="well pad">
<div class="bar" role="img" aria-label="${esc(label)}">${segments}</div>
<ul class="shares">${legend}</ul>
<p class="note">CI reviews counts the <span class="mono">@claude</span> runs in GitHub Actions only. Claude Code Review runs on Anthropic&rsquo;s side, is billed through claude.ai, and is <strong>not measured</strong>.</p>
</div></section>`;
}

/** A change in dollars with its sign; the Claude calls page's change on the previous period reads it. */
export const signed = (micros: number) => `${micros < 0 ? '−' : '+'}${dollars(Math.abs(micros))}`;

const CHART = { width: 1000, height: 280, left: 72, right: 16, top: 16, bottom: 32 };

/**
 * A token count as people say one: 9,946, 74k, 665.6M, 1.31B. Each unit starts
 * where the one below would round up to a thousand of it, so 999,600 reads 1.0M, not 1000k.
 */
export const tokenCount = (n: number) =>
  n >= 999.95e6 ? `${(n / 1e9).toFixed(2)}B` : n >= 999.5e3 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : number(Math.round(n));

/** How each per-day chart is headed, labelled and read. */
const MEASURES: Record<Measure, { title: string; id: string; value: (n: number) => string; axis: (n: number) => string; note: string }> = {
  cost: { title: 'Cost per day', id: 'perday', value: dollars, axis: dollars, note: '' },
  tokens: {
    title: 'Tokens per day',
    id: 'tokensperday',
    value: (n) => `${tokenCount(n)} tokens`,
    axis: tokenCount,
    note: '<p class="note chart-note">Input, output, cache write and cache read tokens summed, priced or not.</p>',
  },
};

/**
 * Cost or tokens per day as lines, one per series of the split with a dashed
 * total. Every day of the range has a point, and each point's title carries its value.
 */
function overTime(page: CostsPage, now: number, measure: Measure): string {
  const { query } = page;
  const chart = dayChart(page.groups, measure === 'cost' ? page.series : page.tokenSeries, firstDay(query.period, now), now, measure);
  return costPerDay(chart, (key) => colourOf(query.split, key, knownKeys(page)), measure);
}

/** The per-day panel for a chart in its measure, each line in the colour `colour` gives its series; empty where the chart has no day. */
export function costPerDay(chart: DayChart, colour: (key: string) => string, measure: Measure = 'cost'): string {
  if (chart.days.length === 0) return '';
  const { title, id, value, axis, note } = MEASURES[measure];
  const { width, height, left, right, top, bottom } = CHART;
  const peak = Math.max(...chart.total, 1);
  const x = (i: number) => (chart.days.length === 1 ? (left + width - right) / 2 : left + (i / (chart.days.length - 1)) * (width - left - right));
  const y = (v: number) => top + (1 - v / peak) * (height - top - bottom);
  const lines = [
    ...chart.lines.map((l) => ({ ...l, colour: colour(l.key), dash: false })),
    { key: 'total', label: 'Total', values: chart.total, colour: 'var(--ink-strong)', dash: true },
  ];
  const grid = [0, 0.5, 1]
    .map((f) => `<line x1="${left}" x2="${width - right}" y1="${y(peak * f).toFixed(1)}" y2="${y(peak * f).toFixed(1)}" class="gridline"/><text x="${left - 8}" y="${(y(peak * f) + 4).toFixed(1)}" text-anchor="end" class="axis">${axis(peak * f)}</text>`)
    .join('');
  const ends = [...new Set([0, Math.floor((chart.days.length - 1) / 2), chart.days.length - 1])];
  const dates = ends.map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 10}" text-anchor="${i === 0 && ends.length > 1 ? 'start' : i === chart.days.length - 1 && ends.length > 1 ? 'end' : 'middle'}" class="axis">${formatDay(chart.days[i]!)}</text>`).join('');
  const drawn = lines
    .map((l) => {
      const points = l.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const dots = l.values
        .map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${l.colour}"><title>${esc(l.label)} · ${formatDay(chart.days[i]!)} · ${value(v)}</title></circle>`)
        .join('');
      return `<g data-line="${esc(l.key)}"><polyline points="${points}" fill="none" stroke="${l.colour}" stroke-width="2"${l.dash ? ' stroke-dasharray="6 4"' : ''}/>${dots}</g>`;
    })
    .join('');
  const area = `<polygon points="${x(0).toFixed(1)},${y(0).toFixed(1)} ${chart.total.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} ${x(chart.days.length - 1).toFixed(1)},${y(0).toFixed(1)}" class="total-area"/>`;
  return `<section class="panel" aria-labelledby="${id}">${band(title, `<span class="legend">${keys(lines)}</span>`, id)}<div class="well chart">${note}<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}, ${formatDay(chart.days[0]!)} to ${formatDay(chart.days.at(-1)!)}: ${esc(lines.map((l) => l.label).join(', '))}">${area}${grid}${dates}${drawn}</svg></div>
</section>`;
}

/** A chart's key: a swatch and a name for each line, the total's dashed. */
const keys = (lines: { label: string; colour: string; dash?: boolean | undefined }[]) =>
  lines.map((l) => `<span class="key"><i${l.dash ? ' class="dash"' : ` style="background:${l.colour}"`} aria-hidden="true"></i>${esc(l.label)}</span>`).join('');

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
  const head = `<section class="trend" aria-labelledby="${d.id}"><h3 id="${d.id}">${d.title}</h3><p class="note">${d.note}</p>`;
  if (shown.length === 0) return `${head}<p class="muted" data-empty="${d.id}">Nothing to chart in this period.</p></section>`;
  const peak = Math.max(...shown.flatMap((l) => l.values.map((v) => v ?? 0)), 1);
  const x = (i: number) => (t.buckets.length === 1 ? (left + width - right) / 2 : left + (i / (t.buckets.length - 1)) * (width - left - right));
  const y = (v: number) => top + (1 - v / peak) * (height - top - bottom);
  const grid = [0, 0.5, 1]
    .map((f) => `<line x1="${left}" x2="${width - right}" y1="${y(peak * f).toFixed(1)}" y2="${y(peak * f).toFixed(1)}" class="gridline"/><text x="${left - 8}" y="${(y(peak * f) + 4).toFixed(1)}" text-anchor="end" class="axis">${d.axis(peak * f)}</text>`)
    .join('');
  const ends = [...new Set([0, Math.floor((t.buckets.length - 1) / 2), t.buckets.length - 1])];
  const dates = ends.map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 10}" text-anchor="${i === 0 && ends.length > 1 ? 'start' : i === t.buckets.length - 1 && ends.length > 1 ? 'end' : 'middle'}" class="axis">${t.weekly ? 'Week of ' : ''}${formatDay(t.buckets[i]!)}</text>`).join('');
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
        .map((v, i) => (v === null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${l.colour}"><title>${esc(l.label)} · ${t.weekly ? 'week of ' : ''}${formatDay(t.buckets[i]!)} · ${d.value(v)}</title></circle>`))
        .join('');
      return `<g data-line="${esc(l.key)}">${paths}${dots}</g>`;
    })
    .join('');
  const legend = shown.length === 1 ? '' : `<div class="legend">${keys(shown)}</div>`;
  return `${head}<div class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${d.title}, ${formatDay(t.buckets[0]!)} to ${formatDay(t.buckets.at(-1)!)}">${grid}${dates}${drawn}</svg></div>${legend}</section>`;
}

/** "Is the harness getting more expensive?": starting context, pull request size and cost per 1,000 lines changed. */
function harnessTrends(page: CostsPage): string {
  const t = page.trends;
  if (t === null) return '';
  const ink = 'var(--cat-violet)';
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
      lines: t.costPerThousandLines.map((l) => (l.key === 'total' ? { ...l, colour: 'var(--ink-strong)', dash: true } : { ...l, colour: COLOURS[l.key as Category] })),
      value: dollars,
      axis: dollars,
    }),
  ];
  return `<section class="panel" aria-labelledby="trends">${band('Is the harness getting more expensive?', 'Not affected by &ldquo;coloured by&rdquo;: these follow the period and the &ldquo;Only&rdquo; filters.', 'trends')}<div class="well pad">${charts.join('\n')}</div></section>`;
}

/** The repository as GitHub names it, `owner/name`; anything else is no repository and links nowhere. */
export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
  const sessions = g.prNumber === null ? '' : ` · <a href="/pr/${g.prNumber}${queryString(query, { engineer: null, group: DEFAULT_GROUP, sort: 'default', page: 1 })}">Sessions</a>`;
  return `<td class="first">${label}<div class="muted small">${issue}${sessions}</div></td>`;
}

function row(g: CostGroup, group: Group, max: number, query: CostQuery, series: Series[], known: string[], repository: string | null): string {
  const first = firstCell(g, query, repository);
  const extra =
    group === 'pr'
      ? `<td>${g.engineer === null ? '' : esc(g.engineer)}</td><td class="nowrap">${g.merged === null ? '' : esc(g.merged)}</td>` +
        // Blank, not zero, for what linking has not read. No open-to-merged or review columns: they say nothing about cost, and the title needs the room.
        `<td class="nowrap mono">${g.lines === null ? '' : `+${number(g.lines.added)} −${number(g.lines.removed)}`}</td>`
      : group === 'issue' || group === 'engineer'
        ? `<td>${number(g.pullRequests)}</td>`
        : '';
  const cost = (s: Series) => g.bySeries[s.key] ?? 0;
  // A catch-all draws nothing in its split cell, not even the track, which would read as a bar at $0.
  const split = g.catchAll
    ? ''
    : series.map((s) => (cost(s) > 0 ? `<div style="width:${((cost(s) / max) * 100).toFixed(1)}%;background:${colourOf(query.split, s.key, known)}"></div>` : '')).join('');
  // No column per colour: hovering the bar names each colour's dollars.
  const hover = g.catchAll ? '' : ` title="${esc(series.filter((s) => cost(s) > 0).map((s) => `${s.label} ${dollars(cost(s))}`).join(' · '))}"`;
  const unpriced = g.unpricedRequests > 0 ? ` <span class="unpriced">+ ${number(g.unpricedRequests)} unpriced</span>` : '';
  // Each day's tokens by kind, priced or not; no other grouping counts them.
  const tokens =
    group === 'day' ? [g.tokens.input, g.tokens.output, g.tokens.cacheWrite, g.tokens.cacheRead].map((n) => `<td class="num mono muted">${tokenCount(n)}</td>`).join('') : '';
  return `<tr>${first}${extra}<td class="split-cell"${hover}><div class="split${g.catchAll ? ' bare' : ''}">${split}</div></td><td class="num mono total">${dollars(g.totalMicros)}${unpriced}</td>${tokens}</tr>`;
}

function table(page: CostsPage, repository: string | null): string {
  const { query, groups } = page;
  const title = `By ${GROUP_LABELS[query.group].toLowerCase()}`;
  if (groups.length === 0) return `<section class="panel">${band(title)}<p class="well empty">Nothing in this period. No Claude Code requests match the filters.</p></section>`;
  // A page past the end shows the last one, rather than an empty table.
  const pageNo = Math.min(query.page, Math.ceil(groups.length / PAGE_SIZE));
  const start = (pageNo - 1) * PAGE_SIZE;
  const shown = groups.slice(start, start + PAGE_SIZE);
  // The bars scale to the largest row that draws one: a catch-all is left out, so it cannot shrink every other bar.
  const max = Math.max(...shown.filter((g) => !g.catchAll).map((g) => g.totalMicros), 1);
  const extraHeads = query.group === 'pr' ? '<th scope="col">Engineer</th><th scope="col">Merged</th><th scope="col">Lines</th>' : query.group === 'issue' || query.group === 'engineer' ? '<th scope="col">Pull requests</th>' : '';
  const tokenHeads = query.group === 'day' ? '<th scope="col" class="num">Input</th><th scope="col" class="num">Output</th><th scope="col" class="num">Cache write</th><th scope="col" class="num">Cache read</th>' : '';
  const link = (to: number, text: string) => `<a href="/${queryString(query, { page: to })}">${text}</a>`;
  const pager = [pageNo > 1 ? link(pageNo - 1, 'Previous') : '', start + PAGE_SIZE < groups.length ? link(pageNo + 1, `Next ${PAGE_SIZE}`) : '']
    .filter(Boolean)
    .join(' · ');
  // Engineers are always by total, so neither header there is a link; elsewhere the inactive sort's header is.
  const switchable = query.group !== 'engineer';
  const byTotal = query.sort === 'total' || !switchable;
  const firstHead = switchable && byTotal ? `<a href="/${queryString(query, { sort: 'default', page: 1 })}">${GROUP_LABELS[query.group]}</a>` : GROUP_LABELS[query.group];
  const totalHead = switchable && !byTotal ? `<a href="/${queryString(query, { sort: 'total', page: 1 })}">Total</a>` : 'Total';
  const marks = (on: boolean) => (on ? ' ▾' : '');
  const sortedBy = byTotal ? 'total' : SORTED_BY[query.group];
  return `<section class="panel" aria-label="Cost by ${GROUP_LABELS[query.group].toLowerCase()}">${band(title)}<div class="well">
<div class="scroll"><table class="costs">
<thead><tr><th scope="col" class="first">${firstHead}${marks(!byTotal)}</th>${extraHeads}<th scope="col" class="split-head">Coloured by ${COLOUR_WORDS[query.split]}</th><th scope="col" class="num">${totalHead}${marks(byTotal)}</th>${tokenHeads}</tr></thead>
<tbody>
${shown.map((g) => row(g, query.group, max, query, page.series, knownKeys(page), repository)).join('\n')}
</tbody></table></div>
<div class="foot"><span>Showing ${shown.length === groups.length ? number(groups.length) : `${number(start + 1)}–${number(start + shown.length)} of ${number(groups.length)}`} · sorted by ${sortedBy}</span><span>${pager}</span></div>
</div></section>`;
}

/** The public page: Claude Code's cost, grouped and filtered. Counts and dollars only; never an email or any content. */
export function renderPage(
  page: CostsPage,
  report: { unpriced: UnpricedLine[]; repository?: string | undefined },
  now = Date.now(),
): string {
  const repository = report.repository !== undefined && REPOSITORY.test(report.repository) ? report.repository : null;
  // What the sentence changes comes first, in reading order; the trends, which only the filters change, come last.
  const body = [
    '<h1 class="sr-only">Claude Code costs</h1>',
    warning(report.unpriced),
    whereItWent(page),
    page.query.group === 'day' ? overTime(page, now, 'cost') : '',
    page.query.group === 'day' ? overTime(page, now, 'tokens') : '',
    table(page, repository),
    harnessTrends(page),
    jobLines(page.jobs),
  ].join('\n');
  return shell({ current: 'costs', controls: controls(page), body }, now);
}
