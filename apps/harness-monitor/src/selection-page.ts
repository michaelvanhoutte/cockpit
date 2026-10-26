import { belgianDay, formatDateTime, formatDay } from './belgium';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, lead } from './explain';
import { esc, inline, lineKey, questionOf, sentenceForm } from './look';
import { number, REPOSITORY } from './page';
import { GREY, ORANGE, RED, VIOLET } from './palette';
import { humanMs, outLink, pct, reportPage, section, tile } from './report';
import {
  barsOf,
  dayOf,
  dayRange,
  GROUPS,
  groupByStart,
  JOB_CHOICES,
  JOB_NAMES,
  jobOf,
  jobsOf,
  leadingRuleOf,
  matchesOutcome,
  median,
  missesOf,
  OUTCOME_CHOICES,
  OUTCOME_LABELS,
  OUTCOMES,
  outcomeOf,
  overBar,
  packageRows,
  parseSelectionQuery,
  PERIOD_CHOICES,
  PERIODS,
  percent,
  plural,
  rankRules,
  RULE_GROUP_LABELS,
  ruleRows,
  rulePrompt,
  selectionAddress,
  shareOf,
  TEST_ROWS,
  tileClass,
  UNIT,
  verdictOf,
  whyText,
  type Group,
  type Job,
  type Outcome,
  type SelectedFile,
  type SelectionQuery,
  type Verdict,
} from './selection-report';
import { LEAD_MORE, TABLES, WHAT } from './selection-explain';
import type { SelectionView, ViewJob, ViewPull } from './selection-view';

const ROW_WORDS: Record<Group, string> = { day: 'each day', pr: 'each pull request', rule: 'each rule that forced a full run', package: 'each package', test: 'each test, most selected first', miss: 'each miss' };

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

/** A tile's label with its verdict after it, so the (i) follows both. Each verdict word is its own element, with no space inside one, so the label wraps between them and the (i) binds to the last; the dot keeps to the word after it. */
const withVerdict = (label: string, verdict: Verdict) =>
  verdict === 'unread' ? label : `${label} ${(verdict === 'crossed' ? '·&nbsp;over the bar' : '·&nbsp;within').split(' ').map((w) => `<em>${w}</em>`).join(' ')}`;

const mono = (s: string) => `<span class="mono">${esc(s)}</span>`;
const prLabel = (p: { number: number; title: string }) => `<span class="pr-no">#${p.number}</span> ${esc(p.title)}`;
const jobDot = (job: Job) => `<i class="job-dot" style="background:${JOB_COLOURS[job]}"></i>`;

/** One selected file and the chain that reached it, as the pull request's selection and an opened cycle time line both list it. */
const fileItem = (f: Pick<SelectedFile, 'path' | 'status' | 'text'>) =>
  `<li><span class="mono${f.status === 'failed' ? ' over-ink' : ''}">${esc(f.path)}${f.status === 'failed' ? ' (failed)' : ''}</span><div class="sub">${esc(whyText(f.text, f.path))}</div></li>`;

const OWN_ADDRESS = parseSelectionQuery(new URLSearchParams());

/** Copies the prompt a button sits beside, which is in the page and never shown, and says so for a moment. */
const COPY_SCRIPT = `<script>document.addEventListener('click',function(e){var b=e.target.closest('.copy-prompt');if(!b)return;var pre=b.parentNode.querySelector('pre');var say=function(t){b.textContent=t;setTimeout(function(){b.textContent='Copy prompt'},1500)};var fail=function(){say('Could not copy')};try{navigator.clipboard.writeText(pre.textContent).then(function(){say('Copied')},fail)}catch(x){fail()}});</script>`;

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
const CAUGHT = 'No pull request in this period matches the filters.';

