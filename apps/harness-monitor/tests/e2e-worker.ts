import worker, { type Env } from '../src/worker';
import { storeBatch } from '../src/store';
import { validateBatch } from '../src/validate';

/**
 * What the browser suite runs in place of `src/worker.ts` (`scripts/e2e-stack.mjs`
 * passes it to Wrangler as the entry): the same Worker, with one more route, so
 * a walk can put a page's worth of data in without GitHub or a write key. It is
 * in no deployment, and `pnpm dev:harness` does not use it.
 *
 * The route prices the walk's requests from one rate it stores itself, stores
 * them through the Worker's own write path, and records the pull requests the
 * hourly job would have read from GitHub. A request already stored is ignored,
 * so seeding twice (the suite runs each walk on two devices) changes nothing.
 */
const RATES = { 'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5 } };

interface SeededPullRequest {
  branch: string;
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  issue: number | null;
  engineer: string | null;
}

export default {
  ...worker,
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/__e2e/seed' || request.method !== 'POST') return worker.fetch(request, env, ctx);

    const { rows, pullRequests } = (await request.json()) as { rows: unknown[]; pullRequests: SeededPullRequest[] };
    const checked = validateBatch({ rows });
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO price_list (id, models, fetched_at, last_attempt_at) VALUES (1, ?1, ?2, ?2)
       ON CONFLICT (id) DO UPDATE SET models = excluded.models, fetched_at = excluded.fetched_at, last_attempt_at = excluded.last_attempt_at`,
    )
      .bind(JSON.stringify(RATES), now)
      .run();
    const stored = await storeBatch(env.DB, checked.rows);
    await env.DB.batch([
      ...pullRequests.map((p) =>
        env.DB.prepare(
          `INSERT INTO branch_links (branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '2026-01-01T00:00:00Z', ?8)
           ON CONFLICT (branch) DO UPDATE SET pr_number = excluded.pr_number, title = excluded.title, state = excluded.state,
             merged_at = excluded.merged_at, issue_number = excluded.issue_number, engineer = excluded.engineer`,
        ).bind(p.branch, p.number, p.title, p.state, p.mergedAt, p.issue, p.engineer, now),
      ),
      env.DB.prepare(
        `INSERT INTO link_state (id, cursor, last_success_at) VALUES (1, NULL, ?1)
         ON CONFLICT (id) DO UPDATE SET last_success_at = excluded.last_success_at`,
      ).bind(now),
    ]);
    return Response.json(stored);
  },
} satisfies ExportedHandler<Env>;
