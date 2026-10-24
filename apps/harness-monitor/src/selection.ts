/**
 * Test selection's merged pull requests as the nightly `Selection` job sends
 * them (tools/selection): for each pull request and job (Test, E2E) whether it
 * ran, ran everything or was documentation only, its packages and modes, every
 * file it ran with the chain that picked it, and its misses; with the bars'
 * thresholds. The Monitor checks their shape and stores them; it derives nothing.
 */

/** Most pull requests one send may carry. The body is capped too, at the Worker's MAX_BODY characters. */
export const MAX_PULLS = 50;
/** Most packages in a job, files in a package or changed files in a job, and misses in a pull request: far above any real one, so only a malformed send reaches them. */
export const MAX_PACKAGES = 50;
export const MAX_FILES = 5000;
export const MAX_MISSES = 500;
const MAX_CHAIN = 100;

export const JOBS = ['test', 'e2e'] as const;
export type SelectionJob = (typeof JOBS)[number];

export const STATUSES = ['ran', 'docs-only', 'no-record'] as const;
export type SelectionStatus = (typeof STATUSES)[number];

/** The bars a send carries thresholds for, and the only ones the answer reads. */
export const BAR_IDS = ['e2e-forced-full', 'test-forced-full', 'misses', 'most-selected'] as const;
export type BarId = (typeof BAR_IDS)[number];

export interface Owner {
  concept: string;
  path: string | null;
  via?: string;
}

/** Why a file ran: the package ran everything, the file itself changed, an import chain from a changed file, the product area a changed file belongs to, or a trigger the graph does not carry. */
export type SelectedBy =
  | { kind: 'full' }
  | { kind: 'itself'; text: string }
  | { kind: 'chain'; chain: string[]; text: string }
  | { kind: 'concept'; owners: Owner[]; text: string }
  | { kind: 'unknown'; text: string };

export interface SelectionFile {
  path: string;
  level: string;
  status: 'passed' | 'failed';
  selectedBy: SelectedBy;
}

export interface SelectionPackage {
  name: string;
  dir: string;
  mode: 'full' | 'changed';
  report: 'written' | 'none';
  reason: { rule: string; path: string | null } | null;
  /** The files the package ran, never the ones it skipped. */
  files: SelectionFile[];
}

export interface SelectionJobRow {
  job: SelectionJob;
  status: SelectionStatus;
  ranEverything: boolean;
  selecting: boolean;
  filesRun: number | null;
  filesTotal: number | null;
  prDurationMs: number | null;
  mainDurationMs: number | null;
  changedFiles: { path: string; ignored: boolean }[];
  packages: SelectionPackage[];
}

export interface SelectionMiss {
  job: SelectionJob;
  path: string;
  level: string;
  reason: string | null;
}

export interface SelectionPull {
  number: number;
  title: string;
  url: string;
  mergedAt: number;
  jobs: SelectionJobRow[];
  misses: SelectionMiss[];
}

export interface BarSetting {
  id: BarId;
  name: string;
  threshold: number;
  minOver: number | null;
  /** The bar's open alarm issue; null when none is open, undefined when the send could not read them and the stored one stands. */
  alarmIssue: number | null | undefined;
}

export interface SelectionBars {
  windowDays: number;
  minPulls: number;
  items: BarSetting[];
}

export type CheckedSelection = { ok: true; pulls: SelectionPull[]; bars: SelectionBars } | { ok: false; error: string };

/** A four-digit year and an explicit zone, as GitHub writes every time. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, max: number, { empty = false } = {}): string | null {
  return typeof value === 'string' && (empty || value.trim() !== '') && value.length <= max ? value : null;
}

/** A whole number, `min` or more, or null where `nullable` and absent; a string is the complaint. */
function whole(r: Fields, key: string, options?: { min?: number; nullable?: false }): number | string;
function whole(r: Fields, key: string, options: { min?: number; nullable: true }): number | null | string;
function whole(r: Fields, key: string, { min = 0, nullable = false }: { min?: number; nullable?: boolean } = {}): number | null | string {
  const value = r[key];
  if (value === null || value === undefined) return nullable ? null : `has no ${key}.`;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min) return value;
  return `has ${key} ${JSON.stringify(value)}, which is not a whole number, ${min === 0 ? 'zero' : 'one'} or more.`;
}

function flag(r: Fields, key: string): boolean | string {
  return typeof r[key] === 'boolean' ? (r[key] as boolean) : `has ${key} ${JSON.stringify(r[key] ?? null)}, which is not true or false.`;
}

