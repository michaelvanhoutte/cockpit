import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PAGES, PAGE_SIZE, SEARCH_CAP } from '../../src/github';
import { fakeGitHub, pageOf, pullRequest, recordedPullRequest, runHourly, theLinks, theLinkState } from './github-support';
import { emptyTheDatabase } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.restoreAllMocks());

describe('Harness Monitor', () => {
  describe('only pull requests changed since the last run are fetched', () => {
    it('a second run asks only for what was updated since the newest pull request read, and with nothing changed leaves everything as it was', async () => {
      const calls = fakeGitHub((call) =>
        pageOf(call.q.includes('updated:>=') ? [recordedPullRequest(979)] : [recordedPullRequest(969), recordedPullRequest(979)]),
      );

      await runHourly();
      const links = await theLinks();
      const state = await theLinkState();
      expect(calls[0]!.q).not.toContain('updated:');

      await runHourly();

      expect(calls[1]!.q).toContain('updated:>=2026-10-11T11:27:29Z');
      expect(await theLinks()).toEqual(links);
      expect((await theLinkState())[0]!.cursor).toBe(state[0]!.cursor);
      expect(state[0]!.cursor).toBe('2026-10-11T11:27:29Z');
    });

    it('more pull requests than one page are all read, page after page', async () => {
      const first = pullRequest({ number: 1, headRefName: 'b/1', updatedAt: '2026-10-01T10:00:00Z' });
      const second = pullRequest({ number: 2, headRefName: 'b/2', updatedAt: '2026-10-02T10:00:00Z' });
      const third = pullRequest({ number: 3, headRefName: 'b/3', updatedAt: '2026-10-03T10:00:00Z' });
      const calls = fakeGitHub((call) =>
        call.after === null ? pageOf([first], true) : call.after === 'cursor-1' && calls.length === 2 ? pageOf([second], true) : pageOf([third]),
      );

      await runHourly();

      expect(calls.map((c) => c.after)).toEqual([null, 'cursor-1', 'cursor-1']);
      expect((await theLinks()).map((l) => l.pr_number)).toEqual([1, 2, 3]);
      expect((await theLinkState())[0]!.cursor).toBe('2026-10-03T10:00:00Z');
    });

    it("at GitHub's cap on one search's results, the run searches again from the newest pull request read", async () => {
      const page = (from: number) =>
        Array.from({ length: PAGE_SIZE }, (_, i) =>
          pullRequest({ number: from + i, headRefName: `b/${from + i}`, updatedAt: `2026-10-01T${String(Math.floor((from + i) / 60)).padStart(2, '0')}:${String((from + i) % 60).padStart(2, '0')}:00Z` }),
        );
      const pages = SEARCH_CAP / PAGE_SIZE;
      const beyond = pullRequest({ number: 5000, headRefName: 'b/beyond', updatedAt: '2026-10-02T10:00:00Z' });
      const calls = fakeGitHub((call, all) => {
        if (call.q.includes('updated:>=')) return pageOf([beyond]);
        const n = all.length;
        return pageOf(page((n - 1) * PAGE_SIZE), n < pages);
      });

      await runHourly();

      expect(calls).toHaveLength(pages + 1);
      expect(calls[pages]!.q).toContain('updated:>=2026-10-01T16:39:00Z');
      expect(calls[pages]!.after).toBeNull();
      expect(await theLinks()).toHaveLength(SEARCH_CAP + 1);
      expect((await theLinkState())[0]!.last_success_at).not.toBeNull();
    });

    it('a run that never reaches the end stops at its page budget, keeps what it read, and does not claim to have caught up', async () => {
      let next = 0;
      const calls = fakeGitHub(() => {
        next += 1;
        const updatedAt = `2026-10-01T10:00:${String(next).padStart(2, '0')}Z`;
        return pageOf([pullRequest({ number: next, headRefName: `b/${next}`, updatedAt })], true);
      });

      await runHourly();

      expect(calls).toHaveLength(MAX_PAGES);
      expect(await theLinks()).toHaveLength(MAX_PAGES);
      const state = (await theLinkState())[0]!;
      expect(state.cursor).toBe(`2026-10-01T10:00:${String(MAX_PAGES).padStart(2, '0')}Z`);
      expect(state.last_success_at).toBeNull();
    });
  });
});
