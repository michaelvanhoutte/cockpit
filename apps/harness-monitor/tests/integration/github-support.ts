import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import worker from '../../src/worker';
import recorded from './fixtures/github-pull-requests.json';
import { costRows, thePage, type CostRow } from './support';

/** The pull requests of GitHub's real answer, recorded once from the GraphQL query the job sends. */
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
  closingIssuesReferences: { nodes: { number: number }[] };
}

/** A recorded pull request by number: 884 closes nothing, 292 is open, 969 and 979 are merged and close an issue. */
export const recordedPullRequest = (number: number): Node => {
  const found = RECORDED_NODES.find((n) => n.number === number);
  if (!found) throw new Error(`No recorded pull request ${number}.`);
  return structuredClone(found);
};

/** A recorded pull request with some of its fields replaced. */
export const pullRequest = (over: Partial<Node> & { number: number }, from = 979): Node => ({
  ...recordedPullRequest(from),
  ...over,
});

export const pageOf = (nodes: Node[], hasNextPage = false) =>
  Response.json({ data: { search: { pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${nodes.length}` : null }, nodes } } });

/** An answer that pages through `all` by the size asked for, as GitHub does; the cursor is how many were given so far. */
export const listing = (all: Node[]) => (call: { after: string | null; first: number }) => {
  const from = call.after === null ? 0 : Number(call.after.replace('cursor-', ''));
  const to = Math.min(from + call.first, all.length);
  return Response.json({
    data: { search: { pageInfo: { hasNextPage: to < all.length, endCursor: to < all.length ? `cursor-${to}` : null }, nodes: all.slice(from, to) } },
  });
};

export interface GitHubCall {
  q: string;
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
export function fakeGitHub(answer: (call: GitHubCall, calls: GitHubCall[]) => Response | Promise<Response>) {
  const calls: GitHubCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href !== 'https://api.github.com/graphql') throw new Error(`Unexpected request to ${url.href}`);
    const { variables } = JSON.parse(String(init?.body)) as { variables: { q: string; after: string | null; first: number } };
    const call = { q: variables.q, after: variables.after, first: variables.first, authorization: new Headers(init?.headers).get('authorization') };
    calls.push(call);
    return answer(call, calls);
  });
  return calls;
}

/** The hourly schedule firing, entered through the Worker's own scheduled handler. */
export async function runHourly(over: { GITHUB_TOKEN?: string | undefined } = { GITHUB_TOKEN: 'test-token' }) {
  const ctx = createExecutionContext();
  const { GITHUB_TOKEN, ...rest } = { ...env, GITHUB_REPOSITORY: 'owner/repo', ...over };
  await worker.scheduled(createScheduledController({ cron: '0 * * * *' }), GITHUB_TOKEN === undefined ? rest : { ...rest, GITHUB_TOKEN }, ctx);
  await waitOnExecutionContext(ctx);
}

export async function theLinkState() {
  const { results } = await env.DB.prepare('SELECT cursor, last_success_at FROM link_state').all<{ cursor: string | null; last_success_at: number | null }>();
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