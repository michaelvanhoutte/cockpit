import { formatDateTime, startOfDay } from './belgium';
import { failuresByJob, flakyAmong, jobKey, times, type JobFailures } from './ci-flakiness';
import { explain } from './explain';
import { esc } from './look';
import { number } from './page';
import { BLUE, GREY, ORANGE, RED, VIOLET } from './palette';
import { humanMs, outLink, pct, section, tile } from './report';
import { WHAT } from './stability-explain';
import { dash, OPEN_SCRIPT, strip } from './stability-rows';
import { sortJobs, sortOf, SORTS, sumTallies, tallyOf, type JobModel, type Last, type StabilityData, type StabilityQuery, type Tally } from './stability-report';
import { bandOf, branchSide, side } from './stability-workflow-page';

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

/** A job's row: its figures on main, and what was counted against it on main and on feature branches. A job that only flaked on a branch has no figures on main. */
interface JobRow {
  workflow: string;
  job: JobModel;
  last: Last | null;
  fails: JobFailures | undefined;
  /** The attempts it failed in and a later attempt on the same commit passed, on feature branches. */
  branchFlaky: number;
}

const rowKey = (j: JobRow) => jobKey(j.workflow, j.job.name);

/** The Job tab: tiles and panels counting main, then a row per job with its figures on main, opening to main beside the feature branches. */
export function jobTab(q: StabilityQuery, data: StabilityData, days: string[], link: (over: Partial<StabilityQuery>) => string): string {
  const keep = (name: string) => q.workflow === null || name === q.workflow;
  const inPeriod = data.attempts.filter((a) => a.at >= startOfDay(days[0]!));
  const failures = failuresByJob(inPeriod, flakyAmong(inPeriod));
  const periodLabel = q.period === 'all' ? `Everything held · ${days.length} days` : `Last ${days.length} days`;
  const sort = sortOf(q);

  const workflows = data.main.filter((w) => keep(w.name));
  const lastOf = (wf: string) => data.lastRuns.find((l) => l.workflow === wf);
  const onMain: JobRow[] = workflows.flatMap((w) =>
    w.jobs.map((job): JobRow => {
      const fails = failures.get(jobKey(w.name, job.name));
      return { workflow: w.name, job, last: lastOf(w.name)?.jobs.find((j) => j.name === job.name)?.last ?? null, fails, branchFlaky: fails?.branchFlaky.length ?? 0 };
    }),
  );
  // A job that ran on no attempt of main in the period, and flaked on a branch, is a row with nothing on main.
  const known = new Set(onMain.map(rowKey));
  const onBranches = [...failures.values()]
    .filter((f) => keep(f.workflow) && !known.has(jobKey(f.workflow, f.job)) && f.branchFlaky.length > 0)
    .map((f): JobRow => ({ workflow: f.workflow, job: { name: f.job, tally: tallyOf({}), durations: null, steps: [] }, last: null, fails: f, branchFlaky: f.branchFlaky.length }));
  const jobs = [...onMain, ...onBranches];
  const jobLink = (j: JobRow) => link({ group: 'job', sort: null, steps: rowKey(j) });

  /** Tiles and the row of panels, all counting main. */
  function overview(): string {
    const overall = sumTallies(workflows.map((w) => w.tally));
    const reliable = [...jobs].filter((j) => j.job.tally.rate !== null && j.job.tally.completed >= 3).sort((a, b) => a.job.tally.rate! - b.job.tally.rate! || b.job.tally.completed - a.job.tally.completed)[0];
    const slowest = [...jobs].filter((j) => j.job.durations !== null).sort((a, b) => b.job.durations!.median - a.job.durations!.median)[0];
    const tiles = `<div class="tiles">
${tile('Runs passed', overall.rate === null ? '—' : `<span class="rate ${bandOf(overall.rate)}">${pct(overall.rate)}</span>`, `${number(overall.pass)} of ${number(overall.completed)} finished · ${number(overall.cancelled)} cancelled left out`, '', explain('t-passed', 'Runs passed', WHAT.passed))}
${reliable ? tile('Least reliable job', `<a href="${jobLink(reliable)}">${esc(reliable.job.name)}</a>`, `${pct(reliable.job.tally.rate!)} · ${number(reliable.job.tally.fail)} failed of ${number(reliable.job.tally.completed)} · ${esc(reliable.workflow)}`, 'name', explain('t-least', 'Least reliable job', WHAT.leastReliable)) : ''}
${slowest ? tile('Slowest job', `<a href="${jobLink(slowest)}">${esc(slowest.job.name)}</a>`, `median ${humanMs(slowest.job.durations!.median)} · p90 ${humanMs(slowest.job.durations!.p90)} · ${esc(slowest.workflow)}`, 'name', explain('t-slowest', 'Slowest job', WHAT.slowest)) : ''}
</div>`;

    const c = counts(sumTallies(jobs.map((j) => j.job.tally)));
    const totalRuns = OUTCOMES.reduce((a, o) => a + c[o.key], 0);
    const shown = OUTCOMES.filter((o) => c[o.key] > 0);
    const ended = section(
      'ended',
      'How every job run ended',
      `${number(totalRuns)} job runs on main · ${esc(periodLabel.toLowerCase())}`,
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
    const lastPanel = section('last-runs', 'Last run of each workflow', 'on main', `<ul class="well changes">${lasts || '<li class="faint">No finished run</li>'}</ul>`, 'panel narrow', explain('last-runs', 'Last run of each workflow', WHAT.lastRuns));
    return `${tiles}\n<div class="row">${ended}${lastPanel}</div>\n`;
  }

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
      `${esc(chosen.workflow)} · on main · median ${humanMs(chosen.job.durations?.median)} · p90 ${humanMs(chosen.job.durations?.p90)} · <a href="${link({ steps: null })}">Close</a>`,
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
      const { tally } = j.job;
      const detail = strip(
        side(
          'On main',
          tally.completed ? `${times(tally.completed, 'run')} · ${pct(tally.rate!)} passed · ${times(tally.fail, 'failure')}${tally.fail ? `, ${j.fails?.mainFlaky ?? 0} passed on a re-run` : ''}` : 'No finished run on main in this period.',
          j.fails?.mainCauses ?? [],
          'main',
        ),
        branchSide(j.fails?.branchFlaky ?? [], j.fails?.branchCauses ?? [], 'This job did not fail and then pass on a feature branch.'),
        j.job.steps.length ? `<a href="${on ? link({ steps: null }) : jobLink(j)}">${on ? 'Hide' : 'Show'} where ${esc(j.job.name)}&rsquo;s time goes on main</a>` : 'No step of this job is stored for main.',
      );
      return `<tr data-opens="${esc(j.job.name)}"${on ? ' class="chosen"' : ''}><td class="first"><a href="${on ? link({ steps: null }) : jobLink(j)}">${esc(j.job.name)}</a><div class="sub">${esc(j.workflow)}${j.job.steps.length ? ` · ${on ? 'steps shown' : 'steps'}` : ''}</div></td>${lastCell(j.last)}${rateCell(tally)}<td class="split-cell">${outcomeBar(tally)}</td><td class="num">${tally.fail ? number(tally.fail) : dash}${j.branchFlaky ? `<span class="of">+${number(j.branchFlaky)} on branches</span>` : ''}</td><td class="num faint-num">${tally.cancelled ? number(tally.cancelled) : '—'}</td><td class="num">${humanMs(j.job.durations?.median)}</td><td class="num faint-num">${humanMs(j.job.durations?.p90)}</td></tr><tr class="detail" hidden><td colspan="8">${detail}</td></tr>`;
    })
    .join('\n');
  out += rows.length
    ? section(
        'by-job',
        'By job',
        `${number(rows.length)} jobs · ${esc(SORTS.job.find(([k]) => k === sort)![1].toLowerCase())} first · a job&rsquo;s name opens its steps, a row opens to main and its feature branches`,
        `<div class="well table"><table class="openable">
<thead><tr><th scope="col">Job</th><th scope="col" class="num">Last run</th><th scope="col" class="num">Pass rate on main</th><th scope="col">Outcomes</th><th scope="col" class="num">Failed on main</th><th scope="col" class="num">Cancelled</th><th scope="col" class="num">Median</th><th scope="col" class="num">p90</th></tr></thead>
<tbody>${table}</tbody></table></div>${OPEN_SCRIPT}`,
        'panel wide',
        explain('by-job', 'By job', WHAT.job),
      )
    : section('by-job', 'By job', '', '<p class="well empty">No job ran in this period.</p>', 'panel', explain('by-job', 'By job', WHAT.job));
  return `${overview()}${out}`;
}
