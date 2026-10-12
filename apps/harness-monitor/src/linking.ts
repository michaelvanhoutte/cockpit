import { fetchChangedPullRequests, type PullRequest } from './github';

/**
 * Stores each head branch's newest-updated pull request in one statement, from a
 * JSON array bound as a single parameter (see store.ts). A branch already
 * linked to a more recently updated pull request keeps it, and a link that
 * would not change is not written. With ?3 = 1 the pull requests came with
 * errors from GitHub, so a missing issue or engineer keeps the one stored.
 */
const NEW_ISSUE = 'CASE WHEN ?3 = 1 THEN COALESCE(excluded.issue_number, branch_links.issue_number) ELSE excluded.issue_number END';
const NEW_ENGINEER = 'CASE WHEN ?3 = 1 THEN COALESCE(excluded.engineer, branch_links.engineer) ELSE excluded.engineer END';
const UPSERT_LINKS = `INSERT INTO branch_links (
  branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at
)
SELECT value ->> '$.branch', value ->> '$.number', value ->> '$.title', value ->> '$.state',
       value ->> '$.mergedAt', value ->> '$.issue', value ->> '$.engineer', value ->> '$.updatedAt', ?2
FROM json_each(?1) WHERE true
ORDER BY key
ON CONFLICT (branch) DO UPDATE SET
  pr_number = excluded.pr_number, title = excluded.title, state = excluded.state,
  merged_at = excluded.merged_at, issue_number = ${NEW_ISSUE}, engineer = ${NEW_ENGINEER},
  pr_updated_at = excluded.pr_updated_at, linked_at = excluded.linked_at
WHERE excluded.pr_updated_at > branch_links.pr_updated_at
   OR (excluded.pr_updated_at = branch_links.pr_updated_at AND (
        excluded.pr_number IS NOT branch_links.pr_number OR excluded.title IS NOT branch_links.title
     OR excluded.state IS NOT branch_links.state OR excluded.merged_at IS NOT branch_links.merged_at
     OR (${NEW_ISSUE}) IS NOT branch_links.issue_number OR (${NEW_ENGINEER}) IS NOT branch_links.engineer))`;

/**
 * Stores each pull request's size, timing, CI rounds and closing issue's title, one
 * row per pull request, from the same JSON array. An older read never replaces a
 * newer one. A figure GitHub did not give (a file it left unread, a push it did not
 * list) keeps the one stored; a title it did not give keeps the stored one only
 * when its answer carried errors, since a pull request that no longer closes an
 * issue has none.
 */
const UPSERT_STATS = `INSERT INTO pull_request_stats (
  pr_number, lines_added, lines_removed, opened_at, merged_at, ci_rounds, issue_title, pr_updated_at, read_at
)
SELECT value ->> '$.number', value ->> '$.additions', value ->> '$.deletions', value ->> '$.openedAt', value ->> '$.mergedAt',
       value ->> '$.ciRounds',
       CASE WHEN value ->> '$.partial' = 1 AND value ->> '$.issueTitle' IS NULL
            THEN (SELECT issue_title FROM pull_request_stats WHERE pr_number = value ->> '$.number')
            ELSE value ->> '$.issueTitle' END,
       value ->> '$.updatedAt', ?2
FROM json_each(?1) WHERE true
ORDER BY key
ON CONFLICT (pr_number) DO UPDATE SET
  lines_added = COALESCE(excluded.lines_added, pull_request_stats.lines_added),
  lines_removed = COALESCE(excluded.lines_removed, pull_request_stats.lines_removed),
  opened_at = COALESCE(excluded.opened_at, pull_request_stats.opened_at),
  merged_at = excluded.merged_at,
  ci_rounds = COALESCE(excluded.ci_rounds, pull_request_stats.ci_rounds),
  issue_title = excluded.issue_title,
  pr_updated_at = excluded.pr_updated_at, read_at = excluded.read_at
WHERE excluded.pr_updated_at >= pull_request_stats.pr_updated_at`;

/**
 * The run's place and, when it caught up, the time. A full re-read sets its
 * place whatever is stored; any other run only moves the place it started from
 * (?3), so one that overlapped a full re-read and finished after it cannot undo
 * the rewind. A run that lost its place changes nothing here, which its
 * `changes` of 0 says.
 */
