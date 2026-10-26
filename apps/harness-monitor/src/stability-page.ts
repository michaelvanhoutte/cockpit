import { startOfDay, formatDateTime } from './belgium';
import { periodDays } from './ci-flakiness';
import type { FragileData, WorkflowData } from './ci-flakiness-report';
import { COPY_STYLE } from './copy-prompt';
import { PERIODS } from './costs';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, lead } from './explain';
import { esc, inline, questionOf, sentenceForm } from './look';
import { number, REPOSITORY } from './page';
import { BLUE, GREY, ORANGE, RED, VIOLET } from './palette';
import { humanMs, outLink, pct, reportPage, section, tile } from './report';
import {
  GROUPS,
  redMs,
  sortJobs,
  sortOf,
  spellSpan,
  stabilityAddress,
  SORTS,
  sumTallies,
  type JobModel,
  type Last,
  type StabilityData,
  type StabilityQuery,
  type Tally,
} from './stability-report';
import { LEAD_MORE, WHAT } from './stability-explain';
import { FRAGILE_STYLE, fragileTab } from './stability-fragile-page';
import { ROWS_STYLE } from './stability-rows';
import { bandOf, redNowNotice, WORKFLOW_STYLE, workflowTab } from './stability-workflow-page';

const ROW_WORDS: Record<StabilityQuery['group'], string> = { job: 'each job', workflow: 'each workflow', tests: 'each fragile test' };
/** The period as a word of the page's sentence ("over the last 7 days"). */
const PERIOD_WORDS: [string, string][] = [
  ['7d', 'the last 7 days'],
  ['30d', 'the last 30 days'],
  ['90d', 'the last 90 days'],
  ['all', 'everything held'],
];

/** The branch the runs are of: the Stability job sends `main`'s alone. */
const BRANCH = 'main';
/** How a run ended, in stacking order: failed is red, being bad; cancelled and skipped ran no verdict, so they are grey and stack last, and the series beside them takes blue, a slot grey clears. */
const OUTCOMES = [
  { key: 'pass', label: 'Passed', colour: VIOLET },
  { key: 'fail', label: 'Failed', colour: RED },
  { key: 'running', label: 'Still running', colour: ORANGE },
  { key: 'other', label: 'Other or unrecognised', colour: BLUE },
  { key: 'cancelled', label: 'Cancelled', colour: GREY },
  { key: 'skipped', label: 'Skipped', colour: GREY },
] as const;

function rateCell(t: Tally): string {
  if (t.rate === null) return '<td class="num"><span class="rate none">no data</span><span class="of">0 finished</span></td>';
  return `<td class="num"><span class="rate ${bandOf(t.rate)}">${pct(t.rate)}</span><span class="of">${number(t.pass)} of ${number(t.completed)}</span></td>`;
}

function lastCell(last: Last | null | undefined): string {
  if (!last) return '<td class="num"><span class="rate none">no data</span></td>';
  const [cls, word] = last.outcome === 'pass' ? ['ok', 'passed'] : ['poor', 'failed'];
  return `<td class="num">${outLink(last.url, word, `rate ${cls}`)}<span class="of">${esc(formatDateTime(last.at))}</span></td>`;
}

const counts = (t: Tally): Record<(typeof OUTCOMES)[number]['key'], number> => ({ pass: t.pass, fail: t.fail, cancelled: t.cancelled, skipped: t.skipped, running: t.running, other: t.other + t.unknown });

function outcomeBar(t: Tally): string {
  const c = counts(t);
  const total = OUTCOMES.reduce((a, o) => a + c[o.key], 0);
  if (!total) return '<div class="split bare"></div>';
  const parts = OUTCOMES.filter((o) => c[o.key] > 0).map((o) => `<div style="width:${((c[o.key] / total) * 100).toFixed(1)}%;background:${o.colour}" title="${o.label} ${c[o.key]}"></div>`);
  return `<div class="split" title="${OUTCOMES.filter((o) => c[o.key] > 0).map((o) => `${o.label} ${c[o.key]}`).join(' · ')}">${parts.join('')}</div>`;
}

interface JobRow {
  workflow: string;
  job: JobModel;
  last: Last | null;
}

const rowKey = (j: JobRow) => `${j.workflow}|${j.job.name}`;

