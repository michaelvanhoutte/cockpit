import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import { LITELLM_URL } from '../../src/prices';
import worker from '../../src/worker';
import litellm from '../fixtures/litellm-prices.json';

export const WRITE_KEY = 'test-write-key';

export const usage = (requestId: string, over: Record<string, unknown> = {}) => ({
  requestId,
  sessionId: 'session_1',
  time: '2026-10-01T10:00:00Z',
  branch: 'claude/build-1',
  category: 'building',
  model: 'claude-sonnet-5-5',
  speed: 'standard',
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationTokens: 30,
  cacheReadTokens: 40,
  subagent: false,
  ranWhere: 'local',
  source: 'hook',
  ...over,
});

/** A write as a real caller makes it, with the right key unless told otherwise. */
export function send(rows: unknown[], headers: Record<string, string> = { authorization: `Bearer ${WRITE_KEY}` }) {
  return SELF.fetch('https://monitor.test/v1/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ rows }),
  });
}

export async function emptyTheDatabase() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM usage_requests'),
    env.DB.prepare('DELETE FROM daily_totals'),
    env.DB.prepare('DELETE FROM daily_split_totals'),
    env.DB.prepare('DELETE FROM session_starts'),
    env.DB.prepare('DELETE FROM price_list'),
    env.DB.prepare('DELETE FROM branch_links'),
    env.DB.prepare('DELETE FROM link_state'),
    env.DB.prepare('DELETE FROM job_runs'),
    env.DB.prepare('DELETE FROM pull_request_stats'),
    env.DB.prepare('DELETE FROM stability_runs'),
    env.DB.prepare('DELETE FROM stability_jobs'),
    env.DB.prepare('DELETE FROM stability_steps'),
    env.DB.prepare('DELETE FROM cycle_time_pulls'),
    env.DB.prepare('DELETE FROM cycle_time_rounds'),
    env.DB.prepare('DELETE FROM cycle_time_checks'),
    env.DB.prepare('DELETE FROM cycle_time_failures'),
    env.DB.prepare('DELETE FROM selection_pulls'),
    env.DB.prepare('DELETE FROM selection_packages'),
    env.DB.prepare('DELETE FROM selection_files'),
    env.DB.prepare('DELETE FROM selection_changed_files'),
    env.DB.prepare('DELETE FROM selection_misses'),
    env.DB.prepare('DELETE FROM selection_bars'),
    env.DB.prepare('DELETE FROM claude_calls'),
    env.DB.prepare('DELETE FROM claude_call_daily_totals'),
    env.DB.prepare('DELETE FROM claude_call_place'),
    env.DB.prepare('DELETE FROM claude_call_job_runs'),
    env.DB.prepare('DELETE FROM tests_trees'),
    env.DB.prepare('DELETE FROM tests_area_lines'),
    env.DB.prepare('DELETE FROM tests_current'),
  ]);
}

/** A step as the Stability job sends it, `ms` long. */
export const stabilityStep = (name: string, ms: number | null, over: Record<string, unknown> = {}) => ({
  number: 1,
  name,
  occurrence: 1,
  conclusion: 'success',
  startedAt: '2026-10-01T10:00:00Z',
  completedAt: '2026-10-01T10:01:00Z',
  durationMs: ms,
  ...over,
});

/** A job as the Stability job sends it, `ms` long, that passed unless told otherwise. */
export const stabilityJob = (name: string, ms: number | null, over: Record<string, unknown> = {}) => ({
  name,
  status: 'completed',
  conclusion: 'success',
  outcome: 'pass',
  startedAt: '2026-10-01T10:00:00Z',
  completedAt: '2026-10-01T10:05:00Z',
  durationMs: ms,
  failedStep: null,
  url: 'https://github.com/o/r/actions/runs/1/job/1',
  steps: [],
  ...over,
});

