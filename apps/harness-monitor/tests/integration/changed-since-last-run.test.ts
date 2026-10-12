import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REQUESTS } from '../../src/github';
import { cursorAfter, fakeGitHub, listing, pageOf, pullRequest, recordedPullRequest, runHourly, theLinks, theLinkState, timedOut, withErrors } from './github-support';
import { emptyTheDatabase } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.restoreAllMocks());

describe('Harness Monitor', () => {
  describe('only pull requests changed since the last run are fetched', () => {
    it('a run after catching up reads again only from the start of the last page, and with nothing changed leaves everything as it was', async () => {
      const all = [recordedPullRequest(969), recordedPullRequest(979), recordedPullRequest(884)];
      const answer = listing(all);
      const calls = fakeGitHub((call) => answer({ ...call, first: 2 }));

      await runHourly();
      const links = await theLinks();
      const state = await theLinkState();
      expect(calls[0]).toMatchObject({ repository: 'owner/repo', after: null });

      await runHourly();

      expect(calls.map((c) => c.after)).toEqual([null, cursorAfter(all[1]!), cursorAfter(all[1]!)]);
      expect(await theLinks()).toEqual(links);
      expect((await theLinkState())[0]!.cursor).toBe(state[0]!.cursor);
      expect((await theLinkState())[0]!.last_success_at).not.toBeNull();
    });

    it('more pull requests than one page are all read, page after page', async () => {
      const all = [1, 2, 3].map((n) => pullRequest({ number: n, headRefName: `b/${n}`, updatedAt: `2026-10-0${n}T10:00:00Z` }));
      const answer = listing(all);
      const calls = fakeGitHub((call) => answer({ ...call, first: 1 }));

      await runHourly();

      expect(calls.map((c) => c.after)).toEqual([null, 'cursor-1', 'cursor-2']);
      expect((await theLinks()).map((l) => l.pr_number)).toEqual([1, 2, 3]);
    });

    it('a run that never reaches the end stops at its request budget, keeps what it read, and does not claim to have caught up', async () => {
      let next = 0;
      const calls = fakeGitHub(() => {
        next += 1;
        const updatedAt = `2026-10-01T10:00:${String(next).padStart(2, '0')}Z`;
        return pageOf([pullRequest({ number: next, headRefName: `b/${next}`, updatedAt })], true);
      });

      await runHourly();

      expect(calls).toHaveLength(MAX_REQUESTS);
      expect(await theLinks()).toHaveLength(MAX_REQUESTS);
      const state = (await theLinkState())[0]!;
      expect(state.cursor).toBe(`cursor-${MAX_REQUESTS}`);
      expect(state.last_success_at).toBeNull();
    });

    it('a page GitHub answers in part, beside errors about the rest, is kept and the run carries on', async () => {
      // A closing issue the token cannot see comes back as null with an error naming it.
      const hidden = { ...pullRequest({ number: 1, headRefName: 'b/1' }), closingIssuesReferences: null } as unknown as ReturnType<typeof pullRequest>;
      fakeGitHub(async () => withErrors(pageOf([hidden, pullRequest({ number: 2, headRefName: 'b/2' })]), 'Resource not accessible by integration'));

      await runHourly();

      expect((await theLinks()).map((l) => [l.branch, l.issue_number])).toEqual([
        ['b/1', null],
        ['b/2', recordedPullRequest(979).closingIssuesReferences.nodes[0]!.number],
      ]);
      expect((await theLinkState())[0]!.last_success_at).not.toBeNull();
    });

    it("an issue or engineer GitHub could not give, beside errors, never erases the one a branch is already linked to", async () => {
      fakeGitHub(() => pageOf([pullRequest({ number: 1, headRefName: 'b/1' })]));
      await runHourly();
      const before = (await theLinks())[0]!;
      vi.restoreAllMocks();
      const hidden = { ...pullRequest({ number: 1, headRefName: 'b/1', title: 'renamed', updatedAt: '2026-10-12T10:00:00Z' }), closingIssuesReferences: null, author: null };
      fakeGitHub(async () => withErrors(pageOf([hidden as unknown as ReturnType<typeof pullRequest>]), 'Resource not accessible by integration'));

      await runHourly();

      expect((await theLinks())[0]).toEqual({ ...before, title: 'renamed' });
    });

    it('a pull request read again unchanged is not written again', async () => {
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-04-01T12:00:00Z') });
      try {
        await runHourly();
        vi.setSystemTime(new Date('2026-04-01T13:00:00Z'));
        await runHourly();
      } finally {
        vi.useRealTimers();
      }

      const { results } = await env.DB.prepare('SELECT linked_at FROM branch_links').all<{ linked_at: number }>();
      expect(results.map((r) => r.linked_at)).toEqual([Date.parse('2026-04-01T12:00:00Z')]);
    });
  });

  describe('a page GitHub answers only in part is never stepped past', () => {
    const first = pullRequest({ number: 1, headRefName: 'b/1', updatedAt: '2026-10-01T10:00:00Z' });
    const second = pullRequest({ number: 2, headRefName: 'b/2', updatedAt: '2026-10-02T10:00:00Z' });
    const partOfAPage = async (body: Record<string, unknown>) => Response.json(body);
    const connection = (pageInfo: unknown, nodes: unknown[]) => ({ data: { repository: { pullRequests: { pageInfo, nodes } } } });

    it.each([
      {
        situation: 'pull requests beside an error saying the query timed out',
        answer: async () => withErrors(pageOf([second], true), 'Something went wrong while executing your query. This may be the result of a timeout.'),
      },
      { situation: 'a pull request left out as null', answer: () => partOfAPage({ ...connection({ hasNextPage: false, endCursor: 'cursor-2' }, [second, null]), errors: [{ message: 'x' }] }) },
      { situation: 'no word on where the page ends', answer: () => partOfAPage(connection(undefined, [second])) },
      { situation: 'more to read but no place to read it from', answer: () => partOfAPage(connection({ hasNextPage: true, endCursor: null }, [second])) },
    ])('$situation: the pages before it are kept, the run stops there, and the next run starts at that page', async ({ answer }) => {
      fakeGitHub((call) => (call.after === null ? pageOf([first], true) : answer()));

      await runHourly();

      expect((await theLinks()).map((l) => l.branch)).toEqual(['b/1']);
      expect((await theLinkState())[0]).toEqual({ cursor: cursorAfter(first), last_success_at: null });
    });
  });

  describe('linking reads every pull request, whatever order GitHub returns them in', () => {
    it('pull requests answered out of update order, with the run cut short, are read by the next run', async () => {
      // GitHub answers the newer pull request first; the run ends before the older one.
      const newer = pullRequest({ number: 1, headRefName: 'b/newer', updatedAt: '2026-10-05T10:00:00Z' });
      const older = pullRequest({ number: 2, headRefName: 'b/older', updatedAt: '2026-10-01T10:00:00Z' });
      const answer = listing([newer, older]);
      fakeGitHub((call) => (call.after === null ? answer({ ...call, first: 1 }) : timedOut()));
      await runHourly();
      expect((await theLinks()).map((l) => l.branch)).toEqual(['b/newer']);
      vi.restoreAllMocks();
      fakeGitHub(answer);

      await runHourly();

      expect((await theLinks()).map((l) => l.branch)).toEqual(['b/newer', 'b/older']);
    });

    it('a pull request updated while a catch-up is under way is read again, and its link follows', async () => {
      const all = [1, 2, 3].map((n) => pullRequest({ number: n, headRefName: `b/${n}`, title: `first ${n}`, updatedAt: `2026-10-0${n}T10:00:00Z` }));
      const answer = listing(all);
      fakeGitHub((call) => (call.after === null ? answer({ ...call, first: 2 }) : timedOut()));
      await runHourly();
      vi.restoreAllMocks();
      // Pull request 1 is updated: it moves to the end of the update order.
      all.push({ ...all.shift()!, title: 'renamed 1', updatedAt: '2026-10-09T10:00:00Z' });
      fakeGitHub(answer);

      await runHourly();

      expect((await theLinks()).map((l) => [l.pr_number, l.title])).toEqual([
        [1, 'renamed 1'],
        [2, 'first 2'],
        [3, 'first 3'],
      ]);
    });

    it('a pull request that appears behind the end of a caught-up run, stamped before it was visible, is read by the next run', async () => {
      const all = [1, 2, 3].map((n) => pullRequest({ number: n, headRefName: `b/${n}`, updatedAt: `2026-10-0${n}T10:00:00Z` }));
      const answer = listing(all);
      fakeGitHub((call) => answer({ ...call, first: 1 }));
      await runHourly();
      vi.restoreAllMocks();
      // It is filed before the last pull request the run read.
      all.splice(2, 0, pullRequest({ number: 4, headRefName: 'b/late', updatedAt: '2026-10-02T12:00:00Z' }));
      fakeGitHub(answer);

      await runHourly();

      expect((await theLinks()).map((l) => l.branch)).toContain('b/late');
    });
  });
});
