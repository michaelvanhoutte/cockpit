import { formatDateTime } from './belgium';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, lead } from './explain';
import { esc, inline, questionOf, sentenceForm } from './look';
import { number } from './page';
import { VIOLET } from './palette';
import { reportPage, section, tile } from './report';
import {
  branchGaps,
  countOf,
  coverageOf,
  DEFAULT_QUERY,
  deepRules,
  filesCovered,
  GROUPS,
  isThin,
  LEVELS,
  levelName,
  ownRules,
  PACKAGES,
  pathOf,
  percent,
  pkgLabel,
  pkgOf,
  rowsUnder,
  ruleId,
  showRows,
  testsAddress,
  testsBehind,
  THIN,
  walk,
  keepOf,
  type Area,
  type Case,
  type Coverage,
  type FileStatements,
  type Line,
  type ListSpec,
  type Pane,
  type Ref,
  type Rule,
  type TestsQuery,
  type TestsView,
} from './tests-report';
import { LEAD_MORE, WHAT } from './tests-explain';
import type { PullRequestTests } from './tests-store';

/** The page opens with the question its top tab names and the words a newcomer will not know, under the band, whatever it shows. */
const PAGE_LEAD = lead(questionOf('tests'), LEAD_MORE);

/** A non-breaking space, which indents an Area option where a browser drops a plain one; built from its code so no editor can turn it back into a space. */
const NBSP = String.fromCharCode(160);

const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
/** A row's anchor, so a full load of a view lands on the row it was opened from: a space is a hyphen and any other character outside letters and digits its code in underscores, so no two keys share one. */
const anchor = (key: string) => `a-${key.replace(/[^A-Za-z0-9 ]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`).replace(/ /g, '-')}`;

const ROW_WORDS: Record<TestsQuery['group'], string> = { area: 'each concept area', gaps: 'each gap' };

/** What unknown coverage says, wherever a figure needs a run the snapshot had none of. */
const UNKNOWN_COVERAGE = 'Unknown, not none: the share covered comes from CI&rsquo;s coverage run on main, and this snapshot had none.';

/**
 * Whose tests the page shows, the sentence's first word: a select of `main`'s
 * and each open pull request with tests shown, newest first, that submits when
 * changed, or the plain word where there is no pull request to pick or ask for.
 * It keeps the view (the rows, the area and the filters) but not an open rule or
 * list, which belong to the tests picked away from. One asked for that it does
 * not list shows chosen but cannot be picked, so picking `main` is a change. A
 * pull request's title is its author's text, so it is escaped like everything
 * else a snapshot says.
 */
function whose(asked: TestsQuery, pulls: PullRequestTests[]): string {
  if (pulls.length === 0 && asked.pr === null) return 'main&rsquo;s';
  const options: [string, string, boolean?][] = [['', 'main’s'], ...pulls.map((p): [string, string] => [String(p.number), `#${p.number}${p.title ? ` · ${p.title}` : ''}`])];
  if (asked.pr !== null && !pulls.some((p) => p.number === asked.pr)) options.push([String(asked.pr), `#${asked.pr}`, true]);
  return inline('pr', 'Tests of', options, asked.pr === null ? '' : String(asked.pr));
}

/**
 * The page when the snapshot asked for is not shown: `main`'s before CI has sent
 * one, or a pull request with none. The sentence, and the one thing to read. The
 * view asked for rides along as hidden fields, since it has no filters to carry
 * it. An unlisted pull request does too, after its select: its option is
 * disabled, so the form never sends it, and new rows would otherwise fall back
 * to `main`; picking `main`'s sends an empty value first, which wins.
 */
function renderNothing({ asked, pulls }: TestsView, now: number): string {
  const kept = (['node', 'level', 'package', 'show', 'split'] as const)
    .filter((name) => asked[name] !== null && asked[name] !== DEFAULT_QUERY[name])
    .map((name) => `<input type="hidden" name="${name}" value="${esc(String(asked[name]))}">`);
  if (asked.pr !== null && !pulls.some((p) => p.number === asked.pr)) kept.push(`<input type="hidden" name="pr" value="${asked.pr}">`);
  const controls = sentenceForm('/tests', `Show ${whose(asked, pulls)} tests for ${inline('group', 'Rows', GROUPS.map((g): [string, string] => [g, ROW_WORDS[g]]), asked.group)}`, [], [], kept.join(''));
  const said =
    asked.pr === null
      ? 'No snapshot of main&rsquo;s tests has arrived yet. The page shows the latest one once CI has sent it after a merge to main.'
      : `Pull request #${asked.pr} has no snapshot of its tests here. One arrives when CI finishes on its latest push, and goes once it merges or closes.`;
  return reportPage({ current: 'tests', controls, body: `${PAGE_LEAD}\n${section('nothing', 'Test coverage', '', `<p class="well empty">${said}</p>`)}`, style: EXTRA + EXPLAIN_STYLE }, now);
}

