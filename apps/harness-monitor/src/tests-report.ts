import { GREY, slot } from './palette';
import { pullRequestNumber, pullRequestSnapshot, unpack, type Snapshot } from './tests';
import { shownAreaLines, shownTests, type PullRequestTests } from './tests-store';

/**
 * What the Test coverage page reads of the shown snapshot, `main`'s or an open
 * pull request's, and the counting over it: which rules a row counts and what
 * share of its statements ran under the filters, what a count opens, which
 * areas Show keeps, and what the side panel beside the table lists. The snapshot is the tree document the test explorer
 * sent (src/tests.ts); the Monitor derives nothing from it but these counts,
 * which the filters change, so they cannot be stored with it.
 */

export interface Line {
  line: number;
  text: string;
}
export interface Ref {
  file: string;
  line: number;
}
export interface Case extends Ref {
  text: string;
}
export interface Rule extends Ref {
  concept: string;
  statement: string;
  level: string;
  cases: Case[];
  todoCases: Case[];
}
export interface Area {
  key: string;
  label: string;
  /** Own rules per level; null is n/a, never a stand-in for zero. */
  counts: Record<string, number | null>;
  rules: Rule[];
  /** Null when the run had no coverage: unknown, which is not none. */
  branchesNothingTakes: Ref[] | null;
  /** Each own file the run measured, with its statements and how many ran; null when the run had no coverage, or the tree came from an analyzer older than the figures. */
  statements: FileStatements[] | null;
  children: Area[];
}
export interface FileStatements {
  file: string;
  total: number;
  covered: number;
  /** The lines no test runs, as ranges ("40-58"); the check accepts a file without them. */
  uncovered?: string[];
}
/** A file judged not worth a test, from the list checked in beside the area registry: its reason, and how many of its statements no test ran when it was decided. */
export interface Decided {
  file: string;
  reason: string;
  notRun: number;
}
export interface Model {
  commit: string;
  commitUrl: string | null;
  generatedAt: string | null;
  tree: Area[];
  coverageAvailable: boolean;
  /** False for a level the whole repository does not have yet. */
  availableLevels: Record<string, boolean>;
  /** The files judged not worth a test; empty in a tree from an analyzer older than the list. */
  notWorthATest: Decided[];
  warnings: string[];
}
/** One area's source lines, keyed `file:line`. */
export type AreaLines = Record<string, Line[]>;

/** testing-strategy's levels, in its own order, as tools/test-explorer/src/model.js names them. Each takes its own slot of the palette (src/palette.ts), and Contract, which most areas have none of, is grey. */
export const LEVELS = [
  { id: 'L1', name: 'Unit', description: 'No real dependencies: pure logic, calculations, branching, edge cases.', colour: slot(1) },
  { id: 'L2', name: 'Integration', description: 'Real infrastructure the service owns, its own database, no other service.', colour: slot(2) },
  { id: 'L3', name: 'System', description: 'Backend services wired together at the API level, no browser. Needs a second backend service.', colour: slot(3) },
  { id: 'F1', name: 'Frontend unit', description: 'No real dependencies: component and view-model logic.', colour: slot(4) },
  { id: 'F2', name: 'Service-frontend', description: 'The frontend plus only its own service&rsquo;s backend.', colour: slot(5) },
  { id: 'F3', name: 'End-to-end', description: 'Everything real, in a real browser. The one level every capability must have.', colour: slot(6) },
  { id: 'Contract', name: 'Contract', description: 'Scheduled live checks against a third party. n/a for an area no contract suite names.', colour: GREY },
] as const;
export type LevelId = (typeof LEVELS)[number]['id'];
export const LEVEL_IDS: readonly string[] = LEVELS.map((l) => l.id);
export const levelName = (id: string) => LEVELS.find((l) => l.id === id)?.name ?? id;

