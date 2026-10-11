import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGitHub, pageOf, pullRequest, pullRequestRows, recordedPullRequest, runHourly, theLinks } from './github-support';
import { emptyTheDatabase, send, thePage, usage } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.restoreAllMocks());

describe('Harness Monitor', () => {
  describe("a branch is credited to its pull request, the issue it closes, and that pull request's author", () => {
    it('a pull request closing an issue credits the session to both, and the engineer is its author', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/build-971-fd1134' })]);
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));

      await runHourly();

      const row = (await pullRequestRows())['#979 Stand up the Harness Monitor: store each Claude Code request once, and show daily token totals (#971)']!;
      expect(row.sub).toBe('Issue #971');
      expect(row.details[0]).toBe('michaelvanhoutte');
    });

    it('a pull request closing nothing is still linked, with no issue', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'fix/milkdown-timer-outlives-jsdom' })]);
      fakeGitHub(() => pageOf([recordedPullRequest(884)]));

      await runHourly();

      const row = Object.values(await pullRequestRows()).find((r) => r.label.startsWith('#884'))!;
      expect(row.sub).toBe('No issue');
      expect(row.details[0]).toBe('michaelvanhoutte');
    });

    it('two pull requests from one branch credit the session to the one updated most recently, whatever order GitHub lists them', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/shared' })]);
      const older = pullRequest({ number: 1, headRefName: 'claude/shared', updatedAt: '2026-10-01T10:00:00Z', title: 'Older attempt' });
      const newer = pullRequest({ number: 2, headRefName: 'claude/shared', updatedAt: '2026-10-02T10:00:00Z', title: 'Newer attempt' });
      fakeGitHub(() => pageOf([newer, older]));

      await runHourly();

      expect(Object.keys(await pullRequestRows())).toEqual(['#2 Newer attempt']);
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

      expect(Object.keys(await pullRequestRows())).toEqual(['#2 Newer attempt']);
    });

    it("a fork's pull request never claims a branch of the same name here", async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/shared' })]);
      const ours = pullRequest({ number: 1, headRefName: 'claude/shared', updatedAt: '2026-10-01T10:00:00Z', title: 'Ours' });
      const fork = pullRequest({ number: 2, headRefName: 'claude/shared', updatedAt: '2026-10-02T10:00:00Z', isCrossRepository: true });
      fakeGitHub(() => pageOf([ours, fork]));

      await runHourly();

      expect(Object.keys(await pullRequestRows())).toEqual(['#1 Ours']);
    });

    it('a pull request whose branch has no sessions is stored and changes nothing on the page', async () => {
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));

      await runHourly();

      expect(await theLinks()).toHaveLength(1);
      expect(await pullRequestRows()).toEqual({});
    });

    it('a pull request title is shown as text, never as markup', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/shared' })]);
      fakeGitHub(() => pageOf([pullRequest({ number: 5, headRefName: 'claude/shared', title: '<script>alert(1)</script> & more' })]));

      await runHourly();

      expect(Object.keys(await pullRequestRows())).toEqual(['#5 <script>alert(1)</script> & more']);
      expect(await thePage('?period=all')).not.toContain('<script>alert(1)');
    });
  });
});