/** The Test coverage page: the shown snapshot, `main`'s or a pull request's, as a tree of areas, counted by level or package with the share of each area's code its tests run, each name and count opening the tests behind it in a panel beside the table. */
export function renderTests(view: TestsView, now: number): string {
  if (!view.data) return renderNothing(view, now);
  const { model, index: ix, query: q } = view.data;
  const scope = q.node ? ix.byKey.get(q.node)! : null;
  const inScope = scope ? [...walk([scope])] : [...walk(model.tree)];
  const blob = model.commitUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]+$/.test(model.commitUrl) ? model.commitUrl.replace('/commit/', '/blob/') : null;
  const fileLink = (file: string, line: number | null, label = file) =>
    blob ? `<a href="${esc(`${blob}/${file.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);

  const keep = keepOf(q);
  const scopeRules = inScope.flatMap((a) => ownRules(a, keep));
  const qualifier = [q.level ? `${q.level} only` : '', q.package ? `${pkgLabel(q.package)} only` : ''].filter(Boolean).join(' · ');
  const link = (over: Partial<TestsQuery> = {}) => esc(testsAddress(q, over));
  /** The files of `areas` with their statements, or null where coverage is unknown: no run, or a tree older than the figures. */
  const measured = (areas: Area[], k = keep) => (model.coverageAvailable ? filesCovered(areas, k) : null);

  // ---- filters ----
  const areaOptions: [string, string][] = [['', 'All areas']];
  const addOptions = (areas: Area[], depth: number) => {
    for (const a of areas) {
      areaOptions.push([a.key, `${NBSP.repeat(3 * depth)}${a.label}`]);
      addOptions(a.children, depth + 1);
    }
  };
  addOptions(model.tree, 0);
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
  const onAreas = q.group === 'area';
  // The controls as one sentence on the band; a control is offered only where it changes what the tab draws (Gaps lists files, so no Level; Show and Count by act on the areas' table), and a choice the sentence has no room for rides along as a hidden field.
  const controls = sentenceForm(
    '/tests',
    `Show ${whose(q, view.pulls)} tests for ${inline('group', 'Rows', GROUPS.map((g): [string, string] => [g, ROW_WORDS[g]]), q.group)}
${onAreas ? `counted by ${inline('split', 'Count by', [['level', 'level'], ['package', 'package']], q.split)}` : ''}`,
    [
      inline('node', 'Area', areaOptions, q.node ?? '', ''),
      q.group === 'gaps' ? '' : inline('level', 'Level', [['', 'All levels'], ...LEVELS.map((l): [string, string] => [l.id, `${l.id} · ${l.name}`])], q.level ?? '', ''),
      inline('package', 'Package', [['', 'All packages'], ...PACKAGES.filter((p) => p.key !== 'other').map((p): [string, string] => [p.key, p.label])], q.package ?? '', ''),
      onAreas ? inline('show', 'Show', [['all', 'Every area'], ['files', `Areas under ${THIN}% covered`], ['empty', q.level ? `Areas with no ${q.level} rule` : 'Areas with no rule']], q.show, 'all') : '',
    ],
    [],
    [
      q.group === 'gaps' && q.level ? hidden('level', q.level) : '',
      !onAreas && q.show !== 'all' ? hidden('show', q.show) : '',
      !onAreas && q.split !== 'level' ? hidden('split', q.split) : '',
    ].join(''),
  );

  // ---- breadcrumb: the address's drill-down, kept on every tab ----
  const crumbs = [scope ? `<a href="${link({ node: null })}">All areas</a>` : '<span aria-current="page">All areas</span>'];
  if (scope) {
    const up: Area[] = [];
    for (let a = ix.parent.get(scope.key); a; a = ix.parent.get(a.key)) up.unshift(a);
    for (const u of up) crumbs.push(`<a href="${link({ node: u.key })}">${esc(u.label)}</a>`);
    crumbs.push(`<span aria-current="page">${esc(scope.label)}</span>`);
  }
  const crumbline = `<nav class="crumbs" aria-label="Area">${crumbs.join('<span class="sep">›</span>')}</nav>`;

  // ---- series: what a row's counts are split into ----
  interface Series {
    key: string;
    label: string;
    title: string;
    colour: string;
    /** Whether the series has a colour of its own: levels do, packages do not. */
    swatch: boolean;
  }
  const levelSeries: Series[] = LEVELS.filter((l) => q.level === null || l.id === q.level).map((l) => ({ key: l.id, label: l.id, title: l.name, colour: l.colour, swatch: true }));
  const pkgSeries = (rules: Rule[]): Series[] => {
    const seen = new Set(rules.map((r) => pkgOf(r.file)));
    return PACKAGES.filter((p) => seen.has(p.key)).map((p) => ({ key: p.key, label: p.label, title: p.label, colour: VIOLET, swatch: false }));
  };
  const swatch = (s: Series) => (s.swatch ? `<i style="background:${s.colour}"></i>` : '');
  const dash = '<span class="faint">0</span>';
  /** The tests a name or count opens: what it did not name stays as the page's filters have it. */
  const listOf = (over: Partial<ListSpec>): ListSpec => ({ node: over.node ?? q.node, level: over.level ?? q.level, package: over.package ?? q.package });
  const sameList = (a: ListSpec | null, b: ListSpec) => a !== null && a.node === b.node && a.level === b.level && a.package === b.package;
  /** Wraps a count so a click opens the tests behind it in the panel beside the table, landing on the row it was clicked in. */
  const toTests = (cell: string, n: number, over: Partial<ListSpec>, row: string, pane: Pane = 'rules') => {
    if (n <= 0) return cell;
    const list = listOf(over);
    const on = sameList(q.list, list) && q.pane === pane;
    return `<a class="count${on ? ' on' : ''}" href="${link({ list, pane })}#${anchor(row)}">${cell}</a>`;
  };
  /** A row's own figure, then everything inside it in brackets. */
  const pair = (ownN: number | null, subN: number | null, hasKids: boolean, bad = false) =>
    `${ownN === null ? '<span class="na">n/a</span>' : ownN === 0 ? dash : bad ? `<span class="bad">${number(ownN)}</span>` : number(ownN)}${hasKids && subN !== null ? ` <span class="subtotal">(${number(subN)})</span>` : ''}`;
  const unknown = '<span class="na">unknown</span>';
  /** A share of statements run, red under THIN, with a small meter; a dash where there is nothing to run. */
  const share = (c: Coverage | null) =>
    c === null ? '<span class="faint">—</span>' : `<span class="meter"><i style="width:${(c.rate * 100).toFixed(1)}%"></i></span><span${isThin(c) ? ' class="bad"' : ''}>${percent(c)}</span>`;

  const body = q.group === 'area' ? areaView() : gapsView();

  const commit = model.commitUrl && blob ? `<a href="${esc(model.commitUrl)}" target="_blank" rel="noopener noreferrer">${esc(model.commit)}</a>` : esc(model.commit);
  const generated = model.generatedAt !== null && !Number.isNaN(Date.parse(model.generatedAt)) ? `, ${formatDateTime(Date.parse(model.generatedAt))}` : '';
  const stamp = `<p class="stamp">${q.pr === null ? 'main&rsquo;s' : `#${q.pr}&rsquo;s`} tests at ${commit}${generated}.</p>`;
  return reportPage({ current: 'tests', controls, body: `${PAGE_LEAD}\n${stamp}\n${crumbline}\n${body}\n${EXPLAIN_SCRIPT}${q.group === 'area' ? PANE_SCRIPT : ''}`, style: EXTRA + EXPLAIN_STYLE }, now);

  // ---- Concept area: the tree under the chosen area, beside the panel ----
  function areaView(): string {
    const series = q.split === 'level' ? levelSeries : pkgSeries(scopeRules);
    const { shown, matched } = showRows(rowsUnder(model, scope), q, keep, ix);

    const heads = series.map((s) => `<th scope="col" class="num" title="${esc(s.title)}">${swatch(s)}${esc(s.label)}</th>`).join('');
    const rows = shown
      .map(({ area: a, depth }) => {
        const o = ownRules(a, keep);
        const d = deepRules(a, keep);
        const kids = a.children.length > 0;
        const selected = q.list !== null && q.list.node === a.key;
        const name = `<a href="${link({ list: listOf({ node: a.key }) })}#${anchor(a.key)}">${esc(a.label)}</a>`;
        const sub = kids ? `<div class="sub">${plural([...walk(a.children)].length, 'area')} inside</div>` : '';
        const cells = series
          .map((s) => {
            const deep = countOf(model, a, q.split, s.key, d, true);
            return `<td class="num">${toTests(pair(countOf(model, a, q.split, s.key, o, false), deep, kids), deep ?? 0, q.split === 'level' ? { node: a.key, level: s.key as ListSpec['level'] } : { node: a.key, package: s.key as ListSpec['package'] }, a.key)}</td>`;
          })
          .join('');
        const deepFiles = measured([...walk([a])]);
        const deepCover = coverageOf(deepFiles);
        const ownCover = coverageOf(measured([a]));
        const shareCell = deepFiles === null ? unknown : `${share(ownCover)}${kids && deepCover !== null ? ` <span class="subtotal">(${percent(deepCover)})</span>` : ''}`;
        const covered = deepCover !== null ? toTests(shareCell, 1, { node: a.key }, a.key, 'files') : shareCell;
        const branchOwn = branchGaps([a], keep);
        const branchDeep = branchGaps([...walk([a])], keep);
        const branches = !model.coverageAvailable
          ? unknown
          : branchOwn || branchDeep
            ? toTests(pair(branchOwn, branchDeep, kids, true), 1, { node: a.key }, a.key, 'branches')
            : pair(0, 0, kids);
        return `<tr id="${anchor(a.key)}" class="${matched.has(a.key) ? '' : 'context'}${selected ? ' selected' : ''}"><td class="first"><div class="tree" style="--depth:${depth}">${name}${sub}</div></td>${cells}<td class="num total">${toTests(pair(o.length, d.length, kids), d.length, { node: a.key }, a.key)}</td><td class="num cover">${covered}</td><td class="num">${branches}</td></tr>`;
      })
      .join('\n');
    const showNote = q.show === 'files' ? `areas under ${THIN}% covered` : q.show === 'empty' ? `areas with no ${q.level ? `${q.level} ` : ''}rule` : '';
    const areasTitle = shown.length ? (scope ? `${esc(scope.label)}, area by area` : 'Every area') : 'Areas';
    const areasInfo = explain('areas', areasTitle, WHAT.areas);
    const scopeFiles = measured(inScope);
    /** Areas under THIN asked for where coverage is unknown: an empty table is then unknown, not none. */
    const showUnknown = q.show === 'files' && scopeFiles === null;
    const table = shown.length
      ? section(
          'areas',
          areasTitle,
          `${plural(matched.size, 'area')}${showNote ? ` · ${showNote}, with what holds them faint` : ''} · a row holding others counts its own, then (everything inside it)`,
          `<div class="well table"><table>
<thead><tr><th scope="col">Area</th>${heads}<th scope="col" class="num">Rules</th><th scope="col" class="num" title="Share of the area&rsquo;s statements CI&rsquo;s coverage run executes">Covered</th><th scope="col" class="num wrap">Branches untaken</th></tr></thead>
<tbody>${rows}</tbody></table></div>`,
          'panel wide',
          areasInfo,
        )
      : section('areas', areasTitle, '', `<p class="well empty">${showUnknown ? UNKNOWN_COVERAGE : `No area here matches: there are no ${showNote}.`}</p>`, 'panel wide', areasInfo);

    // The tiles.
    const cases = scopeRules.reduce((n, r) => n + r.cases.length, 0);
    const todos = scopeRules.reduce((n, r) => n + r.todoCases.length, 0);
    const testFiles = new Set(scopeRules.map((r) => r.file)).size;
    const emptyAreas = inScope.filter((a) => deepRules(a, keep).length === 0);
    const where = scope ? `in ${esc(scope.label)}${scope.children.length ? ` and the ${plural([...walk(scope.children)].length, 'area')} inside it` : ''}` : 'in every area';
    const scopeCover = coverageOf(scopeFiles);
    const untouched = (scopeFiles ?? []).filter((f) => f.covered === 0).length;
    const coveredTile =
      scopeFiles === null
        ? tile('Covered', 'unknown', 'measured by CI&rsquo;s coverage run on main, which this snapshot had none of', '', explain('t-covered', 'Covered', WHAT.covered))
        : scopeCover === null
          ? tile('Covered', '—', 'no statements to run here', '', explain('t-covered', 'Covered', WHAT.covered))
          : tile('Covered', percent(scopeCover), `${number(scopeCover.covered)} of ${plural(scopeCover.total, 'statement')} run · ${plural(untouched, 'file')} nothing runs`, '', explain('t-covered', 'Covered', WHAT.covered));
    const tiles = `<div class="tiles">
${tile('Rules', number(scopeRules.length), `${where}${qualifier ? ` · ${qualifier}` : ''}`, '', explain('t-rules', 'Rules', WHAT.rules))}
${tile('Cases', number(cases), `in ${plural(testFiles, 'test file')}${todos ? ` · ${number(todos)} not written yet` : ''}`, '', explain('t-cases', 'Cases', WHAT.cases))}
${coveredTile}
${tile('Branches nothing takes', model.coverageAvailable ? number(branchGaps(inScope, keep)) : 'unknown', model.coverageAvailable ? 'branches no test takes, measured by CI&rsquo;s coverage run on main' : 'measured by CI&rsquo;s coverage run on main, which this snapshot had none of', '', explain('t-branches', 'Branches nothing takes', WHAT.branches))}
${tile('Areas with no rule', `${number(emptyAreas.length)} <small>of ${number(inScope.length)}</small>`, emptyAreas.length ? esc(emptyAreas.slice(0, 3).map((a) => a.label).join(', ')) + (emptyAreas.length > 3 ? '…' : '') : q.level ? `every area has a ${q.level} rule` : 'every area has a rule', '', explain('t-empty', 'Areas with no rule', WHAT.empty))}
</div>`;

    return `<div class="with-pane"><div class="main-col">${table}</div>${pane()}</div>
${tiles}`;
  }

  // ---- the panel beside the table: the tests, files and branches behind the opened list ----
  /** A case's or rule's place, which opens the source around it where it is read from: only when it is opened, so a panel lists any number of cases and reads none. */
  function code(ref: Ref): string {
    return `<details class="code" data-at="${esc(ruleId(ref))}"><summary>${fileLink(ref.file, ref.line, `${ref.file}:${ref.line}`)}</summary><div class="src"></div></details>`;
  }

  function pane(): string {
    const spec = q.list;
    const open = (inner: string, idle = false) => `<aside class="pane${idle ? ' pane-idle' : ''}" id="pane" aria-label="Tests behind the count"${q.pr === null ? '' : ` data-pr="${q.pr}"`}>${inner}</aside>`;
    if (!spec) return open('<div class="well empty">Pick an area, or any count, to see its rules and their cases here.</div>', true);
    const at = spec.node === null ? null : (ix.byKey.get(spec.node) ?? null);
    const areasIn = at ? [...walk([at])] : [...walk(model.tree)];
    const fileKeep = keepOf({ level: null, package: spec.package });
    const behind = testsBehind(model, ix, spec);
    const nRules = behind.reduce((t, x) => t + x.rules.length, 0);
    const nCases = behind.reduce((t, x) => t + x.rules.reduce((n, r) => n + r.cases.length, 0), 0);
    const files = measured(areasIn, fileKeep);
    const cover = coverageOf(files);
    const branchRows = [...branchesByFile(areasIn, fileKeep)].sort(([fa, a], [fb, b]) => b.count - a.count || (fa < fb ? -1 : 1));
    const what = [spec.level ? `${spec.level} · ${esc(levelName(spec.level))}` : '', spec.package ? esc(pkgLabel(spec.package)) : ''].filter(Boolean).join(' · ');
    const path = at ? pathOf(ix, at).join(' › ') : '';
    const summary = [plural(nRules, 'rule'), plural(nCases, 'case'), files === null ? 'coverage unknown' : cover ? `${percent(cover)} of ${plural(cover.total, 'statement')} run` : 'no statements to run'].join(' · ');

    const thin = (files ?? []).filter((f) => isThin(f)).sort((a, b) => a.covered / a.total - b.covered / b.total || (a.file < b.file ? -1 : 1));
    const label = at ? at.label : 'Cockpit';
    const prompt =
      thin.length || branchRows.length
        ? [
            ...(thin.length ? [`These files in the "${label}" feature area have under ${THIN}% of their statements run by any test:`, ...thin.map((f) => `- ${f.file} (${percent(f)})`)] : []),
            ...(branchRows.length ? [...(thin.length ? [''] : []), `These branches in the "${label}" feature area are never taken by a test:`, ...branchRows.map(([f, own]) => `- ${f}: lines ${[...new Set(own.lines)].sort((x, y) => x - y).join(', ')}`)] : []),
            '',
            "Use this repo's test strategy and guidance when defining tests, to figure out which tests may need to be added to ensure this is covered.",
          ].join('\n')
        : '';
    const copy = prompt
      ? `<textarea id="pane-prompt" hidden>${esc(prompt)}</textarea><button type="button" class="copy" onclick="navigator.clipboard.writeText(document.getElementById('pane-prompt').value).then(()=>{this.textContent='Copied'})">Copy prompt for missing tests</button>`
      : '';
    const tabLink = (p: Pane, text: string) => `<a href="${link({ list: spec, pane: p })}"${q.pane === p ? ' aria-current="page"' : ''}>${text}</a>`;
    const tabs = `<nav class="pane-tabs" aria-label="Panel">${tabLink('rules', `Rules (${number(nRules)})`)}${tabLink('files', `Files (${files === null ? 'unknown' : number(files.length)})`)}${tabLink('branches', `Branches (${model.coverageAvailable ? number(branchGaps(areasIn, fileKeep)) : 'unknown'})`)}</nav>`;
    const close = `<a class="close" href="${link()}" aria-label="Close the panel">&#10005;</a>`;
    const inner = q.pane === 'files' ? filesPane(files) : q.pane === 'branches' ? branchesPane(branchRows) : rulesPane(behind);

    return open(
      `<div class="pane-head">${close}${path ? `<div class="pane-path">${esc(path)}</div>` : ''}<div class="pane-title"><h2>${at ? esc(at.label) : 'Every area'}${what ? ` <span class="faint">· ${what}</span>` : ''}</h2>${explain('pane', 'the tests behind this count', WHAT.pane).both}</div><div class="pane-sum">${summary}</div>${copy ? `<div>${copy}</div>` : ''}</div>${tabs}<div class="pane-body">${inner}</div>`,
    );
  }

  function rulesPane(behind: { area: Area; rules: Rule[] }[]): string {
    if (!behind.length) return '<p class="empty">No rule here.</p>';
    const caseItem = (c: Case, todo: boolean) => `<li>${todo ? '<span class="todo">not written yet</span> ' : ''}<span class="case">${esc(c.text)}</span>${code(c)}</li>`;
    return behind
      .map(
        (x) =>
          `<div class="pane-group" data-area="${esc(x.area.key)}">${behind.length > 1 ? `<h3 class="pane-area">${esc(x.area.label)} <span class="faint">${plural(x.rules.length, 'rule')}</span></h3>` : ''}` +
          LEVELS.map((l) => ({ l, rules: x.rules.filter((r) => r.level === l.id) }))
            .filter((g) => g.rules.length)
            .map(
              (g) =>
                `<div class="pane-level"><i style="background:${g.l.colour}"></i>${g.l.id} · ${g.l.name} <span class="faint">${plural(g.rules.length, 'rule')}</span></div>` +
                g.rules.map((r) => `<div class="pane-rule"><div class="statement">${esc(r.statement)}</div>${code(r)}<ol class="pane-cases">${r.cases.map((c) => caseItem(c, false)).join('')}${r.todoCases.map((c) => caseItem(c, true)).join('')}</ol></div>`).join(''),
            )
            .join('') +
          '</div>',
      )
      .join('');
  }

  function filesPane(files: FileStatements[] | null): string {
    if (files === null) return `<p class="empty">${UNKNOWN_COVERAGE}</p>`;
    if (!files.length) return '<p class="empty">No source file with statements here.</p>';
    const sorted = [...files].sort((a, b) => a.covered / a.total - b.covered / b.total || (a.file < b.file ? -1 : 1));
    return `<ul class="pane-files">${sorted
      .map((f) => {
        const c = coverageOf([f])!;
        return `<li><span class="meter"><i style="width:${(c.rate * 100).toFixed(1)}%"></i></span><span class="pct${isThin(c) ? ' bad' : ''}">${percent(c)}</span><span class="path">${fileLink(f.file, null)}</span><span class="faint stmts">${f.covered === 0 ? 'nothing runs · ' : ''}${number(f.covered)}/${number(f.total)}</span></li>`;
      })
      .join('')}</ul>`;
  }

  function branchesPane(rows: [string, { lines: number[]; count: number; areas: Area[] }][]): string {
    if (!model.coverageAvailable) return '<p class="empty">Unknown, not zero: the branches no test takes come from CI&rsquo;s instrumented run on main, and this snapshot had none.</p>';
    if (!rows.length) return '<p class="empty">None: every branch here is taken by at least one test.</p>';
    return `<ul class="pane-files pane-branches">${rows
      .map(([file, own]) => `<li><span class="pct bad">${number(own.count)}</span><span class="path">${fileLink(file, null)}</span><span class="lines">lines ${[...new Set(own.lines)].sort((x, y) => x - y).map((n) => fileLink(file, n, `${n}`)).join(', ')}</span></li>`)
      .join('')}</ul>`;
  }

  // ---- Gaps: the files under THIN covered, most statements no test runs first, then the branches no test takes ----
  function gapsView(): string {
    const files = measured(inScope);
    const filesTitle = `Files to test next${scope ? ` in ${esc(scope.label)}` : ''}`;
    const filesInfo = explain('gap-files', filesTitle, WHAT.gapFiles);
    if (files === null) return `${section('gap-files', filesTitle, '', `<p class="well empty">${UNKNOWN_COVERAGE}</p>`, 'panel wide', filesInfo)}\n${branchesPanel()}`;
    const owners = new Map<string, Area[]>();
    for (const a of inScope) for (const s of a.statements ?? []) owners.set(s.file, [...(owners.get(s.file) ?? []), a]);
    const branches = new Map([...branchesByFile(inScope)].map(([f, own]) => [f, own.count]));
    const notRun = (f: FileStatements) => f.total - f.covered;
    const thin = files.filter((f) => isThin(f)).sort((a, b) => notRun(b) - notRun(a) || (a.file < b.file ? -1 : 1));
    const above = files.length - thin.length;
    const body = thin
      .map((f) => {
        const n = branches.get(f.file) ?? 0;
        return `<tr><td class="first path">${fileLink(f.file, null)}</td><td class="num"><strong>${number(notRun(f))}</strong> <span class="faint">of ${number(f.total)}</span></td><td class="num cover">${share(coverageOf([f]))}</td><td class="num">${n ? `<span class="bad">${number(n)}</span>` : dash}</td><td>${(owners.get(f.file) ?? []).map((a) => `<a href="${link({ group: 'area', node: a.key })}">${esc(a.label)}</a>`).join(', ')}</td></tr>`;
      })
      .join('\n');
    const label = scope ? scope.label : 'Cockpit';
    const prompt = thin.length
      ? [`Tests are missing for these files in the "${label}" feature area:`, ...thin.map((f) => `- ${f.file}`), '', "Use this repo's test strategy and guidance when defining tests, to figure out which tests may need to be added to ensure this is covered."].join('\n')
      : '';
    const copy = prompt
      ? ` · <textarea id="gap-prompt" hidden>${esc(prompt)}</textarea><button type="button" class="copy" onclick="navigator.clipboard.writeText(document.getElementById('gap-prompt').value).then(()=>{this.textContent='Copied'})">Copy prompt for missing tests</button>`
      : '';
    const table = section(
      'gap-files',
      filesTitle,
      `${plural(thin.length, 'file')} under ${THIN}% covered, most statements no test runs first · ${plural(above, 'file')} at or above it not listed${q.package ? ` · ${esc(pkgLabel(q.package))} only` : ''}${copy}`,
      thin.length
        ? `<div class="well table"><table>
<thead><tr><th scope="col">Source file</th><th scope="col" class="num wrap">Statements not run</th><th scope="col" class="num">Covered</th><th scope="col" class="num wrap">Branches untaken</th><th scope="col">Owned by</th></tr></thead>
<tbody>${body}</tbody></table></div>`
        : `<p class="well empty">None: every file here has at least ${THIN}% of its statements run by a test.</p>`,
      'panel wide',
      filesInfo,
    );
    return `${table}\n${branchesPanel()}`;
  }

  /** The branches no test takes across areas, per file: its lines, how many, and the areas owning it. A file owned by several areas is counted once, by the most any one holds (as `branchGaps` does). */
  function branchesByFile(areas: Area[], k = keep): Map<string, { lines: number[]; count: number; areas: Area[] }> {
    const byFile = new Map<string, { lines: number[]; count: number; areas: Area[] }>();
    for (const a of areas) {
      const here = new Map<string, number[]>();
      for (const b of a.branchesNothingTakes ?? []) if (k.file(b)) here.set(b.file, [...(here.get(b.file) ?? []), b.line]);
      for (const [file, ls] of here) {
        const own = byFile.get(file) ?? { lines: [], count: 0, areas: [] };
        own.lines.push(...ls);
        own.count = Math.max(own.count, ls.length);
        own.areas.push(a);
        byFile.set(file, own);
      }
    }
    return byFile;
  }

  /** The branches no test takes, a row per file with its lines; unknown, not none, when the snapshot had no coverage. */
  function branchesPanel(): string {
    const info = (title: string) => explain('gap-branches', title, WHAT.gapBranches);
    if (!model.coverageAvailable) {
      return section('gap-branches', 'Branches nothing takes', '', '<p class="well empty">Unknown, not zero: the branches no test takes come from CI&rsquo;s instrumented run on main, and this snapshot had none.</p>', 'panel wide', info('Branches nothing takes'));
    }
    const byFile = branchesByFile(inScope);
    if (!byFile.size) return section('gap-branches', 'Branches nothing takes', '', `<p class="well empty">None: every branch ${scope ? `${esc(scope.label)} owns` : 'here'} is taken by at least one test.</p>`, 'panel wide', info('Branches nothing takes'));
    const body = [...byFile]
      .sort(([fa, a], [fb, b]) => b.count - a.count || (fa < fb ? -1 : 1))
      .map(
        ([file, own]) =>
          `<tr><td class="first path">${fileLink(file, null)}</td><td class="num">${number(own.count)}</td><td class="path">${[...new Set(own.lines)].sort((x, y) => x - y).map((n) => fileLink(file, n, `${n}`)).join(', ')}</td><td>${own.areas.map((a) => `<a href="${link({ group: 'area', node: a.key })}">${esc(a.label)}</a>`).join(', ')}</td></tr>`,
      )
      .join('\n');
    const title = `Branches nothing takes${scope ? ` in ${esc(scope.label)}` : ''}`;
    return section(
      'gap-branches',
      title,
      `${plural(branchGaps(inScope, keep), 'branch', 'branches')} in ${plural(byFile.size, 'file')}`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Source file</th><th scope="col" class="num">Branches</th><th scope="col">Lines</th><th scope="col">Owned by</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
      'panel wide',
      info(title),
    );
  }
}

