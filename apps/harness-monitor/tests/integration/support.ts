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
  /** Dollars per column of the split, left to right (by phase: unphased, scoping, building, code review, security review, after push, CI reviews); '—' for none. */
  categories: string[];
  /** How many coloured segments the row's split bar is drawn with. */
  segments: number;
  /** Each segment's width as a percentage of the track, left to right; none for a row that draws no bar. */
  widths: number[];
  total: string;
  unpriced: string | null;
}

/** The rows of the page's cost table, in the order shown. */
export function costRows(html: string): CostRow[] {
  const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return [...html.matchAll(/<tr>(<td class="first">.*?)<\/tr>/gs)].map(([, row]) => {
    const cells = [...row!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]!);
    const [first, ...rest] = cells;
    const split = rest.findIndex((c) => c.startsWith('<div class="split'));
    const [, label, sub] = /^(.*?)(?:<div class="muted small">(.*?)<\/div>)?$/s.exec(first!)!;
    const [, total, unpriced] = /^([^<]*?)(?: <span class="unpriced">(.*?)<\/span>)?$/.exec(rest.at(-1)!)!;
    const widths = [...rest[split]!.matchAll(/<div style="width:([\d.]+)%/g)].map((m) => Number(m[1]));
    return {
      label: decode(label!.replace(/<\/?a[^>]*>/g, '')),
      sub: sub === undefined ? null : decode(sub.replace(/<\/?a[^>]*>/g, '').replace(/ · Sessions$/, '')),
      details: rest.slice(0, split).map(decode),
      categories: rest.slice(split + 1, -1),
      segments: widths.length,
      widths,
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

/** The names over the split's columns, left to right. */
export function splitColumns(html: string): string[] {
  const found = /<th scope="col" class="split-head">Split<\/th>(.*?)<th scope="col" class="num">(?:<a[^>]*>)?Total/s.exec(html);
  if (!found) return [];
  return [...found[1]!.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]!.replace(/<i [^>]*><\/i>/, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))));
}

/** The groupings as the band offers them, left to right: the name, where it goes, and whether it is the page's. */
export function groupTabs(html: string): { label: string; href: string; current: boolean }[] {
  const tabs = /<div class="band-tabs">(.*?)<\/div>/s.exec(html)?.[1] ?? '';
  return [...tabs.matchAll(/<a href="([^"]*)"( aria-current="page")?>(.*?)<\/a>/g)].map(([, href, current, label]) => ({ label: label!, href: href!.replace(/&amp;/g, '&'), current: current !== undefined }));
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
