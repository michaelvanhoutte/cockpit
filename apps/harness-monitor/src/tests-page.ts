import { formatDateTime } from './belgium';
import { esc, selectField } from './look';
import { number } from './page';
import { bandTabs, reportPage, section, tile } from './report';
import {
  branchGaps,
  countOf,
  DEFAULT_QUERY,
  deepRules,
  distinctFiles,
  GROUP_LABELS,
  GROUPS,
  LEVELS,
  levelName,
  ownFiles,
  ownRules,
  PACKAGES,
  pathOf,
  pkgLabel,
  pkgOf,
  rowsUnder,
  ruleId,
  showRows,
  testsAddress,
  testsBehind,
  walk,
  keepOf,
  type Area,
  type Case,
  type ListSpec,
  type Ref,
  type Rule,
  type TestsQuery,
  type TestsView,
} from './tests-report';
import type { PullRequestTests } from './tests-store';

/** The one colour a bar takes when its parts are packages, which are not told apart by colour. */
const PLAIN = 'var(--cat-slate)';

const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

/**
 * Which snapshot the page shows, as a select of `main` and each open pull
 * request with tests shown, newest first, that submits when changed. It keeps
 * the view (the tab, the area and the filters) but not an open rule or list,
 * which belong to the tests picked away from. Drawn only where there is a
 * pull request to pick, or one asked for. A pull request's title is its
 * author's text, so it is escaped like everything else a snapshot says.
 */
function picker(asked: TestsQuery, pulls: PullRequestTests[]): string {
  const options: [string, string][] = [['', 'main'], ...pulls.map((p): [string, string] => [String(p.number), `#${p.number}${p.title ? ` · ${p.title}` : ''}`])];
  const current = asked.pr === null ? '' : String(asked.pr);
  const hidden = (['group', 'node', 'level', 'package', 'show', 'split'] as const)
    .filter((name) => asked[name] !== null && asked[name] !== DEFAULT_QUERY[name])
    .map((name) => `<input type="hidden" name="${name}" value="${esc(String(asked[name]))}">`)
    .join('');
  return `<label for="pr">Tests of</label> <select id="pr" name="pr" onchange="this.form.submit()">${options
    .map(([value, text]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text)}</option>`)
    .join('')}</select>${hidden}<noscript> <button type="submit">Show</button></noscript>`;
}

/** The page when the snapshot asked for is not shown: `main`'s before CI has sent one, or a pull request with none. The frame, the picker where there is one, and the one thing to read. */
function renderNothing({ asked, pulls }: TestsView, now: number): string {
  const tabs = bandTabs(GROUPS.map((g): [string, string, boolean] => [testsAddress(DEFAULT_QUERY, { group: g, pr: asked.pr }), GROUP_LABELS[g], g === 'area']));
  const pick = pulls.length > 0 || asked.pr !== null ? `<form class="stamp" method="get" action="/tests">${picker(asked, pulls)}</form>\n` : '';
  const said =
    asked.pr === null
      ? 'No snapshot of main&rsquo;s tests has arrived yet. The page shows the latest one once CI has sent it after a merge to main.'
      : `Pull request #${asked.pr} has no snapshot of its tests here. One arrives when CI finishes on its latest push, and goes once it merges or closes.`;
  return reportPage({ current: 'tests', tabs, body: `${pick}${section('nothing', 'Tests', '', `<p class="well empty">${said}</p>`)}`, style: EXTRA }, now);
}