/**
 * The fragment a case shows under its place when it is opened: the lines around
 * it with its own marked, or that they were not stored (a tree older than the
 * lines, or an area that holds none).
 */
export function renderSource(at: string, lines: Line[] | null): string {
  if (!lines?.length) return '<p class="path">The source around this case was not stored.</p>';
  const line = Number(at.slice(at.lastIndexOf(':') + 1));
  return `<pre>${lines.map((l) => `<span class="${l.line === line ? 'hit' : ''}"><b>${l.line}</b>${esc(l.text)}</span>`).join('')}</pre>`;
}

/**
 * A click that opens the panel fetches the view and swaps only the panel and
 * the table's marks, so the page stays where it is and only the panel starts at
 * its top; the address is pushed, and Back swaps the previous panel in. Without
 * script, or where the fetch fails, the link loads the whole page. A case's
 * source is fetched when its place is first opened. Where the panel is stacked
 * above the table (the media query below, as the style's), each swap scrolls its
 * top into view, under the pinned band.
 */
const PANE_SCRIPT = `<script>
(function(){
  var wrap = document.querySelector('.with-pane');
  if (!wrap || !window.fetch || !window.DOMParser) return;
  var latest = 0;
  function reveal(pane){
    if (!matchMedia('(max-width:1300px)').matches || pane.classList.contains('pane-idle')) return;
    var band = document.querySelector('.band-controls');
    scrollTo(0, Math.max(0, pane.getBoundingClientRect().top + scrollY - (band ? band.offsetHeight : 0) - 8));
  }
  function opens(a){ return a.matches('a.count, .tree a, .pane-tabs a, .pane .close'); }
  function swap(url, push){
    var mine = ++latest;
    return fetch(url, { headers: { accept: 'text/html' } }).then(function(r){ return r.text(); }).then(function(html){
      if (mine !== latest) return;
      var next = new DOMParser().parseFromString(html, 'text/html');
      var pane = next.querySelector('.with-pane .pane');
      var old = wrap.querySelector('.pane');
      if (!pane || !old) { location.href = url; return; }
      old.replaceWith(pane);
      if (window.explainBind) window.explainBind(pane);
      reveal(pane);
      var on = {};
      next.querySelectorAll('.main-col a.count.on').forEach(function(a){ on[a.getAttribute('href')] = true; });
      wrap.querySelectorAll('.main-col a.count').forEach(function(a){ a.classList.toggle('on', !!on[a.getAttribute('href')]); });
      wrap.querySelectorAll('.main-col tr[id]').forEach(function(tr){ var n = next.getElementById(tr.id); tr.classList.toggle('selected', !!(n && n.classList.contains('selected'))); });
      if (push) history.pushState({ pane: true }, '', url);
    });
  }
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a');
    if (!a || !wrap.contains(a) || !opens(a) || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    var url = a.getAttribute('href').split('#')[0];
    swap(url, true).catch(function(){ location.href = url; });
  });
  window.addEventListener('popstate', function(){ swap(location.pathname + location.search, false).catch(function(){ location.reload(); }); });
  document.addEventListener('toggle', function(e){
    var d = e.target;
    if (!d.matches || !d.matches('details.code[data-at]') || !d.open || d.dataset.loaded) return;
    d.dataset.loaded = '1';
    var box = d.querySelector('.src'), group = d.closest('[data-area]'), pane = d.closest('.pane');
    box.textContent = 'Loading the source...';
    fetch('/tests/source?area=' + encodeURIComponent(group.dataset.area) + '&at=' + encodeURIComponent(d.dataset.at) + (pane.dataset.pr ? '&pr=' + pane.dataset.pr : ''))
      .then(function(r){ if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function(html){ box.innerHTML = html; })
      .catch(function(){ delete d.dataset.loaded; box.textContent = 'The source could not be loaded. Close this and open it again.'; });
  }, true);
})();
</script>`;