function oneOf<T extends string>(r: Fields, key: string, allowed: readonly T[]): T | string {
  const value = r[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : `has ${key} ${JSON.stringify(value ?? null)}, which is not ${allowed.join(' or ')}.`;
}

function selectedByOf(raw: unknown, mode: 'full' | 'changed'): SelectedBy | string {
  if (!isObject(raw)) return 'has no selectedBy.';
  const kind: string = oneOf(raw, 'kind', ['full', 'itself', 'chain', 'concept', 'unknown'] as const);
  if (!['full', 'itself', 'chain', 'concept', 'unknown'].includes(kind)) return `selectedBy ${kind}`;
  // A file of a package that ran everything was not picked, and one of a package that selected was.
  if ((kind === 'full') !== (mode === 'full')) return mode === 'full' ? `ran in a full package but its selectedBy is ${kind}.` : 'ran in a package that selected, but its selectedBy is full.';
  if (kind === 'full') return { kind: 'full' };
  const words = text(raw.text, 2000);
  if (!words) return 'has a selectedBy with no text.';
  if (kind === 'itself' || kind === 'unknown') return { kind, text: words } as SelectedBy;
  if (kind === 'chain') {
    const chain = raw.chain;
    if (!Array.isArray(chain) || chain.length === 0 || chain.length > MAX_CHAIN) return `has a selectedBy chain that is not a list of 1 to ${MAX_CHAIN} paths.`;
    const paths: string[] = [];
    for (const step of chain) {
      const path = text(step, 500);
      if (path === null) return 'has a selectedBy chain with a step that is not a path.';
      paths.push(path);
    }
    return { kind: 'chain', chain: paths, text: words };
  }
  const owners = raw.owners;
  if (!Array.isArray(owners) || owners.length === 0 || owners.length > MAX_CHAIN) return `has a selectedBy with owners that are not a list of 1 to ${MAX_CHAIN}.`;
  const checked: Owner[] = [];
  for (const owner of owners) {
    if (!isObject(owner)) return 'has a selectedBy owner that is not an object.';
    const concept = text(owner.concept, 300);
    if (!concept) return 'has a selectedBy owner with no concept.';
    const path = owner.path === null || owner.path === undefined ? null : text(owner.path, 500);
    if (owner.path !== null && owner.path !== undefined && path === null) return 'has a selectedBy owner with a path that is not a short string.';
    const via = owner.via === undefined ? undefined : text(owner.via, 500);
    if (owner.via !== undefined && via === null) return 'has a selectedBy owner with a via that is not a short string.';
    checked.push({ concept, path, ...(via ? { via } : {}) });
  }
  return { kind: 'concept', owners: checked, text: words };
}

function checkFile(raw: unknown, mode: 'full' | 'changed'): SelectionFile | string {
  if (!isObject(raw)) return 'is not an object.';
  const path = text(raw.path, 500);
  if (!path) return 'has no path.';
  const label = `file ${path}`;
  const level = text(raw.level, 40);
  if (!level) return `${label} has no level.`;
  const status = oneOf(raw, 'status', ['passed', 'failed'] as const);
  if (status !== 'passed' && status !== 'failed') return `${label} ${status} Only the files a job ran are sent.`;
  const selectedBy = selectedByOf(raw.selectedBy, mode);
  if (typeof selectedBy === 'string') return `${label} ${selectedBy}`;
  return { path, level, status, selectedBy };
}

function checkPackage(raw: unknown): SelectionPackage | string {
  if (!isObject(raw)) return 'is not an object.';
  const name = text(raw.name, 300);
  if (!name) return 'has no name.';
  const label = `package ${name}`;
  const dir = text(raw.dir, 500);
  if (!dir) return `${label} has no dir.`;
  const mode = oneOf(raw, 'mode', ['full', 'changed'] as const);
  if (mode !== 'full' && mode !== 'changed') return `${label} ${mode}`;
  const report = oneOf(raw, 'report', ['written', 'none'] as const);
  if (report !== 'written' && report !== 'none') return `${label} ${report}`;
  let reason: SelectionPackage['reason'] = null;
  if (raw.reason !== null && raw.reason !== undefined) {
    if (!isObject(raw.reason)) return `${label} has a reason that is not an object.`;
    const rule = text(raw.reason.rule, 500);
    if (!rule) return `${label} has a reason with no rule.`;
    const path = raw.reason.path === null || raw.reason.path === undefined ? null : text(raw.reason.path, 500);
    if (raw.reason.path !== null && raw.reason.path !== undefined && path === null) return `${label} has a reason with a path that is not a short string.`;
    reason = { rule, path };
  }
  if (!Array.isArray(raw.files)) return `${label} has no list of files.`;
  if (raw.files.length > MAX_FILES) return `${label} has ${raw.files.length} files; the most one package takes is ${MAX_FILES}.`;
  if (report === 'none' && raw.files.length > 0) return `${label} wrote no report but names files.`;
  const files: SelectionFile[] = [];
  const seen = new Set<string>();
  for (const rawFile of raw.files) {
    const file = checkFile(rawFile, mode);
    if (typeof file === 'string') return `${label} ${file}`;
    if (seen.has(file.path)) return `${label} has file ${file.path} twice.`;
    seen.add(file.path);
    files.push(file);
  }
  return { name, dir, mode, report, reason, files };
}

function checkJob(raw: unknown): SelectionJobRow | string {
  if (!isObject(raw)) return 'is not an object.';
  const job = oneOf(raw, 'job', JOBS);
  if (job !== 'test' && job !== 'e2e') return job;
  const status = oneOf(raw, 'status', STATUSES);
  if (!(STATUSES as readonly string[]).includes(status)) return status;
  const ranEverything = flag(raw, 'ranEverything');
  if (typeof ranEverything === 'string') return ranEverything;
  const selecting = flag(raw, 'selecting');
  if (typeof selecting === 'string') return selecting;
  const filesRun = whole(raw, 'filesRun', { nullable: true });
  if (typeof filesRun === 'string') return filesRun;
  const filesTotal = whole(raw, 'filesTotal', { nullable: true });
  if (typeof filesTotal === 'string') return filesTotal;
  const prDurationMs = whole(raw, 'prDurationMs', { nullable: true });
  if (typeof prDurationMs === 'string') return prDurationMs;
  const mainDurationMs = whole(raw, 'mainDurationMs', { nullable: true });
  if (typeof mainDurationMs === 'string') return mainDurationMs;

  if (!Array.isArray(raw.changedFiles)) return 'has no list of changedFiles.';
  if (raw.changedFiles.length > MAX_FILES) return `has ${raw.changedFiles.length} changed files; the most one job takes is ${MAX_FILES}.`;
  const changedFiles: SelectionJobRow['changedFiles'] = [];
  const changed = new Set<string>();
  for (const entry of raw.changedFiles) {
    const path = isObject(entry) ? text(entry.path, 500) : null;
    if (!path || !isObject(entry) || typeof entry.ignored !== 'boolean') return 'has a changed file with no path or no ignored flag.';
    if (changed.has(path)) return `has changed file ${path} twice.`;
    changed.add(path);
    changedFiles.push({ path, ignored: entry.ignored });
  }

  if (!Array.isArray(raw.packages)) return 'has no list of packages.';
  if (raw.packages.length > MAX_PACKAGES) return `has ${raw.packages.length} packages; the most one job takes is ${MAX_PACKAGES}.`;
  const packages: SelectionPackage[] = [];
  const names = new Set<string>();
  for (const rawPackage of raw.packages) {
    const checked = checkPackage(rawPackage);
    if (typeof checked === 'string') return checked;
    if (names.has(checked.name)) return `has package ${checked.name} twice.`;
    names.add(checked.name);
    packages.push(checked);
  }

  // A job that did not run has nothing to say about what it ran.
  if (status !== 'ran' && (ranEverything || selecting || packages.length > 0 || filesRun !== null || filesTotal !== null)) {
    return `is ${status} but names packages, files run, or ran everything or selected.`;
  }
  if (ranEverything && selecting) return 'both ran everything and selected.';
  return { job, status: status as SelectionStatus, ranEverything, selecting, filesRun, filesTotal, prDurationMs, mainDurationMs, changedFiles, packages };
}

function checkMiss(raw: unknown): SelectionMiss | string {
  if (!isObject(raw)) return 'is not an object.';
  const job = oneOf(raw, 'job', JOBS);
  if (job !== 'test' && job !== 'e2e') return job;
  const path = text(raw.path, 500);
  if (!path) return 'has no path.';
  const level = text(raw.level, 40);
  if (!level) return 'has no level.';
  const reason = raw.reason === null || raw.reason === undefined ? null : text(raw.reason, 200);
  if (raw.reason !== null && raw.reason !== undefined && reason === null) return 'has a reason that is not a short string.';
  return { job, path, level, reason };
}

function checkPull(raw: unknown): SelectionPull | string {
  if (!isObject(raw)) return 'is not an object.';
  const number = whole(raw, 'number', { min: 1 });
  if (typeof number === 'string') return number;
  const title = text(raw.title, 500, { empty: true });
  if (title === null) return 'has no title.';
  const url = text(raw.url, 500);
  if (!url?.startsWith('https://')) return 'has a url that is not an https address.';
  const merged = typeof raw.mergedAt === 'string' && ISO_TIME.test(raw.mergedAt) ? Date.parse(raw.mergedAt) : Number.NaN;
  if (Number.isNaN(merged)) return 'has a mergedAt that is not an ISO 8601 timestamp with a time zone.';
  if (!Array.isArray(raw.jobs)) return 'has no list of jobs.';
  const jobs: SelectionJobRow[] = [];
  for (const rawJob of raw.jobs) {
    const job = checkJob(rawJob);
    const name = isObject(rawJob) && (JOBS as readonly unknown[]).includes(rawJob.job) ? (rawJob.job as string) : null;
    if (typeof job === 'string') return name ? `job ${name} ${job}` : job;
    if (jobs.some((each) => each.job === job.job)) return `has job ${job.job} twice.`;
    jobs.push(job);
  }
  for (const job of JOBS) if (!jobs.some((each) => each.job === job)) return `has no ${job} job.`;
  if (!Array.isArray(raw.misses)) return 'has no list of misses.';
  if (raw.misses.length > MAX_MISSES) return `has ${raw.misses.length} misses; the most one pull request takes is ${MAX_MISSES}.`;
  const misses: SelectionMiss[] = [];
  for (const [index, rawMiss] of raw.misses.entries()) {
    const miss = checkMiss(rawMiss);
    if (typeof miss === 'string') return `miss ${index} ${miss}`;
    misses.push(miss);
  }
  return { number, title, url, mergedAt: merged, jobs, misses };
}

function checkBars(raw: unknown): SelectionBars | string {
  if (!isObject(raw)) return 'The send has no bars.';
  const windowDays = whole(raw, 'windowDays', { min: 1 });
  if (typeof windowDays === 'string') return `The bars ${windowDays}`;
  const minPulls = whole(raw, 'minPulls', { min: 1 });
  if (typeof minPulls === 'string') return `The bars ${minPulls}`;
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > BAR_IDS.length) return `The bars have no list of 1 to ${BAR_IDS.length} items.`;
  const items: BarSetting[] = [];
  for (const item of raw.items) {
    if (!isObject(item)) return 'A bar is not an object.';
    const id = oneOf(item, 'id', BAR_IDS);
    if (!(BAR_IDS as readonly string[]).includes(id)) return `A bar ${id}`;
    if (items.some((each) => each.id === id)) return `The bars have ${id} twice.`;
    const label = `Bar ${id}`;
    const name = text(item.name, 200);
    if (!name) return `${label} has no name.`;
    const threshold = item.threshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return `${label} has threshold ${JSON.stringify(threshold ?? null)}, which is not a number above zero.`;
    const minOver = whole(item, 'minOver', { nullable: true, min: 1 });
    if (typeof minOver === 'string') return `${label} ${minOver}`;
    const alarmIssue = item.alarmIssue === undefined ? undefined : whole(item, 'alarmIssue', { nullable: true, min: 1 });
    if (typeof alarmIssue === 'string') return `${label} ${alarmIssue}`;
    items.push({ id: id as BarId, name, threshold, minOver, alarmIssue });
  }
  return { windowDays, minPulls, items };
}