/** A run of CI on `main` as the Stability job sends it, started at `createdAt`, that passed unless told otherwise. */
export const stabilityRun = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  workflow: 'CI',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
  outcome: 'pass',
  headSha: 'a'.repeat(40),
  createdAt: '2026-10-01T10:00:00Z',
  url: `https://github.com/o/r/actions/runs/${id}`,
  jobs: [stabilityJob('Test', 300_000, { steps: [stabilityStep('Run the tests', 240_000)] })],
  ...over,
});

/** A send of runs as the Stability job makes it, with the right key unless told otherwise. */
export function sendRuns(runs: unknown[], headers: Record<string, string> = { authorization: `Bearer ${WRITE_KEY}` }) {
  return SELF.fetch('https://monitor.test/v1/stability', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ runs }),
  });
}

/** What is stored: each run with its conclusion, and how many jobs and steps sit under it. */
export async function storedRuns(): Promise<{ run_id: number; conclusion: string | null; jobs: number; steps: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.run_id, r.conclusion,
            (SELECT COUNT(*) FROM stability_jobs j WHERE j.run_id = r.run_id) AS jobs,
            (SELECT COUNT(*) FROM stability_steps s WHERE s.run_id = r.run_id) AS steps
     FROM stability_runs r ORDER BY r.run_id`,
  ).all<{ run_id: number; conclusion: string | null; jobs: number; steps: number }>();
  return results;
}

/** A check that held a round up `ms`, that passed unless told otherwise, as the Cycle time job sends it. */
export const cycleCheck = (name: string, ms: number, over: Record<string, unknown> = {}) => ({
  name,
  attempt: 1,
  heldMs: ms,
  last: false,
  failure: null,
  flukeMs: null,
  queuedMs: null,
  detailNotRecorded: false,
  noFileFailed: false,
  failedSteps: [],
  failedFiles: [],
  ...over,
});

/** A round of `checks`, pushed at `pushedAt` and `ms` long, that went green unless told otherwise. */
export const cycleRound = (checks: unknown[], over: Record<string, unknown> = {}) => ({
  sha: 'b'.repeat(40),
  pushedAt: '2026-10-01T10:00:00Z',
  endedAt: '2026-10-01T10:05:00Z',
  ms: 300_000,
  red: false,
  commits: 1,
  queueNotRecorded: false,
  checks,
  ...over,
});

/** A merged pull request as the Cycle time job sends it: recorded, one green round of one check, merged at `mergedAt`. */
export const cyclePull = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  mergedAt: '2026-10-01T12:00:00Z',
  base: 'main',
  head: `claude/${number}-work`,
  landing: false,
  size: { additions: 30, deletions: 10, files: 3, commits: 2, mainMerges: 0 },
  start: { at: '2026-10-01T08:00:00Z', from: 'session-record' },
  recorded: true,
  codingMs: 600_000,
  localMs: 300_000,
  ciMs: 300_000,
  waitingToMergeMs: 60_000,
  awayMs: 0,
  totalMs: 14_400_000,
  localReviews: { count: 2, ms: 300_000, byKind: { 'code-review': { count: 1, ms: 180_000 }, 'security-review': { count: 1, ms: 120_000 } } },
  localRuns: { test: null, browser: null },
  runnerMs: 600_000,
  cancelled: { superseded: { runs: 0, ms: 0 }, other: { runs: 0, ms: 0 } },
  rounds: [cycleRound([cycleCheck('Test', 300_000, { last: true })])],
  ...over,
});

/** A send of pull requests as the Cycle time job makes it, with the right key unless told otherwise. */
export function sendPulls(pulls: unknown[], headers: Record<string, string> = { authorization: `Bearer ${WRITE_KEY}` }) {
  return SELF.fetch('https://monitor.test/v1/cycle-time', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ pulls }),
  });
}

/** What is stored: each pull request with how many rounds, checks and failing items sit under it. */
export async function storedPulls(): Promise<{ pull_number: number; recorded: number; rounds: number; checks: number; failures: number; fluke_ms: number | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.pull_number, p.recorded,
            (SELECT COUNT(*) FROM cycle_time_rounds r WHERE r.pull_number = p.pull_number) AS rounds,
            (SELECT COUNT(*) FROM cycle_time_checks c WHERE c.pull_number = p.pull_number) AS checks,
            (SELECT COUNT(*) FROM cycle_time_failures f WHERE f.pull_number = p.pull_number) AS failures,
            (SELECT SUM(c.fluke_ms) FROM cycle_time_checks c WHERE c.pull_number = p.pull_number) AS fluke_ms
     FROM cycle_time_pulls p ORDER BY p.pull_number`,
  ).all<{ pull_number: number; recorded: number; rounds: number; checks: number; failures: number; fluke_ms: number | null }>();
  return results;
}

