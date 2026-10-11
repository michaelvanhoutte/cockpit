import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { emptyTheDatabase, micros, pullRequestFigures, send, spend, thePage, thePullRequest, usage, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => vi.restoreAllMocks());

/** Three sessions on one pull request's branch, one on another's, in several categories. */
async function seed() {
  await send([
    spend('a1', 5, { sessionId: 's-local', category: 'building', ranWhere: 'local' }),
    spend('a2', 3, { sessionId: 's-local', category: 'local-code-review', reviewLevel: 'xhigh', ranWhere: 'local' }),
    spend('a3', 2, { sessionId: 's-local', category: 'local-code-review', reviewLevel: 'xhigh', ranWhere: 'local' }),
    spend('a4', 1, { sessionId: 's-local', category: 'local-code-review', reviewLevel: 'high', ranWhere: 'local' }),
    spend('b1', 7, { sessionId: 's-cloud', category: 'after-push', ranWhere: 'cloud', model: 'claude-sonnet-5' }),
    spend('c1', 2, { sessionId: 's-actions', category: 'ci-reviews', ranWhere: 'actions' }),
    spend('x1', 40, { sessionId: 's-other', branch: 'b/other' }),
  ]);
  await linked(
    pullRequest({ number: 471, title: 'Add a <Filter> panel', headRefName: 'claude/build-1', author: { login: 'alice' } }),
    pullRequest({ number: 472, title: 'Other', headRefName: 'b/other', author: { login: 'bob' } }),
  );
}

describe('Harness Monitor', () => {
  describe("a pull request's page adds up", () => {
    it('its categories sum to its total, and say what each holds', async () => {
      await seed();

      const figures = pullRequestFigures(await (await thePullRequest(471, '?period=all')).text());

      expect(figures.total).toBe('$20.00');
      expect(figures.categories.map((c) => [c.name, c.amount])).toEqual([
        ['Scoping & planning', '$0.00'],
        ['Building', '$5.00'],
        ['Local code review', '$6.00'],
        ['Local security review', '$0.00'],
        ['After push', '$7.00'],
        ['CI reviews', '$2.00'],
      ]);
      expect(figures.categories.reduce((sum, c) => sum + micros(c.amount), 0)).toBe(micros(figures.total));
      const detail = Object.fromEntries(figures.categories.map((c) => [c.name, c.detail]));
      expect(detail['Local code review']).toBe('xhigh × 2 · high × 1 requests');
      expect(detail['Building']).toBe('1 request');
      expect(detail['Local security review']).toBe('none');
      expect(detail['CI reviews']).toBe('1 request (@claude) · app reviews not measured');
    });

    it('its sessions sum to its total, each with where it ran, its models, requests and tokens', async () => {
      await seed();

      const html = await (await thePullRequest(471, '?period=all')).text();
      const figures = pullRequestFigures(html);

      expect(figures.sessions.map((s) => [s.id, s.where, s.models, s.requests, s.tokens, s.cost])).toEqual([
        ['s-local', 'Local', 'claude-sonnet-5', '4', '5.5 M', '$11.00'],
        ['s-cloud', 'Cloud', 'claude-sonnet-5', '1', '3.5 M', '$7.00'],
        ['s-actions', 'GitHub Actions', 'claude-sonnet-5', '1', '1.0 M', '$2.00'],
      ]);
      expect(figures.sessions.reduce((sum, s) => sum + micros(s.cost), 0)).toBe(micros(figures.total));
      expect(html).toContain('Closes issue');
      expect(html).toContain('alice');
      expect(html).toContain('Add a &#60;Filter&#62; panel');
    });

    it('the period and category filters narrow the total, the categories and the sessions together', async () => {
      await seed();

      const figures = pullRequestFigures(await (await thePullRequest(471, '?period=all&category=after-push')).text());

      expect(figures.total).toBe('$7.00');
      expect(figures.categories.map((c) => [c.name, c.amount])).toEqual([['After push', '$7.00']]);
      expect(figures.sessions.map((s) => [s.id, s.cost])).toEqual([['s-cloud', '$7.00']]);
    });

    it('a request with no price is left out of the dollars and counted beside them', async () => {
      await send([usage('waiting', { model: 'claude-future-1', sessionId: 's-1' }), spend('paid', 4, { sessionId: 's-1' })]);
      await linked(pullRequest({ number: 471, headRefName: 'claude/build-1' }));

      const figures = pullRequestFigures(await (await thePullRequest(471, '?period=all')).text());

      expect(figures.total).toBe('$4.00 + 1 unpriced');
      expect(figures.sessions.map((s) => [s.requests, s.cost])).toEqual([['2', '$4.00 + 1 unpriced']]);
    });

    it('opens from the costs table, keeping the period and category', async () => {
      await seed();

      const html = await thePage('?period=all&category=building&engineer=alice');

      expect(html).toContain('href="/pr/471?period=all&category=building"');
    });

    it('a number no pull request has is nothing found', async () => {
      await seed();

      const responses = await Promise.all([thePullRequest(99999), thePullRequest('abc'), thePullRequest(0)]);

      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(await response.text()).toContain('Nothing found');
      }
    });
  });
});