/** Where a test or source file lives, read off its path. Connectors are one row: four small packages read better together. Packages carry no colour: plain counts. */
export const PACKAGES = [
  { key: 'api', label: 'apps/api', prefix: 'apps/api/' },
  { key: 'web', label: 'apps/web', prefix: 'apps/web/' },
  { key: 'e2e', label: 'tests/e2e', prefix: 'tests/' },
  { key: 'shared', label: 'packages/shared', prefix: 'packages/shared/' },
  { key: 'connectors', label: 'packages/connectors', prefix: 'packages/connectors/' },
  { key: 'monitor', label: 'apps/harness-monitor', prefix: 'apps/harness-monitor/' },
  { key: 'other', label: 'Elsewhere', prefix: '' },
] as const;
export type PackageKey = (typeof PACKAGES)[number]['key'];
export const PACKAGE_KEYS: readonly string[] = PACKAGES.map((p) => p.key);
export const pkgOf = (file: string): PackageKey => PACKAGES.find((p) => file.startsWith(p.prefix))?.key ?? 'other';
export const pkgLabel = (key: string) => PACKAGES.find((p) => p.key === key)?.label ?? key;

/** The page's two tabs; an address naming one that has gone (`level`, `package`) opens the first. */
export const GROUPS = ['area', 'gaps'] as const;
export type Group = (typeof GROUPS)[number];
/** `files` is the areas under THIN covered; the address keeps the word it had when it was the areas with files nothing runs. */
export const SHOWS = ['all', 'files', 'empty'] as const;
export type Show = (typeof SHOWS)[number];
export const SPLITS = ['level', 'package'] as const;
export type Split = (typeof SPLITS)[number];
/** The side panel's tabs: the rules behind a count, the files they cover, the branches no test takes. */
export const PANES = ['rules', 'files', 'branches'] as const;
export type Pane = (typeof PANES)[number];

/** The tests behind a clicked count: any part empty means every one. */
export interface ListSpec {
  node: string | null;
  level: LevelId | null;
  package: PackageKey | null;
}

export interface TestsQuery {
  group: Group;
  /** The area the view is drilled into. */
  node: string | null;
  level: LevelId | null;
  package: PackageKey | null;
  show: Show;
  split: Split;
  /** The tests a clicked count or an area's name opens in the panel beside the table; the page's own filters stay as they were. */
  list: ListSpec | null;
  /** Which tab of the panel the list opens on. */
  pane: Pane;
  /** The open pull request whose tests are shown; null is `main`'s. */
  pr: number | null;
}

export const DEFAULT_QUERY: TestsQuery = { group: 'area', node: null, level: null, package: null, show: 'all', split: 'level', list: null, pane: 'rules', pr: null };
const DEFAULTS: Partial<Record<keyof TestsQuery, unknown>> = { group: 'area', show: 'all', split: 'level', pane: 'rules' };

/** Longest value an address may carry for an area or a case, so a junk address is never a long cache key. */
const MAX_VALUE = 400;

const oneOf = <T extends string>(value: string | null, list: readonly string[]): T | null => (value !== null && list.includes(value) ? (value as T) : null);
const pick = <T extends string>(value: string | null, list: readonly string[], fallback: T): T => oneOf<T>(value, list) ?? fallback;
const text = (value: string | null) => (value !== null && value !== '' && value.length <= MAX_VALUE ? value : null);

/** The view the address asks for, as written: an area or rule it does not know is only found out once the snapshot is read (`resolveQuery`). */
export function parseTestsQuery(params: URLSearchParams): TestsQuery {
  const [node, level, pkg, ...extra] = (params.get('tests') ?? '').split('~');
  const part = <T>(value: string | undefined, read: (v: string | null) => T | null) => (value ? read(value) : null);
  const listed = { node: part(node, text), level: part(level, (v) => oneOf<LevelId>(v, LEVEL_IDS)), package: part(pkg, (v) => oneOf<PackageKey>(v, PACKAGE_KEYS)) };
  // A part that is written but not understood drops the list: leaving it empty would mean every area, level or package.
  const readable = (value: string | undefined, got: unknown) => !value || got !== null;
  const list = params.has('tests') && extra.length === 0 && readable(node, listed.node) && readable(level, listed.level) && readable(pkg, listed.package) ? listed : null;
  return {
    group: pick<Group>(params.get('group'), GROUPS, 'area'),
    node: text(params.get('node')),
    level: oneOf(params.get('level'), LEVEL_IDS),
    package: oneOf(params.get('package'), PACKAGE_KEYS),
    show: pick(params.get('show'), SHOWS, 'all'),
    split: pick(params.get('split'), SPLITS, 'level'),
    list,
    pane: pick(params.get('pane'), PANES, 'rules'),
    pr: pullRequestNumber(params.get('pr')),
  };
}

