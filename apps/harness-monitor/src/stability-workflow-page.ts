import { belgianDay, formatDateTime, formatDay, startOfDay } from './belgium';
import type { WorkflowData } from './ci-flakiness-report';
import {
  causesOf,
  flakyAmong,
  sortFigures,
  times,
  whereOf,
  workflowFigures,
  workflowPrompt,
  type Attempt,
  type Cause,
  type RedNow,
  type WorkflowFigures,
} from './ci-flakiness';
import { COPY_SCRIPT, promptBox } from './copy-prompt';
import { explain } from './explain';
import { esc } from './look';
import { number } from './page';
import { ORANGE, RED, VIOLET } from './palette';
import { humanMs, outLink, pct, section, tile } from './report';
import { WHAT } from './stability-explain';
import { dash, OPEN_SCRIPT, shortName, strip, whereTag } from './stability-rows';
import { sortOf, type StabilityQuery } from './stability-report';

/** Green at 99% or more, red below 90%: how a pass rate is coloured on every tab. */
export const bandOf = (rate: number) => (rate >= 0.99 ? 'ok' : rate >= 0.9 ? 'mid' : 'poor');

/** Red now: a workflow whose newest attempt on main failed, on every tab. */
export function redNowNotice(redNow: RedNow[], now: number): string {
  if (!redNow.length) return '';
  return `<p class="notice" role="status">${redNow
    .map((r) => {
      const died = r.jobs.map((j) => `${outLink(j.url, esc(j.name))}${j.step ? ` at &ldquo;${esc(j.step)}&rdquo;` : ''}`).join(', ');
      return `<strong>${esc(r.workflow)} is red now</strong>, since ${outLink(r.sinceUrl, esc(formatDateTime(r.since)))} (${humanMs(now - r.since)})${died ? `: ${died} failed` : ''}.`;
    })
    .join('<br>')}</p>`;
}

/** Attempts bucketed by the Belgian day they started on, so a strip or chart formats each instant once. */
const byDay = (attempts: Attempt[]): Map<string, Attempt[]> => {
  const days = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const d = belgianDay(a.at);
    const own = days.get(d) ?? [];
    own.push(a);
    days.set(d, own);
  }
  return days;
};

/** A square per day: main's pass rate that day, with a dot under it on a day a feature branch flaked. */
function dayStrip(main: Attempt[], branchFlaky: Attempt[], days: string[]): string {
  const mainOf = byDay(main);
  const flakedOf = byDay(branchFlaky);
  return `<div class="day-strip">${days
    .map((d) => {
      const own = mainOf.get(d) ?? [];
      const pass = own.filter((a) => a.outcome === 'pass').length;
      const fail = own.length - pass;
      const flaked = (flakedOf.get(d) ?? []).length;
      const cls = own.length === 0 ? 'none' : bandOf(pass / own.length);
      return `<span title="${esc(formatDay(d))} · main: ${own.length ? `${pct(pass / own.length)}, ${fail} failed of ${own.length}` : 'no finished run'}${flaked ? ` · feature branches: ${flaked} flaky` : ''}"><i class="${cls}"></i><b class="${flaked ? 'branch' : ''}"></b></span>`;
    })
    .join('')}</div>`;
}