/** The CI stability page: the same figures whatever the tab, narrowed by the filters, with the overview only on the first. */
export function renderStability(q: StabilityQuery, data: StabilityData, repository: string | undefined, now: number): string {
  const repo = repository !== undefined && REPOSITORY.test(repository) ? repository : null;
  const { from, until } = data;
  const keep = (name: string) => q.workflow === null || name === q.workflow;
  const periodLabel = q.period === 'all' ? `Everything held · ${data.heldDays} days` : `Last ${data.periodDays} days`;
  const periodWords = q.period === 'all' || data.partial ? `the ${data.heldDays} days held` : `the last ${data.periodDays} days`;

  const workflows = data.workflows.filter((w) => keep(w.name));
  const lastOf = (wf: string) => data.lastRuns.find((l) => l.workflow === wf);
  const jobs: JobRow[] = workflows.flatMap((w) => w.jobs.map((job) => ({ workflow: w.name, job, last: lastOf(w.name)?.jobs.find((j) => j.name === job.name)?.last ?? null })));
  const spells = data.spells.filter((s) => keep(s.workflow) && spellSpan(s, until)[1] > from);
  const red = redMs(spells, from, until);
  const link = (over: Partial<StabilityQuery>) => esc(stabilityAddress(q, over));
  const jobLink = (j: JobRow) => link({ group: 'job', sort: null, steps: rowKey(j) });
  const sort = sortOf(q);

  const empty = workflows.every((w) => w.tally.pass + w.tally.fail + w.tally.cancelled + w.tally.skipped + w.tally.running + w.tally.other + w.tally.unknown === 0);

  const anomalies = data.unrecognised.length
    ? `<p class="notice" role="status"><strong>Not counted, because the report does not recognise them:</strong> ${data.unrecognised
        .map((a) => `${number(a.count)} run${a.count === 1 ? '' : 's'} or job${a.count === 1 ? '' : 's'} concluded &ldquo;${esc(a.conclusion)}&rdquo;`)
        .join('; ')}.</p>`
    : '';
  const partial = data.partial ? `<p class="muted small">Only ${number(data.heldDays)} of the period&rsquo;s ${number(data.periodDays ?? 0)} days are stored so far.</p>` : '';

  /** Tiles and the row of panels: the Job tab alone draws them. */
  function overviewOf(): string {
    const overall = sumTallies(workflows.map((w) => w.tally));
    const reliable = [...jobs].filter((j) => j.job.tally.rate !== null && j.job.tally.completed >= 3).sort((a, b) => a.job.tally.rate! - b.job.tally.rate! || b.job.tally.completed - a.job.tally.completed)[0];
    const slowest = [...jobs].filter((j) => j.job.durations !== null).sort((a, b) => b.job.durations!.median - a.job.durations!.median)[0];
    const tiles = `<div class="tiles">
${tile('Runs passed', overall.rate === null ? '—' : `<span class="rate ${bandOf(overall.rate)}">${pct(overall.rate)}</span>`, `${number(overall.pass)} of ${number(overall.completed)} finished · ${number(overall.cancelled)} cancelled left out`, '', explain('t-passed', 'Runs passed', WHAT.passed))}
${tile(`Time ${BRANCH} was red`, humanMs(red), `${Math.round((red / Math.max(1, until - from)) * 100)}% of ${periodWords} · ${number(spells.length)} spell${spells.length === 1 ? '' : 's'}`, red > 0 ? 'up' : '', explain('t-red', `Time ${BRANCH} was red`, WHAT.red))}
${reliable ? tile('Least reliable job', `<a href="${jobLink(reliable)}">${esc(reliable.job.name)}</a>`, `${pct(reliable.job.tally.rate!)} · ${number(reliable.job.tally.fail)} failed of ${number(reliable.job.tally.completed)} · ${esc(reliable.workflow)}`, 'name', explain('t-least', 'Least reliable job', WHAT.leastReliable)) : ''}
${slowest ? tile('Slowest job', `<a href="${jobLink(slowest)}">${esc(slowest.job.name)}</a>`, `median ${humanMs(slowest.job.durations!.median)} · p90 ${humanMs(slowest.job.durations!.p90)} · ${esc(slowest.workflow)}`, 'name', explain('t-slowest', 'Slowest job', WHAT.slowest)) : ''}
</div>`;

    const jobsTally = sumTallies(jobs.map((j) => j.job.tally));
    const c = counts(jobsTally);
    const totalRuns = OUTCOMES.reduce((a, o) => a + c[o.key], 0);
    const shown = OUTCOMES.filter((o) => c[o.key] > 0);
    const ended = section(
      'ended',
      'How every job run ended',
      `${number(totalRuns)} job runs · ${esc(periodLabel.toLowerCase())}`,
      `<div class="well where">
<div class="bar" role="img" aria-label="${shown.map((o) => `${o.label} ${c[o.key]}`).join(', ')}">${shown.map((o) => `<div style="flex:${c[o.key]};background:${o.colour}" title="${o.label} ${c[o.key]}"></div>`).join('')}</div>
<ul class="shares">${shown.map((o) => `<li><i style="background:${o.colour}"></i><span class="name">${o.label}</span><span class="amount">${number(c[o.key])}</span><span class="share">${totalRuns ? Math.round((c[o.key] / totalRuns) * 100) : 0}%</span></li>`).join('')}</ul>
</div>`,
      'panel wide',
      explain('ended', 'How every job run ended', WHAT.ended),
    );

    const lasts = data.lastRuns
      .filter((l): l is typeof l & { last: Last } => l.last !== null && keep(l.workflow))
      .sort((a, b) => (a.last.outcome === b.last.outcome ? b.last.at - a.last.at : a.last.outcome === 'pass' ? 1 : -1))
      .map((l) => `<li><span class="name">${esc(l.workflow)}</span><span class="delta ${l.last.outcome === 'pass' ? 'down' : 'up'}">${outLink(l.last.url, l.last.outcome === 'pass' ? 'passed' : 'failed', 'verdict')}</span><span class="from">${esc(formatDateTime(l.last.at))}</span></li>`)
      .join('');
    const lastPanel = section('last-runs', 'Last run of each workflow', '', `<ul class="well changes">${lasts || '<li class="faint">No finished run</li>'}</ul>`, 'panel narrow', explain('last-runs', 'Last run of each workflow', WHAT.lastRuns));
    return `${tiles}\n<div class="row">${ended}${lastPanel}</div>\n`;
  }

  function jobTab(): string {
    const rows = sortJobs(jobs, sort);
    const chosen = q.steps ? jobs.find((j) => rowKey(j) === q.steps) : undefined;
    let out = '';
    if (chosen) {
      const steps = chosen.job.steps;
      const peak = Math.max(...steps.map((s) => s.durations?.p90 ?? 0), 1);
      const list = steps
        .map(
          (s) => `<li><span class="step-name">${esc(s.name)}${s.occurrence > 1 ? ` <span class="faint">(${s.occurrence})</span>` : ''}</span><span class="track"><span class="p90" style="width:${(((s.durations?.p90 ?? 0) / peak) * 100).toFixed(1)}%"></span><span class="median" style="width:${(((s.durations?.median ?? 0) / peak) * 100).toFixed(1)}%"></span></span><span class="num">${s.durations === null ? '<span class="faint">no data</span>' : humanMs(s.durations.median)}</span><span class="num faint-num">${humanMs(s.durations?.p90)}</span><span class="num faint-num">${number(s.durations?.count ?? 0)}</span></li>`,
        )
        .join('');
      out += section(
        'steps',
        `Where ${esc(chosen.job.name)}&rsquo;s time goes`,
        `${esc(chosen.workflow)} · median ${humanMs(chosen.job.durations?.median)} · p90 ${humanMs(chosen.job.durations?.p90)} · <a href="${link({ steps: null })}">Close</a>`,
        `<div class="well">${
          steps.length
            ? `<ul class="steps"><li class="head"><span>Step</span><span><i class="median"></i>Median <i class="p90"></i>p90</span><span class="num">Median</span><span class="num">p90</span><span class="num">Runs</span></li>${list}</ul>`
            : '<p class="empty">No step finished in this period.</p>'
        }</div>`,
        'panel wide',
        explain('steps', `where ${esc(chosen.job.name)}&rsquo;s time goes`, WHAT.steps),
      );
    }
    const table = rows
      .map((j) => {
        const on = chosen === j;
        return `<tr${on ? ' class="chosen"' : ''}><td class="first"><a href="${on ? link({ steps: null }) : jobLink(j)}">${esc(j.job.name)}</a><div class="sub">${esc(j.workflow)}${j.job.steps.length ? ` · ${on ? 'steps shown' : 'steps'}` : ''}</div></td>${lastCell(j.last)}${rateCell(j.job.tally)}<td class="split-cell">${outcomeBar(j.job.tally)}</td><td class="num">${j.job.tally.fail ? number(j.job.tally.fail) : '<span class="faint">—</span>'}</td><td class="num faint-num">${j.job.tally.cancelled ? number(j.job.tally.cancelled) : '—'}</td><td class="num">${humanMs(j.job.durations?.median)}</td><td class="num faint-num">${humanMs(j.job.durations?.p90)}</td></tr>`;
      })
      .join('\n');
    out += rows.length
      ? section(
          'by-job',
          'By job',
          `${number(rows.length)} jobs · ${esc(SORTS.job.find(([k]) => k === sort)![1].toLowerCase())} first · a job&rsquo;s name opens its steps`,
          `<div class="well table"><table>
<thead><tr><th scope="col">Job</th><th scope="col" class="num">Last run</th><th scope="col" class="num">Pass rate</th><th scope="col">Outcomes</th><th scope="col" class="num">Failed</th><th scope="col" class="num">Cancelled</th><th scope="col" class="num">Median</th><th scope="col" class="num">p90</th></tr></thead>
<tbody>${table}</tbody></table></div>`,
          'panel wide',
          explain('by-job', 'By job', WHAT.job),
        )
      : section('by-job', 'By job', '', '<p class="well empty">No job ran in this period.</p>', 'panel', explain('by-job', 'By job', WHAT.job));
    return out;
  }

  // The overview (tiles, outcomes, last runs) belongs to Job, the first tab; every other tab goes straight to its own content.
  const content = empty
    ? section('nothing', 'CI stability', '', '<p class="well empty">Nothing in this period. No run of main is stored for it with these filters.</p>')
    : `${overviewOf()}${jobTab()}`;

  return stabilityFrame(q, repo, data.finishedWorkflows, `${partial}${redNowNotice(data.redNow, now)}${anomalies}`, content, now);
}