/** The address for `q` with `over` applied; defaults are left out, so one view has one address (and one cache entry). A list and its tab are dropped unless asked for, and a tab means nothing without a list. */
export function testsAddress(q: TestsQuery, over: Partial<TestsQuery> = {}): string {
  const all: TestsQuery = { ...q, list: null, pane: 'rules', ...over };
  if (all.list === null) all.pane = 'rules';
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(all)) {
    if (value === null || DEFAULTS[name as keyof TestsQuery] === value) continue;
    if (name === 'list') params.set('tests', `${all.list!.node ?? ''}~${all.list!.level ?? ''}~${all.list!.package ?? ''}`);
    else params.set(name, String(value));
  }
  const text = params.toString();
  return text === '' ? '/tests' : `/tests?${text}`;
}

// ---- The snapshot as the page reads it

export interface Index {
  byKey: Map<string, Area>;
  parent: Map<string, Area | null>;
}

export function* walk(areas: Area[]): Generator<Area> {
  for (const a of areas) {
    yield a;
    yield* walk(a.children);
  }
}
export const ruleId = (r: Ref) => `${r.file}:${r.line}`;

export function indexOf(model: Model): Index {
  const ix: Index = { byKey: new Map(), parent: new Map() };
  const visit = (areas: Area[], parent: Area | null) => {
    for (const a of areas) {
      ix.byKey.set(a.key, a);
      ix.parent.set(a.key, parent);
      visit(a.children, a);
    }
  };
  visit(model.tree, null);
  return ix;
}

/** The labels of an area's ancestors, outermost first. */
export function pathOf(ix: Index, area: Area): string[] {
  const path: string[] = [];
  for (let a = ix.parent.get(area.key); a; a = ix.parent.get(a.key)) path.unshift(a.label);
  return path;
}

/** The query with an area the snapshot does not hold dropped, and a list naming such an area dropped whole (an empty area would mean every area), so no link carries it. */
export function resolveQuery(q: TestsQuery, ix: Index): TestsQuery {
  const list = q.list && (q.list.node === null || ix.byKey.has(q.list.node)) ? q.list : null;
  return { ...q, node: q.node !== null && ix.byKey.has(q.node) ? q.node : null, list };
}

/** The stored tree document, with what the explorer's older models or a hand-built one may lack given its default. */
export function readModel(raw: unknown): Model {
  const doc = raw as Partial<Model> & { tree: unknown[] };
  const area = (node: unknown): Area => {
    const a = node as Partial<Area> & { key: string; label: string; counts: Area['counts']; rules: Partial<Rule>[]; children: unknown[] };
    return {
      key: a.key,
      label: a.label,
      counts: a.counts,
      rules: a.rules.map((r) => ({ ...r, cases: r.cases ?? [], todoCases: r.todoCases ?? [] }) as Rule),
      branchesNothingTakes: a.branchesNothingTakes ?? null,
      statements: a.statements ?? null,
      children: a.children.map(area),
    };
  };
  return {
    commit: doc.commit!,
    commitUrl: doc.commitUrl ?? null,
    generatedAt: doc.generatedAt ?? null,
    tree: doc.tree.map(area),
    coverageAvailable: doc.coverageAvailable === true,
    availableLevels: doc.availableLevels ?? {},
    notWorthATest: doc.notWorthATest ?? [],
    warnings: doc.warnings ?? [],
  };
}

export interface TestsData {
  model: Model;
  index: Index;
  /** The address's query with what the snapshot does not hold dropped. */
  query: TestsQuery;
}

export interface TestsView {
  /** The address's query as written: which snapshot it asks for, and the view to keep when another is picked. */
  asked: TestsQuery;
  /** The open pull requests with tests shown, for the picker, newest first. */
  pulls: PullRequestTests[];
  /** The asked snapshot read, or null when none of it is shown. */
  data: TestsData | null;
}

/**
 * What the page reads: the pull requests with tests shown and the asked
 * snapshot's tree, in one round trip. The source lines a case shows are not
 * read here but by `loadSource`, when the case is opened.
 */
export async function loadTests(db: D1Database, asked: TestsQuery): Promise<TestsView> {
  const snapshot: Snapshot = asked.pr === null ? 'main' : pullRequestSnapshot(asked.pr);
  const { pulls, tree: current } = await shownTests(db, snapshot);
  if (!current) return { asked, pulls, data: null };
  const unpacked = await unpack('The tree', current.document);
  if (!unpacked.ok) throw new Error(unpacked.error);
  const model = readModel(unpacked.value);
  const index = indexOf(model);
  return { asked, pulls, data: { model, index, query: resolveQuery(asked, index) } };
}

