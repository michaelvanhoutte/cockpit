import { GREY, slot } from './palette';
import { pullRequestNumber, pullRequestSnapshot, unpack, type Snapshot } from './tests';
import { currentAreaLines, shownTests, type PullRequestTests } from './tests-store';

/**
 * What the Tests page reads of the shown snapshot, `main`'s or an open pull
 * request's, and the counting over
 * it: which rules and files a row counts under the filters, what a count opens,
 * which areas Show keeps. The snapshot is the tree document the test explorer
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
  filesNothingRuns: Ref[];
  /** Null when the run had no coverage: unknown, which is not none. */
  branchesNothingTakes: Ref[] | null;
  children: Area[];
}
export interface Model {
  commit: string;
  commitUrl: string | null;
  generatedAt: string | null;
  tree: Area[];
  coverageAvailable: boolean;
  /** False for a level the whole repository does not have yet. */
  availableLevels: Record<string, boolean>;
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

export const GROUPS = ['area', 'level', 'package', 'gaps'] as const;
export type Group = (typeof GROUPS)[number];
export const SHOWS = ['all', 'files', 'empty'] as const;
export type Show = (typeof SHOWS)[number];
export const SPLITS = ['level', 'package'] as const;
export type Split = (typeof SPLITS)[number];

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
  /** A rule's id, `file:line`: its cases open instead of the tab. */
  rule: string | null;
  /** The tests a clicked count opens above the tab; the page's own filters stay as they were. */
  list: ListSpec | null;
  /** The open pull request whose tests are shown; null is `main`'s. */
  pr: number | null;
}

export const DEFAULT_QUERY: TestsQuery = { group: 'area', node: null, level: null, package: null, show: 'all', split: 'level', rule: null, list: null, pr: null };
const DEFAULTS: Partial<Record<keyof TestsQuery, unknown>> = { group: 'area', show: 'all', split: 'level' };

/** Longest value an address may carry for an area or a rule, so a junk address is never a long cache key. */
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
  const group = pick<Group>(params.get('group'), GROUPS, 'area');
  return {
    group,
    node: text(params.get('node')),
    // A filter that repeats the rows is dropped, as its control is not offered.
    level: group === 'level' ? null : oneOf(params.get('level'), LEVEL_IDS),
    package: group === 'package' ? null : oneOf(params.get('package'), PACKAGE_KEYS),
    show: pick(params.get('show'), SHOWS, 'all'),
    split: pick(params.get('split'), SPLITS, 'level'),
    rule: text(params.get('rule')),
    list,
    pr: pullRequestNumber(params.get('pr')),
  };
}

/** The address for `q` with `over` applied; defaults are left out, so one view has one address (and one cache entry). A rule and a list are dropped unless asked for. */
export function testsAddress(q: TestsQuery, over: Partial<TestsQuery> = {}): string {
  const all: TestsQuery = { ...q, rule: null, list: null, ...over };
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
  rules: Map<string, { rule: Rule; area: Area }>;
}

export function* walk(areas: Area[]): Generator<Area> {
  for (const a of areas) {
    yield a;
    yield* walk(a.children);
  }
}
export const ruleId = (r: Ref) => `${r.file}:${r.line}`;

export function indexOf(model: Model): Index {
  const ix: Index = { byKey: new Map(), parent: new Map(), rules: new Map() };
  const visit = (areas: Area[], parent: Area | null) => {
    for (const a of areas) {
      ix.byKey.set(a.key, a);
      ix.parent.set(a.key, parent);
      for (const r of a.rules) ix.rules.set(ruleId(r), { rule: r, area: a });
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

/** The query with an area or rule the snapshot does not hold dropped, and a list naming such an area dropped whole (an empty area would mean every area), so no link carries it. */
export function resolveQuery(q: TestsQuery, ix: Index): TestsQuery {
  const list = q.list && (q.list.node === null || ix.byKey.has(q.list.node)) ? q.list : null;
  return { ...q, node: q.node !== null && ix.byKey.has(q.node) ? q.node : null, rule: q.rule !== null && ix.rules.has(q.rule) ? q.rule : null, list };
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
      filesNothingRuns: a.filesNothingRuns ?? [],
      branchesNothingTakes: a.branchesNothingTakes ?? null,
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
    warnings: doc.warnings ?? [],
  };
}

export interface TestsData {
  model: Model;
  index: Index;
  /** The address's query with what the snapshot does not hold dropped. */
  query: TestsQuery;
  /** The lines around the open rule's cases: its area's own document. Null when no rule is open, or the area holds none. */
  lines: AreaLines | null;
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
 * snapshot's tree, in one round trip, and, for a rule, its area's source
 * lines. The lines are read after the tree because the rule's area is only
 * known from it, still inside the one request the page is answered by.
 */
export async function loadTests(db: D1Database, asked: TestsQuery): Promise<TestsView> {
  const snapshot: Snapshot = asked.pr === null ? 'main' : pullRequestSnapshot(asked.pr);
  const { pulls, tree: current } = await shownTests(db, snapshot);
  if (!current) return { asked, pulls, data: null };
  const unpacked = await unpack('The tree', current.document);
  if (!unpacked.ok) throw new Error(unpacked.error);
  const model = readModel(unpacked.value);
  const index = indexOf(model);
  const query = resolveQuery(asked, index);
  let lines: AreaLines | null = null;
  if (query.rule !== null) {
    const stored = await currentAreaLines(db, snapshot, current.commit, index.rules.get(query.rule)!.area.key);
    const unpackedLines = stored ? await unpack('The source lines', stored) : null;
    if (unpackedLines?.ok) lines = unpackedLines.value as AreaLines;
  }
  return { asked, pulls, data: { model, index, query, lines } };
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
/** An area's own source files nothing runs. */
export const ownFiles = (a: Area, keep: Keep) => a.filesNothingRuns.filter(keep.file);
/** The distinct files nothing runs across areas: a file owned by two is one gap. */
export const distinctFiles = (areas: Area[], keep: Keep) => new Set(areas.flatMap((a) => ownFiles(a, keep).map((f) => f.file)));

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
  const matches = (a: Area) => (q.show === 'files' ? ownFiles(a, keep).length > 0 : q.show === 'empty' ? deepRules(a, keep).length === 0 : true);
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
