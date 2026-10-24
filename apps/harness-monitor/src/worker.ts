import { checkWriteKey } from './auth';
import { exportClaudeCalls } from './claude-calls-export';
import { callsPage, callsQueryString, parseCallsQuery } from './claude-calls-page';
import { renderClaudeCalls } from './claude-calls-view';
import { costsPage, DEFAULT_GROUP, parseQuery, queryString } from './costs';
import { checkPulls } from './cycle-time';
import { renderCycleTime } from './cycle-time-page';
import { cycleTimeAddress, loadCycleTime, parseCycleTimeQuery } from './cycle-time-report';
import { cycleTimeAnswer, newestMerge, storePulls } from './cycle-time-store';
import { exportCsv } from './export';
import { isJob, JOBS, runJob, type JobName } from './jobs';
import { renderPage } from './page';
import { pullRequestPage } from './pull-request';
import { renderNothingFound, renderPullRequest } from './pull-request-page';
import { checkSelection } from './selection';
import { renderSelection } from './selection-page';
import { parseSelectionQuery, periodStart, selectionAddress, wantsOf } from './selection-report';
import { newestSelectionMerge, parseJobFilter, parseSelectionPeriod, selectionAnswer, storeSelection } from './selection-store';
import { selectionView } from './selection-view';
import { checkRuns } from './stability';
import { renderStability } from './stability-page';
import { loadStability, parseStabilityQuery, stabilityAddress } from './stability-report';
import { newestRun, parsePeriod, stabilityAnswer, storeRuns } from './stability-store';
import { correctBatch, stillUnphased, storeBatch, unpricedLines } from './store';
import { validateBatch, validateCorrections } from './validate';

export interface Env {
  DB: D1Database;
  /** The static files in public/ (the font). The platform answers for them before this Worker runs, so only a test asks for one by name. */
  ASSETS: Fetcher;
  /** A secret. Unset, every write is refused. */
  HARNESS_WRITE_KEY?: string;
  /** A secret: a fine-grained, read-only GitHub token. Unset, branch linking skips. */
  GITHUB_TOKEN?: string;
  /** `owner/name`, set in wrangler.jsonc. */
  GITHUB_REPOSITORY?: string;
  /** A secret, the value Cockpit's production holds under the same name. Unset, the import of Cockpit's Claude calls skips. */
  USAGE_READ_TOKEN?: string;
  /** Cockpit's production address, set in wrangler.jsonc; `pnpm dev:harness` points it at the local API. */
  COCKPIT_URL?: string;
  /** How long the edge keeps the costs page and the Claude calls page, in seconds; 0 turns the cache off (local runs and tests). */
  PAGE_CACHE_SECONDS?: string;
}

/** Which job each cron in wrangler.jsonc starts. */
const SCHEDULES: Record<string, JobName> = {
  '0 * * * *': 'linking',
  '10 3 * * *': 'prices',
  '20 3 * * *': 'rebuild',
  '30 */12 * * *': 'claude-calls',
};

/** Far above MAX_BATCH full rows, so only a malformed write reaches it. */
const MAX_BODY = 1_000_000;

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The refusal for a request without the write key, or null when it carries it. */
async function refusal(request: Request, env: Env): Promise<Response | null> {
  const allowed = await checkWriteKey(request.headers.get('authorization'), env.HARNESS_WRITE_KEY);
  if (allowed === 'unconfigured') return json({ error: 'Writing is not set up on this Worker.' }, 503);
  if (allowed === 'refused') return json({ error: 'A valid write key is required.' }, 401);
  return null;
}

/** The request's JSON body, or the refusal for one too large or not JSON. */
async function readBody(request: Request): Promise<{ body: unknown } | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: `The body is over ${MAX_BODY} characters.` }, 413);
  try {
    return { body: JSON.parse(text) };
  } catch {
    return json({ error: 'The body is not JSON.' }, 400);
  }
}

async function write(request: Request, env: Env): Promise<Response> {
  const refused = await refusal(request, env);
  if (refused) return refused;
  const read = await readBody(request);
  if (read instanceof Response) return read;
  const checked = validateBatch(read.body);
  if (!checked.ok) return json({ error: checked.error }, 400);
  return json(await storeBatch(env.DB, checked.rows));
}

/** A send of CI stability's runs, stored whole or refused whole. */
async function writeStability(request: Request, env: Env): Promise<Response> {
  const refused = await refusal(request, env);
  if (refused) return refused;
  const read = await readBody(request);
  if (read instanceof Response) return read;
  const checked = checkRuns(read.body);
  if (!checked.ok) return json({ error: checked.error }, 400);
  return json(await storeRuns(env.DB, checked.runs));
}