/** A case whose source is asked for: the area that holds its lines, its `file:line`, and the snapshot (an open pull request's, or `main`'s when null). */
export interface SourceAsk {
  area: string;
  at: string;
  pr: number | null;
}

/** The source asked for by an address, or null where it names no area or no case, or one too long to be either. */
export function parseSourceAsk(params: URLSearchParams): SourceAsk | null {
  const area = text(params.get('area'));
  const at = text(params.get('at'));
  return area === null || at === null ? null : { area, at, pr: pullRequestNumber(params.get('pr')) };
}

/**
 * The lines around one case, read when it is opened: the one document of the
 * case's own area, at the commit the page shows, and nothing else. Null when
 * the area holds none or none for the case.
 */
export async function loadSource(db: D1Database, ask: SourceAsk): Promise<Line[] | null> {
  const stored = await shownAreaLines(db, ask.pr === null ? 'main' : pullRequestSnapshot(ask.pr), ask.area);
  const unpacked = stored ? await unpack('The source lines', stored) : null;
  if (!unpacked?.ok) return null;
  const lines = unpacked.value as AreaLines;
  // `at` is the address's own text, so an inherited name such as `constructor` is no case.
  return Object.hasOwn(lines, ask.at) ? lines[ask.at]! : null;
}

// ---- Counting

/** What the Level and Package filters keep: they decide which rules and files are counted everywhere on the page. */
export interface Keep {
  rule: (r: Rule) => boolean;
  file: (f: Ref) => boolean;
}
export const keepOf = (q: Pick<TestsQuery, 'level' | 'package'>): Keep => ({
  rule: (r) => (q.level === null || r.level === q.level) && (q.package === null || pkgOf(r.file) === q.package),
  file: (f) => q.package === null || pkgOf(f.file) === q.package,
});

/** An area's own rules the filters keep. */
export const ownRules = (a: Area, keep: Keep) => a.rules.filter(keep.rule);
/** The rules of an area and everything inside it. */
export const deepRules = (a: Area, keep: Keep) => [...walk([a])].flatMap((x) => ownRules(x, keep));
/** Below this percentage of its statements run, an area or a file reads as thin: red, and listed on Gaps. A whole number, so the comparison is exact. */
export const THIN = 80;

/**
 * The distinct files across areas with their statements, a file owned by two
 * counted once, the filters' package kept; null when none of the areas was
 * measured, which is unknown rather than none. A file with no statements
 * (types only) is left out, so it never reads as 0% run.
 */
export function filesCovered(areas: Area[], keep: Keep): FileStatements[] | null {
  if (areas.length > 0 && areas.every((a) => a.statements === null)) return null;
  const files = new Map<string, FileStatements>();
  for (const a of areas) for (const s of a.statements ?? []) if (s.total > 0 && keep.file({ file: s.file, line: 1 })) files.set(s.file, s);
  return [...files.values()];
}

export interface Coverage {
  total: number;
  covered: number;
  rate: number;
}
/** The share of statements run across files, or null when unknown or there are none to run. */
export function coverageOf(files: FileStatements[] | null): Coverage | null {
  if (files === null) return null;
  const total = files.reduce((n, f) => n + f.total, 0);
  const covered = files.reduce((n, f) => n + f.covered, 0);
  return total === 0 ? null : { total, covered, rate: covered / total };
}
/** A share as a whole percentage, floored so a figure never flatters: 799 of 1,000 is 79%. */
export const percent = (c: Pick<Coverage, 'total' | 'covered'>) => `${Math.floor((c.covered * 100) / c.total)}%`;
/** Whether a share is under THIN. */
export const isThin = (c: Pick<Coverage, 'total' | 'covered'> | null) => c !== null && c.covered * 100 < THIN * c.total;

/** A file Gaps lists under Files to test next, with the decision it was taken off where more of it has gone unrun since. */
export interface NextFile {
  file: FileStatements;
  changed: Decided | null;
}
/** A file Gaps lists under Decided not to test, with the decision that put it there. */
export interface DecidedFile {
  file: FileStatements;
  decision: Decided;
}

