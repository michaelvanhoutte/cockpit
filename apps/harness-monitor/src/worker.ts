import { checkWriteKey } from './auth';
import { renderPage } from './page';
import { dailyLines, rebuildTotals, storeBatch } from './store';
import { validateBatch } from './validate';

export interface Env {
  DB: D1Database;
  /** A secret. Unset, every write is refused. */
  HARNESS_WRITE_KEY?: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function write(request: Request, env: Env): Promise<Response> {
  const allowed = await checkWriteKey(request.headers.get('authorization'), env.HARNESS_WRITE_KEY);
  if (allowed === 'unconfigured') return json({ error: 'Writing is not set up on this Worker.' }, 503);
  if (allowed === 'refused') return json({ error: 'A valid write key is required.' }, 401);

  let body: unknown;
  try {
    body = await request.json();
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
      return new Response(renderPage(await dailyLines(env.DB)), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return json({ error: 'Not found.' }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await rebuildTotals(env.DB);
  },
} satisfies ExportedHandler<Env>;
