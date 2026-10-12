import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_SIZE } from '../../src/github';
import { fakeGitHub, pageOf, recordedPullRequest, runHourly, theLinks, theLinkState } from './github-support';
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

    it('a page that times out again on the retry fails the run, says GitHub timed out, and changes nothing', async () => {
      const before = await afterASuccessfulRun();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const calls = fakeGitHub(() => new Response('timeout', { status: 504 }));

      await runHourly();

      expect(calls).toHaveLength(2);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('GitHub timed out (504).'));
      expect(await theLinks()).toEqual(before.links);
      expect(await theLinkState()).toEqual(before.state);
    });

    it('a run that fails partway, after one page was read, stores nothing of that page', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeGitHub((call) => (call.after === null ? pageOf([recordedPullRequest(979)], true) : new Response('Bad gateway', { status: 502 })));

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