/**
 * Which of Gaps' lists each measured file is on, each list most statements not
 * run first. A file decided not worth a test stays under Decided not to test
 * while no more of its statements go unrun than when it was decided; once more
 * do, it is a file to test next again, if under THIN, carrying the decision as
 * changed since. Any other file under THIN is to test next.
 */
export function gapLists(files: FileStatements[], decided: Decided[]): { next: NextFile[]; decided: DecidedFile[] } {
  const decisions = new Map(decided.map((d) => [d.file, d]));
  const notRun = (f: FileStatements) => f.total - f.covered;
  const next: NextFile[] = [];
  const kept: DecidedFile[] = [];
  for (const file of [...files].sort((a, b) => notRun(b) - notRun(a) || (a.file < b.file ? -1 : 1))) {
    const decision = decisions.get(file.file) ?? null;
    if (decision !== null && notRun(file) <= decision.notRun) kept.push({ file, decision });
    else if (isThin(file)) next.push({ file, changed: decision });
  }
  return { next, decided: kept };
}

/** Branches nothing takes across areas, counted once per file by the most any one area holds of it, as the explorer's own totals are. */
export function branchGaps(areas: Area[], keep: Keep): number {
  const perFile = new Map<string, number>();
  for (const a of areas) {
    const own = new Map<string, number>();
    for (const b of a.branchesNothingTakes ?? []) if (keep.file(b)) own.set(b.file, (own.get(b.file) ?? 0) + 1);
    for (const [file, n] of own) perFile.set(file, Math.max(perFile.get(file) ?? 0, n));
  }
  return [...perFile.values()].reduce((sum, n) => sum + n, 0);
}

/** Whether a level is n/a for an area (or, with `inside`, for it and everything inside it): the repository lacks the level, or no area holds it. */
export function levelNotApplicable(model: Model, a: Area, level: string, inside: boolean): boolean {
  if (model.availableLevels[level] === false) return true;
  return inside ? [...walk([a])].every((x) => x.counts[level] === null) : a.counts[level] === null;
}

/** A row's own rules in one series (a level or a package), or null where that level is n/a, which a count of 0 must never stand in for. */
export function countOf(model: Model, a: Area, split: Split, key: string, rules: Rule[], inside: boolean): number | null {
  if (split === 'level' && levelNotApplicable(model, a, key, inside)) return null;
  return rules.filter((r) => (split === 'level' ? r.level : pkgOf(r.file)) === key).length;
}

/** The tree's rows under the scope, each with its depth. */
export function rowsUnder(model: Model, scope: Area | null): { area: Area; depth: number }[] {
  const rows: { area: Area; depth: number }[] = [];
  const add = (areas: Area[], depth: number) => {
    for (const a of areas) {
      rows.push({ area: a, depth });
      add(a.children, depth + 1);
    }
  };
  add(scope ? [scope] : model.tree, 0);
  return rows;
}

/**
 * The rows Show keeps, with their ancestors drawn faint so a kept row is
 * still found in its tree: `shown` is what is drawn, `matched` what Show asked for.
 */
export function showRows(rows: { area: Area; depth: number }[], q: Pick<TestsQuery, 'show'>, keep: Keep, ix: Index): { shown: { area: Area; depth: number }[]; matched: Set<string> } {
  const matches = (a: Area) => (q.show === 'files' ? isThin(coverageOf(filesCovered([a], keep))) : q.show === 'empty' ? deepRules(a, keep).length === 0 : true);
  const visible = new Set<string>();
  const matched = new Set<string>();
  for (const { area } of rows) {
    if (!matches(area)) continue;
    matched.add(area.key);
    for (let a: Area | null | undefined = area; a && rows.some((r) => r.area === a); a = ix.parent.get(a.key)) visible.add(a.key);
  }
  return { shown: rows.filter((r) => visible.has(r.area.key)), matched };
}

/** What a list spec opens: the rules the filters of the count keep, under the areas that own them. */
export function testsBehind(model: Model, ix: Index, spec: ListSpec): { area: Area; rules: Rule[] }[] {
  const at = spec.node === null ? null : (ix.byKey.get(spec.node) ?? null);
  const keep = (r: Rule) => (spec.level === null || r.level === spec.level) && (spec.package === null || pkgOf(r.file) === spec.package);
  return (at ? [...walk([at])] : [...walk(model.tree)]).map((area) => ({ area, rules: area.rules.filter(keep) })).filter((x) => x.rules.length > 0);
}
