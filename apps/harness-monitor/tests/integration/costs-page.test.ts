import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, send, spend, thePage, usage, whereItWent, withPrices } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.restoreAllMocks());

/** The Worker's own entry, with `db` in place of its database, so what the page asks of it can be read. */
async function viewWith(db: D1Database, query: string, over: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://monitor.test/${query}`), { ...env, ...over, DB: db }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A database that notes every statement the page prepares. */
function watched(db: D1Database) {
  const statements: string[] = [];
  const proxy = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'prepare') {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, statements };
}

describe('Harness Monitor', () => {
  describe('the page never reads request rows', () => {
    it.each([
      { situation: 'by pull request', query: '?period=all' },
      { situation: 'by issue', query: '?period=all&group=issue' },
      { situation: 'by engineer, for one engineer', query: '?period=all&group=engineer&engineer=alice' },
      { situation: 'by category, for one category', query: '?period=all&group=category&category=building' },
      { situation: 'by day', query: '?period=7d&group=day' },
    ])('a page view $situation is answered from the daily totals and the links', async ({ query }) => {
      await withPrices();
      await send([spend('paid', 1, { branch: 'b/1' }), usage('waiting', { model: 'claude-future-1', branch: 'b/2' })]);
      await linked(pullRequest({ number: 1, title: 'Mine', headRefName: 'b/1', author: { login: 'alice' } }));
      const { proxy, statements } = watched(env.DB);

      const response = await viewWith(proxy, query);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Tokens with no price');
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter((sql) => /usage_requests/.test(sql))).toEqual([]);
    });
  });

  describe('a page view is cheap for the free plan', () => {
    it('a page viewed again within minutes is the one the edge kept, whatever was reported since', async () => {
      await withPrices();
      await send([spend('first', 1)]);
      const cached = { PAGE_CACHE_SECONDS: '300' };
      const first = await viewWith(env.DB, '?period=all&group=day', cached);
      await send([spend('second', 5)]);

      const second = await viewWith(env.DB, '?period=all&group=day', cached);
      const another = await viewWith(env.DB, '?period=all&group=day&group=pr&junk=1&engineer=', cached);

      expect(first.headers.get('cache-control')).toBe('public, max-age=300');
      expect(whereItWent(await second.text()).heading).toBe("Where the period's $1.00 went, by phase");
      expect(whereItWent(await another.text()).heading).toBe("Where the period's $1.00 went, by phase");
      expect(whereItWent(await thePage('?period=all&group=day')).heading).toBe("Where the period's $6.00 went, by phase");
    });
  });

  describe('the page with nothing to show', () => {
    it('with no requests yet it says nothing is in the period rather than an empty table', async () => {
      const html = await thePage();

      expect(html).toContain('Nothing in this period');
      expect(costRows(html)).toEqual([]);
      expect(whereItWent(html).heading).toBe("Where the period's $0.00 went, by phase");
    });

    it('the not-measured note and the list-price label are always there', async () => {
      const html = await thePage();

      expect(html).toContain('Claude Code Review runs on Anthropic&rsquo;s side, is billed through claude.ai, and is <strong>not measured</strong>');
      expect(html).not.toContain('Approvals');
      await send([spend('r', 1)]);
      expect(await thePage('?period=all')).toContain('at API list price');
    });
  });
});
