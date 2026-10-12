import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import worker from '../../src/worker';
import recorded from './fixtures/github-pull-requests.json';
import recordedSizes from './fixtures/github-pull-request-sizes.json';
import recordedFilesPage from './fixtures/github-pull-request-files-page.json';
import { costRows, thePage, WRITE_KEY, type CostRow } from './support';

/**
 * The pull requests of GitHub's real answer, recorded once from the job's GraphQL search. The repository listing
 * the job reads now asks the same fields of each pull request, so the fakes wrap these nodes in its envelope.
 */
export const RECORDED_NODES: Node[] = recorded.data.search.nodes;
export interface Node {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  updatedAt: string;
  headRefName: string;
  isCrossRepository?: boolean;
  author: { login: string } | null;
  closingIssuesReferences: { nodes: { number: number; title?: string }[] };
  /** What a sized read adds; the first recordings lack them, and read as unsized. */
  id?: string;
  createdAt?: string;
  files?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { path: string; additions: number; deletions: number }[] };
  commits?: { nodes: { commit: { committedDate: string } }[] };
}

/** A recorded pull request by number: 884 closes nothing, 292 is open, 969 and 979 are merged and close an issue. */
export const recordedPullRequest = (number: number): Node => {
  const found = RECORDED_NODES.find((n) => n.number === number);
  if (!found) throw new Error(`No recorded pull request ${number}.`);
  return structuredClone(found);
};

/**
 * A pull request as the job now reads it, files and commits and closing issue's title included, recorded from GitHub:
 * 979 changes 30 files and closes an issue, 618 changes only pnpm-lock.yaml, 884 changes one file and closes nothing,
 * 969 has four commits and closes an issue. Every commit predates the pull request opening.
 */
export const sizedPullRequest = (number: number): Node => {
  const found = Object.values(recordedSizes.data.repository).find((n) => n.number === number);
  if (!found) throw new Error(`No recorded sized pull request ${number}.`);
  return structuredClone(found) as Node;
};

/** The recorded second page of a pull request's files: two files, with more to come. */
export const RECORDED_FILES_PAGE = recordedFilesPage;

/** A recorded pull request with some of its fields replaced. */
export const pullRequest = (over: Partial<Node> & { number: number }, from = 979): Node => ({
  ...recordedPullRequest(from),
  ...over,
});

/** GitHub's cursor after a pull request; here it names the pull request, which is all a test needs to tell them apart. */
export const cursorAfter = (node: Node) => `cursor-${node.number}`;

/** One page of the repository's pull requests, as GitHub answers it: its end is the place after its last pull request. */
export const pageOf = (nodes: Node[], hasNextPage = false) =>
  Response.json({
    data: { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor: nodes.length > 0 ? cursorAfter(nodes.at(-1)!) : null }, nodes } } },
  });

/**
 * An answer that pages through `all`, in the order given, by the size asked
 * for, as GitHub does. The next page starts after the pull request the cursor
 * names, wherever it now stands, so moving another pull request to the end, as
 * an update does, has it read again. Never move the one a stored cursor names.
 */
export const listing = (all: Node[]) => (call: { after: string | null; first: number }) => {
  const at = call.after === null ? -1 : all.findIndex((n) => cursorAfter(n) === call.after);
  if (call.after !== null && at === -1) return badCursor(call.after);
  const from = at + 1;
  const to = Math.min(from + call.first, all.length);
  return pageOf(all.slice(from, to), to < all.length);
};

/** GitHub's answer to an `after` it cannot read. */
export const badCursor = (after: string) => Response.json({ data: null, errors: [{ message: `\`${after}\` does not appear to be a valid cursor.` }] });

/** A page as GitHub answers it with an error about part of it beside the data. */
export async function withErrors(page: Response, message: string) {
  return Response.json({ ...((await page.json()) as object), errors: [{ message }] });
}

/** GitHub taking too long over a page. */
export const timedOut = () => new Response('timeout', { status: 504 });

/** Pages are only places in this order, so the cursor design rests on the job asking for it. */
const UPDATE_ORDER = /pullRequests\(\s*orderBy:\s*\{\s*field:\s*UPDATED_AT,\s*direction:\s*ASC\s*\}/;

export interface GitHubCall {
  /** The repository asked for, as `owner/name`. */
  repository: string;
  after: string | null;
  /** The page size asked for. */
  first: number;
  authorization: string | null;
}

/**
 * A GitHub that can be reached from inside a test, by replacing `fetch` (see
 * apps/api/tests/integration/issuer.ts for why that reaches the Worker). Any
 * other address is refused, so a test that reaches for the internet says so.
 */
export function fakeGitHub(
  answer: (call: GitHubCall, calls: GitHubCall[]) => Response | Promise<Response>,
  /** Answers for the files past a pull request's first 100; a test that does not expect any leaves it out. */
  filesAnswer: (call: FilesCall, calls: FilesCall[]) => Response | Promise<Response> = () => {
    throw new Error('The job asked for more files than the test expected.');
  },
) {
  const calls: GitHubCall[] = [];
  const fileCalls: FilesCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href !== 'https://api.github.com/graphql') throw new Error(`Unexpected request to ${url.href}`);
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { owner: string; name: string; after: string | null; first: number; id?: string };
    };
    if (/^\s*query\(\$id: ID!/.test(query)) {
      const call = { id: variables.id!, after: variables.after };
      fileCalls.push(call);
      return filesAnswer(call, fileCalls);
    }
    if (!UPDATE_ORDER.test(query)) throw new Error('The job did not ask for pull requests in update order, oldest first.');
    const call = {
      repository: `${variables.owner}/${variables.name}`,
      after: variables.after,
      first: variables.first,
      authorization: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    return answer(call, calls);
  });
  return Object.assign(calls, { files: fileCalls });
}

