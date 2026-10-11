import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGitHub, pageOf, pullRequest, recordedPullRequest, runHourly, sessionsOnThePage, theLinks } from './github-support';
import { emptyTheDatabase, send, usage } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.restoreAllMocks());

describe('Harness Monitor', () => {
  describe("a branch is credited to its pull request, the issue it closes, and that pull request's author", () => {
    it('a pull request closing an issue credits the session to both, and the engineer is its author', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/build-971-fd1134' })]);
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));

      await runHourly();

      expect((await sessionsOnThePage()).s1).toEqual([
        'claude/build-971-fd1134',
        '#979 Stand up the Harness Monitor: store each Claude Code request once, and show daily token totals (#971) (merged)',
        '#971',
        'michaelvanhoutte',
      ]);
    });

    it('a pull request closing nothing is still linked, with no issue', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'fix/milkdown-timer-outlives-jsdom' })]);
      fakeGitHub(() => pageOf([recordedPullRequest(884)]));

      await runHourly();

      const cells = (await sessionsOnThePage()).s1!;
      expect(cells[1]).toContain('#884');
      expect(cells[2]).toBe('none');
      expect(cells[3]).toBe('michaelvanhoutte');
    });

    it('two pull requests from one branch credit the session to the one updated most recently, whatever order GitHub lists them', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/shared' })]);
      const older = pullRequest({ number: 1, headRefName: 'claude/shared', updatedAt: '2026-10-01T10:00:00Z', title: 'Older attempt' });
      const newer = pullRequest({ number: 2, headRefName: 'claude/shared', updatedAt: '2026-10-02T10:00:00Z', title: 'Newer attempt' });
      fakeGitHub(() => pageOf([newer, older]));

      await runHourly();

      expect((await sessionsOnThePage()).s1![1]).toContain('#2 Newer attempt');
    });

    it('a pull request updated before the one already stored for its branch does not replace it', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/shared' })]);
      const newer = pullRequest({ number: 2, headRefName: 'claude/shared', updatedAt: '2026-10-02T10:00:00Z', title: 'Newer attempt' });
      fakeGitHub(() => pageOf([newer]));
      await runHourly();
      vi.restoreAllMocks();
      const older = pullRequest({ number: 1, headRefName: 'claude/shared', updatedAt: '2026-10-01T10:00:00Z', title: 'Older attempt' });
      fakeGitHub(() => pageOf([older]));

      await runHourly();

      expect((await sessionsOnThePage()).s1![1]).toContain('#2 Newer attempt');
    });

    it('a pull request whose branch has no sessions is stored and changes nothing on the page', async () => {
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));

      await runHourly();

      expect(await theLinks()).toHaveLength(1);
      expect(await sessionsOnThePage()).toEqual({});
    });

    it('a pull request title is shown as text, never as markup', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/shared' })]);
      fakeGitHub(() => pageOf([pullRequest({ number: 5, headRefName: 'claude/shared', title: '<script>alert(1)</script> & more' })]));

      await runHourly();

      expect((await sessionsOnThePage()).s1![1]).toContain('#5 &lt;script&gt;alert(1)&lt;/script&gt; &amp; more');
    });
  });
});
