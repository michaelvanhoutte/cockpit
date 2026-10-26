import { belgianDay, formatDateTime, formatDay } from './belgium';
import { COPY_SCRIPT, COPY_STYLE, promptBox } from './copy-prompt';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, lead } from './explain';
import { esc, inline, lineKey, questionOf, sentenceForm } from './look';
import { number } from './page';
import { GREY, ORANGE, RED, VIOLET } from './palette';
import { humanMs, outLink, reportPage, section, tile } from './report';
import {
  barsOf,
  dayOf,
  dayRange,
  groupByStart,
  JOB_CHOICES,
  JOB_NAMES,
  jobOf,
  jobsOf,
  missPrompt,
  missRows,
  outcomeOf,
  overBar,
  OUTCOME_LABELS,
  OUTCOMES,
  parseSelectionQuery,
  PERIOD_CHOICES,
  PERIODS,
  percent,
  plural,
  rankRules,
  ranMoreThanNeeded,
  ROWS,
  RULE_GROUP_LABELS,
  ruleRows,
  rulePrompt,
  selectionAddress,
  UNIT,
  whyText,
  type Job,
  type Outcome,
  type SelectedFile,
  type SelectionQuery,
} from './selection-report';
import { LEAD_MORE, TABLES, WHAT } from './selection-explain';
import type { SelectionView, ViewPull } from './selection-view';

const ROW_WORDS: Record<(typeof ROWS)[number], string> = { day: 'each day', rule: 'each rule that forced a full run', miss: 'each test skipped, then failed on main' };

/** Each job takes a slot (src/palette.ts). */
const JOB_COLOURS: Record<Job, string> = { test: VIOLET, e2e: ORANGE };
/** The outcomes in stacking order, a job that never started being grey and stacking last; "ran everything" turns red only where its job is over the bar for the period. */
const OUTCOME_COLOURS: Record<Outcome, string> = { selected: VIOLET, full: ORANGE, docs: GREY, none: GREY };
const outcomeColour = (o: Outcome, over: boolean) => (o === 'full' && over ? RED : OUTCOME_COLOURS[o]);

/** The advice for each rule, by job: what to do about a rule that forces a full run, in the rule's own words. A rule marked `expected` forces a full run by design, so it is listed with the ones not to fix and carries no prompt. */
const ADVICE: Record<Job, Record<string, { advice: string; expected?: true }>> = {
  test: {
    'push to main': { advice: 'Expected on a push to main, which runs everything by design; nothing to fix.', expected: true },
    'not a pull request': { advice: 'Not a pull request event, so nothing to select from. Nothing to fix.', expected: true },
    'diff unreadable': { advice: 'The job could not read the diff, so it ran everything rather than guess. A recurring one is a CI fault: fix the checkout.' },
    'any tsconfig': { advice: 'A tsconfig can extend another package’s, so it forces every package, and should.', expected: true },
    'outside every package': { advice: 'A file outside every package’s directory forces every package, since the import graph cannot attribute it. Fix: move the path under a package, or narrow the rule for files no test can depend on.' },
    'own vitest config': { advice: 'A package’s own Vitest config changes how its whole suite runs, so it forces that package. Expected.', expected: true },
    'own package.json': { advice: 'A package’s own package.json can change what its tests resolve, so it forces that package. Expected.', expected: true },
    'own wrangler config': { advice: 'A package’s Wrangler config is what its suite runs against, so it forces that package. Expected.', expected: true },
    'own migration': { advice: 'A migration forces its own package, since Vitest’s graph does not see the schema. Expected.', expected: true },
    'own global setup': { advice: 'A global setup runs outside any test file’s imports, so it forces its package. Expected.', expected: true },
  },
  e2e: {
    'push to main': { advice: 'Expected on a push to main, which runs everything by design; nothing to fix.', expected: true },
    'not a pull request': { advice: 'Not a pull request event, so nothing to select from. Nothing to fix.', expected: true },
    'diff unreadable': { advice: 'The job could not read the diff, so it ran every spec rather than guess. A recurring one is a CI fault: fix the checkout.' },
    'no product file in the diff': { advice: 'Nothing in the diff places a walk, so every spec ran. A pull request that changes only tests or tooling lands here.' },
    'e2e support, registry or config': { advice: 'Support code, the area registry or the Playwright config is shared by every walk, so it forces every spec, and should.', expected: true },
    'any tsconfig': { advice: 'A tsconfig can extend another package’s, so it forces every walk, and should.', expected: true },
    lockfile: { advice: 'The lockfile changes what every walk installs, so it forces every spec, and should.', expected: true },
    'any package.json': { advice: 'A package.json can change what every walk runs against, so it forces every spec.' },
    'workflow or action': { advice: 'A workflow or action changes how the job itself runs, so it forces every spec.' },
    'outside every package': { advice: 'A workflow, the lockfile or a root config forces every walk, and should.', expected: true },
    'spec with no area': { advice: 'A changed spec whose walks no area owns cannot be placed, so every walk ran. Fix: give the spec’s walks an area in the registry.' },
    'loaded by the job, owned by no area': { advice: 'A file the job loads that no area owns cannot be placed, so every walk ran. Fix: give it an area.' },
    'owned by no concept': { advice: 'The area registry cannot place this file, so every walk ran. A new source file or another tier’s test file lands here. Fix: place a file by what imports it (issue 1275, "Make the E2E (F3) selection fire"), not by adding it to the registry.' },
    'the selection failed': { advice: 'The selection step itself failed, so the job ran every spec. Read that job’s log for the cause.' },
  },
};
const adviceFor = (job: Job, rule: string) => ADVICE[job][rule]?.advice ?? 'No advice is written for this rule yet.';
const isExpected = (job: Job, rule: string) => ADVICE[job][rule]?.expected === true;

