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

/** Pull requests per page; GitHub's search returns at most 1000 results for one query. */
export const PAGE_SIZE = 100;

/**
 * Most pages one run reads. Each page is one subrequest, and the free plan allows
 * 50 per invocation (D1 queries count too), so this leaves room for the rest.
 */
export const MAX_PAGES = 30;

const QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title state mergedAt updatedAt headRefName
        author { login }
        closingIssuesReferences(first: 1) { nodes { number } }
      }
    }
  }
}`;

export interface Fetched {
  pullRequests: PullRequest[];
  /** False when the run stopped for its page budget with more still to read. */
  caughtUp: boolean;
}

interface Node {
  number?: number;
  title?: string;
  state?: string;
  mergedAt?: string | null;
  updatedAt?: string;
  headRefName?: string;
  author?: { login?: string } | null;
  closingIssuesReferences?: { nodes?: { number?: number }[] };
}

function toPullRequest(node: Node | null): PullRequest | null {
  // Search also yields non-pull-request nodes as empty objects; a pull request names its branch.
  if (!node || typeof node.number !== 'number' || !node.headRefName || !node.updatedAt) return null;
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

/**
 * Reads the pull requests updated at or after `since`, oldest first, so a run
 * cut short by its page budget leaves a cursor with nothing older unread.
 * `>=` re-reads the pull request the cursor names; storing it again is harmless.
 *
 * Throws on anything GitHub answers badly, a rate limit included: the caller
 * stores nothing from a run that threw.
 */
export async function fetchChangedPullRequests(
  repository: string,
  token: string,
  since: string | null,
): Promise<Fetched> {
  const q = `repo:${repository} is:pr sort:updated-asc${since ? ` updated:>=${since}` : ''}`;
  const pullRequests: PullRequest[] = [];
  let after: string | null = null;
  for (let page = 1; ; page += 1) {
    const response: Response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'harness-monitor',
      },
      body: JSON.stringify({ query: QUERY, variables: { q, after } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    const body = (await response.json()) as {
      data?: { search?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (Node | null)[] } };
      errors?: { message?: string }[];
    };
    if (body.errors?.length) throw new Error(`GitHub reported: ${body.errors[0]?.message ?? 'an error'}`);
    const search = body.data?.search;
    if (!search?.nodes) throw new Error('GitHub answered without a search result.');

    for (const node of search.nodes) {
      const pr = toPullRequest(node);
      if (pr) pullRequests.push(pr);
    }
    const more = search.pageInfo?.hasNextPage === true && !!search.pageInfo.endCursor;
    // A full last page at the budget may be where GitHub's own cap on a search cut the list off.
    const maybeCapped = page === MAX_PAGES && search.nodes.length === PAGE_SIZE;
    if (!more && !maybeCapped) return { pullRequests, caughtUp: true };
    if (page === MAX_PAGES) return { pullRequests, caughtUp: false };
    after = search.pageInfo?.endCursor ?? null;
  }
}
