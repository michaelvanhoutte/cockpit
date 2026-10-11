import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { emptyTheDatabase, micros, send, spend, theExport, thePage, thePullRequest, usage, whereItWent, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const COLUMNS = [
  'time', 'session', 'branch', 'pull_request', 'issue', 'engineer', 'category', 'model', 'speed', 'ran_where',
  'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'cost_usd', 'pricing',
];
const cost = (row: string[]) => (row[14] === '' ? 0 : Math.round(Number(row[14]) * 1e6));

describe('Harness Monitor', () => {
  describe("the export is the page's requests, one per line", () => {
    it.each([
      { situation: 'every request', query: '?period=all', times: ['01', '02', '03', '04', '05'] },
      { situation: 'one category', query: '?period=all&category=building', times: ['01', '03', '05'] },
      { situation: 'one engineer', query: '?period=all&engineer=alice', times: ['01', '02', '03'] },
      { situation: 'requests no pull request claims', query: '?period=all&engineer=~unattributed', times: ['05'] },
      { situation: 'an engineer and a category', query: '?period=all&engineer=alice&category=building', times: ['01', '03'] },
      { situation: 'the last 7 days', query: '?period=7d', times: ['04', '05'] },
      { situation: 'one pull request', query: '?period=all&pr=2', times: ['04'] },
      { situation: 'a grouping, which changes no request', query: '?period=all&group=day&page=3', times: ['01', '02', '03', '04', '05'] },
    ])('$situation: the lines are the requests the page counts', async ({ query, times }) => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-31T12:00:00Z') });
      await send([
        spend('1', 4, { branch: 'b/alice', category: 'building', time: '2026-03-01T10:01:00Z' }),
        spend('2', 2, { branch: 'b/alice', category: 'after-push', time: '2026-03-01T10:02:00Z' }),
        spend('3', 1, { branch: 'b/alice', category: 'building', time: '2026-03-02T10:03:00Z' }),
        spend('4', 8, { branch: 'b/bob', category: 'after-push', time: '2026-03-28T10:04:00Z' }),
        spend('5', 16, { branch: 'b/nobody', category: 'building', time: '2026-03-30T10:05:00Z' }),
      ]);
      await linked(
        pullRequest({ number: 1, headRefName: 'b/alice', author: { login: 'alice' } }),
        pullRequest({ number: 2, headRefName: 'b/bob', author: { login: 'bob' } }),
      );

      const { response, rows } = await theExport(query);

      expect(response.status).toBe(200);
      expect(rows.map((r) => r[0]!.slice(14, 16))).toEqual(times);
      // The page's own figures, for the same address, count exactly these dollars.
      if (!query.includes('pr=')) {
        const heading = whereItWent(await thePage(query.replace('&pr=2', '')) ).heading;
        expect(rows.reduce((sum, r) => sum + cost(r), 0)).toBe(micros(heading));
      } else {
        const page = await (await thePullRequest(2, query.replace('&pr=2', ''))).text();
        expect(micros(/id="pr-total">(.*?)<\/div>/.exec(page)![1]!)).toBe(rows.reduce((sum, r) => sum + cost(r), 0));
      }
    });

    it('a line says who the request was for and where it ran', async () => {
      await send([spend('1', 3, { branch: 'b/alice', sessionId: 'session-9', category: 'after-push', ranWhere: 'cloud', speed: 'fast', time: '2026-03-01T10:00:00Z' })]);
      await linked(pullRequest({ number: 12, headRefName: 'b/alice', author: { login: 'alice' }, closingIssuesReferences: { nodes: [{ number: 7 }] } }));

      const { header, rows, response } = await theExport('?period=all');

      expect(header).toEqual(COLUMNS);
      expect(response.headers.get('content-type')).toContain('text/csv');
      expect(response.headers.get('content-disposition')).toContain('attachment');
      expect(rows).toEqual([
        ['2026-03-01T10:00:00.000Z', 'session-9', 'b/alice', '12', '7', 'alice', 'after-push', 'claude-sonnet-5', 'fast', 'cloud', '1500000', '0', '0', '0', '3.000000', 'priced'],
      ]);
    });

    it('an unpriced request has no cost and says so', async () => {
      await send([usage('waiting', { model: 'claude-future-1' })]);

      const { rows } = await theExport('?period=all');

      expect(rows.map((r) => [r[14], r[15]])).toEqual([['', 'unpriced']]);
    });

    it('a request priced at upload says so, and one priced as it arrived does not', async () => {
      await send([spend('uploaded', 1, { source: 'upload', time: '2026-03-01T10:00:00Z' }), spend('live', 1, { time: '2026-03-01T10:01:00Z' })]);

      const { rows } = await theExport('?period=all');

      expect(rows.map((r) => [r[14], r[15]])).toEqual([['1.000000', 'priced at upload'], ['1.000000', 'priced']]);
    });

    it('no requests in range is the header line alone', async () => {
      await send([spend('old', 1, { time: '2020-01-01T00:00:00Z' })]);

      const { header, rows, text } = await theExport('?period=7d');

      expect(header).toEqual(COLUMNS);
      expect(rows).toEqual([]);
      expect(text).toBe(`${COLUMNS.join(',')}\r\n`);
    });

    it('a pull request number nobody has is the header line alone', async () => {
      await send([spend('1', 1)]);

      expect((await theExport('?period=all&pr=999')).rows).toEqual([]);
      expect((await theExport('?period=all&pr=abc')).rows).toEqual([]);
    });

    it('a year of requests is exported whole, in order, none twice, across several reads of the database', async () => {
      // 45,000 requests, three to a moment, so a page boundary falls inside a moment: more than two of the 20,000-row reads a year needs.
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 44999)
         INSERT INTO usage_requests (request_id, session_id, occurred_at, day, branch, category, model, speed,
           input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, subagent, ran_where, source, ingest_id, received_at, cost_micros, price_basis)
         SELECT printf('r%06d', i), printf('s%06d', i), 1767225600000 + (i / 3) * 60000, strftime('%Y-%m-%d', 1767225600 + (i / 3) * 60, 'unixepoch'),
           'b/year', 'building', 'claude-sonnet-5', 'standard', 1, 1, 1, 1, 0, 'local', 'hook', 'seed', 0, 1000000, 'arrival'
         FROM n`,
      ).run();

      const { header, rows } = await theExport('?period=all');

      expect(header).toEqual(COLUMNS);
      expect(rows).toHaveLength(45_000);
      expect(new Set(rows.map((r) => `${r[0]}|${r[1]}`)).size).toBe(45_000);
      const times = rows.map((r) => r[0]!);
      expect(times).toEqual([...times].sort());
      expect(rows.reduce((sum, r) => sum + cost(r), 0)).toBe(45_000 * 1_000_000);
    });
  });

  describe('nothing personal or conversational is exported', () => {
    it('whatever else a sender attaches, no line holds an email address or any text of a conversation', async () => {
      const extras = { email: 'someone@example.com', prompt: 'please keep this conversation secret', text: 'hello', userEmail: 'a.b@example.org' };
      await send([spend('1', 2, { branch: 'b/alice', ...extras }), usage('2', { ...extras })]);
      await linked(pullRequest({ number: 12, headRefName: 'b/alice', author: { login: 'alice' } }));

      const { text, header } = await theExport('?period=all');
      const page = await (await thePullRequest(12, '?period=all')).text();
      const costs = await thePage('?period=all');

      expect(header).toEqual(COLUMNS);
      for (const output of [text, page, costs]) {
        expect(output).not.toMatch(/@example|someone|secret|hello|conversation/);
      }
      expect(text).not.toContain('@');
    });

    it('a text cell a spreadsheet would run as a formula is defused, and a comma or quote is quoted', async () => {
      await send([spend('1', 1, { branch: '=cmd|"x",y', sessionId: '@sum' })]);

      const { text } = await theExport('?period=all');

      expect(text).toContain(`"'=cmd|""x"",y"`);
      expect(text).toContain(",'@sum,");
    });
  });
});
