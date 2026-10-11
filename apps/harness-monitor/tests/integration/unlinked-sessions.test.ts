import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGitHub, linkingLine, pageOf, recordedPullRequest, runHourly, sessionsOnThePage } from './github-support';
import { emptyTheDatabase, send, usage } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Harness Monitor', () => {
  describe('a session without a link says why', () => {
    it('before linking has ever succeeded the page says so, and a session with a branch is linking', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/new' })]);

      expect(await linkingLine()).toBe('Branch linking has not succeeded yet.');
      expect((await sessionsOnThePage()).s1).toEqual(['claude/new', 'linking…', '', '']);
    });

    it('a branch no pull request names is unattributed once linking has caught up since the session ended', async () => {
      await send([
        usage('r1', { sessionId: 'older', branch: 'claude/nobody-opened-a-pr', time: '2026-03-01T10:00:00Z' }),
        usage('r2', { sessionId: 'no-branch', branch: null, time: '2026-03-01T11:00:00Z' }),
      ]);
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-04-01T12:00:00Z') });

      await runHourly();

      const sessions = await sessionsOnThePage();
      expect(sessions.older).toEqual(['claude/nobody-opened-a-pr', 'unattributed', '', '']);
      expect(sessions['no-branch']).toEqual(['none', 'unattributed', '', '']);
    });

    it('a session newer than the last successful run is linking, and the page says when linking last succeeded', async () => {
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-04-01T12:00:00Z') });
      await runHourly();
      await send([
        usage('r1', { sessionId: 'before', branch: 'claude/x', time: '2026-04-01T11:59:00Z' }),
        usage('r2', { sessionId: 'after', branch: 'claude/y', time: '2026-04-01T12:30:00Z' }),
      ]);

      expect(await linkingLine()).toBe('Branch linking last succeeded 2026-04-01 12:00 UTC.');
      const sessions = await sessionsOnThePage();
      expect(sessions.before![1]).toBe('unattributed');
      expect(sessions.after![1]).toBe('linking…');
    });

    it('once the next run finds the pull request, the linking session is credited', async () => {
      fakeGitHub(() => pageOf([]));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-04-01T12:00:00Z') });
      await runHourly();
      await send([usage('r1', { sessionId: 'after', branch: 'claude/build-971-fd1134', time: '2026-04-01T12:30:00Z' })]);
      expect((await sessionsOnThePage()).after![1]).toBe('linking…');
      vi.restoreAllMocks();
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));
      vi.setSystemTime(new Date('2026-04-01T13:00:00Z'));

      await runHourly();

      expect((await sessionsOnThePage()).after![1]).toContain('#979');
    });
  });
});
