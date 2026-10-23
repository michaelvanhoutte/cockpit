import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import worker from '../../src/worker';
import recorded from './fixtures/cockpit-claude-calls.json';
import refused from './fixtures/cockpit-claude-calls-refused.json';

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
export function giveTheWorkerTheReadToken() {
  const before = { USAGE_READ_TOKEN: env.USAGE_READ_TOKEN, COCKPIT_URL: env.COCKPIT_URL };
  env.USAGE_READ_TOKEN = READ_TOKEN;
  env.COCKPIT_URL = COCKPIT;
  return () => {
    for (const [name, value] of Object.entries(before) as [keyof typeof before, string | undefined][]) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  };
}

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
