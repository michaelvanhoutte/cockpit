import { addDays, belgianDay, formatDateTime, formatDay, startOfDay } from './belgium';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, lead } from './explain';
import { esc, inline, lineKey, questionOf, sentenceForm } from './look';
import { number, REPOSITORY } from './page';
import { BLUE, colourByPlace, GREY, isFolded, ORANGE, OTHER, OTHER_LABEL, RED, VIOLET } from './palette';
import { humanMs, outLink, pct, reportPage, section, tile } from './report';
import {
  clipSpans,
  GROUPS,
  redMs,
  sortJobs,
  sortOf,
  sortSpells,
  sortWorkflows,
  spellSpan,
  stabilityAddress,
  SORTS,
  sumTallies,
  unionMs,
  type Failure,
  type JobModel,
  type Last,
  type Spell,
  type StabilityData,
  type StabilityQuery,
  type Tally,
} from './stability-report';
import { LEAD_MORE, WHAT } from './stability-explain';

const ROW_WORDS: Record<StabilityQuery['group'], string> = { job: 'each job', workflow: 'each workflow', red: 'each red spell', failures: 'each failure', day: 'each day' };
/** The period as a word of the page's sentence ("over the last 7 days"). */
const PERIOD_WORDS: [string, string][] = [
  ['7d', 'the last 7 days'],
  ['30d', 'the last 30 days'],
  ['90d', 'the last 90 days'],
  ['all', 'everything held'],
];

/** The branch the runs are of: the Stability job sends `main`'s alone. */
const BRANCH = 'main';
/** The most failures the Recent failures list draws; the counts above it use every one. */
const FAILURE_LIMIT = 100;

/** How a run ended, in stacking order: failed is red, being bad; cancelled and skipped ran no verdict, so they are grey and stack last, and the series beside them takes blue, a slot grey clears. */
const OUTCOMES = [
  { key: 'pass', label: 'Passed', colour: VIOLET },
  { key: 'fail', label: 'Failed', colour: RED },
  { key: 'running', label: 'Still running', colour: ORANGE },
  { key: 'other', label: 'Other or unrecognised', colour: BLUE },
  { key: 'cancelled', label: 'Cancelled', colour: GREY },
  { key: 'skipped', label: 'Skipped', colour: GREY },
] as const;

const bandOf = (rate: number) => (rate >= 0.99 ? 'ok' : rate >= 0.9 ? 'mid' : 'poor');

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

/** A bar showing `value` of `peak`, with the figure beside it. */
const lasted = (value: number, peak: number, text: string) =>
  `<div class="lasted"><span class="track"><span class="fill" style="width:${((value / peak) * 100).toFixed(1)}%"></span></span><span class="num">${text}</span></div>`;