const mono = (s: string) => `<span class="mono">${esc(s)}</span>`;
const prLabel = (p: { number: number; title: string }) => `<span class="pr-no">#${p.number}</span> ${esc(p.title)}`;
const jobDot = (job: Job) => `<i class="job-dot" style="background:${JOB_COLOURS[job]}"></i>`;

/** One selected file and the chain that reached it, as the pull request's selection and an opened cycle time line both list it. */
const fileItem = (f: Pick<SelectedFile, 'path' | 'status' | 'text'>) =>
  `<li><span class="mono${f.status === 'failed' ? ' over-ink' : ''}">${esc(f.path)}${f.status === 'failed' ? ' (failed)' : ''}</span><div class="sub">${esc(whyText(f.text, f.path))}</div></li>`;

const OWN_ADDRESS = parseSelectionQuery(new URLSearchParams());

/**
 * What one job selected on one pull request's last CI run, as the fragment a
 * cycle time outline's line opens beneath it: the reasons it ran everything, or
 * the files it selected grouped by the changed file their chains started from.
 */
export function renderSelectionCheck(view: SelectionView, job: Job): string {
  const drill = view.pullDrill;
  const p = drill?.pull;
  if (!drill || !p) return '<p class="faint">The Monitor holds no test selection record for this pull request.</p>';
  const v = jobOf(p, job);
  const o = outcomeOf(v);
  const [unit, units] = UNIT[job];
  const foot = `<p class="sel-foot">What its last CI run selected · <a href="${esc(selectionAddress(OWN_ADDRESS, { group: 'pr', pr: p.number, job }))}">Open its whole selection</a></p>`;
  if (o === 'docs') return `<p>Did not run: the change was documentation only.</p>${foot}`;
  if (o === 'none') return `<p class="faint">No record of what it selected.</p>${foot}`;

  const packages = drill.packages.filter((k) => k.job === job);
  const forced = new Map<string, { rule: string; path: string | null; names: string[] }>();
  for (const k of packages.filter((k) => k.mode === 'full' && k.rule)) {
    const key = JSON.stringify([k.rule, k.path]);
    const entry = forced.get(key) ?? { rule: k.rule!, path: k.path, names: [] };
    entry.names.push(k.name);
    forced.set(key, entry);
  }
  const reasons = [...forced.values()]
    .map((f) => {
      const which = job === 'e2e' ? '' : f.names.length === packages.length ? ' · every package' : ` · ${f.names.map(esc).join(', ')}`;
      return `<li><a href="${esc(selectionAddress(OWN_ADDRESS, { group: 'rule', rule: `${job}:${f.rule}` }))}">${esc(f.rule)}</a>${f.path ? `: ${mono(f.path)}` : ''}<span class="faint">${which}</span><div class="sub">${esc(adviceFor(job, f.rule))}</div></li>`;
    })
    .join('');
  if (o === 'full') return `<p><strong>Ran everything</strong>: ${number(v.filesRun ?? 0)} of ${plural(v.filesTotal ?? 0, unit, units)}, because</p><ul class="sel-list">${reasons}</ul>${foot}`;

  const files = drill.files.filter((f) => f.job === job);
  const groups = groupByStart(files);
  const groupRows = groups
    .map((g) => {
      const split = job === 'test' && g.byPackage.length > 0 ? ` <span class="faint">· ${g.byPackage.map(([name, n]) => `${esc(name)} ${number(n)}`).join(' · ')}</span>` : '';
      const name = g.kind === 'itself' ? g.label : g.kind === 'file' && job === 'test' ? mono(g.label) : esc(g.label);
      const through = g.through ? `<div class="sub">mostly through ${mono(g.through.step)} (${number(g.through.count)} of ${number(g.files.length)})</div>` : '';
      return `<li><details><summary>${name} <span class="arrow">→</span> <strong>${plural(g.files.length, unit, units)}</strong>${split}${through}</summary><ul class="sel-list">${g.files.map(fileItem).join('')}</ul></details></li>`;
    })
    .join('');
  const ranIn = job === 'test' ? packages.filter((k) => k.mode === 'changed' && k.ran > 0).map((k) => `${esc(k.name)} ${number(k.ran)} of ${number(k.filesTotal ?? 0)}`) : [];
  const head = `<p><strong>Selected a subset</strong>: ${number(v.filesRun ?? 0)} of ${plural(v.filesTotal ?? 0, unit, units)}${ranIn.length ? ` <span class="faint">· ${ranIn.join(' · ')}</span>` : ''}</p>`;
  const body = files.length ? `<p class="sub">Reached from ${plural(groups.length, 'starting point')}, each ${unit} counted under the first chain that reached it:</p><ul class="sel-list triggers">${groupRows}</ul>` : '<p class="faint">Nothing selected.</p>';
  const alsoWhole = reasons ? `<p>And ran some packages whole, because</p><ul class="sel-list">${reasons}</ul>` : '';
  return `${head}${body}${alsoWhole}${foot}`;
}