/** A send of cycle time's merged pull requests, stored whole or refused whole. */
async function writeCycleTime(request: Request, env: Env): Promise<Response> {
  const refused = await refusal(request, env);
  if (refused) return refused;
  const read = await readBody(request);
  if (read instanceof Response) return read;
  const checked = checkPulls(read.body);
  if (!checked.ok) return json({ error: checked.error }, 400);
  return json(await storePulls(env.DB, checked.pulls));
}

/** A send of test selection's pull requests, with the bars' thresholds, stored whole or refused whole. */
async function writeSelection(request: Request, env: Env): Promise<Response> {
  const refused = await refusal(request, env);
  if (refused) return refused;
  const read = await readBody(request);
  if (read instanceof Response) return read;
  const checked = checkSelection(read.body);
  if (!checked.ok) return json({ error: checked.error }, 400);
  return json(await storeSelection(env.DB, checked.pulls, checked.bars));
}

/** Whether the request asks for the JSON answer rather than the page: `?format=json`, or an `Accept` header naming `application/json`. */
const wantsJson = (request: Request, url: URL) => url.searchParams.get('format') === 'json' || (request.headers.get('accept') ?? '').includes('application/json');

/**
 * Cycle time: the page, or its stored pull requests as JSON when the request
 * asks (`wantsJson`): for the period the address asks, each window's figures and
 * every pull request merged in it, with its rounds and checks. Cached like the
 * costs page under one key per view, so a page and its JSON never share an entry.
 */
