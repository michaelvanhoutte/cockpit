/** One pull request as the job keeps it. */
export interface PullRequest {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  updatedAt: string;
  branch: string;
  issue: number | null;
  engineer: string | null;
}

/**
 * Pull requests per page. A page of 100, each with its closing issue, makes GitHub
 * time out (a 502 or 504), so pages are small; a retry asks for half.
 */
export const PAGE_SIZE = 25;

/**
 * Most requests one run makes to GitHub, a retry after a timeout included. Each is
 * one subrequest, and the free plan allows 50 per invocation (D1 queries count
 * too), so this leaves room for the rest.
 */
export const MAX_REQUESTS = 30;

/** The smallest page a retry asks for. */
const MIN_PAGE_SIZE = 5;

// A run's budget must stay under GitHub's 1000-result cap on one search, which reports no next page past it.
if (MAX_REQUESTS * PAGE_SIZE >= 1000) throw new Error('MAX_REQUESTS * PAGE_SIZE must stay under 1000.');

const QUERY = `query($q: String!, $after: String, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title state mergedAt updatedAt headRefName isCrossRepository
        author { login }
        closingIssuesReferences(first: 1) { nodes { number } }
      }
    }
  }
}`;

export interface Fetched {
  pullRequests: PullRequest[];
  /** False when the run stopped for its request budget, or for GitHub timing out, with more still to read. */
  caughtUp: boolean;
  /** Why GitHub's answer ended the run early, in a sentence, when it did. */
  timeout: string | null;
}

interface Node {
  number?: number;
  title?: string;
  state?: string;
  mergedAt?: string | null;
  updatedAt?: string;
  headRefName?: string;
  isCrossRepository?: boolean;
  author?: { login?: string } | null;
  closingIssuesReferences?: { nodes?: { number?: number }[] };
}

function toPullRequest(node: Node | null): PullRequest | null {
  // Search also yields non-pull-request nodes as empty objects; a pull request names its branch.
  if (!node || typeof node.number !== 'number' || !node.headRefName || !node.updatedAt) return null;
  // A fork's branch names nothing a session here ran on, and could share a name with one that did.
  if (node.isCrossRepository) return null;
  return {
    number: node.number,
    title: node.title ?? '',
    state: node.state ?? 'OPEN',
    mergedAt: node.mergedAt ?? null,
    updatedAt: node.updatedAt,
    branch: node.headRefName,
    issue: node.closingIssuesReferences?.nodes?.[0]?.number ?? null,
    engineer: node.author?.login ?? null,
  };
}

interface Search {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: (Node | null)[];
}

/** One page: what GitHub answered, or why it did not in time. */
type Page = { search: Search } | { timeout: string };

const TIMEOUT_ERROR = /time(d)? ?out/i;

/** Reads a page, treating whatever means the query ran too long as a timeout and anything else wrong as a throw. */
async function readPage(token: string, variables: { q: string; after: string | null; first: number }): Promise<Page> {
  let response: Response;
  try {
    response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'harness-monitor' },
      body: JSON.stringify({ query: QUERY, variables }),
      // Covers reading the body too.
      signal: AbortSignal.timeout(15_000),
    });
    // 502 and 504 are the query running too long.
    if (response.status === 502 || response.status === 504) {
      await response.body?.cancel();
      return {
        timeout:
          response.status === 502
            ? 'GitHub failed to answer (502); usually the query took too long'
            : `GitHub did not answer in time (${response.status})`,
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub answered ${response.status}.`);
    }
    const body = (await response.json()) as { data?: { search?: Search }; errors?: { message?: string }[] };
    const message = body.errors?.[0]?.message;
    if (body.errors?.length) {
      // GitHub's commonest timeout is a 200 whose error says so.
      if (message && TIMEOUT_ERROR.test(message)) return { timeout: 'GitHub did not answer in time' };
      throw new Error(`GitHub reported: ${message ?? 'an error'}`);
    }
    if (!body.data?.search?.nodes) throw new Error('GitHub answered without a search result.');
    return { search: body.data.search };
  } catch (error) {
    // Our own limit on waiting ran out, in the answer or in its body.
    if (error instanceof Error && error.name === 'TimeoutError') return { timeout: 'GitHub did not answer in time' };
    throw error;
  }
}

/**
 * Reads the pull requests updated at or after `since`, oldest first, so a run
 * cut short by its request budget leaves a cursor with nothing older unread.
 * `>=` re-reads the pull request the cursor names; storing it again is harmless.
 *
 * Throws on anything GitHub answers badly, a rate limit included, and on a
 * timeout before any page was read: the caller stores nothing from a run that
 * threw. A timeout the retry does not cure, after pages were read, ends the run
 * early with what it has.
 */
export async function fetchChangedPullRequests(
  repository: string,
  token: string,
  since: string | null,
): Promise<Fetched> {
  const q = `repo:${repository} is:pr sort:updated-asc${since ? ` updated:>=${since}` : ''}`;
  const pullRequests: PullRequest[] = [];
  let after: string | null = null;
  let requests = 0;
  let size = PAGE_SIZE;
  for (let pages = 0; ; pages += 1) {
    requests += 1;
    let page = await readPage(token, { q, after, first: size });
    if ('timeout' in page && requests < MAX_REQUESTS) {
      // One retry at half the size, which the rest of the run keeps.
      size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
      requests += 1;
      page = await readPage(token, { q, after, first: size });
    }
    if ('timeout' in page) {
      if (pages === 0) throw new Error(`${page.timeout}.`);
      return { pullRequests, caughtUp: false, timeout: page.timeout };
    }
    const search = page.search;
    for (const node of search.nodes ?? []) {
      const pr = toPullRequest(node);
      if (pr) pullRequests.push(pr);
    }
    const more = search.pageInfo?.hasNextPage === true && !!search.pageInfo.endCursor;
    if (!more) return { pullRequests, caughtUp: true, timeout: null };
    if (requests >= MAX_REQUESTS) return { pullRequests, caughtUp: false, timeout: null };
    after = search.pageInfo?.endCursor ?? null;
  }
}