/** A file a job ran, picked by an import chain from a changed file unless told otherwise. */
export const selectionFile = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  level: 'unit',
  status: 'passed',
  selectedBy: { kind: 'chain', chain: [path, 'apps/api/src/a.ts'], text: `${path} → apps/api/src/a.ts` },
  ...over,
});

/** A package that selected rather than ran everything, with the files it ran. */
export const selectionPackage = (name: string, files: unknown[], over: Record<string, unknown> = {}) => ({
  name,
  dir: `apps/${name}`,
  mode: 'changed',
  report: 'written',
  reason: null,
  files,
  ...over,
});

/** A package that ran everything because `rule` named `path`; its files were not picked, the package ran them all. */
export const fullPackage = (name: string, rule: string, path: string | null, paths: string[] = []) =>
  selectionPackage(
    name,
    paths.map((p) => selectionFile(p, { selectedBy: { kind: 'full' } })),
    { mode: 'full', reason: { rule, path } },
  );

/** One job of a pull request: it ran and selected unless told otherwise. */
export const selectionJob = (job: 'test' | 'e2e', over: Record<string, unknown> = {}) => ({
  job,
  status: 'ran',
  ranEverything: false,
  selecting: true,
  filesRun: 12,
  filesTotal: 300,
  prDurationMs: job === 'test' ? 90_000 : null,
  mainDurationMs: job === 'test' ? 400_000 : null,
  changedFiles: [{ path: 'apps/api/src/a.ts', ignored: false }],
  packages: [],
  ...over,
});

/** A job that ran everything for `rule` (`path`). */
export const ranEverything = (job: 'test' | 'e2e', rule: string, path: string | null, paths: string[] = []) =>
  selectionJob(job, { ranEverything: true, selecting: false, filesRun: paths.length, packages: [fullPackage(job === 'e2e' ? 'e2e' : 'api', rule, path, paths)] });

/** A job that never started, the diff touching nothing it checks. */
export const docsOnly = (job: 'test' | 'e2e') =>
  selectionJob(job, { status: 'docs-only', selecting: false, filesRun: null, filesTotal: null, prDurationMs: null, mainDurationMs: null, packages: [] });

/** A merged pull request as the Selection job sends it: both jobs selected, no miss, merged at `mergedAt`. */
export const selectionPull = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  mergedAt: '2026-10-01T12:00:00Z',
  jobs: [selectionJob('test'), selectionJob('e2e')],
  misses: [],
  ...over,
});

/** The bars as the tool sends them: its thresholds, and no open alarm. */
export const selectionBars = (over: Record<string, unknown> = {}, items?: Record<string, unknown>[]) => ({
  windowDays: 14,
  minPulls: 20,
  items: items ?? [
    { id: 'e2e-forced-full', name: 'E2E forced to run every spec', threshold: 0.25, minOver: null, alarmIssue: null },
    { id: 'test-forced-full', name: 'Test forced to run everything', threshold: 0.25, minOver: null, alarmIssue: null },
    { id: 'misses', name: 'Misses', threshold: 1, minOver: null, alarmIssue: null },
    { id: 'most-selected', name: 'A test selected on nearly every pull request', threshold: 0.8, minOver: 10, alarmIssue: null },
  ],
  ...over,
});

/** A send of pull requests as the Selection job makes it, with the right key unless told otherwise. */
export function sendSelection(pulls: unknown[], bars: unknown = selectionBars(), headers: Record<string, string> = { authorization: `Bearer ${WRITE_KEY}` }) {
  return SELF.fetch('https://monitor.test/v1/selection', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ pulls, bars }),
  });
}

