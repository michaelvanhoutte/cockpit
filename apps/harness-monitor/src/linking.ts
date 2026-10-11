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

export type LinkResult = 'skipped' | 'failed' | 'caught-up' | 'more-to-read';

/**
 * The hourly job. Reads the pull requests updated since the stored cursor and
 * stores their links and the new cursor in one batch, so a run that fails
 * anywhere before that batch leaves the links, the cursor and the last success
 * time as they were. A run that hits its page budget stores what it read and
 * moves the cursor there, but does not count as a success: the page keeps
 * saying when linking last caught up.
 */
export async function linkBranches(env: LinkEnv, now = Date.now()): Promise<LinkResult> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    console.log('Branch linking skipped: GITHUB_TOKEN or GITHUB_REPOSITORY is not set.');
    return 'skipped';
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
    return fetched.caughtUp ? 'caught-up' : 'more-to-read';
  } catch (error) {
    console.error(`Branch linking failed, nothing changed: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

export type LinkStatus =
  | { kind: 'linked'; prNumber: number; title: string; state: string; issue: number | null; engineer: string | null }
  | { kind: 'linking' }
  | { kind: 'unattributed' };

export interface SessionLine {
  sessionId: string;
  branch: string | null;
  lastAt: number;
  status: LinkStatus;
}

export interface LinkingPage {
  /** Epoch milliseconds; null while linking has never succeeded. */
  lastSuccessAt: number | null;
  sessions: SessionLine[];
}

interface SessionRow {
  sessionId: string;
  branch: string | null;
  lastAt: number;
  prNumber: number | null;
  title: string | null;
  state: string | null;
  issue: number | null;
  engineer: string | null;
}

/**
 * The newest sessions with what links them. A session without a link is
 * "linking" while it is newer than the last success (its pull request may not
 * have been seen yet), else "unattributed": no pull request names its branch.
 */
export async function linkingPage(db: D1Database, limit = 50): Promise<LinkingPage> {
  const state = await db.prepare('SELECT last_success_at AS lastSuccessAt FROM link_state WHERE id = 1').first<{
    lastSuccessAt: number | null;
  }>();
  const lastSuccessAt = state?.lastSuccessAt ?? null;
  const { results } = await db
    .prepare(`SELECT s.session_id AS sessionId, s.branch AS branch, s.last_at AS lastAt,
        l.pr_number AS prNumber, l.title AS title, l.state AS state,
        l.issue_number AS issue, l.engineer AS engineer
      FROM (
        -- A bare column beside MAX() comes from the row holding the maximum.
        SELECT session_id, branch, MAX(occurred_at) AS last_at
        FROM (SELECT session_id, branch, occurred_at FROM usage_requests ORDER BY occurred_at DESC LIMIT 5000)
        GROUP BY session_id
      ) s
      LEFT JOIN branch_links l ON l.branch = s.branch
      ORDER BY s.last_at DESC LIMIT ?`)
    .bind(limit)
    .all<SessionRow>();

  const sessions = results.map((r): SessionLine => {
    let status: LinkStatus;
    if (r.prNumber !== null) {
      status = { kind: 'linked', prNumber: r.prNumber, title: r.title ?? '', state: r.state ?? '', issue: r.issue, engineer: r.engineer };
    } else if (r.branch !== null && (lastSuccessAt === null || r.lastAt > lastSuccessAt)) {
      status = { kind: 'linking' };
    } else {
      status = { kind: 'unattributed' };
    }
    return { sessionId: r.sessionId, branch: r.branch, lastAt: r.lastAt, status };
  });
  return { lastSuccessAt, sessions };
}
