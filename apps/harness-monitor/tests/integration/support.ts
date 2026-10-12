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
    env.DB.prepare('DELETE FROM daily_branch_totals'),
    env.DB.prepare('DELETE FROM price_list'),
    env.DB.prepare('DELETE FROM branch_links'),
    env.DB.prepare('DELETE FROM link_state'),
    env.DB.prepare('DELETE FROM job_runs'),
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

/** The public page as a visitor opens it, with the filters in the address (`?group=issue&period=all`). */
export async function thePage(query = ''): Promise<string> {
  return (await SELF.fetch(`https://monitor.test/${query}`)).text();
}

export interface CostRow {
  /** The first cell: what the row is. */
  label: string;
  /** The line under it, if any. */
  sub: string | null;
  /** The cells between the label and the split bar: engineer and merged for pull requests, the pull request count for issues and engineers. */
  details: string[];
  /** Dollars per category, in the order scoping, building, code review, security review, after push, CI reviews; '—' for none. */
  categories: string[];
  total: string;
  unpriced: string | null;
}

/** The rows of the page's cost table, in the order shown. */
export function costRows(html: string): CostRow[] {
  const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return [...html.matchAll(/<tr>(<td class="first">.*?)<\/tr>/gs)].map(([, row]) => {
    const cells = [...row!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]!);
    const [first, ...rest] = cells;
    const split = rest.findIndex((c) => c.startsWith('<div class="split">'));
    const [, label, sub] = /^(.*?)(?:<div class="muted small">(.*?)<\/div>)?$/s.exec(first!)!;
    const [, total, unpriced] = /^([^<]*?)(?: <span class="unpriced">(.*?)<\/span>)?$/.exec(rest.at(-1)!)!;
    return {
      label: decode(label!.replace(/<\/?a[^>]*>/g, '')),
      sub: sub === undefined ? null : decode(sub),
      details: rest.slice(0, split).map(decode),
      categories: rest.slice(split + 1, split + 7),
      total: total!,
      unpriced: unpriced ?? null,
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
  const sessions = [...html.matchAll(/<tr><td class="mono small">(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td class="num mono">(.*?)<\/td><td class="num mono">(.*?)<\/td><td class="num mono total">(.*?)<\/td><\/tr>/gs)].map(
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