/** What is stored: each pull request and job with how many packages, files and changed files sit under it. */
export async function storedSelection(): Promise<{ pull_number: number; job: string; status: string; packages: number; files: number; changed: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.pull_number, p.job, p.status,
            (SELECT COUNT(*) FROM selection_packages k WHERE k.pull_number = p.pull_number AND k.job = p.job) AS packages,
            (SELECT COUNT(*) FROM selection_files f WHERE f.pull_number = p.pull_number AND f.job = p.job) AS files,
            (SELECT COUNT(*) FROM selection_changed_files c WHERE c.pull_number = p.pull_number AND c.job = p.job) AS changed
     FROM selection_pulls p ORDER BY p.pull_number, p.job`,
  ).all<{ pull_number: number; job: string; status: string; packages: number; files: number; changed: number }>();
  return results;
}

/** `count` areas, named `Area 1` onwards, the first holding the rest beneath it as the product's tree nests. */
export const testsAreas = (count: number) => Array.from({ length: count }, (_, i) => `Area ${i + 1}`);

/** A tree as the test explorer sends it: the model without source lines, one rule in each area. */
export const testsTree = (commit: string, areas: string[], over: Record<string, unknown> = {}) => {
  const node = (key: string) => ({
    key,
    label: key,
    counts: { L1: 1 },
    rules: [{ concept: key, statement: `a rule of ${key}`, level: 'L1', file: 'a.test.ts', line: 3, cases: [], todoCases: [] }],
    filesNothingRuns: [],
    branchesNothingTakes: null,
    path: [],
    children: [] as unknown[],
  });
  const [first, ...rest] = areas.map(node);
  if (first) first.children = rest;
  return { commit, commitUrl: null, generatedAt: '2026-10-24T03:00:00.000Z', coverageAvailable: true, tree: first ? [first] : [], ...over };
};

const gzip = async (value: unknown) =>
  new Uint8Array(await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());

/** One part of a snapshot's tests, `main`'s unless told, as the test explorer sends it, gzipped, with the write key. */
async function sendTestsPart(commit: string, part: string, value: unknown, to = 'main') {
  return SELF.fetch(`https://monitor.test/v1/tests/${to}/${commit}/${part}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/gzip', authorization: `Bearer ${WRITE_KEY}` },
    body: await gzip(value),
  });
}

export const sendTestsTree = (commit: string, tree: unknown, to = 'main') => sendTestsPart(commit, 'tree', tree, to);
export const sendTestsArea = (commit: string, area: string, lines: unknown = { 'a.test.ts:3': [{ line: 3, text: `it('${area}')` }] }, to = 'main') =>
  sendTestsPart(commit, `areas/${encodeURIComponent(area)}`, lines, to);
export const showTests = (commit: string, to = 'main') =>
  SELF.fetch(`https://monitor.test/v1/tests/${to}/${commit}/current`, { method: 'POST', headers: { authorization: `Bearer ${WRITE_KEY}` } });

/** Sends the tree and every one of `areas`' source lines, each answered 200, without making them current. */
export async function sendEveryTestsPart(commit: string, areas: string[], over: Record<string, unknown> = {}) {
  const statuses = [(await sendTestsTree(commit, testsTree(commit, areas, over))).status];
  for (const area of areas) statuses.push((await sendTestsArea(commit, area)).status);
  if (statuses.some((s) => s !== 200)) throw new Error(`a part was refused: ${statuses.join(', ')}`);
}

/**
 * A whole snapshot sent and shown, as `main`'s unless `to` names a pull request's (`pr-9001`): the tree, then each
 * area's source lines (those `lines` names, else none), then the switch. Every part must be answered 200.
 */
