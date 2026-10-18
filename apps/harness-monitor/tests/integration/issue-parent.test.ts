import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ISSUES_PER_REQUEST, MAX_ISSUE_REQUESTS } from '../../src/github';
import { fakeGitHub, issuesOf, linked, pageOf, pullRequest, runHourly, theParents, timedOut } from './github-support';
import { costRows, emptyTheDatabase, send, spend, thePage, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => vi.restoreAllMocks());

/** A pull request into a feature branch: GitHub gives no closing reference, the body names the issue. */
const unit = (number: number, issue: number, over: Record<string, unknown> = {}) =>
  pullRequest({ number, title: `Unit ${number}`, headRefName: `b/${number}`, closingIssuesReferences: { nodes: [] }, body: `Part of #${issue}\n`, ...over });

const rows = async () => costRows(await thePage('?period=all&group=issue&sort=total')).map((r) => [r.label, r.total]);

describe('Harness Monitor', () => {
  describe("a pull request's issue is its closing reference, or else the issue its body says it is part of", () => {
    it('a closing reference wins over a Part of line, and needs no further request for its parent', async () => {
      const calls = fakeGitHub(() =>
        pageOf([pullRequest({ number: 10, headRefName: 'b/10', body: 'Part of #99', closingIssuesReferences: { nodes: [{ number: 5, title: 'Child', parent: { number: 1, title: 'Whole' } }] } })]),
      );

      await runHourly();

      expect(await theParents()).toEqual([{ branch: 'b/10', issue: 5, parent: 1, parentTitle: 'Whole' }]);
      expect(calls.issues).toEqual([]);
    });

    it('with no closing reference the Part of line gives the issue, and its parent is read', async () => {
      fakeGitHub(() => pageOf([unit(11, 1241)]), undefined, issuesOf({ 1241: { title: 'Child', parent: { number: 1238, title: 'Whole' } } }));

      await runHourly();

      expect(await theParents()).toEqual([{ branch: 'b/11', issue: 1241, parent: 1238, parentTitle: 'Whole' }]);
    });

    it('with neither the pull request has no issue', async () => {
      await linked(pullRequest({ number: 12, headRefName: 'b/12', body: 'Nothing here', closingIssuesReferences: { nodes: [] } }));

      expect(await theParents()).toEqual([{ branch: 'b/12', issue: null, parent: null, parentTitle: null }]);
    });
  });

  describe("the by-issue view counts a child's cost under its parent", () => {
    const known = {
      21: { title: 'Child A', parent: { number: 20, title: 'Whole run' } },
      22: { title: 'Child B', parent: { number: 20, title: 'Whole run' } },
      30: { title: 'Plain' },
    };

    async function ranWith(...extra: ReturnType<typeof pullRequest>[]) {
      await send([
        spend('a', 2, { branch: 'b/1', category: 'building' }),
        spend('b', 3, { branch: 'b/2', category: 'building' }),
        spend('c', 1, { branch: 'b/3', category: 'building' }),
        ...(extra.length > 0 ? [spend('d', 4, { branch: 'b/4', category: 'building' })] : []),
      ]);
      fakeGitHub(() => pageOf([unit(1, 21), unit(2, 22), unit(3, 30), ...extra]), undefined, issuesOf(known));
      await runHourly();
    }

    it('two children of one parent are one row for the parent, and an issue with no parent is its own row', async () => {
      await ranWith();

      expect(await rows()).toEqual([
        ['#20 Whole run', '$5.00'],
        ['#30 Plain', '$1.00'],
      ]);
    });

    it("a parent's own pull request joins the row its children make", async () => {
      await ranWith(pullRequest({ number: 4, headRefName: 'b/4', closingIssuesReferences: { nodes: [{ number: 20, title: 'Whole run' }] }, body: '' }));

      expect(await rows()).toEqual([
        ['#20 Whole run', '$9.00'],
        ['#30 Plain', '$1.00'],
      ]);
    });
  });

  describe('a run stays inside its request budget, and pull requests linked before gain their parent', () => {
    it('issues named on a page are read together in one request', async () => {
      const calls = fakeGitHub(() => pageOf([unit(1, 21), unit(2, 22), unit(3, 21)]), undefined, issuesOf({ 21: { title: 'A' }, 22: { title: 'B' } }));

      await runHourly();

      expect(calls.issues).toEqual([{ numbers: [21, 22] }]);
    });

    it('never asks for more than its allowance of issue requests, however many issues are named', async () => {
      const prs = Array.from({ length: ISSUES_PER_REQUEST * MAX_ISSUE_REQUESTS + 5 }, (_, i) => unit(100 + i, 500 + i));
      const calls = fakeGitHub(() => pageOf(prs), undefined, issuesOf({}));

      await runHourly();

      expect(calls.issues).toHaveLength(MAX_ISSUE_REQUESTS);
    });

    it('the first run after the parent was added re-reads every pull request once, and every stored link gains its parent', async () => {
      await linked(unit(1, 21));
      await env.DB.prepare('UPDATE link_state SET sizing_version = 1').run();
      expect(await theParents()).toEqual([{ branch: 'b/1', issue: 21, parent: null, parentTitle: null }]);

      fakeGitHub(() => pageOf([unit(1, 21)]), undefined, issuesOf({ 21: { title: 'A', parent: { number: 20, title: 'Whole' } } }));
      await runHourly();
      expect(await theParents()).toEqual([{ branch: 'b/1', issue: 21, parent: 20, parentTitle: 'Whole' }]);
      const version = () => env.DB.prepare('SELECT sizing_version AS v FROM link_state').first<{ v: number }>();
      expect((await version())!.v).toBeGreaterThan(1);
    });

    it.each([
      { situation: 'times out', answer: () => timedOut() },
      { situation: 'cannot see the issue', answer: () => issuesOf({ 21: null })({ numbers: [21] }) },
      { situation: 'answers with an error', answer: () => new Response('no', { status: 500 }) },
    ])('GitHub that $situation leaves the link stored without a parent, and the run does not fail', async ({ answer }) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeGitHub(() => pageOf([unit(1, 21)]), undefined, answer);

      await runHourly();

      expect(await theParents()).toEqual([{ branch: 'b/1', issue: 21, parent: null, parentTitle: null }]);
    });

    it('a parent already stored is kept when GitHub does not give it again', async () => {
      fakeGitHub(() => pageOf([unit(1, 21)]), undefined, issuesOf({ 21: { title: 'A', parent: { number: 20, title: 'Whole' } } }));
      await runHourly();
      vi.restoreAllMocks();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await env.DB.prepare('UPDATE link_state SET sizing_version = 1').run();
      fakeGitHub(() => pageOf([unit(1, 21)]), undefined, () => timedOut());

      await runHourly();

      expect((await theParents())[0]!.parent).toBe(20);
    });
  });
});
