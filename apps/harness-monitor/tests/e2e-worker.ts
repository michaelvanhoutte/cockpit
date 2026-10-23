import { importClaudeCalls, FEED_PATH } from '../src/claude-calls';
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
 * them through the Worker's own write path, copies the Claude calls it carries
 * through the import itself (read from a stand-in for Cockpit's production, so
 * the totals the page reads are the import's own), and records the pull requests
 * the hourly job would have read from GitHub. A request already stored is ignored,
 * so seeding twice (the suite runs each walk on two devices) changes nothing.
 */
const RATES = { 'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5 } };

/** Production's address in the suite, and the calls the stand-in serves: every call seeded so far, in row order. */
const COCKPIT = 'https://cockpit.e2e.test';
const served: { id: number }[] = [];
let standingIn = false;

/** Answers Cockpit's route from `served`, as production pages through its record; any other address reaches the network as before. */
function standInForCockpit() {
  if (standingIn) return;
  standingIn = true;
  const network = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== COCKPIT || url.pathname !== FEED_PATH) return network(input, init);
    const after = Number(url.searchParams.get('after') ?? 0);
    const rest = served.filter((c) => c.id > after);
    return Response.json({ calls: rest.slice(0, 1000), more: rest.length > 1000 });
  }) as typeof fetch;
}

interface SeededPullRequest {
  branch: string;
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  issue: number | null;
  engineer: string | null;
  /** What linking would have read of it, when the walk looks at that. */
  size?: { added: number; removed: number; openedAt: string; ciRounds: number; issueTitle: string | null };
}

export default {
  ...worker,
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/__e2e/seed' || request.method !== 'POST') return worker.fetch(request, env, ctx);

    const { rows, pullRequests, calls = [] } = (await request.json()) as { rows: unknown[]; pullRequests: SeededPullRequest[]; calls?: { id: number }[] };
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
      ...pullRequests.flatMap((p) =>
        p.size
          ? [
              env.DB.prepare(
                `INSERT INTO pull_request_stats (pr_number, lines_added, lines_removed, opened_at, ci_rounds, issue_title, pr_updated_at, read_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-01-01T00:00:00Z', ?7)
                 ON CONFLICT (pr_number) DO UPDATE SET lines_added = excluded.lines_added, lines_removed = excluded.lines_removed,
                   opened_at = excluded.opened_at, ci_rounds = excluded.ci_rounds, issue_title = excluded.issue_title`,
              ).bind(p.number, p.size.added, p.size.removed, p.size.openedAt, p.size.ciRounds, p.size.issueTitle, now),
            ]
          : [],
      ),
      env.DB.prepare(
        `INSERT INTO link_state (id, cursor, last_success_at) VALUES (1, NULL, ?1)
         ON CONFLICT (id) DO UPDATE SET last_success_at = excluded.last_success_at`,
      ).bind(now),
    ]);
    // A call already served is served once: seeding twice (a walk runs on two devices) changes nothing.
    for (const call of calls) if (!served.some((s) => s.id === call.id)) served.push(call);
    served.sort((a, b) => a.id - b.id);
    if (calls.length > 0) {
      standInForCockpit();
      const copied = await importClaudeCalls({ DB: env.DB, USAGE_READ_TOKEN: 'e2e', COCKPIT_URL: COCKPIT }, { now });
      if (copied.status === 'failed') return Response.json({ error: copied.error }, { status: 500 });
    }
    return Response.json(stored);
  },
} satisfies ExportedHandler<Env>;