/** The CI stability page's Workflow tab, drawn from the stored attempts on every branch. */
export function renderWorkflowStability(q: StabilityQuery, data: WorkflowData, repository: string | undefined, now: number): string {
  return attemptsPage(q, data, repository, now, (days, link) => workflowTab(q, data, days, link), WORKFLOW_STYLE);
}

/** The CI stability page's Fragile tests tab, drawn from the same stored attempts and the misses Test selection stored. */
export function renderFragileStability(q: StabilityQuery, data: FragileData, repository: string | undefined, now: number): string {
  return attemptsPage(q, data, repository, now, (days) => fragileTab(q, data, days), FRAGILE_STYLE);
}

/** What the tabs drawn from the stored attempts share: the days, the note on how much is stored, the red-now line and the empty page. */
function attemptsPage(q: StabilityQuery, data: WorkflowData, repository: string | undefined, now: number, tab: (days: string[], link: (over: Partial<StabilityQuery>) => string) => string, style: string): string {
  const repo = repository !== undefined && REPOSITORY.test(repository) ? repository : null;
  const days = periodDays(q.period, now, data.oldest);
  const first = startOfDay(days[0]!);
  const named = PERIODS[q.period];
  const partial = data.oldest !== null && named !== null && data.oldest > first ? `<p class="muted small">Only ${number(Math.max(1, Math.round((now - data.oldest) / 86_400_000)))} of the period&rsquo;s ${number(named)} days are stored so far.</p>` : '';
  const content = data.attempts.length === 0
    ? section('nothing', 'CI stability', '', '<p class="well empty">Nothing in this period. No attempt is stored for it.</p>')
    : tab(days, (over) => esc(stabilityAddress(q, over)));
  return stabilityFrame(q, repo, data.workflows, `${partial}${redNowNotice(data.redNow, now)}`, content, now, ROWS_STYLE + style + COPY_STYLE);
}