function dayChart(f: WorkflowFigures, flaky: Set<Attempt>, days: string[]): string {
  const mainOf = byDay(f.main);
  const flakedOf = byDay(f.branchFlaky);
  const rows = days.map((d) => {
    const own = mainOf.get(d) ?? [];
    return {
      d,
      pass: own.filter((a) => a.outcome === 'pass').length,
      flaky: own.filter((a) => a.outcome === 'fail' && flaky.has(a)).length,
      fail: own.filter((a) => a.outcome === 'fail' && !flaky.has(a)).length,
      branch: (flakedOf.get(d) ?? []).length,
    };
  });
  const peak = Math.max(1, ...rows.map((r) => Math.max(r.pass + r.fail + r.flaky, r.branch)));
  const { width, height, left, bottom, top } = { width: 1000, height: 220, left: 40, bottom: 28, top: 14 };
  const bw = (width - left) / days.length;
  const y = (v: number) => (v / peak) * (height - top - bottom);
  const bars = rows
    .map((r, i) => {
      const x = left + i * bw + bw * 0.1;
      const w = bw * 0.52;
      let base = height - bottom;
      const seg = (v: number, colour: string, label: string) => {
        if (!v) return '';
        base -= y(v);
        return `<rect x="${x.toFixed(1)}" y="${base.toFixed(1)}" width="${w.toFixed(1)}" height="${y(v).toFixed(1)}" fill="${colour}"><title>${esc(formatDay(r.d))} · main: ${label} ${v}</title></rect>`;
      };
      const rate = r.pass + r.fail + r.flaky ? pct(r.pass / (r.pass + r.fail + r.flaky)) : '';
      const branch = r.branch
        ? `<rect x="${(x + w + bw * 0.04).toFixed(1)}" y="${(height - bottom - y(r.branch)).toFixed(1)}" width="${(bw * 0.22).toFixed(1)}" height="${y(r.branch).toFixed(1)}" class="branch-bar"><title>${esc(formatDay(r.d))} · feature branches: failed, then passed on the same commit ${r.branch}</title></rect>`
        : '';
      return `${seg(r.fail, RED, 'failed')}${seg(r.flaky, ORANGE, 'failed, then passed on the same commit')}${seg(r.pass, VIOLET, 'passed')}${branch}${rate && r.fail + r.flaky ? `<text x="${(x + w / 2).toFixed(1)}" y="${(base - 4).toFixed(1)}" text-anchor="middle" class="axis">${rate}</text>` : ''}`;
    })
    .join('');
  const ends = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  // The first and last dates sit against the chart's edges, so the last is never cut off.
  const dates = ends
    .map((i) => {
      const x = i === 0 && ends.length > 1 ? left + 2 : i === days.length - 1 && ends.length > 1 ? width - 2 : left + i * bw + bw / 2;
      const anchor = i === 0 && ends.length > 1 ? 'start' : i === days.length - 1 && ends.length > 1 ? 'end' : 'middle';
      return `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" class="axis">${formatDay(days[i]!)}</text>`;
    })
    .join('');
  // Whole-number ticks only: a peak of 1 has no half run to label.
  const grid = [...new Set([0, Math.ceil(peak / 2), peak])]
    .map((v) => `<line x1="${left}" x2="${width}" y1="${(height - bottom - y(v)).toFixed(1)}" y2="${(height - bottom - y(v)).toFixed(1)}" class="gridline"/><text x="${left - 8}" y="${(height - bottom - y(v) + 4).toFixed(1)}" text-anchor="end" class="axis">${v}</text>`)
    .join('');
  const legend = `<span class="legend"><span class="key"><i style="background:${VIOLET}"></i>Main passed</span><span class="key"><i style="background:${ORANGE}"></i>Main failed, then passed</span><span class="key"><i style="background:${RED}"></i>Main failed</span><span class="key"><i class="branch-key"></i>Feature branch failed, then passed</span></span>`;
  return section('per-day', 'Runs per day', legend, `<div class="well chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Runs per day">${grid}${bars}${dates}</svg></div>`, 'panel wide', explain('per-day', 'Runs per day', WHAT.workflowPerDay));
}