export async function sendTestsModel(snapshot: { commit: string; tree: { key: string; children: unknown[] }[] }, lines: Record<string, unknown> = {}, to = 'main') {
  const keys: string[] = [];
  const collect = (nodes: { key: string; children: unknown[] }[]) => {
    for (const node of nodes) {
      keys.push(node.key);
      collect(node.children as { key: string; children: unknown[] }[]);
    }
  };
  collect(snapshot.tree);
  const statuses = [(await sendTestsTree(snapshot.commit, snapshot, to)).status];
  for (const key of keys) statuses.push((await sendTestsArea(snapshot.commit, key, lines[key] ?? {}, to)).status);
  statuses.push((await showTests(snapshot.commit, to)).status);
  if (statuses.some((s) => s !== 200)) throw new Error(`a part was refused: ${statuses.join(', ')}`);
}

/** The tests' JSON answer, as a reader asks for it: `main`'s, or with `pr` that pull request's. */
export async function theTests(pr?: number): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(`https://monitor.test/tests?format=json${pr === undefined ? '' : `&pr=${pr}`}`);
  if (response.status !== 200) throw new Error(`/tests answered ${response.status}`);
  return response.json();
}

/** Every commit of a snapshot (`main`'s unless told) with parts stored, how many area parts it holds, and which commit is shown. */
export async function storedTests(snapshot = 'main'): Promise<{ commits: { commit: string; areas: number }[]; current: string | null }> {
  const { results } = await env.DB.prepare(
    `SELECT t.commit_sha, (SELECT COUNT(*) FROM tests_area_lines l WHERE l.snapshot = t.snapshot AND l.commit_sha = t.commit_sha) AS areas
     FROM tests_trees t WHERE t.snapshot = ?1
     UNION SELECT l.commit_sha, COUNT(*) FROM tests_area_lines l
     WHERE l.snapshot = ?1 AND NOT EXISTS (SELECT 1 FROM tests_trees t WHERE t.snapshot = l.snapshot AND t.commit_sha = l.commit_sha) GROUP BY l.commit_sha
     ORDER BY 1`,
  )
    .bind(snapshot)
    .all<{ commit_sha: string; areas: number }>();
  const current = await env.DB.prepare('SELECT commit_sha FROM tests_current WHERE snapshot = ?1').bind(snapshot).first<{ commit_sha: string }>();
  return { commits: results.map((r) => ({ commit: r.commit_sha, areas: r.areas })), current: current?.commit_sha ?? null };
}

export interface Total {
  day: string;
  category: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

/** The token totals; dollars are read by `dollars()`. */
export async function totals(): Promise<Total[]> {
  const { results } = await env.DB.prepare(
    `SELECT day, category, model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
     FROM daily_totals ORDER BY day, category, model`,
  ).all<Total>();
  return results;
}

export async function storedRequestIds(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT request_id FROM usage_requests ORDER BY request_id').all<{
    request_id: string;
  }>();
  return results.map((r) => r.request_id);
}

/** The recorded slice of LiteLLM's file, as the network served it. */
export const recordedFile = litellm as Record<string, Record<string, unknown>>;

/** What LiteLLM's address answers, from now on; any other address a test reaches for is an error. */
export function theFileAnswers(answer: unknown) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== LITELLM_URL) throw new Error(`nothing in a test may reach ${url}`);
    if (answer instanceof Response) return answer.clone();
    if (typeof answer === 'function') return (answer as () => Response)();
    return Response.json(answer);
  });
}

type WorkerSetting = 'GITHUB_TOKEN' | 'GITHUB_REPOSITORY' | 'USAGE_READ_TOKEN' | 'COCKPIT_URL';

/** Gives the Worker these settings, and returns what puts each back as it was. */
export function giveTheWorker(settings: Partial<Record<WorkerSetting, string>>) {
  const given = Object.entries(settings) as [WorkerSetting, string][];
  const before = given.map(([name]) => [name, env[name]] as const);
  for (const [name, value] of given) env[name] = value;
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  };
}

/** The day's two schedules, prices then totals, run the way the platform runs them. */
export async function runTheDailyJob() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '10 3 * * *' }), env, ctx);
  await worker.scheduled(createScheduledController({ cron: '20 3 * * *' }), env, ctx);
  await waitOnExecutionContext(ctx);
}

