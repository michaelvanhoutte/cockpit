import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import worker from '../../src/worker';
import recorded from './fixtures/cockpit-claude-calls.json';
import refused from './fixtures/cockpit-claude-calls-refused.json';
import { giveTheWorker } from './support';

/** Where the tests' Cockpit answers; production's real address is never reached. */
export const COCKPIT = 'https://cockpit.test';
export const READ_TOKEN = 'test-read-token';

/** A call as production's route sent it, recorded from the real route (fixtures/cockpit-claude-calls.json). */
export interface Call {
  id: number;
  at: string;
  environment: string;
  feature: string;
  promptVersion: string | null;
  startedBy: string | null;
  model: string;
  outcome: string;
  tokensIn: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  pullRequest: number | null;
  runId: number | null;
  branch: string | null;
}

/** The recorded calls: 1004 and 1005 production's, priced; 1006 and 1007 one CI run on pull request 1505, 1007 unpriced; 1008 local, 1010 staging, both unpriced. */
export const RECORDED_CALLS: Call[] = recorded.calls as Call[];

/** A recorded call (1004 unless told) with some of its fields replaced. */
export const callLike = (over: Partial<Call> & { id: number }, from = 1004): Call => ({
  ...structuredClone(RECORDED_CALLS.find((c) => c.id === from)!),
  ...over,
});

/** `n` calls numbered 1 to n, cycling through the recorded ones. */
export const numberedCalls = (n: number): Call[] =>
  Array.from({ length: n }, (_, i) => ({ ...structuredClone(RECORDED_CALLS[i % RECORDED_CALLS.length]!), id: i + 1 }));

/** Cockpit's 401, as the real route answered a wrong token. */
export const tokenRefused = () => Response.json(refused.body, { status: refused.status });

export interface CockpitCall {
  after: string | null;
  authorization: string | null;
}

/**
 * A Cockpit production that can be reached from inside a test, by replacing
 * `fetch` (see github-support.ts). Any other address is refused.
 */
export function fakeCockpit(answer: (call: CockpitCall, calls: CockpitCall[]) => Response | Promise<Response>) {
  const calls: CockpitCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== COCKPIT || url.pathname !== '/v1/usage-records') throw new Error(`Unexpected request to ${url.href}`);
    const call = { after: url.searchParams.get('after'), authorization: new Headers(init?.headers).get('authorization') };
    calls.push(call);
    return answer(call, calls);
  });
  return calls;
}

/** The route paging through `all` by row number, `size` calls a page, as production does. */
export const theRoute =
  (all: Call[], size = 1000) =>
  (call: CockpitCall) => {
    const after = Number(call.after ?? 0);
    const rest = all.filter((c) => c.id > after);
    return Response.json({ calls: rest.slice(0, size), more: rest.length > size });
  };

/** Gives the Worker the read token and Cockpit's address, and returns what puts both back as they were. */
export const giveTheWorkerTheReadToken = () => giveTheWorker({ USAGE_READ_TOKEN: READ_TOKEN, COCKPIT_URL: COCKPIT });

/** A cron firing, entered through the Worker's own scheduled handler. */
export async function fire(cron: string) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron }), env, ctx);
  await waitOnExecutionContext(ctx);
}

/** The import's schedule firing. */
export const runTheImport = () => fire('30 */12 * * *');

/** The nightly rebuild's schedule firing. */
export const runTheRebuild = () => fire('20 3 * * *');

/** The production row numbers copied. */
export async function theCopies(): Promise<number[]> {
  const { results } = await env.DB.prepare('SELECT id FROM claude_calls ORDER BY id').all<{ id: number }>();
  return results.map((r) => r.id);
}

export interface CallTotal {
  day: string;
  environment: string;
  feature: string;
  model: string;
  started_by: string;
  pull_request: number;
  run_id: number;
  calls: number;
  cost_micros: number;
  unpriced_calls: number;
}

/** The daily totals of the copies, one row per key. */
export async function theCallTotals(): Promise<CallTotal[]> {
  const { results } = await env.DB.prepare(
    `SELECT day, environment, feature, model, started_by, pull_request, run_id, calls, cost_micros, unpriced_calls
     FROM claude_call_daily_totals ORDER BY day, environment, feature, model, started_by, pull_request, run_id`,
  ).all<CallTotal>();
  return results;
}

/** The row number the next import continues after; null before any import stored one. */
export async function thePlace(): Promise<number | null> {
  return (await env.DB.prepare('SELECT after_id AS after FROM claude_call_place WHERE id = 1').first<{ after: number }>())?.after ?? null;
}

/** Cockpit serves these calls and the import copies them, the way a run does, then the fake goes away. */
export async function importTheCalls(calls: Call[]) {
  fakeCockpit(theRoute(calls));
  await runTheImport();
  vi.restoreAllMocks();
}

/** The Cockpit's Claude calls page exactly as the address asks for it; the bare address is Over time. */
export const theCallsPage = async (query = ''): Promise<string> => (await SELF.fetch(`https://monitor.test/claude-calls${query}`)).text();