/** The CI stability page: the same figures whatever the tab, narrowed by the filters, with the overview only on the first. */
export function renderStability(q: StabilityQuery, data: StabilityData, repository: string | undefined, now: number): string {
  const repo = repository !== undefined && REPOSITORY.test(repository) ? repository : null;
  const { from, until } = data;
  const keep = (name: string) => q.workflow === null || name === q.workflow;
  const periodLabel = q.period === 'all' ? `Everything held · ${data.heldDays} days` : `Last ${data.periodDays} days`;
  const periodWords = q.period === 'all' || data.partial ? `the ${data.heldDays} days held` : `the last ${data.periodDays} days`;

  const names = data.finishedWorkflows;
  // Only workflows that were ever red are drawn as series, so only they take a slot, by their place among them in a fixed order; the ninth onward are drawn together as Other.
  const everRed = [...new Set(data.spells.map((s) => s.workflow))].sort((a, b) => names.indexOf(a) - names.indexOf(b));
  const colour = (name: string) => colourByPlace(everRed, name);
  const workflows = data.workflows.filter((w) => keep(w.name));
  const lastOf = (wf: string) => data.lastRuns.find((l) => l.workflow === wf);
  const jobs: JobRow[] = workflows.flatMap((w) => w.jobs.map((job) => ({ workflow: w.name, job, last: lastOf(w.name)?.jobs.find((j) => j.name === job.name)?.last ?? null })));
  const spells = data.spells.filter((s) => keep(s.workflow) && spellSpan(s, until)[1] > from);
  const failures = data.failures.filter((f) => keep(f.workflow) && f.createdAt >= from);
  const red = redMs(spells, from, until);
  const link = (over: Partial<StabilityQuery>) => esc(stabilityAddress(q, over));
  const jobLink = (j: JobRow) => link({ group: 'job', sort: null, steps: rowKey(j) });
  const sort = sortOf(q);

  const empty = workflows.every((w) => w.tally.pass + w.tally.fail + w.tally.cancelled + w.tally.skipped + w.tally.running + w.tally.other + w.tally.unknown === 0);

  // Red now: the one thing the page must not let a reader miss, on every tab and whatever the Workflow filter holds.
  const ongoing = data.spells.filter((s) => s.ongoing);
  const redNow = ongoing.length
    ? `<p class="notice" role="status">${ongoing
        .map((s) => {
          const f = data.failures.find((x) => x.runId === s.openedBy);
          const died = f?.jobs.map((j) => `${outLink(j.url, esc(j.name))}${j.failedStep ? ` at &ldquo;${esc(j.failedStep)}&rdquo;` : ''}`).join(', ');
          return `<strong>${esc(s.workflow)} is red now</strong>, for ${humanMs(now - s.from)} since ${outLink(s.fromUrl, esc(formatDateTime(s.from)))}${died ? `: ${died} failed` : ''}.`;
        })
        .join('<br>')}</p>`
    : '';
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

  function workflowTab(): string {
    const rows = sortWorkflows(
      workflows.map((w) => {
        const own = spells.filter((s) => s.workflow === w.name);
        return { ...w, spells: own.length, red: redMs(own, from, until) };
      }),
      sort,
    );
    const peak = Math.max(...rows.map((r) => r.red), 1);
    const table = rows
      .map(
        (r) =>
          `<tr><td class="first"><a href="${link({ workflow: r.name, group: 'job', sort: null })}">${esc(r.name)}</a><div class="sub">${number(r.jobs.length)} job${r.jobs.length === 1 ? '' : 's'}${r.tally.completed === 0 && r.tally.skipped ? ` · ${number(r.tally.skipped)} skipped, none ran` : ''}</div></td>${lastCell(lastOf(r.name)?.last)}${rateCell(r.tally)}<td class="split-cell">${outcomeBar(r.tally)}</td><td class="num">${r.tally.fail ? number(r.tally.fail) : '<span class="faint">—</span>'}</td><td class="num faint-num">${r.spells ? number(r.spells) : '—'}</td><td class="lasted-cell">${r.red ? lasted(r.red, peak, humanMs(r.red)) : '<span class="faint">never red</span>'}</td></tr>`,
      )
      .join('\n');
    return section(
      'by-workflow',
      'By workflow',
      `${number(rows.length)} workflows · ${esc(SORTS.workflow.find(([k]) => k === sort)![1].toLowerCase())} first · a workflow&rsquo;s name opens its jobs`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Workflow</th><th scope="col" class="num">Last run</th><th scope="col" class="num">Pass rate</th><th scope="col">Outcomes</th><th scope="col" class="num">Failed</th><th scope="col" class="num">Red spells</th><th scope="col">Time red</th></tr></thead>
<tbody>${table}</tbody></table></div>`,
      'panel wide',
      explain('by-workflow', 'By workflow', WHAT.workflow),
    );
  }

  function redTab(): string {
    const rows = sortSpells(spells, sort, until);
    const info = explain('spells', `How long ${esc(BRANCH)} stayed red`, WHAT.spells);
    if (!rows.length) return section('spells', `How long ${esc(BRANCH)} stayed red`, '', `<p class="well empty">${esc(BRANCH)} was not red in this period.</p>`, 'panel', info);
    const len = (s: Spell) => spellSpan(s, until)[1] - spellSpan(s, until)[0];
    const peak = Math.max(...rows.map(len), 1);
    const table = rows
      .map((s) => {
        const f = data.failures.find((x) => x.runId === s.openedBy);
        const died = f?.jobs.map((j) => `${esc(j.name)}${j.failedStep ? ` · ${esc(j.failedStep)}` : ''}`).join(', ');
        return `<tr${s.ongoing ? ' class="open"' : ''}><td class="first"><i class="dot" style="background:${colour(s.workflow)}"></i>${esc(s.workflow)}${died ? `<div class="sub">${died}</div>` : ''}</td><td class="num">${outLink(s.fromUrl, esc(formatDateTime(s.from)))}</td><td class="num">${s.until !== null ? outLink(s.untilUrl, esc(formatDateTime(s.until))) : '<span class="rate poor">red now</span>'}</td><td class="lasted-cell">${lasted(len(s), peak, humanMs(len(s)))}</td><td class="num faint-num">${number(s.commits)}</td></tr>`;
      })
      .join('\n');
    return section(
      'spells',
      `How long ${esc(BRANCH)} stayed red`,
      `${number(rows.length)} spells · ${humanMs(red)} red with overlaps counted once · ${sort === 'longest' ? 'longest' : 'newest'} first`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Workflow</th><th scope="col" class="num">Went red</th><th scope="col" class="num">Green again</th><th scope="col">Lasted</th><th scope="col" class="num">Commits</th></tr></thead>
<tbody>${table}</tbody></table></div>`,
      'panel wide',
      info,
    );
  }

  function failuresTab(): string {
    const where = new Map<string, { job: string; step: string | null; workflows: Set<string>; count: number; last: Failure; url: string | null }>();
    for (const f of failures)
      for (const j of f.jobs) {
        const key = `${j.name}|${j.failedStep ?? ''}`;
        const e = where.get(key) ?? { job: j.name, step: j.failedStep, workflows: new Set<string>(), count: 0, last: f, url: j.url };
        e.count++;
        e.workflows.add(f.workflow);
        if (f.createdAt > e.last.createdAt) {
          e.last = f;
          e.url = j.url;
        }
        where.set(key, e);
      }
    const steps = [...where.values()].sort((a, b) => b.count - a.count || b.last.createdAt - a.last.createdAt);
    const peak = Math.max(...steps.map((s) => s.count), 1);
    let out = '';
    if (steps.length) {
      out += section(
        'where-they-died',
        'Where they died',
        `${number(steps.length)} job and step pairs · most first`,
        `<div class="well table"><table>
<thead><tr><th scope="col">Job · step</th><th scope="col">Workflow</th><th scope="col">Failures</th><th scope="col" class="num">Last</th></tr></thead>
<tbody>${steps
          .map(
            (s) =>
              `<tr><td class="first">${esc(s.job)}<div class="sub">${s.step ? esc(s.step) : 'no failing step recorded'}</div></td><td>${[...s.workflows].map(esc).join(', ')}</td><td class="lasted-cell">${lasted(s.count, peak, number(s.count))}</td><td class="num">${outLink(s.url ?? s.last.url, esc(formatDateTime(s.last.createdAt)))}</td></tr>`,
          )
          .join('\n')}</tbody></table></div>`,
        'panel wide',
        explain('where-they-died', 'Where they died', WHAT.whereTheyDied),
      );
    }
    const listed = failures.slice(0, FAILURE_LIMIT);
    out += failures.length
      ? section(
          'recent-failures',
          'Recent failures',
          `${number(failures.length)} · newest first`,
          `<div class="well table"><table>
<thead><tr><th scope="col" class="num">When</th><th scope="col">Workflow</th><th scope="col">Failing job</th><th scope="col">Died at</th><th scope="col">Commit</th></tr></thead>
<tbody>${listed
            .map(
              (f) =>
                `<tr><td class="num">${outLink(f.url, esc(formatDateTime(f.createdAt)))}</td><td class="first"><i class="dot" style="background:${colour(f.workflow)}"></i>${esc(f.workflow)}</td><td>${f.jobs.length ? f.jobs.map((j) => outLink(j.url, esc(j.name))).join('<br>') : '<span class="faint">none recorded</span>'}</td><td class="step-cell">${f.jobs.map((j) => (j.failedStep ? esc(j.failedStep) : '<span class="faint">—</span>')).join('<br>')}</td><td>${repo ? `<a class="sha" href="https://github.com/${repo}/commit/${esc(f.headSha)}" target="_blank" rel="noopener noreferrer">${esc(f.headSha.slice(0, 7))}</a>` : `<span class="sha">${esc(f.headSha.slice(0, 7))}</span>`}</td></tr>`,
            )
            .join('\n')}</tbody></table>${failures.length > listed.length ? `<p class="note steps-note">The newest ${number(listed.length)} are listed; the counts above use all ${number(failures.length)}.</p>` : ''}</div>`,
          'panel wide',
          explain('recent-failures', 'Recent failures', WHAT.recent),
        )
      : section('recent-failures', 'Recent failures', '', '<p class="well empty">No failure in this period.</p>', 'panel', explain('recent-failures', 'Recent failures', WHAT.recent));
    return out;
  }

  /** Hours red per Belgian day, per workflow, and with overlaps merged. */
  function dayTab(): string {
    const days: string[] = [];
    for (let d = belgianDay(from); d <= belgianDay(until); d = addDays(d, 1)) days.push(d);
    const redWorkflows = [...new Set(spells.map((s) => s.workflow))].sort((a, b) => names.indexOf(a) - names.indexOf(b));
    const folded = redWorkflows.filter((w) => isFolded(everRed, w));
    const dayRed = (d: string, list: Spell[]) => unionMs(clipSpans(list.map((s) => spellSpan(s, until)), Math.max(from, startOfDay(d)), Math.min(until, startOfDay(addDays(d, 1)))));
    const own = redWorkflows.filter((w) => !folded.includes(w)).map((w) => ({ key: w, label: w, colour: colour(w), dash: false, values: days.map((d) => dayRed(d, spells.filter((s) => s.workflow === w))) }));
    // Other is the time any of the folded workflows was red, overlaps counted once, so it can never run above the total.
    const lines = folded.length ? [...own, { key: OTHER, label: OTHER_LABEL, colour: GREY, dash: false, values: days.map((d) => dayRed(d, spells.filter((s) => folded.includes(s.workflow)))) }] : own;
    const total = days.map((d) => dayRed(d, spells));
    const { width, height, left, right, top, bottom } = { width: 1000, height: 260, left: 64, right: 12, top: 12, bottom: 30 };
    const peak = Math.max(...total, 1);
    const x = (i: number) => (days.length === 1 ? (left + width - right) / 2 : left + (i / (days.length - 1)) * (width - left - right));
    const y = (v: number) => top + (1 - v / peak) * (height - top - bottom);
    const grid = [0, 0.5, 1].map((f) => `<line x1="${left}" x2="${width - right}" y1="${y(peak * f).toFixed(1)}" y2="${y(peak * f).toFixed(1)}" class="gridline"/><text x="${left - 10}" y="${(y(peak * f) + 4).toFixed(1)}" text-anchor="end" class="axis">${humanMs(peak * f)}</text>`).join('');
    const ends = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
    const dates = ends.map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="${i === 0 && ends.length > 1 ? 'start' : i === days.length - 1 && ends.length > 1 ? 'end' : 'middle'}" class="axis">${formatDay(days[i]!)}</text>`).join('');
    const area = `<polygon points="${x(0).toFixed(1)},${y(0).toFixed(1)} ${total.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} ${x(days.length - 1).toFixed(1)},${y(0).toFixed(1)}" class="total-area"/>`;
    const drawn = [...lines, { key: 'total', label: 'Any workflow', values: total, colour: 'var(--ink-strong)', dash: true }]
      .map(
        (l) =>
          `<g${l.dash ? ' data-line="total"' : ''}><polyline points="${l.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="${l.colour}" stroke-width="${l.dash ? 1.5 : 2}" stroke-linejoin="round"${l.dash ? ' stroke-dasharray="5 4"' : ''}/>${l.values
            .map((v, i) => (v > 0 ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${l.dash ? 0 : 2.5}" fill="${l.colour}"><title>${esc(l.label)} · ${formatDay(days[i]!)} · ${humanMs(v)} red</title></circle>` : ''))
            .join('')}</g>`,
      )
      .join('');
    const legend = [...lines.map((l) => lineKey(esc(l.label), l.colour)), lineKey('Any workflow', null)].join('');
    let out = section(
      'red-per-day',
      `Time ${esc(BRANCH)} was red, per day`,
      `<span class="legend">${legend}</span>`,
      `<div class="well chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Time red per day">${area}${grid}${dates}<g class="lines">${drawn}</g></svg></div>`,
      'panel',
      explain('red-per-day', `Time ${esc(BRANCH)} was red, per day`, WHAT.perDay),
    );

    const dayPeak = Math.max(...total, 1);
    const heads = lines.map((l) => `<th scope="col" class="num"><i style="background:${l.colour}"></i>${esc(l.label)}</th>`).join('');
    const rows = days
      .map((d, i) => ({ d, i }))
      .reverse()
      .map(({ d, i }) => {
        const began = spells.filter((s) => belgianDay(s.from) === d).length;
        const failed = failures.filter((f) => belgianDay(f.createdAt) === d).length;
        // The bar is the day's red time with overlaps merged; its segments share it in proportion to each workflow's own.
        const split = total[i]! > 0 ? `<span class="stack" style="width:${((total[i]! / dayPeak) * 100).toFixed(1)}%">${lines.map((l) => (l.values[i]! > 0 ? `<span style="flex:${l.values[i]!};background:${l.colour}" title="${esc(l.label)} ${humanMs(l.values[i]!)}"></span>` : '')).join('')}</span>` : '';
        const cells = lines.map((l) => `<td class="num">${l.values[i]! > 0 ? humanMs(l.values[i]!) : '<span class="faint">—</span>'}</td>`).join('');
        return `<tr><td class="first">${esc(formatDay(d))}</td><td class="split-cell"><div class="split">${split}</div></td>${cells}<td class="num faint-num">${began || '—'}</td><td class="num faint-num">${failed || '—'}</td><td class="num total">${total[i]! > 0 ? humanMs(total[i]!) : '<span class="faint">green all day</span>'}</td></tr>`;
      })
      .join('\n');
    out += section(
      'by-day',
      'By day',
      `${number(days.length)} days · newest first`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Day</th><th scope="col">Split</th>${heads}<th scope="col" class="num">Spells began</th><th scope="col" class="num">Failures</th><th scope="col" class="num">Any workflow</th></tr></thead>
<tbody>${rows}</tbody></table></div>`,
      'panel wide',
      explain('by-day', 'By day', WHAT.day),
    );
    return out;
  }

  const tabBodies: Record<StabilityQuery['group'], () => string> = { job: jobTab, workflow: workflowTab, red: redTab, failures: failuresTab, day: dayTab };
  // The overview (tiles, outcomes, last runs) belongs to Job, the first tab; every other tab goes straight to its own content.
  const content = empty
    ? section('nothing', 'CI stability', '', '<p class="well empty">Nothing in this period. No run of main is stored for it with these filters.</p>')
    : `${q.group === 'job' ? overviewOf() : ''}${tabBodies[q.group]()}`;

  // The controls as one sentence on the band: the order is a word of it where the rows have more than one, and the Workflow filter is not offered when the rows are workflows.
  const sorts = SORTS[q.group];
  const workflowChoices: [string, string][] = [['', 'All workflows'], ...data.finishedWorkflows.map((w): [string, string] => [w, w])];
  if (q.workflow !== null && !data.finishedWorkflows.includes(q.workflow)) workflowChoices.push([q.workflow, q.workflow]);
  const form = sentenceForm(
    '/stability',
    `Show CI on main for ${inline('group', 'Rows', GROUPS.map((g): [string, string] => [g, ROW_WORDS[g]]), q.group)}
${sorts.length ? inline('sort', 'Order', sorts.map(([v, t]): [string, string] => [v, `${t.toLowerCase()} first`]), sort) : ''}
over ${inline('period', 'Period', PERIOD_WORDS, q.period)}`,
    [q.group === 'workflow' ? '' : inline('workflow', 'Workflow', workflowChoices, q.workflow ?? '', '')],
    repo ? [`<a class="button" href="https://github.com/${repo}/actions?query=branch%3A${encodeURIComponent(BRANCH)}" target="_blank" rel="noopener noreferrer">Open in Actions</a>`] : [],
  );
  // The page opens with the question its top tab names and the words a newcomer will not know, under the band, on every tab.
  const pageLead = lead(questionOf('stability'), LEAD_MORE);
  return reportPage({ current: 'stability', controls: form, body: `${pageLead}\n${partial}${redNow}${anomalies}\n${content}\n${EXPLAIN_SCRIPT}`, style: EXTRA + EXPLAIN_STYLE }, now);
}

