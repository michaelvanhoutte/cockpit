import { checkWriteKey } from './auth';
import { costsPage, parseQuery, queryString } from './costs';
import { linkBranches } from './linking';
import { renderPage } from './page';
import { listStatus, priceWaitingRows, refreshPriceList } from './price-list';
import { rebuildTotals, storeBatch, unpricedLines } from './store';
import { validateBatch } from './validate';

export interface Env {
  DB: D1Database;
  /** A secret. Unset, every write is refused. */
  HARNESS_WRITE_KEY?: string;
  /** A secret: a fine-grained, read-only GitHub token. Unset, branch linking skips. */
  GITHUB_TOKEN?: string;
  /** `owner/name`, set in wrangler.jsonc. */
  GITHUB_REPOSITORY?: string;
  /** How long the edge keeps the costs page, in seconds; 0 turns the cache off (local runs and tests). */
  PAGE_CACHE_SECONDS?: string;
}

/** The daily job (prices, then the totals); any other schedule links branches. */
const DAILY = '10 3 * * *';

/** Far above MAX_BATCH full rows, so only a malformed write reaches it. */
const MAX_BODY = 1_000_000;

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function write(request: Request, env: Env): Promise<Response> {
  const allowed = await checkWriteKey(request.headers.get('authorization'), env.HARNESS_WRITE_KEY);
  if (allowed === 'unconfigured') return json({ error: 'Writing is not set up on this Worker.' }, 503);
  if (allowed === 'refused') return json({ error: 'A valid write key is required.' }, 401);

  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: `The body is over ${MAX_BODY} characters.` }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'The body is not JSON.' }, 400);
  }
  const checked = validateBatch(body);
  if (!checked.ok) return json({ error: checked.error }, 400);
  return json(await storeBatch(env.DB, checked.rows));
}

/**
 * The costs page, cached at the edge so public traffic cannot spend the free
 * read allowance: the cache key is the page's canonical address, so the
 * filters' spellings and stray parameters all share the few real pages.
 */
async function costs(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams);
  const seconds = Number(env.PAGE_CACHE_SECONDS ?? 0);
  const cache = seconds > 0 ? caches.default : null;
  const key = new Request(`${url.origin}/${queryString(query)}`);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const [page, unpriced, list] = await Promise.all([costsPage(env.DB, query), unpricedLines(env.DB), listStatus(env.DB)]);
  const response = new Response(renderPage(page, { unpriced, list }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cache ? `public, max-age=${seconds}` : 'no-store',
    },
  });
  if (cache) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/usage') {
      return request.method === 'POST' ? write(request, env) : json({ error: 'Use POST.' }, 405);
    }
    if (pathname === '/' && request.method === 'GET') return costs(request, env, ctx);
    return json({ error: 'Not found.' }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron !== DAILY) {
      await linkBranches(env);
      return;
    }
    // The daily job: refresh the prices (a failure keeps the last good list),
    // price what was waiting, then rebuild the totals from the rows.
    await refreshPriceList(env.DB);
    await priceWaitingRows(env.DB);
    await rebuildTotals(env.DB);
  },
} satisfies ExportedHandler<Env>;
