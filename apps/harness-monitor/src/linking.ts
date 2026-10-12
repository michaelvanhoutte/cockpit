import { fetchChangedPullRequests, type PullRequest } from './github';

/**
 * Stores each head branch's newest-updated pull request in one statement, from a
 * JSON array bound as a single parameter (see store.ts). A branch already
 * linked to a more recently updated pull request keeps it.
 */
const UPSERT_LINKS = `INSERT INTO branch_links (
  branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at
)
SELECT value ->> '$.branch', value ->> '$.number', value ->> '$.title', value ->> '$.state',
       value ->> '$.mergedAt', value ->> '$.issue', value ->> '$.engineer', value ->> '$.updatedAt', ?2
FROM json_each(?1) WHERE true
ORDER BY key
ON CONFLICT (branch) DO UPDATE SET
  pr_number = excluded.pr_number, title = excluded.title, state = excluded.state,
  merged_at = excluded.merged_at, issue_number = excluded.issue_number, engineer = excluded.engineer,
  pr_updated_at = excluded.pr_updated_at, linked_at = excluded.linked_at
WHERE excluded.pr_updated_at >= branch_links.pr_updated_at`;

const SAVE_STATE = `INSERT INTO link_state (id, cursor, last_success_at) VALUES (1, ?1, ?2)
ON CONFLICT (id) DO UPDATE SET
  cursor = COALESCE(excluded.cursor, link_state.cursor),
  last_success_at = COALESCE(excluded.last_success_at, link_state.last_success_at)`;

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
  | { status: 'caught-up' | 'more-to-read'; linked: number };

/** GitHub's refusal of the token in a sentence; any other failure as it came. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^GitHub answered 40[13]\.$/.test(message) ? `GitHub refused the token (${message.slice(-4, -1)}).` : message;
}

/**
 * The hourly job. Reads the pull requests updated since the stored cursor and
 * stores their links and the new cursor in one batch, so a run that fails
 * anywhere before that batch leaves the links, the cursor and the last success
 * time as they were. A run that hits its page budget stores what it read and
 * moves the cursor there, but does not count as a success: the page's
 * "last succeeded" time, shown beside a failed run, stays at the last catch-up.
 */
export async function linkBranches(env: LinkEnv, now = Date.now()): Promise<LinkResult> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    console.log('Branch linking skipped: GITHUB_TOKEN or GITHUB_REPOSITORY is not set.');
    return { status: 'skipped' };
  }
  try {
    const state = await env.DB.prepare('SELECT cursor FROM link_state WHERE id = 1').first<{ cursor: string | null }>();
    const fetched = await fetchChangedPullRequests(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN, state?.cursor ?? null);

    // Oldest first, so the newest-updated pull request of a branch is stored last and wins.
    const ordered: PullRequest[] = [...fetched.pullRequests].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const newest = ordered.at(-1)?.updatedAt ?? null;
    await env.DB.batch([
      env.DB.prepare(UPSERT_LINKS).bind(JSON.stringify(ordered), now),
      env.DB.prepare(SAVE_STATE).bind(newest, fetched.caughtUp ? now : null),
    ]);
    return { status: fetched.caughtUp ? 'caught-up' : 'more-to-read', linked: ordered.length };
  } catch (error) {
    const message = describe(error);
    console.error(`Branch linking failed, nothing changed: ${message}`);
    return { status: 'failed', error: message };
  }
}
