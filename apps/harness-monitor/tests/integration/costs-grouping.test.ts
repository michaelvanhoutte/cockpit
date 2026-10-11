import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, send, spend, thePage, whereItWent, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => vi.restoreAllMocks());

/** Three pull requests: 10 and 11 close issue 5 (by alice and bob), 12 closes nothing (by alice). */
const pullRequests = () =>
  linked(
    pullRequest({ number: 10, title: 'First', headRefName: 'b/10', author: { login: 'alice' }, closingIssuesReferences: { nodes: [{ number: 5 }] } }),
    pullRequest({ number: 11, title: 'Second', headRefName: 'b/11', author: { login: 'bob' }, closingIssuesReferences: { nodes: [{ number: 5 }] } }),
    pullRequest({ number: 12, title: 'Third', headRefName: 'b/12', author: { login: 'alice' }, closingIssuesReferences: { nodes: [] } }),
  );

/** Sessions on each pull request's branch, one on a branch no pull request names, one on none. $13.75 in all. */
const sessions = () =>
  send([
    spend('a1', 2, { branch: 'b/10', category: 'building', sessionId: 's1' }),
    spend('a2', 4, { branch: 'b/10', category: 'after-push', sessionId: 's1' }),
    spend('a3', 2, { branch: 'b/10', category: 'building', sessionId: 's2' }),
    spend('b1', 1, { branch: 'b/11', category: 'building' }),
    spend('b2', 1, { branch: 'b/11', category: 'ci-reviews' }),
    spend('c1', 3, { branch: 'b/12', category: 'local-code-review' }),
    spend('x1', 0.5, { branch: 'claude/nobody', category: 'building' }),
    spend('x2', 0.25, { branch: null, category: 'scoping-planning' }),
  ]);

/** Each row as label, total, then the six categories. */
const rows = async (group: string) => costRows(await thePage(`?period=all&group=${group}`)).map((r) => [r.label, r.total, ...r.categories]);

describe('Harness Monitor', () => {
  describe("each group's total is the sum of its requests", () => {
    beforeEach(async () => {
      await sessions();
      await pullRequests();
    });

    it('by pull request, each pull request’s sessions are summed and split by category', async () => {
      expect(await rows('pr')).toEqual([
        ['#10 First', '$8.00', '—', '$4.00', '—', '—', '$4.00', '—'],
        ['#12 Third', '$3.00', '—', '—', '$3.00', '—', '—', '—'],
        ['#11 Second', '$2.00', '—', '$1.00', '—', '—', '—', '$1.00'],
        ['claude/nobody', '$0.50', '—', '$0.50', '—', '—', '—', '—'],
        ['No branch', '$0.25', '$0.25', '—', '—', '—', '—', '—'],
      ]);
    });

    it('by issue, pull requests closing the same issue are summed together', async () => {
      expect(await rows('issue')).toEqual([
        ['Issue #5', '$10.00', '—', '$5.00', '—', '—', '$4.00', '$1.00'],
        ['No issue', '$3.00', '—', '—', '$3.00', '—', '—', '—'],
        ['Unattributed', '$0.75', '$0.25', '$0.50', '—', '—', '—', '—'],
      ]);
    });

    it('by engineer, requests are summed per pull request author and unattributed ones stand alone', async () => {
      expect(await rows('engineer')).toEqual([
        ['alice', '$11.00', '—', '$4.00', '$3.00', '—', '$4.00', '—'],
        ['bob', '$2.00', '—', '$1.00', '—', '—', '—', '$1.00'],
        ['Unattributed', '$0.75', '$0.25', '$0.50', '—', '—', '—', '—'],
      ]);
    });

    it('by category there are six groups, CI reviews among them', async () => {
      await send([spend('s', 0.1, { category: 'local-security-review' })]);

      const byCategory = await rows('category');

      expect(byCategory.map((r) => [r[0], r[1]])).toEqual([
        ['Building', '$5.50'],
        ['After push', '$4.00'],
        ['Local code review', '$3.00'],
        ['CI reviews', '$1.00'],
        ['Scoping & planning', '$0.25'],
        ['Local security review', '$0.10'],
      ]);
    });

    it('by day there is one group per UTC day', async () => {
      await send([
        spend('d1', 1, { time: '2026-03-02T23:59:59Z', branch: 'b/10' }),
        spend('d2', 1, { time: '2026-03-03T00:00:01Z', branch: 'b/10' }),
        spend('d3', 5, { time: '2026-03-03T01:30:00+02:00', branch: 'b/11' }),
      ]);

      expect((await rows('day')).map((r) => [r[0], r[1]])).toEqual([
        ['2026-03-01', '$13.75'],
        ['2026-03-02', '$6.00'],
        ['2026-03-03', '$1.00'],
      ]);
    });

    it('the heading and the bar add up the same requests the table does', async () => {
      const html = await thePage('?period=all');

      expect(whereItWent(html).heading).toBe("Where the period's $13.75 went");
      expect(whereItWent(html).bar).toBe(
        'Scoping & planning $0.25, Building $5.50, Local code review $3.00, Local security review $0.00, After push $4.00, CI reviews $1.00',
      );
    });
  });
});