const EXTRA = `
main{max-width:1800px}
.stamp{margin:0;font-size:13px;color:var(--ink-faint)}.stamp a{color:inherit}
a.count{color:inherit;text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 30%,transparent);text-underline-offset:3px}a.count:hover{color:var(--accent-deep)}
a.count.on{outline:2px solid var(--accent-deep);outline-offset:2px;border-radius:3px}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:15px;font-weight:500;color:var(--ink-strong)}
.crumbs a{color:var(--accent-deep)}.crumbs .sep{color:var(--ink-faint)}
.tile-value small{font-size:15px;font-weight:500;color:var(--ink-faint)}
.tree{padding-left:calc(var(--depth) * 22px);position:relative}
.tree a{color:inherit;text-decoration:none}.tree a:hover{color:var(--accent-deep)}
.tree::before{content:'';position:absolute;left:calc(var(--depth) * 22px - 13px);top:-11px;height:24px;width:9px;border-left:1px solid color-mix(in srgb,var(--shade) 20%,transparent);border-bottom:1px solid color-mix(in srgb,var(--shade) 20%,transparent)}
.tree[style*="--depth:0"]::before{display:none}
tr.context td{opacity:.55}
tr.selected td{background:var(--accent-tint)}
tr.selected .tree a{font-weight:600}
tr[id]{scroll-margin-top:120px}
.subtotal{color:var(--ink-faint);font-weight:400}
.na{display:inline-block;padding:0 6px;border-radius:var(--radius-sm);font-size:12px;color:var(--ink-faint);background:color-mix(in srgb,var(--shade) 6%,transparent)}
.bad{color:var(--over-ink);font-weight:600}
td.num a{text-decoration:none}
td.cover{white-space:nowrap}
th.wrap{white-space:normal;width:80px}
.meter{display:inline-block;width:36px;height:6px;margin-right:6px;vertical-align:1px;border-radius:3px;background:color-mix(in srgb,var(--shade) 12%,transparent);overflow:hidden}
.meter i{display:block;height:100%;background:${VIOLET}}
.path{font-size:13px;color:var(--ink-faint);word-break:break-all}.path a{color:var(--ink-soft)}
td.path{max-width:360px}
.todo{display:inline-block;padding:0 6px;border-radius:var(--radius-sm);font-size:12px;background:var(--due-soft);color:var(--due-ink)}
.case{color:var(--ink-strong)}
details.code summary{cursor:pointer;font-size:12px;color:var(--ink-faint);list-style-position:inside}
details.code pre{margin:6px 0 0;padding:8px 0;overflow-x:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--field);border:1px solid color-mix(in srgb,var(--shade) 10%,transparent);border-radius:var(--radius-sm)}
details.code pre span{display:block;padding:0 10px;white-space:pre}details.code pre b{display:inline-block;width:42px;color:var(--ink-faint);font-weight:400}
details.code pre .hit{background:var(--accent-tint)}
details.code .src{margin-top:6px;font-size:12px;color:var(--ink-faint)}
.copy{height:30px;padding:0 12px;border:0;border-radius:var(--radius-md);background:var(--surface);box-shadow:var(--shadow-panel);font:inherit;font-size:13px;font-weight:500;color:var(--ink-strong);cursor:pointer}
.copy:hover{background:var(--field)}
.with-pane{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,26%);gap:20px;align-items:start}
.main-col{min-width:0;display:flex;flex-direction:column;gap:20px}
.with-pane .table table{min-width:0}
.with-pane th,.with-pane td{padding-left:6px;padding-right:6px}
.with-pane th:first-child,.with-pane td:first-child{padding-left:14px}
.with-pane th{letter-spacing:.03em;font-size:10.5px}
.with-pane td.num{font-size:13px}
.with-pane .first{min-width:150px}
.with-pane .meter{width:22px;margin-right:4px}
/* Pinned below the band, which is pinned too and about 110px tall, so the head is never under it. */
.pane{position:sticky;top:124px;max-height:calc(100vh - 136px);display:flex;flex-direction:column;background:var(--well);box-shadow:var(--well-edge);border:1px solid color-mix(in srgb,var(--shade) 10%,transparent);border-radius:var(--radius-sm);overflow:hidden}
.pane > .well.empty{padding:24px 18px;box-shadow:none;border:0}
.pane-head{position:relative;padding:14px 44px 12px 16px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid color-mix(in srgb,var(--shade) 10%,transparent)}
.pane-title{display:flex;align-items:center}
.pane-head h2{margin:0;font-size:18px;font-weight:600;color:var(--ink-strong)}
.pane-path{font-size:12px;color:var(--ink-faint)}.pane-sum{font-size:13px;color:var(--ink-soft)}
.pane .close{position:absolute;top:10px;right:12px;padding:4px 8px;color:var(--ink-faint);text-decoration:none;font-size:15px}.pane .close:hover{color:var(--ink-strong)}
.pane-tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid color-mix(in srgb,var(--shade) 10%,transparent)}
.pane-tabs a{padding:6px 10px;font-size:13px;font-weight:500;color:var(--ink-soft);text-decoration:none;border-bottom:2px solid transparent}
.pane-tabs a[aria-current]{color:var(--accent-deep);border-bottom-color:var(--accent-deep)}
.pane-body{overflow-y:auto;padding:4px 16px 16px}
.pane-body .empty{padding:16px 0;color:var(--ink-faint);font-size:14px}
.pane-area{margin:18px 0 4px;font-size:14px;font-weight:600;color:var(--ink-strong)}
.pane-level{margin:14px 0 6px;font-size:12px;font-weight:600;color:var(--accent-deep)}.pane-level i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
.pane-rule{padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--shade) 8%,transparent)}
.pane-rule .statement{font-weight:600;color:var(--ink-strong);font-size:14px}
.pane-rule > details.code{margin-top:2px}
.pane-cases{margin:6px 0 0;padding-left:22px;display:flex;flex-direction:column;gap:6px;font-size:13px}
.pane-files{list-style:none;margin:0;padding:6px 0}
.pane-files li{display:grid;grid-template-columns:auto 44px 1fr;gap:2px 8px;align-items:baseline;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--shade) 8%,transparent)}
.pane-files .pct{font-variant-numeric:tabular-nums;text-align:right;font-size:13px}
.pane-files .stmts{grid-column:3;font-size:12px}
.pane-branches li{grid-template-columns:36px minmax(0,1fr)}
.pane-branches .lines{grid-column:2;font-size:12px;color:var(--ink-faint);word-break:normal;overflow-wrap:normal}.pane-branches .lines a{color:var(--ink-soft);white-space:nowrap}
@media (max-width:1300px){.with-pane{grid-template-columns:minmax(0,1fr)}.pane{position:static;max-height:none;order:-1}.pane-idle{display:none}}
`;