/** The Tests page: the shown snapshot, `main`'s or a pull request's, as a tree of areas, counted by level or package, each count opening the tests behind it. */
export function renderTests(view: TestsView, now: number): string {
  if (!view.data) return renderNothing(view, now);
  const { model, index: ix, query: q, lines } = view.data;
  const scope = q.node ? ix.byKey.get(q.node)! : null;
  const inScope = scope ? [...walk([scope])] : [...walk(model.tree)];
  const blob = model.commitUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]+$/.test(model.commitUrl) ? model.commitUrl.replace('/commit/', '/blob/') : null;
  const fileLink = (file: string, line: number | null, label = file) =>
    blob ? `<a href="${esc(`${blob}/${file.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);

  const keep = keepOf(q);
  const deepFiles = (areas: Area[]) => distinctFiles(areas, keep);
  const scopeRules = inScope.flatMap((a) => ownRules(a, keep));
  const scopeFiles = deepFiles(inScope);
  const qualifier = [q.level ? `${q.level} only` : '', q.package ? `${pkgLabel(q.package)} only` : ''].filter(Boolean).join(' · ');
  const link = (over: Partial<TestsQuery> = {}) => esc(testsAddress(q, over));

  // ---- filters ----
  const areaOptions: [string, string][] = [['', 'All areas']];
  const addOptions = (areas: Area[], depth: number) => {
    for (const a of areas) {
      areaOptions.push([a.key, `${'   '.repeat(depth)}${a.label}`]);
      addOptions(a.children, depth + 1);
    }
  };
  addOptions(model.tree, 0);
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
  const onAreas = q.group === 'area';
  const toggles = (['level', 'package'] as const)
    .map((v) => `<button type="submit" name="split" value="${v}" aria-pressed="${v === q.split}">${v === 'level' ? 'Level' : 'Package'}</button>`)
    .join('');
  const filters = `<form class="filters" method="get" action="/tests">
${q.pr !== null ? hidden('pr', String(q.pr)) : ''}
${q.group !== 'area' ? hidden('group', q.group) : ''}
${selectField('node', 'Area', areaOptions, q.node ?? '')}
${q.group === 'gaps' ? (q.level ? hidden('level', q.level) : '') : selectField('level', 'Level', [['', 'Every level'], ...LEVELS.map((l): [string, string] => [l.id, `${l.id} · ${l.name}`])], q.level ?? '')}
${selectField('package', 'Package', [['', 'Every package'], ...PACKAGES.filter((p) => p.key !== 'other').map((p): [string, string] => [p.key, p.label])], q.package ?? '')}
${onAreas ? selectField('show', 'Show', [['all', 'Every area'], ['files', 'Areas with files nothing runs'], ['empty', q.level ? `Areas with no ${q.level} rule` : 'Areas with no rule']], q.show, 'all') : q.show !== 'all' ? hidden('show', q.show) : ''}
${onAreas && !q.rule ? `<div class="field"><span id="splitby">Count by</span><div class="toggles" role="group" aria-labelledby="splitby">${toggles}</div></div>${hidden('split', q.split)}` : q.split !== 'level' ? hidden('split', q.split) : ''}
<noscript><button type="submit">Apply</button></noscript>
</form>`;

  // ---- breadcrumb: the address's drill-down, kept on every tab ----
  const crumbs = [scope ? `<a href="${link({ node: null })}">All areas</a>` : '<span aria-current="page">All areas</span>'];
  if (scope) {
    const up: Area[] = [];
    for (let a = ix.parent.get(scope.key); a; a = ix.parent.get(a.key)) up.unshift(a);
    for (const u of up) crumbs.push(`<a href="${link({ node: u.key })}">${esc(u.label)}</a>`);
    crumbs.push(q.rule ? `<a href="${link()}">${esc(scope.label)}</a>` : `<span aria-current="page">${esc(scope.label)}</span>`);
  }
  if (q.rule) crumbs.push('<span aria-current="page">Rule</span>');
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
    return PACKAGES.filter((p) => seen.has(p.key)).map((p) => ({ key: p.key, label: p.label, title: p.label, colour: PLAIN, swatch: false }));
  };
  const swatch = (s: Series) => (s.swatch ? `<i style="background:${s.colour}"></i>` : '');
  /** A row's bar: one segment per level, or one plain segment for its total when the parts are packages. */
  const barOf = (series: Series[], counts: number[], max: number) => {
    if (series.length && !series[0]!.swatch) {
      const total = counts.reduce((a, b) => a + b, 0);
      return total ? `<div style="width:${((total / max) * 100).toFixed(1)}%;background:${PLAIN}"></div>` : '';
    }
    return series.map((s, i) => (counts[i] ? `<div style="width:${((counts[i]! / max) * 100).toFixed(1)}%;background:${s.colour}" title="${esc(s.label)} ${counts[i]}"></div>` : '')).join('');
  };
  const dash = '<span class="faint">0</span>';
  /** Wraps a count so a click opens the tests behind it above the tab; what the count did not name stays as the page's filters have it. */
  const toTests = (cell: string, n: number, over: Partial<ListSpec>) => {
    if (n <= 0) return cell;
    const list: ListSpec = { node: over.node ?? q.node, level: over.level ?? q.level, package: over.package ?? q.package };
    return `<a class="count" href="${link({ list })}#tests">${cell}</a>`;
  };
  /** A row's own figure, then everything inside it in brackets. */
  const pair = (ownN: number | null, subN: number | null, hasKids: boolean, bad = false) =>
    `${ownN === null ? '<span class="na">n/a</span>' : ownN === 0 ? dash : bad ? `<span class="bad">${number(ownN)}</span>` : number(ownN)}${hasKids && subN !== null ? ` <span class="subtotal">(${number(subN)})</span>` : ''}`;

  let body: string;
  if (q.rule) body = ruleDetail(ix.rules.get(q.rule)!.rule, ix.rules.get(q.rule)!.area);
  else if (q.group === 'area') body = `${q.list ? testsList(q.list) : ''}${areaView()}`;
  else if (q.group === 'level') body = `${q.list ? testsList(q.list) : ''}${levelView()}`;
  else if (q.group === 'package') body = `${q.list ? testsList(q.list) : ''}${packageView()}`;
  else body = gapsView();

  const commit = model.commitUrl && blob ? `<a href="${esc(model.commitUrl)}" target="_blank" rel="noopener noreferrer">${esc(model.commit)}</a>` : esc(model.commit);
  const generated = model.generatedAt !== null && !Number.isNaN(Date.parse(model.generatedAt)) ? `, ${formatDateTime(Date.parse(model.generatedAt))}` : '';
  const tabs = bandTabs(GROUPS.map((g): [string, string, boolean] => [link({ group: g }), GROUP_LABELS[g], g === q.group]));
  const after = ` at ${commit}${generated}. The explorer reads the test files and never runs them.`;
  const stamp =
    view.pulls.length > 0 || q.pr !== null
      ? `<form class="stamp" method="get" action="/tests">${picker(q, view.pulls)}<span>${after.trimStart()}</span></form>`
      : `<p class="stamp"><strong>main&rsquo;s tests</strong>${after}</p>`;
  return reportPage({ current: 'tests', tabs, body: `${stamp}\n${filters}\n${crumbline}\n${body}`, style: EXTRA }, now);

  // ---- Concept area: the tree under the chosen area, then that area's own rules ----
  function areaView(): string {
    const series = q.split === 'level' ? levelSeries : pkgSeries(scopeRules);
    const seriesOf = (r: Rule) => (q.split === 'level' ? r.level : pkgOf(r.file));
    const { shown, matched } = showRows(rowsUnder(model, scope), q, keep, ix);
    const max = Math.max(...shown.map((r) => deepRules(r.area, keep).length), 1);

    const heads = series.map((s) => `<th scope="col" class="num" title="${esc(s.title)}">${swatch(s)}${esc(s.label)}</th>`).join('');
    const rows = shown
      .map(({ area: a, depth }) => {
        const o = ownRules(a, keep);
        const d = deepRules(a, keep);
        const kids = a.children.length > 0;
        const bar = barOf(series, series.map((s) => d.filter((r) => seriesOf(r) === s.key).length), max);
        const name = a.key === q.node ? `<strong>${esc(a.label)}</strong>` : `<a href="${link({ node: a.key })}">${esc(a.label)}</a>`;
        const sub = kids ? `<div class="sub">${plural([...walk(a.children)].length, 'area')} inside</div>` : '';
        const cells = series
          .map((s) => {
            const deep = countOf(model, a, q.split, s.key, d, true);
            return `<td class="num">${toTests(pair(countOf(model, a, q.split, s.key, o, false), deep, kids), deep ?? 0, q.split === 'level' ? { node: a.key, level: s.key as ListSpec['level'] } : { node: a.key, package: s.key as ListSpec['package'] })}</td>`;
          })
          .join('');
        const filesOwn = ownFiles(a, keep).length;
        const filesDeep = deepFiles([...walk([a])]).size;
        const files = filesOwn || filesDeep ? `<a href="${link({ group: 'gaps', node: a.key })}">${pair(filesOwn, filesDeep, kids, true)}</a>` : pair(0, 0, kids);
        const branchOwn = branchGaps([a], keep);
        const branchDeep = branchGaps([...walk([a])], keep);
        const branches = !model.coverageAvailable
          ? '<span class="na">unknown</span>'
          : branchOwn || branchDeep
            ? `<a href="${link({ group: 'gaps', node: a.key })}">${pair(branchOwn, branchDeep, kids, true)}</a>`
            : pair(0, 0, kids);
        return `<tr class="${matched.has(a.key) ? '' : 'context'}"><td class="first"><div class="tree" style="--depth:${depth}">${name}${sub}</div></td><td class="split-cell"><div class="split">${bar}</div></td>${cells}<td class="num total">${toTests(pair(o.length, d.length, kids), d.length, { node: a.key })}</td><td class="num">${files}</td><td class="num">${branches}</td></tr>`;
      })
      .join('\n');
    const showNote = q.show === 'files' ? 'areas with files nothing runs' : q.show === 'empty' ? `areas with no ${q.level ? `${q.level} ` : ''}rule` : '';
    const table = shown.length
      ? section(
          'areas',
          scope ? `${esc(scope.label)}, area by area` : 'Every area',
          `${plural(matched.size, 'area')}${showNote ? ` · ${showNote}, with what holds them faint` : ''} · a row holding others counts its own, then (everything inside it)`,
          `<div class="well table"><table>
<thead><tr><th scope="col">Area</th><th scope="col">Rules by ${q.split}</th>${heads}<th scope="col" class="num">Rules</th><th scope="col" class="num">Files nothing runs</th><th scope="col" class="num">Branches nothing takes</th></tr></thead>
<tbody>${rows}</tbody></table></div>`,
          'panel wide',
        )
      : section('areas', 'Areas', '', `<p class="well empty">No area here matches: there are no ${showNote}.</p>`, 'panel wide');

    // The tiles.
    const cases = scopeRules.reduce((n, r) => n + r.cases.length, 0);
    const todos = scopeRules.reduce((n, r) => n + r.todoCases.length, 0);
    const testFiles = new Set(scopeRules.map((r) => r.file)).size;
    const emptyAreas = inScope.filter((a) => deepRules(a, keep).length === 0);
    const where = scope ? `in ${esc(scope.label)}${scope.children.length ? ` and the ${plural([...walk(scope.children)].length, 'area')} inside it` : ''}` : 'in every area';
    const tiles = `<div class="tiles">
${tile('Rules', number(scopeRules.length), `${where}${qualifier ? ` · ${qualifier}` : ''}`)}
${tile('Cases', number(cases), `in ${plural(testFiles, 'test file')}${todos ? ` · ${number(todos)} not written yet` : ''}`)}
${tile('Files nothing runs', number(scopeFiles.size), 'source files no test imports, at any level')}
${tile('Branches nothing takes', model.coverageAvailable ? number(branchGaps(inScope, keep)) : 'unknown', model.coverageAvailable ? 'branches no test takes, measured by CI&rsquo;s coverage run on main' : 'measured by CI&rsquo;s coverage run on main, which this snapshot had none of')}
${tile('Areas with no rule', `${number(emptyAreas.length)} <small>of ${number(inScope.length)}</small>`, emptyAreas.length ? esc(emptyAreas.slice(0, 3).map((a) => a.label).join(', ')) + (emptyAreas.length > 3 ? '…' : '') : q.level ? `every area has a ${q.level} rule` : 'every area has a rule')}
</div>`;

    // Where the rules are, and the areas with most untested files.
    const totals = series.map((s) => ({ ...s, n: scopeRules.filter((r) => seriesOf(r) === s.key).length }));
    const shares = totals.filter((t) => t.n > 0);
    const wherePanel = section(
      'where',
      `Where the ${plural(scopeRules.length, 'rule')} are`,
      `by ${q.split}`,
      `<div class="well where">
${shares.length && q.split === 'level' ? `<div class="bar" role="img" aria-label="${esc(shares.map((t) => `${t.label} ${t.n}`).join(', '))}">${shares.map((t) => `<div style="flex:${t.n};background:${t.colour}" title="${esc(t.label)} ${t.n}"></div>`).join('')}</div>` : ''}
<ul class="shares">${totals.map((t) => `<li>${swatch(t)}<span class="name">${esc(t.label)}${t.title !== t.label ? ` <span class="faint">${esc(t.title)}</span>` : ''}</span><span class="amount">${t.n ? number(t.n) : dash}</span></li>`).join('')}</ul>
<p class="note">A rule is one inner <code>describe</code>; its cases are the <code>it</code>s inside it. The level is read from the folder the test file sits in. Counts, never percentages: a count only says where to look next to another row&rsquo;s, and more rules is not better tested.</p>
</div>`,
      'panel wide',
    );
    const worst = inScope
      .map((a) => ({ a, n: ownFiles(a, keep).length }))
      .filter((x) => x.n > 0)
      .sort((x, y) => y.n - x.n)
      .slice(0, 5);
    const worstPanel = section(
      'worst',
      'Most files nothing runs',
      '',
      `<ul class="well changes">${
        worst.length
          ? worst.map((x) => `<li><a class="name" href="${link({ group: 'gaps', node: x.a.key })}">${esc(x.a.label)}</a><span class="delta up">${number(x.n)}</span><span class="from">${esc([...pathOf(ix, x.a)].join(' › ') || 'top level')}</span></li>`).join('')
          : '<li class="faint">None: every source file here is imported by a test.</li>'
      }</ul>`,
      'panel narrow',
    );

    return `${table}
${scope ? ownRulesPanel(scope) : ''}
${tiles}
<div class="row">${wherePanel}${worstPanel}</div>`;
  }

  // ---- the tests behind a clicked count: every rule in scope the count names, area by area ----
  function testsList(spec: ListSpec): string {
    const areas = testsBehind(model, ix, spec);
    const at = spec.node === null ? null : (ix.byKey.get(spec.node) ?? null);
    const n = areas.reduce((t, x) => t + x.rules.length, 0);
    const what = [spec.level ? `${spec.level} · ${esc(levelName(spec.level))}` : '', spec.package ? esc(pkgLabel(spec.package)) : ''].filter(Boolean).join(' · ');
    const title = `${plural(n, 'rule')}${at ? ` in ${esc(at.label)}${at.children.length ? ' and inside it' : ''}` : ''}${what ? ` · ${what}` : ''}`;
    const rows = areas
      .map(
        (x) =>
          `<tr class="group"><th colspan="4" scope="colgroup">${esc([...pathOf(ix, x.area), x.area.label].join(' › '))} <span class="faint">${plural(x.rules.length, 'rule')}</span></th></tr>` +
          x.rules
            .map((r) => `<tr><td class="first"><a href="${link({ rule: ruleId(r) })}">${esc(r.statement)}</a></td><td>${esc(r.level)}</td><td class="num">${plural(r.cases.length, 'case')}</td><td class="path">${fileLink(r.file, r.line, `${r.file}:${r.line}`)}</td></tr>`)
            .join(''),
      )
      .join('\n');
    return section(
      'tests',
      `Tests: ${title}`,
      `<a href="${link()}">Close</a>`,
      `<div class="well table"><table class="rules">
<thead><tr><th scope="col">Rule</th><th scope="col">Level</th><th scope="col" class="num">Cases</th><th scope="col">Where</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" class="empty">No test here.</td></tr>'}</tbody></table></div>`,
      'panel wide',
    );
  }

  // The chosen area's own rules, grouped by level: each one drills to its cases.
  function ownRulesPanel(a: Area): string {
    const list = ownRules(a, keep);
    const aside = `${a.children.length ? 'the areas inside it list their own · ' : ''}${qualifier || 'every level'}`;
    if (!list.length) {
      return section('own-rules', `Rules on ${esc(a.label)} itself`, aside, `<p class="well empty">No rule names ${esc(a.label)} as its area${qualifier ? ` at ${esc(qualifier.replace(/ only/g, ''))}` : ''}.</p>`, 'panel wide');
    }
    const rows = LEVELS.map((l) => ({ l, rules: list.filter((r) => r.level === l.id) }))
      .filter((g) => g.rules.length)
      .map(
        (g) =>
          `<tr class="group"><th colspan="3" scope="colgroup"><i style="background:${g.l.colour}"></i>${g.l.id} · ${g.l.name} <span class="faint">${plural(g.rules.length, 'rule')}</span></th></tr>` +
          g.rules
            .map(
              (r) =>
                `<tr><td class="first"><a href="${link({ rule: ruleId(r) })}">${esc(r.statement)}</a></td><td class="num">${plural(r.cases.length, 'case')}${r.todoCases.length ? ` <span class="todo">+${r.todoCases.length} not written</span>` : ''}</td><td class="path">${fileLink(r.file, r.line, `${r.file}:${r.line}`)}</td></tr>`,
            )
            .join(''),
      )
      .join('\n');
    return section(
      'own-rules',
      `Rules on ${esc(a.label)} itself`,
      `${plural(list.length, 'rule')} · ${aside}`,
      `<div class="well table"><table class="rules">
<thead><tr><th scope="col">Rule</th><th scope="col" class="num">Cases</th><th scope="col">Where</th></tr></thead>
<tbody>${rows}</tbody></table></div>`,
      'panel wide',
    );
  }

  // ---- one rule: its cases, each with the source around it ----
  function ruleDetail(r: Rule, a: Area): string {
    const code = (ref: Ref) => {
      const context = lines?.[ruleId(ref)];
      const where = fileLink(ref.file, ref.line, `${ref.file}:${ref.line}`);
      return context?.length
        ? `<details class="code"><summary>${where}</summary><pre>${context.map((l) => `<span class="${l.line === ref.line ? 'hit' : ''}"><b>${l.line}</b>${esc(l.text)}</span>`).join('')}</pre></details>`
        : `<div class="path">${where}</div>`;
    };
    const caseItem = (c: Case, todo: boolean) => `<li>${todo ? '<span class="todo">not written yet</span> ' : ''}<span class="case">${esc(c.text)}</span>${code(c)}</li>`;
    return (
      section(
        'rule',
        `${esc(r.level)} · ${esc(levelName(r.level))} rule`,
        `${esc([...pathOf(ix, a), a.label].join(' › '))} · ${esc(pkgLabel(pkgOf(r.file)))}`,
        `<div class="well rule">
<h3>${esc(r.statement)}</h3>
${code(r)}
<p class="note">No pass or fail mark: the explorer reads the test files and never runs them.</p>
</div>`,
        'panel wide',
      ) + section('cases', 'Cases', plural(r.cases.length, 'case'), `<ol class="well cases">${r.cases.map((c) => caseItem(c, false)).join('')}${r.todoCases.map((c) => caseItem(c, true)).join('')}</ol>`, 'panel wide')
    );
  }

  // ---- Testing level: one row per level, split by package ----
  function levelView(): string {
    const series = pkgSeries(scopeRules);
    const rows = LEVELS.filter((l) => q.level === null || l.id === q.level).map((l) => ({ l, rules: scopeRules.filter((r) => r.level === l.id) }));
    const max = Math.max(...rows.map((x) => x.rules.length), 1);
    const heads = series.map((s) => `<th scope="col" class="num">${esc(s.label)}</th>`).join('');
    const body = rows
      .map(({ l, rules }) => {
        const absent = model.availableLevels[l.id] === false;
        const bar = rules.length ? `<div style="width:${((rules.length / max) * 100).toFixed(1)}%;background:${l.colour}"></div>` : '';
        const cells = series.map((s) => {
          const n = rules.filter((r) => pkgOf(r.file) === s.key).length;
          return `<td class="num">${absent ? '<span class="na">n/a</span>' : n ? toTests(number(n), n, { level: l.id, package: s.key as ListSpec['package'] }) : dash}</td>`;
        });
        const areas = new Set(rules.map((r) => r.concept)).size;
        return `<tr><td class="first"><a href="${link({ group: 'area', level: l.id })}"><i class="dot" style="background:${l.colour}"></i>${l.id} · ${l.name}</a><div class="sub">${l.description}</div></td><td class="split-cell"><div class="split">${bar}</div></td>${cells.join('')}<td class="num total">${rules.length ? toTests(number(rules.length), rules.length, { level: l.id }) : dash}</td><td class="num">${number(rules.reduce((n, r) => n + r.cases.length, 0))}</td><td class="num">${number(new Set(rules.map((r) => r.file)).size)}</td><td class="num">${number(areas)}</td></tr>`;
      })
      .join('\n');
    return section(
      'by-level',
      `By testing level${scope ? ` in ${esc(scope.label)}` : ''}`,
      'testing-strategy&rsquo;s order · a level&rsquo;s name opens the areas at that level',
      `<div class="well table"><table>
<thead><tr><th scope="col" class="wide-name">Level</th><th scope="col"><span class="sr-only">Rules, drawn</span></th>${heads}<th scope="col" class="num">Rules</th><th scope="col" class="num">Cases</th><th scope="col" class="num">Test files</th><th scope="col" class="num">Areas</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
      'panel wide',
    );
  }

  // ---- Package: one row per package, split by level, with its untested files ----
  function packageView(): string {
    const series = levelSeries;
    const allFiles = [...new Set(inScope.flatMap((a) => a.filesNothingRuns.map((f) => f.file)))];
    const keys = PACKAGES.filter((p) => (q.package === null || p.key === q.package) && (scopeRules.some((r) => pkgOf(r.file) === p.key) || allFiles.some((f) => pkgOf(f) === p.key)));
    const rows = keys.map((p) => ({ p, rules: scopeRules.filter((r) => pkgOf(r.file) === p.key), files: allFiles.filter((f) => pkgOf(f) === p.key).length }));
    const max = Math.max(...rows.map((x) => x.rules.length), 1);
    const heads = series.map((s) => `<th scope="col" class="num" title="${esc(s.title)}">${swatch(s)}${esc(s.label)}</th>`).join('');
    const body = rows
      .map(({ p, rules, files }) => {
        const bar = barOf(series, series.map((s) => rules.filter((r) => r.level === s.key).length), max);
        const cells = series.map((s) => {
          const n = rules.filter((r) => r.level === s.key).length;
          return `<td class="num">${model.availableLevels[s.key] === false ? '<span class="na">n/a</span>' : n ? toTests(number(n), n, { package: p.key, level: s.key as ListSpec['level'] }) : dash}</td>`;
        });
        const filesCell = files ? `<a href="${link({ group: 'gaps', package: p.key })}"><span class="bad">${number(files)}</span></a>` : dash;
        return `<tr><td class="first"><a href="${link({ group: 'area', package: p.key })}">${esc(p.label)}</a><div class="sub">${plural(new Set(rules.map((r) => r.file)).size, 'test file')} · ${plural(rules.reduce((n, r) => n + r.cases.length, 0), 'case')}</div></td><td class="split-cell"><div class="split">${bar}</div></td>${cells.join('')}<td class="num total">${rules.length ? toTests(number(rules.length), rules.length, { package: p.key }) : dash}</td><td class="num">${filesCell}</td></tr>`;
      })
      .join('\n');
    return section(
      'by-package',
      `By package${scope ? ` in ${esc(scope.label)}` : ''}`,
      'where the test file, or the untested source file, lives · a name opens the areas it tests',
      `<div class="well table"><table>
<thead><tr><th scope="col">Package</th><th scope="col">Rules by level</th>${heads}<th scope="col" class="num">Rules</th><th scope="col" class="num">Files nothing runs</th></tr></thead>
<tbody>${body || `<tr><td colspan="${series.length + 4}" class="empty">Nothing here.</td></tr>`}</tbody></table></div>`,
      'panel wide',
    );
  }

  // ---- Gaps: every source file nothing imports, with the areas that own it ----
  function gapsView(): string {
    const files = new Map<string, Area[]>();
    for (const a of inScope) for (const f of ownFiles(a, keep)) files.set(f.file, [...(files.get(f.file) ?? []), a]);
    const list = [...files].sort(([fa, aa], [fb, ab]) => inScope.indexOf(aa[0]!) - inScope.indexOf(ab[0]!) || (fa < fb ? -1 : 1));
    const body = list
      .map(([file, areas]) => `<tr><td class="first path">${fileLink(file, null)}</td><td>${areas.map((a) => `<a href="${link({ group: 'area', node: a.key })}">${esc(a.label)}</a>`).join(', ')}</td><td class="faint-num">${esc(pkgLabel(pkgOf(file)))}</td></tr>`)
      .join('\n');
    const label = scope ? scope.label : 'Cockpit';
    const prompt = list.length
      ? [`Tests are missing for these files in the "${label}" feature area:`, ...list.map(([f]) => `- ${f}`), '', "Use this repo's test strategy and guidance when defining tests, to figure out which tests may need to be added to ensure this is covered."].join('\n')
      : '';
    const copy = prompt
      ? `<textarea id="gap-prompt" hidden>${esc(prompt)}</textarea><button type="button" class="copy" onclick="navigator.clipboard.writeText(document.getElementById('gap-prompt').value).then(()=>{this.textContent='Copied'})">Copy prompt for missing tests</button>`
      : '';
    const warning = model.warnings
      .map((w) => {
        const at = w.indexOf(': apps/');
        if (at < 0) return `<p class="warning">${esc(w)}</p>`;
        const tests = w.slice(at + 2).replace(/\.$/, '').split(', ');
        return `<details class="warning"><summary><strong>Some of these may be false positives.</strong> ${plural(tests.length, 'test')} drive the real Worker over HTTP rather than importing what they exercise, so a file reached only through routing still shows here. Check the test before treating a hit as a gap.</summary><ul>${tests.map((t) => `<li>${fileLink(t, null)}</li>`).join('')}</ul></details>`;
      })
      .join('');
    const table = list.length
      ? section(
          'gap-files',
          `Files nothing runs${scope ? ` in ${esc(scope.label)}` : ''}`,
          `${plural(list.length, 'file')}${q.package ? ` · ${esc(pkgLabel(q.package))} only` : ''} · ${copy}`,
          `<div class="well table"><table>
<thead><tr><th scope="col">Source file</th><th scope="col">Owned by</th><th scope="col">Package</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
          'panel wide',
        )
      : section('gap-files', 'Files nothing runs', '', `<p class="well empty">None: every source file ${scope ? `${esc(scope.label)} owns` : 'here'} is imported by at least one test.</p>`, 'panel wide');
    return `${warning}\n${table}\n${branchesPanel()}`;
  }

  /** The branches no test takes, a row per file with its lines; unknown, not none, when the snapshot had no coverage. */
  function branchesPanel(): string {
    if (!model.coverageAvailable) {
      return section('gap-branches', 'Branches nothing takes', '', '<p class="well empty">Unknown, not zero: the branches no test takes come from CI&rsquo;s instrumented run on main, and this snapshot had none.</p>', 'panel wide');
    }
    // A file owned by several areas is counted once, by the most any one holds (as `branchGaps` does).
    const byFile = new Map<string, { lines: number[]; count: number; areas: Area[] }>();
    for (const a of inScope) {
      const here = new Map<string, number[]>();
      for (const b of a.branchesNothingTakes ?? []) if (keep.file(b)) here.set(b.file, [...(here.get(b.file) ?? []), b.line]);
      for (const [file, lines] of here) {
        const own = byFile.get(file) ?? { lines: [], count: 0, areas: [] };
        own.lines.push(...lines);
        own.count = Math.max(own.count, lines.length);
        own.areas.push(a);
        byFile.set(file, own);
      }
    }
    if (!byFile.size) return section('gap-branches', 'Branches nothing takes', '', `<p class="well empty">None: every branch ${scope ? `${esc(scope.label)} owns` : 'here'} is taken by at least one test.</p>`, 'panel wide');
    const body = [...byFile]
      .sort(([fa, a], [fb, b]) => b.count - a.count || (fa < fb ? -1 : 1))
      .map(
        ([file, own]) =>
          `<tr><td class="first path">${fileLink(file, null)}</td><td class="num">${number(own.count)}</td><td class="path">${[...new Set(own.lines)].sort((x, y) => x - y).map((n) => fileLink(file, n, `${n}`)).join(', ')}</td><td>${own.areas.map((a) => `<a href="${link({ group: 'area', node: a.key })}">${esc(a.label)}</a>`).join(', ')}</td></tr>`,
      )
      .join('\n');
    return section(
      'gap-branches',
      `Branches nothing takes${scope ? ` in ${esc(scope.label)}` : ''}`,
      `${plural(branchGaps(inScope, keep), 'branch', 'branches')} in ${plural(byFile.size, 'file')}`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Source file</th><th scope="col" class="num">Branches</th><th scope="col">Lines</th><th scope="col">Owned by</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
      'panel wide',
    );
  }
}