function causeTable(causes: Cause[]): string {
  const peak = Math.max(1, ...causes.map((c) => Math.max(c.main, c.branch)));
  const bar = (v: number, cls: string) => (v ? `<div class="lasted"><span class="track"><span class="fill ${cls}" style="width:${((v / peak) * 100).toFixed(1)}%"></span></span><span class="num">${number(v)}</span></div>` : dash);
  return `<div class="well table"><table><thead><tr><th scope="col">Cause</th><th scope="col">Failed on main</th><th scope="col">Flaky on feature branches</th><th scope="col" class="num">Last</th></tr></thead><tbody>${causes
    .map(
      (c) =>
        `<tr><td class="first">${c.kind === 'test' ? '' : '<span class="tag">step</span> '}${esc(c.label)}<div class="sub">${esc(c.sub)}${c.error ? `<br><span class="err">${esc(c.error)}</span>` : ''}</div></td><td class="lasted-cell">${bar(c.main, '')}${c.main ? `<span class="of">${c.mainFlaky ? `${number(c.mainFlaky)} flaky` : 'none flaky'}</span>` : ''}</td><td class="lasted-cell">${bar(c.branch, 'branch')}</td><td class="num">${outLink(c.lastUrl, esc(formatDateTime(c.last.at)))}<span class="of">${esc(whereOf(c.last))}</span></td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

/** One side of an opened row: its summary and its top three causes. */
function side(title: string, summary: string, causes: Cause[], kind: 'main' | 'branch'): string {
  const list = causes
    .slice(0, 3)
    .map((c) => `<li><span class="n ${kind}">${number(kind === 'main' ? c.main : c.branch)}</span><span>${esc(shortName(c.label))}<span class="of">${esc(c.sub)} · last ${outLink(c.lastUrl, esc(formatDateTime(c.last.at)))}</span></span></li>`)
    .join('');
  return `<div class="side ${kind}"><h4>${title}</h4><p class="muted small">${summary}</p>${list ? `<ul class="causes">${list}</ul>` : ''}${causes.length > 3 ? `<p class="faint small">and ${times(causes.length - 3, 'other cause')}</p>` : ''}</div>`;
}

/** A workflow's own view: tiles, runs per day, its causes and every failure counted for it. */
function workflowView(q: StabilityQuery, f: WorkflowFigures, flaky: Set<Attempt>, days: string[], link: (over: Partial<StabilityQuery>) => string): string {
  const name = q.workflow!;
  const commits = new Set(f.branchFlaky.map((a) => a.sha)).size;
  const top = f.causes[0];
  const tiles = `<div class="tiles">${tile('Pass rate on main', f.rate === null ? '—' : `<span class="rate ${bandOf(f.rate)}">${pct(f.rate)}</span>`, `${number(f.pass)} of ${number(f.pass + f.failed.length)} finished · scheduled and manual runs count as main`, '', explain('t-wf-rate', 'Pass rate on main', WHAT.workflowRate))}${tile('Failed on main', number(f.failed.length), `${number(f.mainFlaky)} passed on a later attempt of the same commit`, f.failed.length ? 'up' : '', explain('t-wf-failed', 'Failed on main', WHAT.workflowFailed))}${tile('Flaky on feature branches', number(f.branchFlaky.length), `failed, then passed on the same commit · ${times(commits, 'commit')}`, '', explain('t-wf-flaky', 'Flaky on feature branches', WHAT.workflowFlaky))}${top ? tile('Top cause', esc(shortName(top.label)), [`${number(top.main)} on main · ${number(top.branch)} on feature branches`, esc(top.sub)], 'name cause', explain('t-wf-top', 'Top cause', WHAT.workflowTop)) : ''}</div>`;
  const failures = [...f.failed, ...f.branchFlaky].sort((x, y) => Number(!x.onMain) - Number(!y.onMain) || y.at - x.at);
  const list = failures
    .map((a) => {
      const jobs = a.failedJobs;
      return `<tr${a.onMain ? ' class="open"' : ''}><td class="num">${whereTag(a.onMain)} ${outLink(a.url, esc(formatDateTime(a.at)))}<span class="of">${esc(whereOf(a))}${a.attempt > 1 ? ` · attempt ${a.attempt}` : ''}</span></td><td>${jobs.length ? jobs.map((j) => `${outLink(j.url, esc(j.name))}<span class="faint"> · ${esc(j.step ?? '—')}</span>`).join('<br>') : '<span class="faint">none recorded</span>'}</td><td class="step-cell">${jobs.flatMap((j) => j.tests).map((t) => esc(t.name)).join('<br>') || dash}</td><td>${flaky.has(a) ? 'passed on a later attempt' : '<span class="rate poor">stayed failed</span>'}</td></tr>`;
    })
    .join('');
  const causes = section(
    'causes',
    `What made ${esc(name)} fail`,
    `${number(f.causes.length)} causes · most on main first · <a href="${link({ workflow: null })}">Every workflow</a>`,
    f.causes.length ? causeTable(f.causes) : '<p class="well empty">No failure in this period.</p>',
    'panel wide',
    explain('causes', `what made ${esc(name)} fail`, WHAT.workflowCauses),
  );
  const every = section(
    'every-failure',
    'Every failure',
    `${number(failures.length)} · main first, then newest`,
    failures.length
      ? `<div class="well table"><table><thead><tr><th scope="col" class="num">When</th><th scope="col">Job · step</th><th scope="col">Tests</th><th scope="col">Then</th></tr></thead><tbody>${list}</tbody></table></div>`
      : '<p class="well empty">No failure in this period.</p>',
    'panel wide',
    explain('every-failure', 'every failure', WHAT.workflowEvery),
  );
  return `${tiles}${dayChart(f, flaky, days)}${causes}${every}`;
}

/** The Workflow tab: a row per workflow, or one workflow's own view. */
export function workflowTab(q: StabilityQuery, data: WorkflowData, days: string[], link: (over: Partial<StabilityQuery>) => string): string {
  const from = startOfDay(days[0]!);
  const inPeriod = data.attempts.filter((a) => a.at >= from);
  const flaky = flakyAmong(inPeriod);
  if (q.workflow !== null) return workflowView(q, workflowFigures(q.workflow, inPeriod, flaky), flaky, days, link);

  const sort = sortOf(q);
  const rows = sortFigures(
    data.workflows.map((name) => workflowFigures(name, inPeriod, flaky)).filter((r) => r.main.length || r.branchFlaky.length),
    sort,
  );
  const body = rows
    .map((r) => {
      const prompt = r.failed.length || r.branchFlaky.length ? promptBox(workflowPrompt(r, days.length)) : '';
      const top = r.causes[0];
      const commits = new Set(r.branchFlaky.map((a) => a.sha)).size;
      const pulls = new Set(r.branchFlaky.map((a) => a.pull ?? a.branch)).size;
      const detail = strip(side(
        'On main',
        r.main.length ? `${times(r.pass + r.failed.length, 'run')} · ${r.rate === null ? 'none finished' : `${pct(r.rate)} passed`} · ${times(r.failed.length, 'failure')}${r.failed.length ? `, ${r.mainFlaky} passed on a re-run` : ''}` : 'No run on main in this period.',
        causesOf(r.failed, flaky),
        'main',
      ), side(
        'On feature branches',
        r.branchFlaky.length ? `${times(r.branchFlaky.length, 'failure')} a later attempt on the same commit passed · ${times(commits, 'commit')} · ${times(pulls, 'branch', 'es')}` : 'Nothing failed and then passed on a feature branch.',
        causesOf(r.branchFlaky, flaky),
        'branch',
      ), `<a href="${link({ workflow: r.name })}">Runs per day and every failure of ${esc(r.name)}</a>`);
      return `<tr data-opens><td class="first"><a href="${link({ workflow: r.name })}">${esc(r.name)}</a></td><td class="num">${r.rate === null ? '<span class="rate none">no run on main</span>' : `<span class="rate ${bandOf(r.rate)}">${pct(r.rate)}</span><span class="of">${number(r.pass)} of ${number(r.pass + r.failed.length)}</span>`}</td><td>${dayStrip(r.main, r.branchFlaky, days)}</td><td class="num">${r.failed.length ? `<span class="rate poor">${number(r.failed.length)}</span>` : dash}${r.branchFlaky.length ? `<span class="of">+${number(r.branchFlaky.length)} on branches</span>` : ''}</td><td>${top ? `${esc(shortName(top.label))}<div class="sub">${number(top.main + top.branch)} of ${number(r.failed.length + r.branchFlaky.length)}</div>` : dash}</td><td class="fix">${prompt}</td></tr><tr class="detail" hidden><td colspan="6">${detail}</td></tr>`;
    })
    .join('');
  return section(
    'by-workflow',
    'By workflow',
    `${number(rows.length)} workflows · ${sort === 'failures' ? 'most failures on main' : 'least reliable on main'} first · a row opens to main and its feature branches`,
    `<div class="well table"><table class="openable"><thead><tr><th scope="col">Workflow</th><th scope="col" class="num">Pass rate on main</th><th scope="col">Each day on main</th><th scope="col" class="num">Failed on main</th><th scope="col">Top cause</th><th scope="col"><span class="visually-hidden">Fix</span></th></tr></thead><tbody>${body}</tbody></table></div>${OPEN_SCRIPT}${COPY_SCRIPT}`,
    'panel wide',
    explain('by-workflow', 'By workflow', WHAT.workflow),
  );
}

export const WORKFLOW_STYLE = `
.tile.name.cause .tile-value{font-size:17px}
.day-strip{display:flex;gap:1px}.day-strip span{display:flex;flex-direction:column;align-items:center;gap:2px}
.day-strip i{display:block;width:5px;height:18px;border-radius:2px;background:color-mix(in srgb,var(--shade) 8%,transparent)}
.day-strip i.ok{background:var(--good)}.day-strip i.mid{background:var(--due)}.day-strip i.poor{background:var(--over)}
.day-strip b{display:block;width:5px;height:5px;border-radius:50%}.day-strip b.branch{background:${ORANGE};opacity:.55}
.branch-bar{fill:${ORANGE};opacity:.45}
.legend i.branch-key{background:${ORANGE};opacity:.45}
`;