export interface Priced {
  request_id: string;
  cost_micros: number | null;
  price_basis: string | null;
}

export async function pricing(): Promise<Priced[]> {
  const { results } = await env.DB.prepare(
    'SELECT request_id, cost_micros, price_basis FROM usage_requests ORDER BY request_id',
  ).all<Priced>();
  return results;
}

/** What the totals say in dollars, and how many requests they leave out of it. */
export async function dollars(): Promise<{ micros: number; unpriced: number }> {
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(cost_micros), 0) AS micros, COALESCE(SUM(unpriced_requests), 0) AS unpriced FROM daily_totals',
  ).first<{ micros: number; unpriced: number }>();
  return row!;
}

/** The public page exactly as the address asks for it; the bare address is Over time. */
export async function theBarePage(query = ''): Promise<string> {
  return (await SELF.fetch(`https://monitor.test/${query}`)).text();
}

/** The public page as a visitor opens it, with the filters in the address (`?group=issue&period=all`); by pull request unless the address names a grouping. */
export async function thePage(query = ''): Promise<string> {
  if (/[?&]group=/.test(query)) return theBarePage(query);
  return theBarePage(`${query === '' ? '?' : `${query}&`}group=pr`);
}

export interface CostRow {
  /** The first cell: what the row is. */
  label: string;
  /** The line under it, if any. */
  sub: string | null;
  /** The cells between the label and the split bar: engineer and merged for pull requests, the pull request count for issues and engineers. */
  details: string[];
  /** What hovering the row's bar says, each colour with its dollars in the colouring's order and joined by " · "; '' for a row that draws no bar. */
  colours: string;
  /** The colour of each segment of the row's bar, left to right. */
  fills: string[];
  /** How many coloured segments the row's split bar is drawn with. */
  segments: number;
  /** Each segment's width as a percentage of the track, left to right; none for a row that draws no bar. */
  widths: number[];
  total: string;
  unpriced: string | null;
  /** The cells after Total: a day's Input, Output, Cache write and Cache read; none for any other grouping. */
  tokens: string[];
}

/** The rows of the page's cost table, in the order shown. */
export function costRows(html: string): CostRow[] {
  const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return [...html.matchAll(/<tr>(<td class="first">.*?)<\/tr>/gs)].map(([, row]) => {
    const all = [...row!.matchAll(/<td([^>]*)>(.*?)<\/td>/gs)];
    const cells = all.map((m) => m[2]!);
    const [first, ...rest] = cells;
    const split = rest.findIndex((c) => c.startsWith('<div class="split'));
    const totalAt = all.slice(1).findIndex((m) => m[1]!.includes('class="num mono total"'));
    const [, label, sub] = /^(.*?)(?:<div class="muted small">(.*?)<\/div>)?$/s.exec(first!)!;
    const [, total, unpriced] = /^([^<]*?)(?: <span class="unpriced">(.*?)<\/span>)?$/.exec(rest[totalAt]!)!;
    const widths = [...rest[split]!.matchAll(/<div style="width:([\d.]+)%/g)].map((m) => Number(m[1]));
    return {
      label: decode(label!.replace(/<\/?a[^>]*>/g, '')),
      sub: sub === undefined ? null : decode(sub.replace(/<\/?a[^>]*>/g, '').replace(/ · Sessions$/, '')),
      details: rest.slice(0, split).map(decode),
      colours: decode(/ title="([^"]*)"/.exec(all.slice(1)[split]![1]!)?.[1] ?? ''),
      fills: [...rest[split]!.matchAll(/;background:([^"]*)"/g)].map((m) => m[1]!),
      segments: widths.length,
      widths,
      total: total!,
      unpriced: unpriced ?? null,
      tokens: rest.slice(totalAt + 1),
    };
  });
}

/** What the page says the period's dollars were, and how they split by category: the heading and the bar's own description. */
export function whereItWent(html: string): { heading: string; bar: string } {
  return {
    heading: /<h2 id="where">(.*?)<\/h2>/s.exec(html)![1]!.replace(/&rsquo;/g, "'"),
    bar: /<div class="bar" role="img" aria-label="(.*?)">/s.exec(html)![1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))),
  };
}

/** A pull request's page as a visitor opens it. */
export const thePullRequest = (number: number | string, query = '') => SELF.fetch(`https://monitor.test/pr/${number}${query}`);

const decodeHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&rsquo;/g, "'");