const EXTRA = `
.rate{font-weight:600;text-decoration:none;color:var(--ink-strong)}.rate.ok{color:var(--good)}.rate.poor{color:var(--over-ink)}
.rate.none{color:var(--ink-faint);font-weight:400}
a.rate:hover{text-decoration:underline}
.of{display:block;font-size:12px;color:var(--ink-faint);font-weight:400}
.tile.name .tile-value{font-size:22px;line-height:1.25;padding:6px 0 5px}.tile.name .tile-value a{color:var(--ink-strong);text-decoration:none}.tile.name .tile-value a:hover{color:var(--accent-deep)}
.changes .verdict{color:inherit;text-decoration:none}.changes .verdict:hover{text-decoration:underline}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}
.sha{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:1px}
tr.chosen td{background:var(--accent-tint)}
tr.open td{background:color-mix(in srgb,var(--over) 8%,transparent)}
.lasted-cell{width:260px}
.lasted{display:flex;align-items:center;gap:10px}.lasted .track{flex:1;height:8px;border-radius:2px;overflow:hidden;background:color-mix(in srgb,var(--shade) 7%,transparent)}.lasted .fill{display:block;height:100%;background:var(--over)}
.lasted .num{min-width:64px}
.step-cell{color:var(--ink-soft)}
.stack{display:flex;gap:1px;height:100%}.stack span{display:block;height:100%;min-width:2px}
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