/** What both tabs share: the sentence on the band, the lead, the notices and the content. */
function stabilityFrame(q: StabilityQuery, repo: string | null, workflows: string[], notices: string, content: string, now: number, style = ''): string {
  // The controls as one sentence on the band: the order is a word of it where the rows have more than one.
  const sorts = SORTS[q.group];
  const workflowChoices: [string, string][] = [['', 'All workflows'], ...workflows.map((w): [string, string] => [w, w])];
  if (q.workflow !== null && !workflows.includes(q.workflow)) workflowChoices.push([q.workflow, q.workflow]);
  const sort = sortOf(q);
  const form = sentenceForm(
    '/stability',
    `Show CI ${q.group === 'job' ? 'on main ' : ''}for ${inline('group', 'Rows', GROUPS.map((g): [string, string] => [g, ROW_WORDS[g]]), q.group)}
${sorts.length ? inline('sort', 'Order', sorts.map(([v, t]): [string, string] => [v, `${t.toLowerCase()} first`]), sort) : ''}
over ${inline('period', 'Period', PERIOD_WORDS, q.period)}`,
    [inline('workflow', 'Workflow', workflowChoices, q.workflow ?? '', '')],
    repo ? [`<a class="button" href="https://github.com/${repo}/actions${q.group === 'job' ? `?query=branch%3A${encodeURIComponent(BRANCH)}` : ''}" target="_blank" rel="noopener noreferrer">Open in Actions</a>`] : [],
  );
  // The page opens with the question its top tab names and the words a newcomer will not know, under the band, on every tab.
  const pageLead = lead(questionOf('stability'), LEAD_MORE);
  return reportPage({ current: 'stability', controls: form, body: `${pageLead}
${notices}
${content}
${EXPLAIN_SCRIPT}`, style: EXTRA + EXPLAIN_STYLE + style }, now);
}

