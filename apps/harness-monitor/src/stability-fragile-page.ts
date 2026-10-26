import { formatDateTime, startOfDay } from './belgium';
import { flakyAmong, fragileTests, newest, testPrompt, times, type FragileTest, type Run } from './ci-flakiness';
import type { FragileData } from './ci-flakiness-report';
import { COPY_SCRIPT, promptBox } from './copy-prompt';
import { explain } from './explain';
import { esc } from './look';
import { number } from './page';
import { outLink, section } from './report';
import { WHAT } from './stability-explain';
import { OPEN_SCRIPT, shortName, strip, whereTag } from './stability-rows';
import { sortOf, type StabilityQuery } from './stability-report';

/** One side of an opened row: its summary and its newest runs, each saying whether a re-run passed. */
function runSide(title: string, summary: string, runs: Run[], kind: 'main' | 'branch'): string {
  const list = newest(runs, 4)
    .map((r) => `<li><span class="n ${kind}">${r.flaky ? 're-run passed' : 'stayed failed'}</span><span>${outLink(r.url, esc(formatDateTime(r.at)))}<span class="of">${esc(r.label)}</span></span></li>`)
    .join('');
  return `<div class="side ${kind}"><h4>${title}</h4><p class="muted small">${summary}</p>${list ? `<ul class="causes">${list}</ul>` : ''}</div>`;
}

/** One stacked bar of a test's failures: those on main in red, then its flaky ones on branches in orange, against the busiest test's. */
function failuresBar({ cause: c }: FragileTest, peak: number): string {
  const width = (n: number) => ((n / peak) * 100).toFixed(1);
  return `<div class="lasted"><span class="track stacked"><span class="fill" style="width:${width(c.main)}%"></span><span class="fill branch" style="width:${width(c.branch)}%"></span></span><span class="num">${number(c.main + c.branch)}</span></div><span class="of">${c.main ? `${number(c.main)} on main` : 'none on main'} · ${number(c.branch)} on branches</span>`;
}

/** The Fragile tests tab: a row per test that failed and then passed on the same commit, on main or a feature branch. */
export function fragileTab(q: StabilityQuery, data: FragileData, days: string[]): string {
  const from = startOfDay(days[0]!);
  const inPeriod = data.attempts.filter((a) => a.at >= from);
  const flaky = flakyAmong(inPeriod);
  const sort = sortOf(q);
  const rows = fragileTests(
    inPeriod.filter((a) => q.workflow === null || a.workflow === q.workflow),
    flaky,
    sort,
  );
  const info = explain('fragile', 'Fragile tests', WHAT.fragile);
  if (!rows.length) return section('fragile', 'Fragile tests', '', '<p class="well empty">No test failed and then passed on the same commit in this period.</p>', 'panel wide', info);

  const missed = new Set(data.missed);
  const peak = Math.max(...rows.map((r) => r.cause.main + r.cause.branch));
  const body = rows
    .map((t) => {
      const c = t.cause;
      const name = shortName(c.label);
      const mainRuns = c.runs.filter((r) => r.main);
      const branchRuns = c.runs.filter((r) => !r.main);
      const detail = strip(
        runSide('On main', mainRuns.length ? `${times(mainRuns.length, 'failure')} · ${c.mainFlaky} passed on a re-run` : 'It has not failed on main in this period.', mainRuns, 'main'),
        runSide(
          'On feature branches',
          branchRuns.length ? `${times(branchRuns.length, 'failure')} a later attempt passed · ${times(new Set(branchRuns.map((r) => r.where)).size, 'branch', 'es')}` : 'It has not flaked on a feature branch in this period.',
          branchRuns,
          'branch',
        ),
        `${esc(c.file ?? '')}${c.projects.length ? ` · ${c.projects.map(esc).join(', ')}` : ''} · ${c.jobs.map(esc).join(', ')}`,
      );
      const above = c.label === name ? (c.file ?? '') : c.label.slice(0, c.label.length - name.length - 3);
      const tag = missed.has(c.file ?? '') ? ' <span class="tag miss" title="Test selection: this file failed on main after a pull request skipped it">also a miss</span>' : '';
      return `<tr data-opens="${esc(name)}"><td class="first">${esc(name)}${tag}<div class="sub">${esc(above)}${t.error ? `<br><span class="err">${esc(t.error)}</span>` : ''}</div></td><td class="lasted-cell">${failuresBar(t, peak)}</td><td class="num">${whereTag(t.last.main)} ${outLink(t.last.url, esc(formatDateTime(t.last.at)))}</td><td class="fix">${promptBox(testPrompt(t))}</td></tr><tr class="detail" hidden><td colspan="4">${detail}</td></tr>`;
    })
    .join('');
  return section(
    'fragile',
    'Fragile tests',
    `${number(rows.length)} tests · ${sort === 'all' ? 'most failures in total' : 'most failures on main'} first · a row opens to main and its feature branches`,
    `<div class="well table"><table class="openable"><thead><tr><th scope="col">Test</th><th scope="col">Failures</th><th scope="col" class="num">Last flaky failure</th><th scope="col"><span class="visually-hidden">Fix</span></th></tr></thead><tbody>${body}</tbody></table></div>${OPEN_SCRIPT}${COPY_SCRIPT}`,
    'panel wide',
    info,
  );
}

export const FRAGILE_STYLE = `
.tag.miss{background:color-mix(in srgb,var(--due) 22%,transparent);color:var(--due-ink)}
.track.stacked{display:flex}.track.stacked .fill{flex:none}
`;
