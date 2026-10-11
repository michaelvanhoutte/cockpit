import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import { LITELLM_URL } from '../../src/prices';
import worker from '../../src/worker';
import litellm from '../fixtures/litellm-prices.json';

export const WRITE_KEY = 'test-write-key';

export const usage = (requestId: string, over: Record<string, unknown> = {}) => ({
  requestId,
  sessionId: 'session_1',
  time: '2026-03-01T10:00:00Z',
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
    env.DB.prepare('DELETE FROM price_list'),
    env.DB.prepare('DELETE FROM branch_links'),
    env.DB.prepare('DELETE FROM link_state'),
  ]);
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

/** The daily job, run the way the platform runs it. */
export async function runTheDailyJob() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '10 3 * * *' }), env, ctx);
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

export async function thePage(): Promise<string> {
  return (await SELF.fetch('https://monitor.test/')).text();
}