/** A request for the files of one pull request past its first page. */
export interface FilesCall {
  id: string;
  after: string | null;
}
/** The hourly schedule firing, entered through the Worker's own scheduled handler. */
export async function runHourly(over: { GITHUB_TOKEN?: string | undefined } = { GITHUB_TOKEN: 'test-token' }) {
  const ctx = createExecutionContext();
  const { GITHUB_TOKEN, ...rest } = { ...env, GITHUB_REPOSITORY: 'owner/repo', ...over };
  await worker.scheduled(createScheduledController({ cron: '0 * * * *' }), GITHUB_TOKEN === undefined ? rest : { ...rest, GITHUB_TOKEN }, ctx);
  await waitOnExecutionContext(ctx);
}

export async function theLinkState() {
  const { results } = await env.DB.prepare('SELECT page_cursor AS cursor, last_success_at FROM link_state').all<{ cursor: string | null; last_success_at: number | null }>();
  return results;
}

export async function theLinks() {
  const { results } = await env.DB.prepare(
    'SELECT branch, pr_number, title, state, merged_at, issue_number, engineer FROM branch_links ORDER BY branch',
  ).all();
  return results;
}

/** What the page says about a job's last run, as a sentence. */
export async function jobLine(job: 'linking' | 'prices' | 'rebuild') {
  const line = new RegExp(`<li data-job="${job}"[^>]*>(.*?)</li>`, 's').exec(await thePage())?.[1];
  return line?.replace(/&mdash;/g, '—').replace(/&rsquo;/g, "'");
}

export const linkingLine = () => jobLine('linking');

/** What linking stored of each pull request's size, timing, rounds and closing issue's title. */
export async function theStats() {
  const { results } = await env.DB.prepare(
    `SELECT pr_number, lines_added, lines_removed, opened_at, merged_at, ci_rounds, issue_title
     FROM pull_request_stats ORDER BY pr_number`,
  ).all<{
    pr_number: number;
    lines_added: number | null;
    lines_removed: number | null;
    opened_at: string | null;
    merged_at: string | null;
    ci_rounds: number | null;
    issue_title: string | null;
  }>();
  return results;
}

/** A recorded sized pull request (979 unless told) with some of its fields replaced. */
export const sized = (over: Partial<Node> & { number: number }, from = 979): Node => ({ ...sizedPullRequest(from), ...over });

/** A file as GitHub lists a pull request's changes. */
export const file = (path: string, additions: number, deletions: number) => ({ path, additions, deletions });

/** A page of a pull request's files, with or without more after it. */
export const filesOf = (nodes: ReturnType<typeof file>[], endCursor: string | null = null) =>
  ({ pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes });

/** The pull requests GitHub lists, linked now, with GitHub replaced again afterwards. */
export async function linked(...nodes: Node[]) {
  fakeGitHub(() => pageOf(nodes));
  await runHourly();
  vi.restoreAllMocks();
}

/** What the page shows for each row of the pull request table, by label (the pull request, or the branch while it has none). */
export async function pullRequestRows(): Promise<Record<string, CostRow>> {
  return Object.fromEntries(costRows(await thePage('?period=all')).map((r) => [r.label, r]));
}
/** A job started by hand, as `pnpm harness:run` starts it, with the write key unless told otherwise. */
export const startJob = (job: string, headers: Record<string, string> = { authorization: `Bearer ${WRITE_KEY}` }) =>
  SELF.fetch(`https://monitor.test/v1/jobs/${job}`, { method: 'POST', headers });

/** Gives the Worker a token and a repository for linking started by hand, and returns what puts both back as they were. */
export function giveTheWorkerAToken() {
  const before = { GITHUB_TOKEN: env.GITHUB_TOKEN, GITHUB_REPOSITORY: env.GITHUB_REPOSITORY };
  env.GITHUB_TOKEN = 'test-token';
  env.GITHUB_REPOSITORY = 'owner/repo';
  return () => {
    for (const [name, value] of Object.entries(before) as [keyof typeof before, string | undefined][]) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  };
}