/** The calls export as a visitor downloads it: the response, and its lines split into cells. */
export async function theCallsExport(query = '') {
  const response = await SELF.fetch(`https://monitor.test/claude-calls/export.csv${query}`);
  const text = await response.text();
  const lines = text === '' ? [] : text.replace(/\r\n$/, '').split('\r\n');
  return { response, text, header: lines[0]!.split(','), rows: lines.slice(1).map((l) => l.split(',')) };
}

const plain = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&rsquo;/g, "'")
    .trim();

export interface CallsRow {
  /** The first cell: what the row is. */
  label: string;
  /** The line under it, if any. */
  sub: string | null;
  /** Where the first cell leads: the pull request on GitHub, and the Monitor's own page for it. */
  links: string[];
  calls: string;
  /** How many coloured segments the row's split bar is drawn with. */
  segments: number;
  /** Dollars per column of the split, left to right; '—' for none. */
  cells: string[];
  total: string;
}

/** The rows of the page's table, in the order shown. */
export function callsRows(html: string): CallsRow[] {
  const table = /<table class="calls">(.*?)<\/table>/s.exec(html)?.[1] ?? '';
  return [...table.matchAll(/<tr><td class="first">(.*?)<\/td><td class="num muted">(.*?)<\/td><td class="split-cell"><div class="split[^"]*">(.*?)<\/div><\/td>(.*?)<td class="num total">(.*?)<\/td><\/tr>/gs)].map(
    ([, first, calls, split, cells, total]) => {
      const [, label, sub] = /^(.*?)(?:<div class="muted small">(.*?)<\/div>)?$/s.exec(first!)!;
      return {
        label: plain(label!),
        sub: sub === undefined ? null : plain(sub),
        links: [...first!.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!),
        calls: plain(calls!),
        segments: [...split!.matchAll(/<div style="width/g)].length,
        cells: [...cells!.matchAll(/<td class="num">(.*?)<\/td>/gs)].map((m) => plain(m[1]!)),
        total: plain(total!),
      };
    },
  );
}

/** The names over the split's columns, left to right. */
export function callsColumns(html: string): string[] {
  const found = /<th scope="col" class="split-head">Split<\/th>(.*?)<th scope="col" class="num">Total<\/th>/s.exec(html);
  return found ? [...found[1]!.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => plain(m[1]!)) : [];
}

/** The page without its (i)s and the explanations they open, so a panel reads as its figures alone. */
export const withoutExplanations = (html: string) =>
  html.replace(/<button type="button" class="info"[^>]*>i<\/button>/g, '').replace(/<div id="x-[^"]*" popover="manual" class="explain-pop">.*?<\/div>/gs, '');

/** The tiles: Spent, Calls and, but for all time, the comparison. */
export const callsTiles = (html: string) =>
  [...withoutExplanations(html).matchAll(/<div class="tile[^"]*"><span class="tile-label">(.*?)<\/span><span class="tile-value">(.*?)<\/span><span class="tile-note">(.*?)<\/span><\/div>/g)].map(
    ([, label, value, note]) => ({ label: plain(label!), value: plain(value!), note: plain(note!) }),
  );

/** The panel that says where the dollars went: its heading, and each series with its dollars and share. */
export function callsWhereItWent(html: string) {
  return {
    heading: plain(/<h2 id="where">(.*?)<\/h2>/s.exec(html)![1]!),
    shares: [...html.matchAll(/<li><i [^>]*><\/i><span class="name">(.*?)<\/span><span class="amount">(.*?)<\/span><span class="share">(.*?)<\/span><\/li>/g)].map(
      ([, name, amount, share]) => ({ name: plain(name!), amount: plain(amount!), share: plain(share!) }),
    ),
  };
}

/** The largest changes: the panel's heading and each change; null where the page draws no such panel. */
export function callsChanges(html: string) {
  const panel = /<h2 id="changes">(.*?)<\/h2>.*?<ul class="well changes">(.*?)<\/ul>/s.exec(html);
  if (!panel) return null;
  return {
    heading: plain(panel[1]!),
    items: [...panel[2]!.matchAll(/<li><span class="name">(.*?)<\/span><span class="delta (up|down)"><span aria-hidden="true">.<\/span> (.*?)<\/span><span class="from">(.*?)<\/span><\/li>/g)].map(
      ([, name, direction, delta, from]) => ({ name: plain(name!), direction: direction!, delta: plain(delta!), from: plain(from!) }),
    ),
    none: panel[2]!.includes('No change'),
  };
}

/** The Cost per day chart's description, or null where the page draws none. */
export const callsChart = (html: string) => /<svg [^>]*aria-label="(Cost per day[^"]*)"/.exec(html)?.[1] ?? null;

/** The warning about calls with no price: its sentence, or null where there is none. */
export const callsWarning = (html: string) => {
  const found = /<section class="panel warning" role="status"[^>]*>.*?<p>(.*?)<\/p>/s.exec(html);
  return found ? plain(found[1]!) : null;
};

/** What the page says of the import's last run. */
export const callsJobLine = (html: string) =>
  /<li data-job="claude-calls"[^>]*>(.*?)<\/li>/s.exec(html)?.[1]?.replace(/&mdash;/g, '—').replace(/&rsquo;/g, "'");