const EXTRA = `
.stamp{margin:0;font-size:13px;color:var(--ink-faint)}.stamp strong{color:var(--ink)}.stamp a{color:inherit}
form.stamp{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}form.stamp label{font-weight:600;color:var(--ink)}
form.stamp select{height:32px;font-size:13px;font-weight:600;max-width:100%;min-width:0;text-overflow:ellipsis}
a.count{color:inherit;text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 30%,transparent);text-underline-offset:3px}a.count:hover{color:var(--accent-deep)}
code,.note code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:15px;font-weight:500;color:var(--ink-strong)}
.crumbs a{color:var(--accent-deep)}.crumbs .sep{color:var(--ink-faint)}
.tile-value small{font-size:15px;font-weight:500;color:var(--ink-faint)}
.tree{padding-left:calc(var(--depth) * 22px);position:relative}
.tree::before{content:'';position:absolute;left:calc(var(--depth) * 22px - 13px);top:-11px;height:24px;width:9px;border-left:1px solid color-mix(in srgb,var(--shade) 20%,transparent);border-bottom:1px solid color-mix(in srgb,var(--shade) 20%,transparent)}
.tree[style*="--depth:0"]::before{display:none}
tr.context td{opacity:.55}
.subtotal{color:var(--ink-faint);font-weight:400}
.na{display:inline-block;padding:0 6px;border-radius:var(--radius-sm);font-size:12px;color:var(--ink-faint);background:color-mix(in srgb,var(--shade) 6%,transparent)}
.bad{color:var(--over-ink);font-weight:600}
td.num a{text-decoration:none}
i.dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:8px;vertical-align:-1px}
tr.group th{position:static;padding-top:16px;font-size:12px;color:var(--accent-deep);background:none}
tr.group th i{margin-right:8px}
table.rules{min-width:720px}
.path{font-size:13px;color:var(--ink-faint);word-break:break-all}.path a{color:var(--ink-soft)}
td.path{max-width:360px}
.todo{display:inline-block;padding:0 6px;border-radius:var(--radius-sm);font-size:12px;background:var(--due-soft);color:var(--due-ink)}
.rule{padding:18px 16px;display:flex;flex-direction:column;gap:10px}
.rule h3{margin:0;font-size:18px;font-weight:600;color:var(--ink-strong)}
.cases{margin:0;padding:8px 16px 8px 44px;display:flex;flex-direction:column}
.cases li{padding:9px 0;border-bottom:1px solid color-mix(in srgb,var(--shade) 8%,transparent)}.cases li:last-child{border-bottom:0}
.case{color:var(--ink-strong)}
details.code summary{cursor:pointer;font-size:13px;color:var(--ink-faint);list-style-position:inside}
details.code pre{margin:6px 0 0;padding:8px 0;overflow-x:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--field);border:1px solid color-mix(in srgb,var(--shade) 10%,transparent);border-radius:var(--radius-sm)}
details.code pre span{display:block;padding:0 10px;white-space:pre}details.code pre b{display:inline-block;width:42px;color:var(--ink-faint);font-weight:400}
details.code pre .hit{background:var(--accent-tint)}
details.warning summary{cursor:pointer}details.warning ul{margin:8px 0 0;padding-left:20px;font-size:13px;columns:2 360px}details.warning a{color:inherit}
.copy{height:30px;padding:0 12px;border:0;border-radius:var(--radius-md);background:var(--surface);box-shadow:var(--shadow-panel);font:inherit;font-size:13px;font-weight:500;color:var(--ink-strong);cursor:pointer}
.copy:hover{background:var(--field)}
.changes a.name{text-decoration:none}
.split-cell{width:130px}
th.wide-name{min-width:260px}
`;