/** What a pull request's page says: its total, its categories with their dollars and details, its sessions. */
export function pullRequestFigures(html: string) {
  const total = decodeHtml(/<div class="mono big" id="pr-total">(.*?)<\/div>/s.exec(html)![1]!);
  const categories = [...html.matchAll(/<div class="cat"><div class="cat-name">(.*?)<\/div><div class="track">.*?<div class="num mono">(.*?)<\/div><div class="muted small">(.*?)<\/div><\/div>/gs)].map(
    ([, name, amount, detail]) => ({ name: decodeHtml(name!), amount: decodeHtml(amount!), detail: decodeHtml(detail!) }),
  );
  const sessions = [...html.matchAll(/<tr class="session"><td class="mono small">(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td class="num mono">(.*?)<\/td><td class="num mono">(.*?)<\/td><td class="num mono total">(.*?)<\/td>/gs)].map(
    ([, id, where, models, requests, tokens, cost]) => ({
      id: decodeHtml(id!),
      where: decodeHtml(where!),
      models: decodeHtml(models!),
      requests: decodeHtml(requests!),
      tokens: decodeHtml(tokens!),
      cost: decodeHtml(cost!),
    }),
  );
  return { total, categories, sessions };
}

/** The agent lines under each session, in the order shown: the main agent, then each subagent indented. */
export function agentLines(html: string) {
  return [...html.matchAll(/<tr class="agent (main|subagent)"[^>]*><td class="agent-name( indent)?">(.*?)<\/td><td><\/td><td>(.*?)<\/td><td class="num mono">(.*?)<\/td><td class="num mono">(.*?)<\/td><td class="num mono">(.*?)<\/td><td class="num mono">(.*?)<\/td><\/tr>/gs)].map(
    ([, kind, indent, name, models, requests, tokens, cost, share]) => ({
      kind: kind!,
      indented: indent !== undefined,
      name: decodeHtml(name!).trim(),
      models: decodeHtml(models!),
      requests: decodeHtml(requests!),
      tokens: decodeHtml(tokens!),
      cost: decodeHtml(cost!),
      share: decodeHtml(share!),
    }),
  );
}

/** Dollars in a page's words ("$12.50", "$3.00 + 1 unpriced") as millionths. */
export const micros = (text: string) => Math.round(Number(/\$([\d,]+\.\d\d)/.exec(text)![1]!.replace(/,/g, '')) * 1e6);

/** The CSV export as a visitor downloads it: the response, and its lines split into cells. */
export async function theExport(query = '') {
  const response = await SELF.fetch(`https://monitor.test/export.csv${query}`);
  const text = await response.text();
  const lines = text === '' ? [] : text.replace(/\r\n$/, '').split('\r\n');
  return { response, text, header: lines[0]!.split(','), rows: lines.slice(1).map((l) => l.split(',')) };
}

/** The recorded price list, stored, so what a test then sends is priced at arrival: claude-sonnet-5 is $2 per million input tokens. */
export async function withPrices() {
  theFileAnswers(recordedFile);
  await runTheDailyJob();
  vi.unstubAllGlobals();
}

/** A request that costs exactly `dollars`, priced from the recorded list (see withPrices). */
export const spend = (requestId: string, dollars: number, over: Record<string, unknown> = {}) =>
  usage(requestId, {
    model: 'claude-sonnet-5',
    inputTokens: dollars * 500_000,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...over,
  });

/** The names over the cost table's columns, left to right, without their sort marks or links. */
export function tableHeads(html: string): string[] {
  const head = /<table class="costs">\s*<thead><tr>(.*?)<\/tr><\/thead>/s.exec(html)?.[1] ?? '';
  return [...head.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, '').replace(/ ▾$/, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))));
}