const SAVE_STATE = `INSERT INTO link_state (id, page_cursor, last_success_at, sizing_version) VALUES (1, ?1, ?2, ?5)
ON CONFLICT (id) DO UPDATE SET
  page_cursor = excluded.page_cursor,
  last_success_at = COALESCE(excluded.last_success_at, link_state.last_success_at),
  sizing_version = COALESCE(excluded.sizing_version, link_state.sizing_version)
WHERE ?4 = 1 OR link_state.page_cursor IS ?3`;

/**
 * What linking reads of each pull request. Raise it when it reads more, and the
 * next run re-reads every pull request from the first, once: it rewinds the place
 * and stores this version beside it in the same batch, so a run that fails
 * rewinds again and one that stored carries on from where it stopped.
 */
export const SIZING_VERSION = 1;

export interface LinkEnv {
  DB: D1Database;
  /** A secret: fine-grained, read-only. Unset, the job skips. */
  GITHUB_TOKEN?: string;
  /** `owner/name` of the repository whose pull requests are read. */
  GITHUB_REPOSITORY?: string;
}

export type LinkResult =
  | { status: 'skipped' }
  | { status: 'failed'; error: string }
  | { status: 'caught-up' | 'more-to-read' | 'place-moved'; linked: number; timeout: string | null; restarted: boolean };

/** GitHub's refusal of the token in a sentence; any other failure as it came. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^GitHub answered 40[13]\.$/.test(message) ? `GitHub refused the token (${message.slice(-4, -1)}).` : message;
}

export interface LinkOptions {
  /** Epoch milliseconds the run started. */
  now?: number;
  /** Start from the repository's first pull request instead of the stored place. */
  full?: boolean;
}

/**
 * The hourly job. Reads the pull requests from the stored place in update
 * order and stores their links and the new place in one batch, so a run that
 * fails anywhere before that batch leaves the links, the place and the last
 * catch-up time as they were. A run that hits its request budget, or that
 * GitHub times out on after a page was read, stores what it read and moves the
 * place there, but has not caught up: link_state.last_success_at, which decides
 * which branches still read as linking, stays at the last catch-up, while the
 * page records the run itself as succeeded (job_runs.last_ok_at).
 *
 * `full` restarts linking's progress from the repository's first pull request,
 * so links an earlier run missed are made; plain runs after it continue from
 * where it stopped until one catches up. It writes links, which all come from
 * GitHub, and that place; it never touches the usage rows.
 */
export async function linkBranches(env: LinkEnv, { now = Date.now(), full = false }: LinkOptions = {}): Promise<LinkResult> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    console.log('Branch linking skipped: GITHUB_TOKEN or GITHUB_REPOSITORY is not set.');
    return { status: 'skipped' };
  }
  try {
    const state = await env.DB.prepare('SELECT page_cursor AS cursor, sizing_version AS sizing FROM link_state WHERE id = 1').first<{
      cursor: string | null;
      sizing: number | null;
    }>();
    const started = state?.cursor ?? null;
    // Pull requests linked before the sizing version are read again from the first.
    const rewind = full || state?.sizing !== SIZING_VERSION;
    const fetched = await fetchChangedPullRequests(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN, rewind ? null : started);

    // Oldest first, so the newest-updated pull request of a branch is stored last and wins.
    const ordered: PullRequest[] = [...fetched.pullRequests].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const links = (partial: boolean) => JSON.stringify(ordered.filter((pr) => pr.partial === partial));
    const results = await env.DB.batch([
      env.DB.prepare(UPSERT_LINKS).bind(links(false), now, 0),
      env.DB.prepare(UPSERT_LINKS).bind(links(true), now, 1),
      env.DB.prepare(UPSERT_STATS).bind(JSON.stringify(ordered), now),
      env.DB.prepare(SAVE_STATE).bind(fetched.cursor, fetched.caughtUp ? now : null, started, rewind ? 1 : 0, rewind ? SIZING_VERSION : null),
    ]);
    const moved = results.at(-1)!.meta.changes === 0;
    const status = moved ? 'place-moved' : fetched.caughtUp ? 'caught-up' : 'more-to-read';
    return { status, linked: ordered.length, timeout: fetched.timeout, restarted: fetched.restarted };
  } catch (error) {
    const message = describe(error);
    console.error(`Branch linking failed, nothing changed: ${message}`);
    return { status: 'failed', error: message };
  }
}
