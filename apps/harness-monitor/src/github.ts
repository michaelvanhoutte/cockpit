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

/** GitHub's answer to a page, or `'abort'` when our own limit on waiting ran out. */
type Answer = Response | 'abort';

/** 502 and 504 are the query running too long; so is our own abort. */
const timedOut = (answer: Answer) => answer === 'abort' || answer.status === 502 || answer.status === 504;

function reason(answer: Answer): string {
  if (answer === 'abort') return 'GitHub did not answer in time';
  if (answer.status === 502) return 'GitHub failed to answer (502); usually the query took too long';
  return `GitHub did not answer in time (${answer.status})`;
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
  let newest = since;
  let requests = 0;
  let size = PAGE_SIZE;
  const ask = async (first: number): Promise<Answer> => {
    requests += 1;
    try {
      return await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'harness-monitor',
        },
        body: JSON.stringify({ query: QUERY, variables: { q, after, first } }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') return 'abort';
      throw error;
    }
  };
  for (let pages = 0; ; pages += 1) {
    let answer = await ask(size);
    if (timedOut(answer) && requests < MAX_REQUESTS) {
      // One retry at half the size, which the rest of the run keeps.
      if (answer !== 'abort') await answer.body?.cancel();
      size = Math.floor(size / 2);
      answer = await ask(size);
    }
    if (timedOut(answer)) {
      if (answer !== 'abort') await answer.body?.cancel();
      if (pages === 0) throw new Error(`${reason(answer)}.`);
      return { pullRequests, caughtUp: false, timeout: reason(answer) };
    }
    const response = answer as Response;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub answered ${response.status}.`);
    }
    const body = (await response.json()) as {
      data?: { search?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (Node | null)[] } };
      errors?: { message?: string }[];
    };
    if (body.errors?.length) throw new Error(`GitHub reported: ${body.errors[0]?.message ?? 'an error'}`);
    const search = body.data?.search;
    if (!search?.nodes) throw new Error('GitHub answered without a search result.');

    for (const node of search.nodes) {
      if (node?.updatedAt && (newest === null || node.updatedAt > newest)) newest = node.updatedAt;
      const pr = toPullRequest(node);
      if (pr) pullRequests.push(pr);
    }
    const more = search.pageInfo?.hasNextPage === true && !!search.pageInfo.endCursor;
    if (!more) return { pullRequests, caughtUp: true, timeout: null };
    if (requests >= MAX_REQUESTS) return { pullRequests, caughtUp: false, timeout: null };
    after = search.pageInfo?.endCursor ?? null;
  }
}
