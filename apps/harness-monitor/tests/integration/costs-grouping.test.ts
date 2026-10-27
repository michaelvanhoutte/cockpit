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

/** Each row as label, total, then what hovering its bar says. */
const rows = async (group: string, sort = 'total') => costRows(await thePage(`?period=all&group=${group}&sort=${sort}`)).map((r) => [r.label, r.total, r.colours]);

describe('Harness Monitor', () => {
  describe("each group's total is the sum of its requests", () => {
    beforeEach(async () => {
      await sessions();
      await pullRequests();
    });

    it('by pull request, each pull request’s sessions are summed and its hover names each category', async () => {
      expect(await rows('pr')).toEqual([
        ['#10 First', '$8.00', 'Building $4.00 · After push $4.00'],
        ['#12 Third', '$3.00', 'Local code review $3.00'],
        ['#11 Second', '$2.00', 'Building $1.00 · CI reviews $1.00'],
        ['claude/nobody', '$0.50', 'Building $0.50'],
        ['No branch', '$0.25', ''],
      ]);
    });

    it('by issue, pull requests closing the same issue are summed together', async () => {
      expect(await rows('issue')).toEqual([
        ['#5', '$10.00', 'Building $5.00 · After push $4.00 · CI reviews $1.00'],
        ['No issue', '$3.00', ''],
        ['Unattributed', '$0.75', ''],
      ]);
    });

    it('by engineer, requests are summed per pull request author and unattributed ones stand alone', async () => {
      expect(await rows('engineer')).toEqual([
        ['alice', '$11.00', 'Building $4.00 · Local code review $3.00 · After push $4.00'],
        ['bob', '$2.00', 'Building $1.00 · CI reviews $1.00'],
        ['Unattributed', '$0.75', ''],
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

    it('by day there is one group per Belgian day, the newest first', async () => {
      await send([
        spend('d1', 1, { time: '2026-10-02T21:59:59Z', branch: 'b/10' }),
        spend('d2', 1, { time: '2026-10-02T22:00:01Z', branch: 'b/10' }),
        spend('d3', 5, { time: '2026-10-02T23:30:00+02:00', branch: 'b/11' }),
      ]);

      expect((await rows('day', 'default')).map((r) => [r[0], r[1]])).toEqual([
        ['3 Oct 2026', '$1.00'],
        ['2 Oct 2026', '$6.00'],
        ['1 Oct 2026', '$13.75'],
      ]);
    });

    it('the heading and the bar add up the same requests the table does', async () => {
      const html = await thePage('?period=all');

      expect(whereItWent(html).heading).toBe("Where the period's $13.75 went, by phase");
      expect(whereItWent(html).bar).toBe(
        'Outside the process $0.00, Scoping & planning $0.25, Building $5.50, Local code review $3.00, Local security review $0.00, After push $4.00, CI reviews $1.00, Process review $0.00',
      );
    });
  });
});