const CHART = { width: 1000, height: 260, left: 52, right: 12, top: 12, bottom: 30 };

/** The test selection page: the same pull requests whatever the row, narrowed by the filters, with the tiles and overview panels only on each day. */
export function renderSelection(q: SelectionQuery, view: SelectionView, now: number): string {
  const jobs = jobsOf(q.job);
  const bars = barsOf(view.bars);
  const pulls = view.pulls;
  const over: Record<Job, boolean> = { test: overBar(pulls, 'test', bars), e2e: overBar(pulls, 'e2e', bars) };
  const link = (to: Partial<SelectionQuery>) => esc(selectionAddress(q, to));
  /** The ran-everything bar of the jobs shown: one figure where they share it, each job's own where they differ. */
  const sharedBar = new Set(jobs.map((j) => bars.forcedFull[j])).size === 1;
  const forcedBarText = sharedBar ? percent(bars.forcedFull[jobs[0]!]) : jobs.map((j) => `${JOB_NAMES[j]} ${percent(bars.forcedFull[j])}`).join(', ');
  /** A row's table, with the (i) that says what its rows are. */
  const wide = (about: keyof typeof TABLES, id: string, title: string, aside: string, content: string) => section(id, title, aside, content, 'panel wide', explain(id, title, TABLES[about]));

  /** The two questions the page answers, one tile each: what ran more than needed, and what ran less. */
  function questionTiles(): string {
    const more = ranMoreThanNeeded(pulls, jobs, view.checkMs, isExpected);
    const missed = missRows(pulls, jobs).length;
    const everyRun = more.perJob.reduce((n, j) => n + j.full, 0);
    const perJob = more.perJob.map((j) => `${JOB_NAMES[j.job]} ${number(j.full)} of ${number(j.ran)}`).join(' · ');
    return `<div class="tiles">
${tile(
  'Ran more than needed',
  humanMs(more.savedMs),
  [
    `could have been saved: ${plural(more.fixRuns, 'full run')} forced by rules to fix, against a typical selected run`,
    `${plural(everyRun, 'full run')} in all (${perJob}), ${humanMs(more.allSavedMs)} counting the expected ones too`,
    `<a href="${link({ group: 'rule' })}">Which rules</a>`,
  ],
  '',
  explain('t-more', 'Ran more than needed', WHAT.ranMore),
)}
${tile('Ran less than needed', plural(missed, 'test'), ['skipped by their pull request, then failed on main', ...(missed ? [`<a href="${link({ group: 'miss' })}">Which ones</a>`] : [])], '', explain('t-less', 'Ran less than needed', WHAT.ranLess))}
</div>`;
  }

  /** What each job did with the period's pull requests, as a split bar per job. */
  function whatEachJobDid(): string {
    const blocks = jobs
      .map((job) => {
        const counts = new Map<Outcome, number>();
        for (const p of pulls) counts.set(outcomeOf(jobOf(p, job)), (counts.get(outcomeOf(jobOf(p, job))) ?? 0) + 1);
        const present = OUTCOMES.filter((o) => counts.has(o));
        const bar = present.map((o) => `<div style="flex:${counts.get(o)};background:${outcomeColour(o, over[job])}" title="${OUTCOME_LABELS[o]} ${counts.get(o)}"></div>`).join('');
        const legend = present
          .map(
            (o) =>
              `<li><i style="background:${outcomeColour(o, over[job])}"></i><span class="name">${OUTCOME_LABELS[o]}${o === 'full' && over[job] ? ' · over the bar' : ''}</span><span class="amount">${number(counts.get(o)!)}</span><span class="share">${percent(counts.get(o)! / pulls.length)}</span></li>`,
          )
          .join('');
        return `<div class="job-block"><div class="job-name"><i style="background:${JOB_COLOURS[job]}"></i>${JOB_NAMES[job]}</div><div class="bar" role="img" aria-label="${esc(present.map((o) => `${OUTCOME_LABELS[o]} ${counts.get(o)}`).join(', '))}">${bar}</div><ul class="shares">${legend}</ul></div>`;
      })
      .join('');
    const title = `What each job did with ${plural(pulls.length, 'pull request')}`;
    return section(
      'what-each-job-did',
      title,
      `ran everything read against ${sharedBar ? `the ${forcedBarText} bar` : `each job&rsquo;s bar, ${forcedBarText}`}`,
      `<div class="well where">${blocks}</div>`,
      'panel wide',
      explain('what-each-job-did', title, WHAT.whatEachJobDid),
    );
  }

  const days = dayRange(q.period, view.oldest, now);
  /** The period's pull requests by Belgian day, bucketed once for the chart and the table. */
  const pullsOn = new Map<string, ViewPull[]>();
  for (const p of pulls) pullsOn.set(dayOf(p), [...(pullsOn.get(dayOf(p)) ?? []), p]);

  /** Each job's share of pull requests that ran everything, per Belgian day, against the bar. */
  function overTimeChart(): string {
    const { width, height, left, right, top, bottom } = CHART;
    const x = (i: number) => (days.length === 1 ? (left + width - right) / 2 : left + (i / (days.length - 1)) * (width - left - right));
    const y = (v: number) => top + (1 - v) * (height - top - bottom);
    const grid = [0, 0.5, 1].map((f) => `<line x1="${left}" x2="${width - right}" y1="${y(f).toFixed(1)}" y2="${y(f).toFixed(1)}" class="gridline"/><text x="${left - 10}" y="${(y(f) + 4).toFixed(1)}" text-anchor="end" class="axis">${percent(f)}</text>`).join('');
    const barLines = jobs
      .filter((job, i) => sharedBar ? i === 0 : true)
      .map((job, i) => {
        const v = bars.forcedFull[job];
        return `<line x1="${left}" x2="${width - right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="threshold"/><text x="${width - right}" y="${(y(v) - 6 + i * 20).toFixed(1)}" text-anchor="end" class="axis">${sharedBar ? '' : `${JOB_NAMES[job]} `}bar ${percent(v)}</text>`;
      })
      .join('');    const ends = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
    const dates = ends.map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}" class="axis">${formatDay(days[i]!)}</text>`).join('');
    const lines = jobs
      .map((job) => {
        const points = days
          .map((d, i) => {
            const ran = (pullsOn.get(d) ?? []).map((p) => jobOf(p, job)).filter((v) => v.status === 'ran');
            return ran.length ? { i, d, full: ran.filter((v) => v.ranEverything).length, of: ran.length } : null;
          })
          .filter((pt) => pt !== null);
        const colour = JOB_COLOURS[job];
        return `<g><polyline points="${points.map((pt) => `${x(pt.i).toFixed(1)},${y(pt.full / pt.of).toFixed(1)}`).join(' ')}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"/>${points
          .map((pt) => `<circle cx="${x(pt.i).toFixed(1)}" cy="${y(pt.full / pt.of).toFixed(1)}" r="3.5" fill="${colour}"><title>${JOB_NAMES[job]} · ${formatDay(pt.d)} · ran everything on ${pt.full} of ${pt.of}</title></circle>`)
          .join('')}</g>`;
      })
      .join('');
    const legend = [...jobs.map((j) => lineKey(JOB_NAMES[j], JOB_COLOURS[j])), '<span class="key"><i class="dash bar-key"></i>Bar</span>'].join('');
    return section(
      'ran-everything-per-day',
      'Share of pull requests that ran everything, per day',
      `<span class="legend">${legend}</span>`,
      `<div class="well chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Share of pull requests that ran everything, per day">${grid}${barLines}${dates}<g class="lines">${lines}</g></svg></div>`,
      'panel',
      explain('ran-everything-per-day', 'Share of pull requests that ran everything, per day', WHAT.perDay),
    );
  }

  /** One pull request in full: what changed, each package's mode and reason, what ran and why. */
  function pullDrill(): string {
    const back = `<a class="back" href="${link({ group: 'day' })}">&larr; Each day</a>`;
    const drill = view.pullDrill;
    const p = drill?.pull;
    const info = explain('pull-request', 'what each job ran and why', WHAT.pull);
    if (!drill || !p) return `${back}${section('pull-request', 'Pull request', '', '<p class="well empty">That pull request is not in the data held.</p>', 'panel wide drill-panel', info)}`;
    const changed = `<details><summary>${plural(drill.changed.length, 'changed file')}</summary><ul class="files">${drill.changed.map((f) => `<li class="mono${f.ignored ? ' faint' : ''}">${esc(f.path)}${f.ignored ? ' (ignored by selection)' : ''}</li>`).join('')}</ul></details>`;
    const parts = jobs.map((job) => {
      const v = jobOf(p, job);
      const o = outcomeOf(v);
      const head = `<h3><i style="background:${JOB_COLOURS[job]}"></i>${JOB_NAMES[job]}</h3>`;
      if (o === 'docs' || o === 'none') return `<div class="drill-job">${head}<p class="faint">${OUTCOME_LABELS[o]}.</p></div>`;
      const pkgRows = drill.packages
        .filter((pkg) => pkg.job === job)
        .map(
          (pkg) =>
            `<tr><td class="first">${esc(pkg.name)}</td><td>${pkg.mode === 'full' ? '<span class="pill plain">full</span>' : '<span class="pill plain">changed</span>'}</td><td>${pkg.rule ? `${esc(pkg.rule)}${pkg.path ? `<div class="sub">${mono(pkg.path)}</div>` : ''}` : '<span class="faint">—</span>'}</td><td class="num">${number(pkg.ran)}${pkg.filesTotal === null ? '' : ` of ${number(pkg.filesTotal)}`}${pkg.failed ? ` <span class="pill over">${pkg.failed} failed</span>` : ''}${pkg.report === 'none' ? ' <span class="faint">no report</span>' : ''}</td></tr>`,
        )
        .join('');
      const files = drill.files.filter((f) => f.job === job);
      const selectedList = files.length
        ? `<ul class="files">${files.map(fileItem).join('')}</ul>`
        : `<p class="faint">${drill.packages.some((pkg) => pkg.job === job && pkg.mode === 'changed') ? 'Nothing selected.' : 'Nothing selected: every package that ran, ran in full.'}</p>`;
      const misses = v.misses.length ? `<p class="warning"><strong>${plural(v.misses.length, 'miss', 'misses')}:</strong> ${v.misses.map((m) => `${mono(m.path)}${m.reason === 'docs only' ? ' (docs only)' : ''}`).join(', ')} failed on main and did not run here.</p>` : '';
      return `<div class="drill-job">${head}${misses}<p class="sub">${OUTCOME_LABELS[o]}: ${number(v.filesRun ?? 0)} of ${plural(v.filesTotal ?? 0, UNIT[job][0], UNIT[job][1])} run</p>
<div class="table"><table class="inner"><thead><tr><th scope="col">${job === 'test' ? 'Package' : 'Tier'}</th><th scope="col">Mode</th><th scope="col">Reason</th><th scope="col" class="num">Ran</th></tr></thead><tbody>${pkgRows}</tbody></table></div>
<p class="sub">Selected, and why</p>${selectedList}${v.unplacedFiles ? `<p class="sub">${plural(v.unplacedFiles, 'changed file')} placed no walk</p>` : ''}</div>`;
    });
    const times = jobs.includes('test') ? ` · Test job ${humanMs(jobOf(p, 'test').prDurationMs)}, main ${humanMs(jobOf(p, 'test').mainDurationMs)}` : '';
    return `${back}${section('pull-request', prLabel(p), `merged ${formatDateTime(p.mergedAt)} · ${outLink(p.url, 'on GitHub')}${times}`, `<div class="well drill">${changed}${parts.join('')}</div>`, 'panel wide drill-panel', info)}`;
  }

  function byRule(): string {
    const { rules, typical } = rankRules(pulls, jobs, view.checkMs, isExpected);
    const title = 'Ran more than needed: what forced a full run';
    if (rules.length === 0) return wide('rule', 'by-rule', title, '', '<p class="well empty">Nothing forced a full run in this period.</p>');
    const body = rules
      .map((r, i) => {
        const saved = r.savedMs === null ? '<span class="faint">—</span>' : humanMs(r.savedMs);
        const last = formatDay(belgianDay(r.lastForced));
        const prompt = r.group === 'fix' ? promptBox(rulePrompt(r, adviceFor(r.job, r.rule))) : '';
        const head = i === 0 || rules[i - 1]!.group !== r.group ? `<tr class="tier"><th colspan="7" scope="rowgroup">${RULE_GROUP_LABELS[r.group]}</th></tr>` : '';
        return `${head}<tr${r.group === 'fix' ? '' : ' class="stopped"'}><td>${jobDot(r.job)}${JOB_NAMES[r.job]}</td><td class="first"><a href="${link({ group: 'rule', rule: `${r.job}:${r.rule}` })}">${esc(r.rule)}</a><div class="sub">${esc(adviceFor(r.job, r.rule))}</div></td><td class="num total">${saved}<div class="sub">${plural(r.everything.size, 'full run')}</div></td><td class="num">${number(r.pulls.size)}<div class="sub">of ${number(r.of)}</div></td><td class="num">${plural(r.paths.size, 'path')}</td><td>${r.group === 'stopped' ? `<span class="pill grey">stopped ${last}</span>` : last}</td><td class="prompt-col">${prompt}</td></tr>`;
      })
      .join('\n');
    const typicalLine = jobs.map((j) => `${JOB_NAMES[j]} ${typical[j] === null ? 'no selected run in this period' : humanMs(typical[j])}`).join(', ');
    return wide(
      'rule',
      'by-rule',
      title,
      `${plural(rules.length, 'rule')} · most time it could have saved first`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Job</th><th scope="col">Rule</th><th scope="col" class="num">Could have saved</th><th scope="col" class="num">Pull requests</th><th scope="col" class="num">Paths</th><th scope="col">Last forced</th><th scope="col"><span class="sr-only">Prompt</span></th></tr></thead>
<tbody>${body}</tbody></table></div>
<p class="legend-foot">Could have saved: each full run&rsquo;s time in its check, less a typical selected run of the same job (${typicalLine}).</p>
${COPY_SCRIPT}`,
    );
  }

  function ruleDrill(key: string): string {
    const back = `<a class="back" href="${link({ group: 'rule' })}">&larr; Every rule</a>`;
    const at = key.indexOf(':');
    const job = key.slice(0, at) as Job;
    const rule = key.slice(at + 1);
    const row = ruleRows(pulls, jobs).find((r) => r.job === job && r.rule === rule);
    const panel = (title: string, aside: string, content: string) => `${back}${section('rule', title, aside, content, 'panel wide drill-panel', explain('rule', 'this rule&rsquo;s paths', WHAT.rule))}`;
    if (!row) return panel(esc(rule), '', '<p class="well empty">This rule forced nothing in this period for the jobs chosen.</p>');
    const paths = [...row.paths.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const body = paths
      .map(([path, list]) => {
        const links = list.map((p) => `<a href="${link({ group: 'pr', pr: p.number })}" title="${esc(p.title)}">#${p.number}</a>`);
        const shown = links.slice(0, 8).join(' ');
        const more = links.length > 8 ? ` <details class="more"><summary>${links.length - 8} more</summary>${links.slice(8).join(' ')}</details>` : '';
        return `<tr><td class="first mono">${esc(path)}</td><td class="num total">${number(list.length)}</td><td class="prs">${shown}${more}</td></tr>`;
      })
      .join('\n');
    return panel(
      `${JOB_NAMES[job]}: ${esc(rule)}`,
      `${plural(row.pulls.size, 'pull request')} of ${number(row.of)} · ${plural(paths.length, 'path')}, worst first`,
      `<div class="well table"><p class="advice">${esc(adviceFor(job, rule))}</p><table>
<thead><tr><th scope="col">Path</th><th scope="col" class="num">Pull requests</th><th scope="col">Which</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
    );
  }

  /** The tests that failed on main after their pull request skipped them, newest first, each with a prompt that settles whether the selection missed it. */
  function byMiss(): string {
    const rows = missRows(pulls, jobs);
    const body = rows
      .map(
        (m) =>
          `<tr><td class="first"><span class="mono">${esc(m.path)}</span><div class="sub">${esc(m.level)} · ${JOB_NAMES[m.job]}</div></td><td><a href="${link({ group: 'pr', pr: m.pull.number })}">${prLabel(m.pull)}</a><div class="sub">${formatDateTime(m.pull.mergedAt)}${m.reason === 'docs only' ? ' · it changed only documents, so it ran no tests' : ''}</div></td><td class="prompt-col">${promptBox(missPrompt(m))}</td></tr>`,
      )
      .join('\n');
    return wide(
      'miss',
      'misses',
      'Tests that were skipped, then failed on main',
      `${plural(rows.length, 'test')} · newest first`,
      `<p class="view-lead">The pull request skipped these tests, and they failed on main once it merged. If the pull request broke the test, the selection missed that its files lead to this test: teach it that a change to those files runs it. If the test is flaky, the selection was right and the test needs fixing. The prompt has Claude find out which, and make the fix.</p>
${
  rows.length
    ? `<div class="well table"><table><thead><tr><th scope="col">Test</th><th scope="col">Skipped in</th><th scope="col"><span class="sr-only">Prompt</span></th></tr></thead><tbody>${body}</tbody></table></div>`
    : '<p class="well empty">None in this period: nothing failed on main that its pull request skipped.</p>'
}
${COPY_SCRIPT}`,
    );
  }

  const drilling = q.pr !== null || q.rule !== null;
  let detail: string;
  if (q.group === 'day') detail = `${questionTiles()}\n${whatEachJobDid()}\n${overTimeChart()}`;
  else if (q.group === 'pr') detail = pullDrill();
  else if (q.group === 'rule') detail = q.rule ? ruleDrill(q.rule) : byRule();
  else detail = byMiss();

  // The controls as one sentence on the band. A drill-down rides along as hidden fields until the rows change, which the address then drops. One pull request has no row of its own to offer, so its sentence names it in a choice left out of the list.
  const drill = [q.pr !== null ? `<input type="hidden" name="pr" value="${q.pr}">` : '', q.rule ? `<input type="hidden" name="rule" value="${esc(q.rule)}">` : ''].join('');
  const rows = ROWS.map((g): [string, string] => [g, ROW_WORDS[g]]);
  const form = sentenceForm(
    '/selection',
    `Show test selection for ${inline('group', 'Rows', q.pr !== null ? [['pr', 'one pull request', 'hidden'], ...rows] : rows, q.group)}
in ${inline('job', 'Job', JOB_CHOICES, q.job)}
over ${inline('period', 'Period', PERIOD_CHOICES, q.period)}`,
    [],
    [],
    drill,
  );
  // A drill-down reads its own rows, so it never waits on the period holding any other.
  const content = !drilling && pulls.length === 0 ? '<p class="well empty">Nothing in this period. No pull request merged in it.</p>' : detail;

  const length = PERIODS[q.period];
  const heldDays = view.oldest === null ? 0 : Math.round((Date.parse(belgianDay(now)) - Date.parse(belgianDay(view.oldest))) / 86_400_000) + 1;
  const partial = !drilling && length !== null && heldDays > 0 && heldDays < length ? `<p class="muted small">Only ${number(heldDays)} of the period&rsquo;s ${number(length)} days are stored so far.</p>` : '';

  // The page opens with the question its top tab names and the words a newcomer will not know, under the band, on every tab.
  const pageLead = lead(questionOf('selection'), LEAD_MORE);
  return reportPage({ current: 'selection', controls: form, body: `${pageLead}\n${partial}${content}\n${EXPLAIN_SCRIPT}`, style: EXTRA + COPY_STYLE + EXPLAIN_STYLE }, now);
}

const EXTRA = `
.mono{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:13px;font-weight:400}
.mono-sub{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12px;color:var(--ink-faint);word-break:break-word}
.first .mono{color:var(--ink-strong)}
td.first{min-width:260px}
.tile-note a{color:var(--accent-deep)}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.over{background:color-mix(in srgb,var(--over) 14%,transparent);color:var(--over-ink)}
.pill.good{background:color-mix(in srgb,var(--good) 14%,transparent);color:var(--good)}
.pill.plain{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent-deep)}
.pill.grey{background:color-mix(in srgb,var(--shade) 8%,transparent);color:var(--ink-soft)}
.over-ink{color:var(--over-ink)}
.job-block{display:flex;flex-direction:column;gap:10px}
.job-name{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--ink-strong);font-size:14px}
.job-name i,.job-dot,h3 i{display:inline-block;width:10px;height:10px;border-radius:3px;flex-shrink:0}
.job-dot{margin-right:8px;vertical-align:-1px}
.threshold{stroke:var(--ink-faint);stroke-dasharray:5 4;stroke-width:1.5}
.key i.bar-key{border-top-color:var(--ink-faint)}
.legend-foot{display:flex;flex-wrap:wrap;gap:4px 16px;margin:8px 10px 6px;font-size:13px;color:var(--ink-faint)}
.legend-foot i{display:inline-block;width:10px;height:10px;border-radius:3px}
.drill-panel .section-band h2{text-transform:none;letter-spacing:0;font-size:16px;color:var(--ink-strong)}
.back{font-size:14px;font-weight:500;margin-bottom:-8px}
.drill{padding:16px;display:flex;flex-direction:column;gap:18px}
.drill h3{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:15px;color:var(--ink-strong)}
.drill-job{display:flex;flex-direction:column;gap:8px;border-top:1px solid color-mix(in srgb,var(--shade) 10%,transparent);padding-top:14px}
.drill table.inner{min-width:640px}
.drill .warning{font-size:13px}
details summary{cursor:pointer;color:var(--accent-deep);font-size:14px;font-weight:500}
.files{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.files li{font-size:13px}
.advice{margin:0;padding:12px 16px;font-size:14px;color:var(--ink-soft);border-bottom:1px solid color-mix(in srgb,var(--shade) 10%,transparent)}
.prs a{margin-right:6px;font-weight:500}
tr.stopped td{opacity:.55}
.view-lead{margin:0 10px 12px;max-width:820px;font-size:14px;line-height:1.55;color:var(--ink)}
tr.tier th{text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);padding-top:18px}
.prompt-col{width:1%;white-space:nowrap;text-align:right}
details.more{display:inline}
details.more summary{display:inline;font-size:13px}
@media (max-width:640px){
  .tile-note{word-break:break-word}
}
`;