const EXTRA = `
.rate{font-weight:600;text-decoration:none;color:var(--ink-strong)}.rate.ok{color:var(--good)}.rate.poor{color:var(--over-ink)}
.rate.none{color:var(--ink-faint);font-weight:400}
a.rate:hover{text-decoration:underline}
.of{display:block;font-size:12px;color:var(--ink-faint);font-weight:400}
.tile.name .tile-value{font-size:22px;line-height:1.25;padding:6px 0 5px}.tile.name .tile-value a{color:var(--ink-strong);text-decoration:none}.tile.name .tile-value a:hover{color:var(--accent-deep)}
.changes .verdict{color:inherit;text-decoration:none}.changes .verdict:hover{text-decoration:underline}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}
tr.chosen td{background:var(--accent-tint)}
tr.open td{background:color-mix(in srgb,var(--over) 8%,transparent)}
.lasted-cell{width:260px}
.lasted{display:flex;align-items:center;gap:10px}.lasted .track{flex:1;height:8px;border-radius:2px;overflow:hidden;background:color-mix(in srgb,var(--shade) 7%,transparent)}.lasted .fill{display:block;height:100%;background:var(--over)}
.lasted .num{min-width:64px}
.step-cell{color:var(--ink-soft)}
.steps-note{margin:0 16px 14px;padding-top:12px}
.steps{list-style:none;margin:0;padding:6px 0}
.steps li{display:grid;grid-template-columns:minmax(180px,2fr) minmax(120px,3fr) 80px 80px 56px;gap:12px;align-items:center;padding:7px 16px;border-bottom:1px solid color-mix(in srgb,var(--shade) 8%,transparent);font-size:14px;font-variant-numeric:tabular-nums}
.steps li:last-child{border-bottom:0}
.steps li.head{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint)}
.steps li.head i{display:inline-block;width:10px;height:10px;border-radius:3px;margin:0 6px 0 10px;vertical-align:-1px}.steps li.head i:first-child{margin-left:0}
.steps .step-name{color:var(--ink-strong)}
.steps .track{position:relative;height:10px;border-radius:2px;background:color-mix(in srgb,var(--shade) 6%,transparent)}
.steps .track span{position:absolute;left:0;top:0;bottom:0;border-radius:2px}
.steps .median,.steps li.head i.median{background:${VIOLET}}.steps .p90,.steps li.head i.p90{background:color-mix(in srgb,${VIOLET} 30%,transparent)}
@media (max-width:640px){
  .steps li{grid-template-columns:1fr 64px 64px;gap:4px 10px}.steps .track{grid-column:1/-1;order:5}.steps li>span:last-child{display:none}.steps li.head>span:nth-child(2){display:none}
}
`;
