import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_SIZE } from '../../src/github';
import { fakeGitHub, listing, pageOf, pullRequest, recordedPullRequest, runHourly, theLinks, theLinkState, timedOut } from './github-support';
import { emptyTheDatabase, send, usage } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.restoreAllMocks());

/** A run that succeeded earlier: one link, a cursor, a last success time. */
async function afterASuccessfulRun() {
  await send([usage('r1', { sessionId: 's1', branch: 'claude/build-971-fd1134' })]);
  fakeGitHub(() => pageOf([recordedPullRequest(979)]));
  await runHourly();
  vi.restoreAllMocks();
  return { links: await theLinks(), state: await theLinkState() };
}

describe('Harness Monitor', () => {
  describe('a failed run changes nothing', () => {
    it.each([
      { situation: 'GitHub errors', answer: () => new Response('Bad gateway', { status: 502 }) },
      { situation: 'GitHub rate-limits the token', answer: () => new Response('rate limited', { status: 403 }) },
      { situation: 'GitHub answers with an error in its body', answer: () => Response.json({ errors: [{ message: 'API rate limit exceeded' }] }) },
      {
        situation: 'the connection fails',
        answer: (): Response => {
          throw new Error('network down');
        },
      },
    ])('$situation: the links, the cursor and the last success time stay as they were', async ({ answer }) => {
      const before = await afterASuccessfulRun();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeGitHub(answer);

      await runHourly();

      expect(await theLinks()).toEqual(before.links);
      expect(await theLinkState()).toEqual(before.state);
    });

    it.each([502, 504])('a page GitHub times out on (%i) is asked again once at half the size, and the run carries on', async (status) => {
      const calls = fakeGitHub((call) => (call.first === PAGE_SIZE ? new Response('timeout', { status }) : pageOf([recordedPullRequest(979)])));

      await runHourly();

      expect(calls.map((c) => c.first)).toEqual([PAGE_SIZE, Math.floor(PAGE_SIZE / 2)]);
      expect((await theLinks()).map((l) => l.pr_number)).toEqual([979]);
      expect((await theLinkState())[0]!.last_success_at).not.toBeNull();
    });

    it("our own limit on waiting running out is treated as GitHub timing out: asked again at half the size", async () => {
      const calls = fakeGitHub((call) => {
        if (call.first === PAGE_SIZE) throw new DOMException('The operation timed out.', 'TimeoutError');
        return pageOf([recordedPullRequest(979)]);
      });

      await runHourly();

      expect(calls.map((c) => c.first)).toEqual([PAGE_SIZE, Math.floor(PAGE_SIZE / 2)]);
      expect((await theLinks()).map((l) => l.pr_number)).toEqual([979]);
    });

    it('once a page needed the half size, the rest of the run keeps it', async () => {
      const all = Array.from({ length: 30 }, (_, i) => pullRequest({ number: i + 1, headRefName: `b/${i + 1}`, updatedAt: `2026-10-01T10:00:${String(i).padStart(2, '0')}Z` }));
      const page = listing(all);
      const calls = fakeGitHub((call) => (call.first === PAGE_SIZE ? timedOut() : page(call)));

      await runHourly();

      expect(calls.map((c) => c.first)).toEqual([PAGE_SIZE, 12, 12, 12]);
      expect(await theLinks()).toHaveLength(30);
    });

    it('repeated timeouts never ask for a page smaller than the floor', async () => {
      const all = Array.from({ length: 60 }, (_, i) => pullRequest({ number: i + 1, headRefName: `b/${i + 1}`, updatedAt: `2026-10-01T10:00:${String(i).padStart(2, '0')}Z` }));
      const page = listing(all);
      // Every page times out on its first try, so each page halves the size again.
      const calls = fakeGitHub((call, all) => (all.length % 2 === 1 ? timedOut() : page(call)));

      await runHourly();

      expect(calls.map((c) => c.first).slice(0, 8)).toEqual([25, 12, 12, 6, 6, 5, 5, 5]);
    });

    it('a slow body, the limit on waiting running out while it is read, is a timeout: asked again at half the size', async () => {
      const calls = fakeGitHub((call) => {
        if (call.first !== PAGE_SIZE) return pageOf([recordedPullRequest(979)]);
        const slow = Response.json({});
        vi.spyOn(slow, 'json').mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
        return slow;
      });

      await runHourly();

      expect(calls.map((c) => c.first)).toEqual([PAGE_SIZE, Math.floor(PAGE_SIZE / 2)]);
      expect((await theLinks()).map((l) => l.pr_number)).toEqual([979]);
    });

    it('a 200 whose error says the query timed out is a timeout: asked again at half the size', async () => {
      const message = 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.';
      const calls = fakeGitHub((call) => (call.first === PAGE_SIZE ? Response.json({ data: null, errors: [{ message }] }) : pageOf([recordedPullRequest(979)])));

      await runHourly();

      expect(calls.map((c) => c.first)).toEqual([PAGE_SIZE, Math.floor(PAGE_SIZE / 2)]);
      expect((await theLinks()).map((l) => l.pr_number)).toEqual([979]);
    });

    it('the first page timing out again on the retry fails the run, says GitHub did not answer in time, and changes nothing', async () => {
      const before = await afterASuccessfulRun();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const calls = fakeGitHub(() => timedOut());

      await runHourly();

      expect(calls).toHaveLength(2);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('GitHub did not answer in time (504).'));
      expect(await theLinks()).toEqual(before.links);
      expect(await theLinkState()).toEqual(before.state);
    });

    it('a run that fails partway, after one page was read, stores nothing of that page', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeGitHub((call) => (call.after === null ? pageOf([recordedPullRequest(979)], true) : new Response('rate limited', { status: 403 })));

      await runHourly();

      expect(await theLinks()).toEqual([]);
      expect((await theLinkState())).toEqual([]);
    });

    it('with no token configured the job skips, says so, and does not ask GitHub', async () => {
      const before = await afterASuccessfulRun();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const calls = fakeGitHub(() => pageOf([]));

      await runHourly({ GITHUB_TOKEN: undefined });

      expect(calls).toHaveLength(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Branch linking skipped: GITHUB_TOKEN'));
      expect(await theLinks()).toEqual(before.links);
      expect(await theLinkState()).toEqual(before.state);
    });
  });
});
