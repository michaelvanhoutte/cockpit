import { checkWriteKey } from './auth';
import { linkBranches, linkingPage } from './linking';
import { renderPage } from './page';
import { listStatus, priceWaitingRows, refreshPriceList } from './price-list';
import { dailyLines, rebuildTotals, storeBatch, unpricedLines } from './store';
import { validateBatch } from './validate';

export interface Env {
  DB: D1Database;
  /** A secret. Unset, every write is refused. */
  HARNESS_WRITE_KEY?: string;
  /** A secret: a fine-grained, read-only GitHub token. Unset, branch linking skips. */
  GITHUB_TOKEN?: string;
  /** `owner/name`, set in wrangler.jsonc. */
  GITHUB_REPOSITORY?: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/usage') {
      return request.method === 'POST' ? write(request, env) : json({ error: 'Use POST.' }, 405);
    }
    if (pathname === '/' && request.method === 'GET') {
      const [lines, unpriced, list, linking] = await Promise.all([
        dailyLines(env.DB),
        unpricedLines(env.DB),
        listStatus(env.DB),
        linkingPage(env.DB),
      ]);
      return new Response(renderPage(lines, { unpriced, list }, linking), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
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
