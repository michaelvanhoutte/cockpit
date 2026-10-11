import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import worker from '../../src/worker';
import recorded from './fixtures/github-pull-requests.json';

/** The pull requests of GitHub's real answer, recorded once from the GraphQL query the job sends. */
export const RECORDED_NODES: Node[] = recorded.data.search.nodes;
export interface Node {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  updatedAt: string;
  headRefName: string;
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

export interface GitHubCall {
  q: string;
  after: string | null;
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
    const { variables } = JSON.parse(String(init?.body)) as { variables: { q: string; after: string | null } };
    const call = { q: variables.q, after: variables.after, authorization: new Headers(init?.headers).get('authorization') };
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

/** What the public page shows for each session: the cells after its id. */
export async function sessionsOnThePage(): Promise<Record<string, string[]>> {
  const html = await (await SELF.fetch('https://monitor.test/')).text();
  const rows: Record<string, string[]> = {};
  for (const [, id, rest] of html.matchAll(/<tr><td>([^<]+)<\/td>(<td>.*?<\/td>)<\/tr>/g)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(id!)) continue; // a day of the totals table
    rows[id!] = rest!.split('</td><td>').map((c) => c.replace(/<\/?td>/g, ''));
  }
  return rows;
}

export const linkingLine = async () => /Branch linking [^<]*/.exec(await (await SELF.fetch('https://monitor.test/')).text())?.[0];
