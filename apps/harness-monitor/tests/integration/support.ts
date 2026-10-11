import { env, SELF } from 'cloudflare:test';

export const WRITE_KEY = 'test-write-key';

export const usage = (requestId: string, over: Record<string, unknown> = {}) => ({
  requestId,
  sessionId: 'session_1',
  time: '2026-03-01T10:00:00Z',
  branch: 'claude/build-1',
  category: 'building',
  model: 'claude-sonnet-5-5',
  speed: 'standard',
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationTokens: 30,
  cacheReadTokens: 40,
  subagent: false,
  ranWhere: 'local',
  source: 'hook',
  ...over,
});

/** A write as a real caller makes it, with the right key unless told otherwise. */
export function send(rows: unknown[], headers: Record<string, string> = { authorization: `Bearer ${WRITE_KEY}` }) {
  return SELF.fetch('https://monitor.test/v1/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ rows }),
  });
}

export async function emptyTheDatabase() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM usage_requests'),
    env.DB.prepare('DELETE FROM daily_totals'),
    env.DB.prepare('DELETE FROM branch_links'),
    env.DB.prepare('DELETE FROM link_state'),
  ]);
}

export interface Total {
  day: string;
  category: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

export async function totals(): Promise<Total[]> {
  const { results } = await env.DB.prepare('SELECT * FROM daily_totals ORDER BY day, category, model').all<Total>();
  return results;
}

export async function storedRequestIds(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT request_id FROM usage_requests ORDER BY request_id').all<{
    request_id: string;
  }>();
  return results.map((r) => r.request_id);
}