/**
 * Checks a whole send. One bad pull request, job, package or file refuses all
 * of it, and the error names the pull request by its position and number and
 * the job, package and file inside it.
 */
export function checkSelection(body: unknown): CheckedSelection {
  const list = isObject(body) ? body.pulls : undefined;
  if (!Array.isArray(list)) return { ok: false, error: 'The body must be {"pulls": [...], "bars": {...}}.' };
  if (list.length === 0) return { ok: false, error: 'The send has no pull requests.' };
  if (list.length > MAX_PULLS) return { ok: false, error: `The send has ${list.length} pull requests; the most one send takes is ${MAX_PULLS}.` };

  const bars = checkBars((body as Fields).bars);
  if (typeof bars === 'string') return { ok: false, error: bars };

  const pulls: SelectionPull[] = [];
  const seen = new Set<number>();
  for (const [index, raw] of list.entries()) {
    const result = checkPull(raw);
    const number = isObject(raw) && typeof raw.number === 'number' ? raw.number : null;
    const label = `Pull request ${index}${number !== null ? ` (#${number})` : ''}`;
    if (typeof result === 'string') return { ok: false, error: `${label}: ${result}` };
    if (seen.has(result.number)) return { ok: false, error: `${label}: is in the send twice.` };
    seen.add(result.number);
    pulls.push(result);
  }
  return { ok: true, pulls, bars };
}
