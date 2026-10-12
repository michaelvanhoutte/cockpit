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
  /** True when GitHub's answer carried errors, so a missing issue or engineer may only be one it could not give. */
  partial: boolean;
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

/**
 * The repository's pull requests in update order. GitHub's cursor on this
 * connection marks a place in that order rather than a count of results, so a
 * pull request updated while it is read moves past it and is read again, and
 * none is ever stepped over, whatever the run's length.
 */
const QUERY = `query($owner: String!, $name: String!, $after: String, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(orderBy: { field: UPDATED_AT, direction: ASC }, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
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
  /** Where the next run starts: caught up, the start of the last page read; cut short, its end. */
  cursor: string | null;
  /** True when GitHub refused the place the run was given, so it read from the first pull request instead. */
  restarted: boolean;
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

function toPullRequest(node: Node | null, partial: boolean): PullRequest | null {
  // A node missing what a pull request always has is skipped rather than stored half-known.
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
    partial,
  };
}

interface Connection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: (Node | null)[];
}

/**
 * One page: what GitHub answered and whether errors came with it, why it did
 * not answer whole and in time, or the message refusing the `after` it was given.
 */
type Page = { connection: Required<Connection>; partial: boolean } | { timeout: string } | { badCursor: string };

const TIMEOUT_ERROR = /time(d)? ?out/i;
/** How GitHub refuses an `after` it cannot read, such as a cursor of a format it no longer accepts. */
const BAD_CURSOR = /cursor|'after'/i;

interface Variables {
  owner: string;
  name: string;
  after: string | null;
  first: number;
}

/** Reads a page, treating whatever means the query ran too long as a timeout and anything else wrong as a throw. */
async function readPage(token: string, variables: Variables): Promise<Page> {
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
    const body = (await response.json()) as {
      data?: { repository?: { pullRequests?: Connection } | null };
      errors?: { message?: string }[];
    };
    const message = body.errors?.[0]?.message;
    const partial = !!body.errors?.length;
    // GitHub's commonest timeout is a 200 whose error says so, whatever part of the page came with it.
    if (body.errors?.some((e) => e.message && TIMEOUT_ERROR.test(e.message))) return { timeout: 'GitHub did not answer in time' };
    const connection = body.data?.repository?.pullRequests;
    // GitHub answers what it could beside errors about the rest, such as a closing issue the token cannot see: those fields read as missing.
    if (connection?.nodes) {
      const { nodes, pageInfo } = connection;
      // A page missing a pull request, or not saying where it ends, cannot be stepped past.
      if (nodes.includes(null) || typeof pageInfo?.hasNextPage !== 'boolean' || (pageInfo.hasNextPage && !pageInfo.endCursor)) {
        return { timeout: 'GitHub answered only part of a page' };
      }
      return { connection: { nodes, pageInfo: pageInfo! }, partial };
    }
    if (variables.after !== null && message && BAD_CURSOR.test(message)) return { badCursor: message };
    if (partial) throw new Error(`GitHub reported: ${message ?? 'an error'}`);
    throw new Error(`GitHub answered without the pull requests of ${variables.owner}/${variables.name}.`);
  } catch (error) {
    // Our own limit on waiting ran out, in the answer or in its body.
    if (error instanceof Error && error.name === 'TimeoutError') return { timeout: 'GitHub did not answer in time' };
    throw error;
  }
}

/**
 * Reads the pull requests after `after`, GitHub's place in the repository's
 * update order where the last run stopped, or from the first when it is null,
 * and returns the place the next run starts from. A run cut short by its
 * request budget therefore leaves nothing behind its cursor unread, and a run
 * that caught up leaves its last page to be read again.
 *
 * Throws on anything GitHub answers badly, a rate limit included, and on a
 * timeout before any page was read: the caller stores nothing from a run that
 * threw. A timeout the retry does not cure, after pages were read, ends the run
 * early with what it has, as does a page GitHub answered only in part. A place
 * GitHub refuses on the run's first request is dropped once, and the run reads
 * from the first pull request instead.
 */
export async function fetchChangedPullRequests(repository: string, token: string, after: string | null): Promise<Fetched> {
  const [owner = '', name = ''] = repository.split('/');
  const pullRequests: PullRequest[] = [];
  let cursor = after;
  let restarted = false;
  let requests = 0;
  let size = PAGE_SIZE;
  for (let pages = 0; ; pages += 1) {
    requests += 1;
    let page = await readPage(token, { owner, name, after: cursor, first: size });
    if ('badCursor' in page && pages === 0 && !restarted) {
      // Only the place the run was given: GitHub no longer reads it, so start from the first pull request, as a full re-read would.
      restarted = true;
      cursor = null;
      requests += 1;
      page = await readPage(token, { owner, name, after: cursor, first: size });
    }
    if ('badCursor' in page) throw new Error(`GitHub reported: ${page.badCursor}`);
    if ('timeout' in page && requests < MAX_REQUESTS) {
      // One retry at half the size, which the rest of the run keeps.
      size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
      requests += 1;
      page = await readPage(token, { owner, name, after: cursor, first: size });
    }
    if ('badCursor' in page) throw new Error(`GitHub reported: ${page.badCursor}`);
    if ('timeout' in page) {
      if (pages === 0) throw new Error(`${page.timeout}.`);
      return { pullRequests, caughtUp: false, timeout: page.timeout, cursor, restarted };
    }
    const { nodes, pageInfo } = page.connection;
    for (const node of nodes) {
      const pr = toPullRequest(node, page.partial);
      if (pr) pullRequests.push(pr);
    }
    // Caught up, the next run starts where this last page did, so a pull
    // request stamped with an update time before it became visible, which
    // lands behind the newest ones, is still ahead of that place and read then.
    if (!pageInfo.hasNextPage) return { pullRequests, caughtUp: true, timeout: null, cursor, restarted };
    cursor = pageInfo.endCursor!;
    // Cut short, the next run carries straight on: the pull requests near now are read again on the run that catches up.
    if (requests >= MAX_REQUESTS) return { pullRequests, caughtUp: false, timeout: null, cursor, restarted };
  }
}