async function cycleTime(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const asJson = wantsJson(request, url);
  const query = parseCycleTimeQuery(url.searchParams);
  const period = parsePeriod(url.searchParams.get('period'));
  const seconds = Number(env.PAGE_CACHE_SECONDS ?? 0);
  const cache = seconds > 0 ? caches.default : null;
  const key = new Request(asJson ? `${url.origin}/cycle-time?format=json${period === '30d' ? '' : `&period=${period}`}` : `${url.origin}${cycleTimeAddress(query)}`);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const now = Date.now();
  const headers = { vary: 'accept', 'cache-control': cache ? `public, max-age=${seconds}` : 'no-store' };
  const response = asJson
    ? Response.json(await cycleTimeAnswer(env.DB, period, now), { headers })
    : new Response(renderCycleTime(query, await loadCycleTime(env.DB, query, now), env.GITHUB_REPOSITORY, now), {
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
      });
  if (cache) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

/**
 * Test selection: the page, or its stored pull requests as JSON when the request
 * asks (`wantsJson`). The JSON is for the period and job the address asks: how
 * many pull requests ran, ran everything or were documentation only, each bar
 * read against the thresholds the last send carried, the rules that forced a
 * full run, the misses and the files selected most often. Cached like the other
 * reports under one key per view, so a page and its JSON never share an entry.
 */
async function selection(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const asJson = wantsJson(request, url);
  const query = parseSelectionQuery(url.searchParams);
  const period = parseSelectionPeriod(url.searchParams.get('period'));
  const job = parseJobFilter(url.searchParams.get('job'));
  const seconds = Number(env.PAGE_CACHE_SECONDS ?? 0);
  const cache = seconds > 0 ? caches.default : null;
  const key = new Request(asJson ? `${url.origin}/selection?format=json&period=${period}&job=${job}` : `${url.origin}${selectionAddress(query, query)}`);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const now = Date.now();
  const headers = { vary: 'accept', 'cache-control': cache ? `public, max-age=${seconds}` : 'no-store' };
  const response = asJson
    ? Response.json(await selectionAnswer(env.DB, period, job, now), { headers })
    : new Response(renderSelection(query, await selectionView(env.DB, wantsOf(query), periodStart(query.period, now), query.job), env.GITHUB_REPOSITORY, now), {
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
      });
  if (cache) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

/**
 * CI stability: the page, or its stored runs as JSON when the request asks
 * (`wantsJson`), for the period the address asks. Cached like the costs page
 * under one key per view, so a page and its JSON never share an entry.
 */
async function stability(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const asJson = wantsJson(request, url);
  const query = parseStabilityQuery(url.searchParams);
  const period = parsePeriod(url.searchParams.get('period'));
  const seconds = Number(env.PAGE_CACHE_SECONDS ?? 0);
  const cache = seconds > 0 ? caches.default : null;
  const key = new Request(asJson ? `${url.origin}/stability?format=json${period === '30d' ? '' : `&period=${period}`}` : `${url.origin}${stabilityAddress(query)}`);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const now = Date.now();
  const headers = { vary: 'accept', 'cache-control': cache ? `public, max-age=${seconds}` : 'no-store' };
  const response = asJson
    ? Response.json(await stabilityAnswer(env.DB, period, now), { headers })
    : new Response(renderStability(query, await loadStability(env.DB, query.period, now), env.GITHUB_REPOSITORY, now), {
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
      });
  if (cache) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

/**
 * Places stored Unphased requests again (Re-place stored Unphased requests
 * since 21 Sep from the local session logs, issue 1487), behind the write key.
 * POST takes `{"corrections": [{requestId, category}]}`, at most 200, and
 * answers `{changed, left}`; GET answers `{unphased}`, how many local requests
 * from 21 Sep on are still Unphased, for the run's report.
 *
 * Built to these failure modes:
 * - **Halfway**: a batch is one statement, so one D1 transaction; a stop leaves
 *   whole batches placed and the rest Unphased, and the daily totals stale
 *   until `rebuild` runs, which only the rows feed.
 * - **Twice**: only a row still Unphased changes, so a re-run changes only what
 *   earlier runs did not reach, and is safe.
 * - **Rows that break the rule**: a category outside the four refuses the whole
 *   batch, naming it; a row already phased, dated before 21 Sep, from a cloud
 *   session or not stored is left and counted in `left`, never dropped silently.
 * - **Interruption**: inside a batch D1 rolls it back whole; a hook inserting
 *   rows meanwhile only inserts, which this never touches.
 */
async function correct(request: Request, env: Env): Promise<Response> {
  const refused = await refusal(request, env);
  if (refused) return refused;
  if (request.method === 'GET') return json({ unphased: await stillUnphased(env.DB) });
  const read = await readBody(request);
  if (read instanceof Response) return read;
  const checked = validateCorrections(read.body);
  if (!checked.ok) return json({ error: checked.error }, 400);
  return json(await correctBatch(env.DB, checked.corrections));
}

/**
 * Starts a job now, the code its schedule runs, and answers with what it did. The write key is the only credential.
 * `?full` (or `full=1`, `full=true`) restarts linking from the first pull request; no other job reads anything it could re-read.
 */
async function startJob(request: Request, env: Env, name: string): Promise<Response> {
  const refused = await refusal(request, env);
  if (refused) return refused;
  if (!isJob(name)) return json({ error: `Unknown job. Use one of: ${JOBS.join(', ')}.` }, 404);
  const asked = new URL(request.url).searchParams.get('full');
  // A value meaning anything else must not quietly run the plain job instead.
  if (asked !== null && !['', '1', 'true'].includes(asked)) return json({ error: 'full is 1, true or bare; nothing ran.' }, 400);
  const full = asked !== null;
  if (full && name !== 'linking') return json({ error: 'Only linking re-reads from the start; run this job without full.' }, 400);
  return json({ job: name, ...(await runJob(env, name, 'hand', { full })) });
}

/**
 * The costs page, cached at the edge so public traffic cannot spend the free
 * read allowance: the cache key is the page's canonical address, so the
 * filters' spellings and stray parameters all share the few real pages. On
 * `workers.dev` the Cache API does nothing, so this takes effect only once the
 * Worker has a custom domain or route.
 */
async function costs(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams);
  const seconds = Number(env.PAGE_CACHE_SECONDS ?? 0);
  const cache = seconds > 0 ? caches.default : null;
  const key = new Request(`${url.origin}/${queryString(query)}`);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const [page, unpriced] = await Promise.all([costsPage(env.DB, query), unpricedLines(env.DB)]);
  const response = new Response(renderPage(page, { unpriced, repository: env.GITHUB_REPOSITORY }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cache ? `public, max-age=${seconds}` : 'no-store',
    },
  });
  if (cache) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

/** Cockpit's Claude calls page, cached at the edge like the costs page; the totals it reads are the import's own. */
async function claudeCalls(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const query = parseCallsQuery(url.searchParams);
  const seconds = Number(env.PAGE_CACHE_SECONDS ?? 0);
  const cache = seconds > 0 ? caches.default : null;
  const key = new Request(`${url.origin}/claude-calls${callsQueryString(query)}`);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const response = new Response(renderClaudeCalls(await callsPage(env.DB, query), { repository: env.GITHUB_REPOSITORY }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cache ? `public, max-age=${seconds}` : 'no-store',
    },
  });
  if (cache) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

/** A pull request number as written in an address: no sign, no leading zero, ten digits at most. */
const prNumber = (raw: string): number | null => (/^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null);

/** One pull request's page, cached like the costs page; a number no link knows is "nothing found". */
async function pullRequest(request: Request, env: Env, ctx: ExecutionContext, raw: string): Promise<Response> {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams);
  const number = prNumber(raw);
  const seconds = Number(env.PAGE_CACHE_SECONDS ?? 0);
  const cache = seconds > 0 ? caches.default : null;
  const key = new Request(`${url.origin}/pr/${raw}${queryString(query, { engineer: null, group: DEFAULT_GROUP, split: 'phase', sort: 'default', page: 1 })}`);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const page = number === null ? null : await pullRequestPage(env.DB, query, number);
  const response = new Response(page === null ? renderNothingFound() : renderPullRequest(page), {
    status: page === null ? 404 : 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cache && page !== null ? `public, max-age=${seconds}` : 'no-store',
    },
  });
  if (cache && page !== null) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

/** The request rows under the page's filters (and one pull request's, with `pr`), as a CSV download. Never cached: it can be a year of rows. */
function exportRows(request: Request, env: Env): Response {
  const params = new URL(request.url).searchParams;
  const pr = params.get('pr');
  const number = pr === null ? null : prNumber(pr);
  if (pr !== null && number === null) return exportCsv(env.DB, parseQuery(params), -1, 'claude-code-requests.csv');
  return exportCsv(env.DB, parseQuery(params), number, number === null ? 'claude-code-requests.csv' : `claude-code-pull-request-${number}.csv`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const prPath = /^\/pr\/([^/]*)\/?$/.exec(pathname);
    if (prPath && request.method === 'GET') return pullRequest(request, env, ctx, prPath[1]!);
    if (pathname === '/export.csv' && request.method === 'GET') return exportRows(request, env);
    if (pathname === '/claude-calls' && request.method === 'GET') return claudeCalls(request, env, ctx);
    // Never cached: it can be a year of calls.
    if (pathname === '/claude-calls/export.csv' && request.method === 'GET') return exportClaudeCalls(env.DB, parseCallsQuery(new URL(request.url).searchParams));
    if (pathname === '/v1/usage') {
      return request.method === 'POST' ? write(request, env) : json({ error: 'Use POST.' }, 405);
    }
    if (pathname === '/v1/stability') {
      if (request.method === 'POST') return writeStability(request, env);
      // Where the next send starts reading: public, as every read here is.
      if (request.method === 'GET') return json({ newestRun: await newestRun(env.DB) });
      return json({ error: 'Use GET or POST.' }, 405);
    }
    if (pathname === '/stability' && request.method === 'GET') return stability(request, env, ctx);
    if (pathname === '/v1/cycle-time') {
      if (request.method === 'POST') return writeCycleTime(request, env);
      // Where the next send starts reading: public, as every read here is.
      if (request.method === 'GET') return json({ newestMerge: await newestMerge(env.DB) });
      return json({ error: 'Use GET or POST.' }, 405);
    }
    if (pathname === '/cycle-time' && request.method === 'GET') return cycleTime(request, env, ctx);
    if (pathname === '/v1/selection') {
      if (request.method === 'POST') return writeSelection(request, env);
      // Where the next send starts reading: public, as every read here is.
      if (request.method === 'GET') return json({ newestMerge: await newestSelectionMerge(env.DB) });
      return json({ error: 'Use GET or POST.' }, 405);
    }
    if (pathname === '/selection' && request.method === 'GET') return selection(request, env, ctx);
    if (pathname === '/v1/usage/corrections') {
      return request.method === 'POST' || request.method === 'GET' ? correct(request, env) : json({ error: 'Use POST or GET.' }, 405);
    }
    const jobPath = /^\/v1\/jobs\/([^/]*)$/.exec(pathname);
    if (jobPath) return request.method === 'POST' ? startJob(request, env, jobPath[1]!) : json({ error: 'Use POST.' }, 405);
    if (pathname === '/' && request.method === 'GET') return costs(request, env, ctx);
    return json({ error: 'Not found.' }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const job = Object.hasOwn(SCHEDULES, controller.cron) ? SCHEDULES[controller.cron] : undefined;
    if (!job) {
      console.error(`No job is scheduled as "${controller.cron}"; nothing ran.`);
      return;
    }
    await runJob(env, job, 'schedule');
  },
} satisfies ExportedHandler<Env>;
