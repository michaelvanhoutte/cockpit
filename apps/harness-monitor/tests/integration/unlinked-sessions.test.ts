import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGitHub, giveTheWorkerAToken, linkingLine, pageOf, pullRequest, pullRequestRows, recordedPullRequest, runHourly, startJob, timedOut } from './github-support';
import { emptyTheDatabase, send, usage } from './support';

/** Linking started by hand, as `pnpm harness:run linking` starts it. */
const linkByHand = async () => (await (await startJob('linking')).json()) as { ok: boolean; message: string };

let putBack: () => void;
beforeEach(async () => {
  await emptyTheDatabase();
  putBack = giveTheWorkerAToken();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  putBack();
});

const subs = async () => Object.fromEntries(Object.entries(await pullRequestRows()).map(([label, row]) => [label, row.sub]));

describe('Harness Monitor', () => {
  describe('a session without a link says why', () => {
    it('before linking has ever run the page says so, and a session with a branch is linking', async () => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/new' })]);

      expect(await linkingLine()).toBe('Branch linking: has not run yet.');
      expect(await subs()).toEqual({ 'claude/new': 'linking…' });
    });

    it('a branch no pull request names is unattributed once linking has caught up since the session ended', async () => {
      await send([
        usage('r1', { sessionId: 'older', branch: 'claude/nobody-opened-a-pr', time: '2026-10-01T10:00:00Z' }),
        usage('r2', { sessionId: 'no-branch', branch: null, time: '2026-10-01T11:00:00Z' }),
      ]);
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T12:00:00Z') });

      await runHourly();

      expect(await subs()).toEqual({ 'claude/nobody-opened-a-pr': 'unattributed', 'No branch': 'unattributed' });
    });

    it('a session newer than the last successful run is linking, and the page says when linking last ran', async () => {
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T12:00:00Z') });
      await runHourly();
      await send([
        usage('r1', { sessionId: 'before', branch: 'claude/x', time: '2026-10-02T11:59:00Z' }),
        usage('r2', { sessionId: 'after', branch: 'claude/y', time: '2026-10-02T12:30:00Z' }),
      ]);

      expect(await linkingLine()).toBe('Branch linking: last run 2026-10-02 12:00 UTC (scheduled) — Linked 1 pull request; caught up with GitHub.');
      expect(await subs()).toEqual({ 'claude/x': 'unattributed', 'claude/y': 'linking…' });
    });

    it.each([
      { situation: 'by hand', run: () => linkByHand() },
      { situation: 'on its schedule', run: () => runHourly() },
    ])('a run $situation that caught up makes every earlier branch no pull request names unattributed', async ({ run }) => {
      await send([usage('r1', { sessionId: 's1', branch: 'claude/no-pr', time: '2026-10-02T11:00:00Z' })]);
      expect(await subs()).toEqual({ 'claude/no-pr': 'linking…' });
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T12:00:00Z') });

      await run();

      expect(await subs()).toEqual({ 'claude/no-pr': 'unattributed' });
    });

    it('a run cut short leaves branches newer than the last catch-up linking', async () => {
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T12:00:00Z') });
      await runHourly();
      await send([
        usage('r1', { sessionId: 'before', branch: 'claude/x', time: '2026-10-02T11:59:00Z' }),
        usage('r2', { sessionId: 'after', branch: 'claude/y', time: '2026-10-02T12:30:00Z' }),
      ]);
      vi.restoreAllMocks();
      const later = pullRequest({ number: 5, headRefName: 'b/5', updatedAt: '2026-10-02T12:40:00Z' });
      fakeGitHub((call) => (call.after === null ? pageOf([later], true) : timedOut()));
      vi.setSystemTime(new Date('2026-10-02T13:00:00Z'));

      expect(await linkByHand()).toMatchObject({ ok: true, message: expect.stringContaining('More to read') });
      expect(await subs()).toEqual({ 'claude/x': 'unattributed', 'claude/y': 'linking…' });
    });

    it('once the next run finds the pull request, the linking session is credited', async () => {
      fakeGitHub(() => pageOf([]));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T12:00:00Z') });
      await runHourly();
      await send([usage('r1', { sessionId: 'after', branch: 'claude/build-971-fd1134', time: '2026-10-02T12:30:00Z' })]);
      expect(await subs()).toEqual({ 'claude/build-971-fd1134': 'linking…' });
      vi.restoreAllMocks();
      fakeGitHub(() => pageOf([recordedPullRequest(979)]));
      vi.setSystemTime(new Date('2026-10-02T13:00:00Z'));

      await runHourly();

      expect(Object.keys(await pullRequestRows())[0]).toContain('#979');
    });
  });
});