export interface SentenceChoice {
  /** What the choice reads now. */
  chosen: string;
  /** Every choice it offers. */
  offered: string[];
  /** The choices it offers but will not take. */
  disabled: string[];
  /** Whether it holds a value, as a filter does. */
  held: boolean;
}

/** The band's sentence and its filters as a visitor sees them: each choice by the address parameter it sets, and the sentence with its choices in brackets. */
export function theSentence(html: string): { text: string; choices: Record<string, SentenceChoice>; pinned: boolean } {
  const decode = (t: string) => t.replace(/<[^>]*>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&rsquo;/g, '’');
  const band = /<div class="band band-controls">(.*?)<\/form><\/div>/s.exec(html)?.[1] ?? '';
  const choices: Record<string, SentenceChoice> = {};
  for (const [, name, attributes, options] of band.matchAll(/<select name="(\w+)" aria-label="[^"]*"([^>]*)>(.*?)<\/select>/gs)) {
    const all = [...options!.matchAll(/<option value="[^"]*"([^>]*)>(.*?)<\/option>/g)].map(([, a, text]) => ({ text: decode(text!), selected: a!.includes(' selected'), disabled: a!.includes(' disabled') }));
    choices[name!] = { chosen: all.find((o) => o.selected)!.text, offered: all.map((o) => o.text), disabled: all.filter((o) => o.disabled).map((o) => o.text), held: attributes!.includes(' data-set') };
  }
  const sentence = /<p class="sentence">(.*?)<\/p>/s.exec(band)?.[1] ?? '';
  const text = decode(sentence.replace(/<select[^>]*>.*?<\/select>/gs, (m) => `[${/<option value="[^"]*" selected[^>]*>(.*?)<\/option>/.exec(m)![1]}]`)).replace(/\s+/g, ' ').trim();
  return { text, choices, pinned: /\.band-controls\{position:sticky;top:0/.test(html) };
}

export interface SplitTotal {
  day: string;
  branch: string;
  category: string;
  model: string;
  ran_where: string;
  subagent: number;
  requests: number;
  cost_micros: number;
  unpriced_requests: number;
  last_at: number;
}

/** The totals the costs page reads, one row per key. */
export async function splitTotals(): Promise<SplitTotal[]> {
  const { results } = await env.DB.prepare(
    `SELECT day, branch, category, model, ran_where, subagent, requests, cost_micros, unpriced_requests, last_at
     FROM daily_split_totals ORDER BY day, branch, category, model, ran_where, subagent`,
  ).all<SplitTotal>();
  return results;
}

/** The tokens the split totals hold, one row per key: branch, model, then input, output, cache write and cache read. */
export async function splitTokens(): Promise<[string, string, number, number, number, number][]> {
  const { results } = await env.DB.prepare(
    `SELECT branch, model, input_tokens AS i, output_tokens AS o, cache_creation_tokens AS w, cache_read_tokens AS r
     FROM daily_split_totals ORDER BY day, branch, category, model, ran_where, subagent`,
  ).all<{ branch: string; model: string; i: number; o: number; w: number; r: number }>();
  return results.map((t) => [t.branch, t.model, t.i, t.o, t.w, t.r]);
}

/** A pull request merged on `mergedAt` that changed `lines` lines, on branch b/<number>. */
export async function merged(number: number, mergedAt: string, lines: number, engineer = 'alice') {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO branch_links (branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at)
       VALUES (?1, ?2, 'T', 'MERGED', ?3, NULL, ?4, ?3, 0)`,
    ).bind(`b/${number}`, number, mergedAt, engineer),
    env.DB.prepare(`INSERT INTO pull_request_stats (pr_number, lines_added, lines_removed, pr_updated_at, read_at) VALUES (?1, ?2, ?3, ?4, 0)`).bind(
      number,
      lines - 100,
      100,
      mergedAt,
    ),
  ]);
}