/** The test selection page: the same pull requests whatever the tab, narrowed by the filters, with the tiles and overview panels only on the first. */
export function renderSelection(q: SelectionQuery, view: SelectionView, repository: string | undefined, now: number): string {
  const repo = repository !== undefined && REPOSITORY.test(repository) ? repository : null;
  const jobs = jobsOf(q.job);
  const bars = barsOf(view.bars);
  const pulls = view.pulls;
  const read = pulls.length >= bars.minPulls;
  const over: Record<Job, boolean> = { test: overBar(pulls, 'test', bars), e2e: overBar(pulls, 'e2e', bars) };
  const link = (to: Partial<SelectionQuery>) => esc(selectionAddress(q, to));
  /** The ran-everything bar of the jobs shown: one figure where they share it, each job's own where they differ. */
  const sharedBar = new Set(jobs.map((j) => bars.forcedFull[j])).size === 1;
  const forcedBarText = sharedBar ? percent(bars.forcedFull[jobs[0]!]) : jobs.map((j) => `${JOB_NAMES[j]} ${percent(bars.forcedFull[j])}`).join(', ');
  /** A tab's table, with the (i) that says what its rows are. */
  const wide = (id: string, title: string, aside: string, content: string) => section(id, title, aside, content, 'panel wide', explain(id, title, TABLES[q.group]));

  /** The bars, as tiles, read on the period's own pull requests. */
  function tiles(): string {
    const alarm = (n: number | null, verdict: string) => (n !== null && verdict === 'crossed' && repo ? [outLink(`https://github.com/${repo}/issues/${n}`, `Alarm issue #${n}`)] : []);
    const unread = read ? [] : [`unread: ${plural(pulls.length, 'pull request')}, a bar needs ${bars.minPulls}`];
    const out: string[] = [];
    for (const job of jobs) {
      const views = pulls.map((p) => jobOf(p, job)).filter((v) => v.status === 'ran');
      const full = views.filter((v) => v.ranEverything);
      const value = views.length ? full.length / views.length : null;
      const verdict = verdictOf(read, value, bars.forcedFull[job]);
      const lead = leadingRuleOf(full);
      out.push(
        tile(
          withVerdict(`${JOB_NAMES[job]} ran everything`, verdict),
          value === null ? 'none' : pct(value),
          [
            `${number(full.length)} of ${plural(views.length, 'pull request')} that ran it · bar ${percent(bars.forcedFull[job])}`,
            ...(lead ? [`Mostly <a href="${link({ group: 'rule', rule: `${job}:${lead.rule}` })}">${esc(lead.rule)}</a>, ${number(lead.count)} of them`] : []),
            ...unread,
            ...alarm(bars.alarm[`${job}-forced-full`], verdict),
          ],
          tileClass(verdict),
          explain(`t-${job}-full`, `${JOB_NAMES[job]} ran everything`, WHAT.ranEverything),
        ),
      );
    }
    const misses = pulls.reduce((a, p) => a + missesOf(p, jobs), 0);
    const missVerdict = verdictOf(read, pulls.length ? misses : null, bars.misses);
    out.push(
      tile(
        withVerdict('Misses', missVerdict),
        number(misses),
        [`a test that failed on main after its pull request skipped it · ${bars.misses <= 1 ? 'any miss' : `${number(bars.misses)} or more`} crosses`, ...(misses ? [`<a href="${link({ group: 'miss' })}">See which</a>`] : []), ...unread, ...alarm(bars.alarm.misses, missVerdict)],
        tileClass(missVerdict),
        explain('t-misses', 'Misses', WHAT.misses),
      ),
    );
    const top = view.worst;
    const topVerdict = verdictOf(read, top ? shareOf(top) : null, bars.mostShare);
    out.push(
      tile(
        withVerdict('Most selected test', topVerdict),
        top ? pct(shareOf(top)) : 'none',
        top
          ? [
              `<a href="${link({ group: 'test', test: top.path })}">${esc(top.path.split('/').pop() ?? top.path)}</a>, ${number(top.selected)} of ${number(top.selecting)} that could skip it`,
              `bar ${percent(bars.mostShare)}, over at least ${bars.mostMinOver}`,
              ...unread,
              ...alarm(bars.alarm['most-selected'], topVerdict),
            ]
          : [`no test had ${bars.mostMinOver} pull requests that could skip it`],
        tileClass(topVerdict),
        explain('t-most', 'Most selected test', WHAT.mostSelected),
      ),
    );
    return `<div class="tiles">${out.join('\n')}</div>`;
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

  /** The typical pull request: medians over the ones that used selection at all. */
  function typical(): string {
    const items: string[] = [];
    for (const job of jobs) {
      const views = pulls.map((p) => jobOf(p, job));
      const selecting = views.filter((v) => v.status === 'ran' && v.selecting);
      const m = median(selecting.map((v) => v.filesRun ?? 0));
      const total = median(views.filter((v) => v.status === 'ran' && v.filesTotal !== null).map((v) => v.filesTotal!));
      items.push(
        `<li><span class="name">${JOB_NAMES[job]}: ${UNIT[job][1]} run</span><span class="delta">${m === null ? 'none' : number(m)}</span><span class="from">${total !== null ? `of ${number(total)} · ` : ''}median over the ${plural(selecting.length, 'pull request')} that selected</span></li>`,
      );
    }
    if (jobs.includes('test')) {
      const ran = pulls.filter((p) => jobOf(p, 'test').status === 'ran');
      const pr = median(ran.map((p) => jobOf(p, 'test').prDurationMs).filter((n): n is number => n !== null));
      const main = median(ran.map((p) => jobOf(p, 'test').mainDurationMs).filter((n): n is number => n !== null));
      items.push(`<li><span class="name">Test job time</span><span class="delta">${humanMs(pr)}</span><span class="from">main&rsquo;s own run of the merge: ${humanMs(main)} · medians</span></li>`);
    }
    const docs = pulls.filter((p) => jobs.every((j) => jobOf(p, j).status === 'docs-only')).length;
    items.push(`<li><span class="name">Documentation only</span><span class="delta">${number(docs)}</span><span class="from">of ${plural(pulls.length, 'pull request')}, skipped both jobs</span></li>`);
    return section('typical-pull-request', 'A typical pull request', '', `<ul class="well changes">${items.join('')}</ul>`, 'panel narrow', explain('typical-pull-request', 'A typical pull request', WHAT.typical));
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

  const outcomeLegend = (anyOver: boolean) =>
    `<p class="legend-foot">${(['selected', 'full', 'docs'] as Outcome[]).map((o) => `<span class="key"><i style="background:${OUTCOME_COLOURS[o]}"></i>${OUTCOME_LABELS[o]}</span>`).join('')}${anyOver ? '<span class="key"><i style="background:var(--over)"></i>Ran everything, in a job over the bar for the period</span>' : ''}</p>`;

  /** A job's outcomes for a set of pull requests, as a split bar and "n of m ran everything". */
  function outcomeCell(views: ViewJob[], isOver: boolean): string {
    const ran = views.filter((v) => v.status === 'ran');
    if (ran.length === 0) return '<td class="split-cell"><span class="faint">—</span></td>';
    const counts = OUTCOMES.map((o) => [o, views.filter((v) => outcomeOf(v) === o).length] as const).filter(([, n]) => n > 0);
    const full = ran.filter((v) => v.ranEverything).length;
    return `<td class="split-cell"><div class="split">${counts.map(([o, n]) => `<div style="width:${((n / views.length) * 100).toFixed(1)}%;background:${outcomeColour(o, isOver)}" title="${OUTCOME_LABELS[o]} ${n}"></div>`).join('')}</div><div class="sub">ran everything on ${number(full)} of ${number(ran.length)}</div></td>`;
  }

  function byDay(): string {
    const rows = [...days]
      .reverse()
      .map((d) => {
        const list = pullsOn.get(d) ?? [];
        if (list.length === 0) {
          return `<tr><td class="first">${formatDay(d)}</td><td class="num faint-num">0</td>${jobs.map(() => '<td class="split-cell"><span class="faint">—</span></td>').join('')}<td class="num faint-num">—</td>${jobs.map(() => '<td class="num faint-num">—</td>').join('')}</tr>`;
        }
        const misses = list.reduce((a, p) => a + missesOf(p, jobs), 0);
        const medians = jobs.map((j) => median(list.map((p) => jobOf(p, j)).filter((v) => v.status === 'ran' && v.selecting).map((v) => v.filesRun ?? 0)));
        return `<tr><td class="first">${formatDay(d)}</td><td class="num"><a href="${link({ group: 'pr' })}">${number(list.length)}</a></td>${jobs.map((j) => outcomeCell(list.map((p) => jobOf(p, j)), over[j])).join('')}<td class="num${misses ? ' total over-ink' : ' faint-num'}">${misses ? number(misses) : '0'}</td>${medians.map((m) => `<td class="num">${m === null ? '<span class="faint">—</span>' : number(m)}</td>`).join('')}</tr>`;
      })
      .join('\n');
    return wide(
      'by-day',
      'By day',
      `${plural(days.length, 'day')} · newest first`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Day</th><th scope="col" class="num">Merged</th>${jobs.map((j) => `<th scope="col"><i style="background:${JOB_COLOURS[j]}"></i>${JOB_NAMES[j]}</th>`).join('')}<th scope="col" class="num">Misses</th>${jobs.map((j) => `<th scope="col" class="num">Typical ${UNIT[j][1]} run</th>`).join('')}</tr></thead>
<tbody>${rows}</tbody></table></div>${outcomeLegend(jobs.some((j) => over[j]))}`,
    );
  }

  /** One job's cell in the pull request table. */
  function jobCell(v: ViewJob, job: Job): string {
    const o = outcomeOf(v);
    if (o === 'docs') return '<td><span class="faint">Skipped: docs only</span></td>';
    if (o === 'none') return '<td><span class="faint">No record</span></td>';
    const reason = v.reasons[0];
    const first = o === 'full' ? `<span class="pill ${over[job] ? 'over' : 'plain'}">Ran everything</span> ${number(v.filesRun ?? 0)}` : `<span class="pill plain">Selected</span> ${number(v.filesRun ?? 0)} of ${number(v.filesTotal ?? 0)}`;
    const sub =
      o === 'full' && reason ? `<div class="sub">${esc(reason.rule)}${reason.path ? `: ${mono(reason.path)}` : ''}${v.reasons.length > 1 ? ` and ${v.reasons.length - 1} more` : ''}</div>` : `<div class="sub">${UNIT[job][1]}</div>`;
    return `<td>${first}${sub}</td>`;
  }

  function byPull(): string {
    const list = pulls.filter((p) => matchesOutcome(p, jobs, q.outcome));
    if (list.length === 0) return wide('by-pull-request', 'By pull request', '', `<p class="well empty">${CAUGHT}</p>`);
    const rows = list
      .map((p) => {
        const misses = missesOf(p, jobs);
        return `<tr><td class="first"><a href="${link({ group: 'pr', pr: p.number })}">${prLabel(p)}</a><div class="sub">${formatDateTime(p.mergedAt)} · ${outLink(p.url, 'on GitHub')}</div></td>${jobs.map((j) => jobCell(jobOf(p, j), j)).join('')}<td class="num">${misses ? `<span class="pill over">${plural(misses, 'miss', 'misses')}</span>` : '<span class="faint">—</span>'}</td>${jobs.includes('test') ? `<td class="num">${humanMs(jobOf(p, 'test').prDurationMs)}</td>` : ''}</tr>`;
      })
      .join('\n');
    return wide(
      'by-pull-request',
      'By pull request',
      `${plural(list.length, 'pull request')} · newest first · open one for what it ran and why`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Pull request</th>${jobs.map((j) => `<th scope="col"><i style="background:${JOB_COLOURS[j]}"></i>${JOB_NAMES[j]}</th>`).join('')}<th scope="col" class="num">Misses</th>${jobs.includes('test') ? '<th scope="col" class="num">Test job time</th>' : ''}</tr></thead>
<tbody>${rows}</tbody></table></div>`,
    );
  }

  /** One pull request in full: what changed, each package's mode and reason, what ran and why. */
  function pullDrill(): string {
    const back = `<a class="back" href="${link({ group: 'pr' })}">&larr; Every pull request</a>`;
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
    if (rules.length === 0) return wide('by-rule', title, '', '<p class="well empty">Nothing forced a full run in this period.</p>');
    const body = rules
      .map((r, i) => {
        const saved = r.savedMs === null ? '<span class="faint">—</span>' : humanMs(r.savedMs);
        const last = formatDay(belgianDay(r.lastForced));
        const prompt = r.group === 'fix' ? `<div class="prompt-cell"><button type="button" class="copy-prompt">Copy prompt</button><pre hidden>${esc(rulePrompt(r, adviceFor(r.job, r.rule)))}</pre></div>` : '';
        const head = i === 0 || rules[i - 1]!.group !== r.group ? `<tr class="tier"><th colspan="7" scope="rowgroup">${RULE_GROUP_LABELS[r.group]}</th></tr>` : '';
        return `${head}<tr${r.group === 'fix' ? '' : ' class="stopped"'}><td>${jobDot(r.job)}${JOB_NAMES[r.job]}</td><td class="first"><a href="${link({ group: 'rule', rule: `${r.job}:${r.rule}` })}">${esc(r.rule)}</a><div class="sub">${esc(adviceFor(r.job, r.rule))}</div></td><td class="num total">${saved}<div class="sub">${plural(r.everything.size, 'full run')}</div></td><td class="num">${number(r.pulls.size)}<div class="sub">of ${number(r.of)}</div></td><td class="num">${plural(r.paths.size, 'path')}</td><td>${r.group === 'stopped' ? `<span class="pill grey">stopped ${last}</span>` : last}</td><td class="prompt-col">${prompt}</td></tr>`;
      })
      .join('\n');
    const typicalLine = jobs.map((j) => `${JOB_NAMES[j]} ${typical[j] === null ? 'no selected run in this period' : humanMs(typical[j])}`).join(', ');
    return wide(
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

  function byPackage(): string {
    const rows = packageRows(view.packages);
    if (rows.length === 0) return wide('by-package', 'By package', '', '<p class="well empty">No job ran in this period.</p>');
    const body = rows
      .map((r) => {
        const lead = [...r.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
        const m = median(r.runs);
        const share = r.changed ? r.touched / r.changed : 0;
        return `<tr><td class="first">${jobDot(r.job)}${esc(r.name)}</td><td class="num faint-num">${r.files === null ? '<span class="faint">—</span>' : number(r.files)}</td><td class="split-cell"><div class="split"><div style="width:${(share * 100).toFixed(1)}%;background:${VIOLET}"></div></div><div class="sub">ran something on ${number(r.touched)} of ${number(r.changed)} that selected · ${percent(share)}</div></td><td class="num">${m === null ? '<span class="faint">—</span>' : number(m)}</td><td class="num">${number(r.full)}</td><td>${lead ? `<a href="${link({ group: 'rule', rule: `${r.job}:${lead[0]}` })}">${esc(lead[0])}</a><div class="sub">${number(lead[1])} of its full runs</div>` : '<span class="faint">—</span>'}</td></tr>`;
      })
      .join('\n');
    return wide(
      'by-package',
      'By package',
      'most often touched first',
      `<div class="well table"><table>
<thead><tr><th scope="col">Package</th><th scope="col" class="num">Files</th><th scope="col">When selecting</th><th scope="col" class="num">Typical run</th><th scope="col" class="num">Ran in full</th><th scope="col">Mostly because</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
    );
  }

  const crossed = (t: { selected: number; selecting: number }) => read && t.selecting >= bars.mostMinOver && shareOf(t) + 1e-9 >= bars.mostShare;

  function byTest(): string {
    const all = view.tally.filter((t) => t.selected > 0);
    if (all.length === 0) return wide('most-selected-tests', 'Most selected tests', '', '<p class="well empty">No test was selected in this period.</p>');
    const body = all
      .slice(0, TEST_ROWS)
      .map((t) => {
        const share = shareOf(t);
        const hot = crossed(t);
        return `<tr${hot ? ' class="crossed"' : ''}><td class="first"><a class="mono" href="${link({ group: 'test', test: t.path })}">${esc(t.path)}</a><div class="sub mono-sub">${esc(whyText(t.chain, t.path))}</div></td><td>${esc(t.level)}</td><td class="split-cell"><div class="split"><div style="width:${(share * 100).toFixed(1)}%;background:${hot ? RED : VIOLET}"></div></div><div class="sub">${number(t.selected)} of ${number(t.selecting)} that could skip it · ${pct(share)}</div></td><td class="num">${number(t.fullRun)}</td><td>${hot ? '<span class="pill over">over the bar</span>' : t.selecting < bars.mostMinOver ? '<span class="faint">too few to read</span>' : ''}</td></tr>`;
      })
      .join('\n');
    return wide(
      'most-selected-tests',
      'Most selected tests',
      `${plural(view.tallyCount, 'file')} selected at least once · the ${Math.min(TEST_ROWS, view.tallyCount)} most selected`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Test, and the chain that most often selected it</th><th scope="col">Level</th><th scope="col">Selected</th><th scope="col" class="num">Full runs</th><th scope="col">Bar ${percent(bars.mostShare)}</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
    );
  }

  function testDrill(path: string): string {
    const back = `<a class="back" href="${link({ group: 'test' })}">&larr; Every test</a>`;
    const drill = view.testDrill;
    const panel = (aside: string, content: string) => `${back}${section('test', mono(path), aside, content, 'panel wide drill-panel', explain('test', 'the pull requests that selected this test', WHAT.test))}`;
    if (!drill || drill.rows.length === 0) return panel('', '<p class="well empty">No pull request in this period ran this test.</p>');
    const selected = drill.rows.filter((r) => r.kind !== 'full');
    const full = drill.rows.length - selected.length;
    // What its packages could have skipped it on, less the pull requests that did select it.
    const skipped = drill.selecting.reduce((n, s) => n + Math.max(0, s.pulls - selected.filter((r) => r.job === s.job && r.package === s.package).length), 0);
    const body = selected
      .map(({ pull, status, text }) => `<tr><td class="first"><a href="${link({ group: 'pr', pr: pull.number })}">${prLabel(pull)}</a><div class="sub">${formatDateTime(Date.parse(pull.mergedAt))}</div></td><td>${esc(status)}</td><td class="mono-sub">${esc(whyText(text, path))}</td></tr>`)
      .join('\n');
    return panel(
      `selected on ${number(selected.length)} · skipped on ${number(skipped)} · ran in full on ${number(full)}`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Pull request that selected it</th><th scope="col">Result</th><th scope="col">Why</th></tr></thead>
<tbody>${body || '<tr><td colspan="3" class="faint">Never selected in this period; it ran only in full runs.</td></tr>'}</tbody></table></div>`,
    );
  }

  function byMiss(): string {
    const rows = pulls.flatMap((p) => jobs.flatMap((job) => jobOf(p, job).misses.map((m) => ({ p, m, job }))));
    if (rows.length === 0) return wide('misses', 'Misses', '', '<p class="well empty">No misses in this period: nothing failed on main that its pull request skipped.</p>');
    const body = rows
      .map(
        ({ p, m, job }) =>
          `<tr><td class="first"><a href="${link({ group: 'pr', pr: p.number })}">${prLabel(p)}</a><div class="sub">${formatDateTime(p.mergedAt)}</div></td><td class="mono">${esc(m.path)}</td><td>${esc(m.level)}</td><td>${jobDot(job)}${JOB_NAMES[job]}</td><td>${m.reason === 'docs only' ? '<span class="pill grey">docs only</span>' : 'not run'}</td></tr>`,
      )
      .join('\n');
    return wide(
      'misses',
      'Misses',
      `${plural(rows.length, 'miss', 'misses')} · newest first`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Pull request</th><th scope="col">Test or spec that failed on main</th><th scope="col">Level</th><th scope="col">Job</th><th scope="col">Why it did not run</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
    );
  }

  const drilling = q.pr !== null || q.rule !== null || q.test !== null;
  let detail: string;
  if (q.group === 'day') detail = `${tiles()}\n<div class="row">${whatEachJobDid()}${typical()}</div>\n${overTimeChart()}\n${byDay()}`;
  else if (q.group === 'pr') detail = q.pr !== null ? pullDrill() : byPull();
  else if (q.group === 'rule') detail = q.rule ? ruleDrill(q.rule) : byRule();
  else if (q.group === 'package') detail = byPackage();
  else if (q.group === 'test') detail = q.test ? testDrill(q.test) : byTest();
  else detail = byMiss();

  // The controls as one sentence on the band. A drill-down rides along as hidden fields until the rows change, which the address then drops.
  const drill = [q.pr !== null ? `<input type="hidden" name="pr" value="${q.pr}">` : '', q.rule ? `<input type="hidden" name="rule" value="${esc(q.rule)}">` : '', q.test ? `<input type="hidden" name="test" value="${esc(q.test)}">` : ''].join('');
  const form = sentenceForm(
    '/selection',
    `Show test selection for ${inline('group', 'Rows', GROUPS.map((g): [string, string] => [g, ROW_WORDS[g]]), q.group)}
in ${inline('job', 'Job', JOB_CHOICES, q.job)}
over ${inline('period', 'Period', PERIOD_CHOICES, q.period)}`,
    [q.group === 'pr' && q.pr === null ? inline('outcome', 'Pull requests', OUTCOME_CHOICES, q.outcome ?? '', '') : ''],
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
  return reportPage({ current: 'selection', controls: form, body: `${pageLead}\n${partial}${content}\n${EXPLAIN_SCRIPT}`, style: EXTRA + EXPLAIN_STYLE }, now);
}

const EXTRA = `
.mono{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:13px;font-weight:400}
.mono-sub{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12px;color:var(--ink-faint);word-break:break-word}
.first .mono{color:var(--ink-strong)}
td.first{min-width:260px}
.tile-note a{color:var(--accent-deep)}
.tile-label em{font-style:normal}
.tile.up .tile-label em{color:var(--over-ink)}
.tile.down .tile-label em{color:var(--good)}
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
tr.crossed td:first-child{box-shadow:inset 3px 0 0 var(--over)}
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
tr.tier th{text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);padding-top:18px}
.prompt-col{width:1%;white-space:nowrap;text-align:right}
.copy-prompt{font:inherit;font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--line,#444);background:transparent;color:var(--accent-deep);cursor:pointer}
details.more{display:inline}
details.more summary{display:inline;font-size:13px}
@media (max-width:640px){
  .tile-note{word-break:break-word}
}
`;
