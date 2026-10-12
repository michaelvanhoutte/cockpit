import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cursorAfter,
  fakeGitHub,
  file,
  filesOf,
  linked,
  listing,
  pageOf,
  pullRequestRows,
  RECORDED_FILES_PAGE,
  runHourly,
  sized,
  theLinkState,
  theStats,
  timedOut,
  withErrors,
  type Node,
} from './github-support';
import { costRows, emptyTheDatabase, send, spend, thePage, withPrices } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.restoreAllMocks());

const OPENED = '2026-10-01T10:00:00Z';
/** A pull request opened at OPENED, with the commits dated as given. */
const withCommits = (over: Partial<Node> & { number: number }, ...dates: string[]): Node =>
  sized({ createdAt: OPENED, commits: { nodes: dates.map((committedDate) => ({ commit: { committedDate } })) }, ...over });
/** A pull request as GitHub listed it before sizes were read: no files, no commits, no opening time. */
const unread = (node: Node): Node => {
  const { files, commits, createdAt, ...rest } = node;
  return rest;
};
const numbered = (n: number, over: Partial<Node> = {}): Node => withCommits({ number: n, headRefName: `b/${n}`, updatedAt: `2026-10-01T10:00:${String(n).padStart(2, '0')}Z`, ...over });

describe('Harness Monitor', () => {
  describe("linking stores each pull request's size, timing, CI rounds and closing issue's title", () => {
    it('only source files count: a lockfile, a snapshot and a generated file are left out', async () => {
      fakeGitHub(() =>
        pageOf([
          numbered(1, {
            files: filesOf([
              file('apps/api/src/lock.ts', 10, 2),
              file('pnpm-lock.yaml', 500, 300),
              file('poc/spike/pnpm-lock.yaml', 40, 40),
              file('apps/web/tests/__snapshots__/card.test.ts.snap', 30, 0),
              file('apps/api/worker-configuration.d.ts', 90, 90),
              file('apps/web/src/card.ts', 5, 1),
            ]),
          }),
        ]),
      );

      await runHourly();

      expect(await theStats()).toMatchObject([{ pr_number: 1, lines_added: 15, lines_removed: 3 }]);
    });

    it('past 100 files the rest are read, and the count is complete', async () => {
      const first = Array.from({ length: 100 }, (_, i) => file(`src/f${i}.ts`, 1, 0));
      const calls = fakeGitHub(
        () => pageOf([numbered(1, { id: 'PR_one', files: filesOf(first, 'c100') })]),
        (call) => {
          if (call.after === 'c100') return Response.json(RECORDED_FILES_PAGE); // two files, +28 and +26, more after 'NA'
          return Response.json({ data: { node: { files: filesOf([file('src/last.ts', 7, 3), file('pnpm-lock.yaml', 999, 999)]) } } });
        },
      );

      await runHourly();

      expect(calls.files).toEqual([
        { id: 'PR_one', after: 'c100' },
        { id: 'PR_one', after: 'NA' },
      ]);
      expect(await theStats()).toMatchObject([{ lines_added: 100 + 28 + 26 + 7, lines_removed: 3 }]);
    });

    it('a pull request whose remaining files cannot be read is stored without a size, not a short one, and the run carries on', async () => {
      const first = Array.from({ length: 100 }, (_, i) => file(`src/f${i}.ts`, 1, 0));
      fakeGitHub(
        () => pageOf([numbered(1, { id: 'PR_one', files: filesOf(first, 'c100') }), numbered(2, { files: filesOf([file('src/x.ts', 6, 0)]) })]),
        () => timedOut(),
      );

      await runHourly();

      expect(await theStats()).toMatchObject([
        { pr_number: 1, lines_added: null, lines_removed: null },
        { pr_number: 2, lines_added: 6, lines_removed: 0 },
      ]);
    });

    it('a pull request updated by a new push has its lines and CI rounds refreshed', async () => {
      await linked(numbered(1, { files: filesOf([file('src/a.ts', 10, 0)]) }));
      expect((await theStats())[0]).toMatchObject({ lines_added: 10, ci_rounds: 0 });

      await linked(
        withCommits({ number: 1, headRefName: 'b/1', updatedAt: '2026-10-02T10:00:00Z', files: filesOf([file('src/a.ts', 10, 0), file('src/b.ts', 4, 1)]) }, '2026-10-01T09:00:00Z', '2026-10-02T09:59:00Z'),
      );

      expect(await theStats()).toMatchObject([{ lines_added: 14, lines_removed: 1, ci_rounds: 1 }]);
    });

    it('only commits after it opened are CI rounds', async () => {
      await linked(withCommits({ number: 1, headRefName: 'b/1' }, '2026-09-30T10:00:00Z', '2026-10-01T09:59:59Z', '2026-10-01T10:00:01Z', '2026-10-03T10:00:00Z'));

      expect((await theStats())[0]!.ci_rounds).toBe(2);
    });

    it('a pull request that closes no issue has no title, and one that does is stored with its issue’s own title', async () => {
      await linked(numbered(1, { closingIssuesReferences: { nodes: [] } }), numbered(2, { closingIssuesReferences: { nodes: [{ number: 40, title: 'Show what drives costs' }] } }));

      expect(await theStats()).toMatchObject([
        { pr_number: 1, issue_title: null },
        { pr_number: 2, issue_title: 'Show what drives costs' },
      ]);
    });

    it('an issue whose title changed on GitHub has the new one at the next run', async () => {
      const closes = (title: string) => ({ nodes: [{ number: 40, title }] });
      await linked(numbered(1, { closingIssuesReferences: closes('Old title') }));

      await linked(numbered(1, { updatedAt: '2026-10-05T10:00:00Z', closingIssuesReferences: closes('New title') }));

      expect((await theStats())[0]!.issue_title).toBe('New title');
    });

    it('an answer with errors beside it, which may only be missing the issue, keeps the stored title', async () => {
      await linked(numbered(1, { closingIssuesReferences: { nodes: [{ number: 40, title: 'Show what drives costs' }] } }));
      fakeGitHub(async () => withErrors(pageOf([numbered(1, { updatedAt: '2026-10-05T10:00:00Z', closingIssuesReferences: null as unknown as Node['closingIssuesReferences'] })]), 'Resource not accessible by integration'));

      await runHourly();

      expect((await theStats())[0]!.issue_title).toBe('Show what drives costs');
    });

    it('when it opened and merged are stored, and a pull request not merged has no merged time', async () => {
      await linked(
        numbered(1, { state: 'MERGED', mergedAt: '2026-10-02T12:00:00Z' }),
        numbered(2, { state: 'OPEN', mergedAt: null }),
      );

      expect(await theStats()).toMatchObject([
        { pr_number: 1, opened_at: OPENED, merged_at: '2026-10-02T12:00:00Z' },
        { pr_number: 2, opened_at: OPENED, merged_at: null },
      ]);
    });
  });

  describe('a run that stops partway keeps what it read, and one that fails stores nothing', () => {
    it('GitHub timing out on a heavier page shrinks it, and what was read is stored with the place moved there', async () => {
      const all = [1, 2, 3, 4].map((n) => numbered(n));
      const page = listing(all);
      const calls = fakeGitHub((call) => (call.first === 25 ? timedOut() : call.after === cursorAfter(all[1]!) ? timedOut() : page({ ...call, first: 2 })));

      await runHourly();

      // The first page went through at half the size; the second timed out twice, so the run ended there.
      expect(calls.map((c) => [c.after, c.first])).toEqual([
        [null, 25],
        [null, 12],
        [cursorAfter(all[1]!), 12],
        [cursorAfter(all[1]!), 6],
      ]);
      expect((await theStats()).map((s) => s.pr_number)).toEqual([1, 2]);
      const state = (await theLinkState())[0]!;
      expect(state.cursor).toBe(cursorAfter(all[1]!));
      expect(state.last_success_at).toBeNull();
    });

    it('a run that fails after a page was read stores no size from it and leaves the place as it was', async () => {
      await linked(numbered(1));
      const before = { stats: await theStats(), state: await theLinkState() };
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeGitHub((call) => (call.after === null ? pageOf([numbered(2)], true) : new Response('rate limited', { status: 403 })), () => timedOut());

      await runHourly();

      expect(await theStats()).toEqual(before.stats);
      expect(await theLinkState()).toEqual(before.state);
    });
  });

  describe('after the change ships, linking reads every pull request again once so history gets sizes', () => {
    /** A pull request linked before sizes existed: a link, a place, and no size. */
    const linkedBefore = () =>
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO branch_links (branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at)
           VALUES ('b/1', 1, 'Old', 'MERGED', '2026-10-02T12:00:00Z', 40, 'alice', '2026-10-02T12:00:00Z', 1)`,
        ),
        env.DB.prepare("INSERT INTO link_state (id, page_cursor, last_success_at) VALUES (1, 'cursor-4', 1)"),
      ]);

    it('a pull request linked before is sized by the first run, which starts from the first pull request; the run after carries on from the place', async () => {
      await linkedBefore();
      const all = [1, 2, 3, 4].map((n) => numbered(n, { files: filesOf([file('src/a.ts', n, 0)]) }));
      const page = listing(all);
      const calls = fakeGitHub((call) => page({ ...call, first: 3 }));

      await runHourly();
      await runHourly();

      // The first run reads the whole listing from the start; the second carries on from where that one caught up.
      expect(calls.map((c) => c.after)).toEqual([null, cursorAfter(all[2]!), cursorAfter(all[2]!)]);
      expect(await theStats()).toMatchObject([1, 2, 3, 4].map((n) => ({ pr_number: n, lines_added: n })));
    });

    it('a rewind that failed is made again, because nothing recorded it as done', async () => {
      await linkedBefore();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeGitHub(() => new Response('rate limited', { status: 403 }));
      await runHourly();
      vi.restoreAllMocks();
      const calls = fakeGitHub(() => pageOf([numbered(1)]));

      await runHourly();

      expect(calls.map((c) => c.after)).toEqual([null]);
      expect((await theStats()).map((s) => s.pr_number)).toEqual([1]);
    });
  });

  describe('the costs page shows each pull request’s lines, how long it was open and its CI rounds, and names issues by title', () => {
    beforeEach(withPrices);

    const seeded = async (...nodes: Node[]) => {
      await linked(...nodes);
      await send(nodes.map((n, i) => spend(`r${i}`, 1, { branch: n.headRefName })));
    };

    it('a merged, sized pull request shows lines added and removed, its open → merged time and its CI rounds', async () => {
      await seeded(withCommits({ number: 10, title: 'Merged one', headRefName: 'b/10', state: 'MERGED', mergedAt: '2026-10-02T14:30:00Z', files: filesOf([file('src/a.ts', 120, 30), file('pnpm-lock.yaml', 900, 900)]) }, '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'));

      const row = (await pullRequestRows())['#10 Merged one']!;

      // engineer, merged, lines, open → merged, CI rounds
      expect(row.details.slice(2)).toEqual(['+120 −30', '1d 4h', '2']);
    });

    it('an open pull request has lines and rounds but no open → merged time', async () => {
      await seeded(numbered(11, { title: 'Open one', state: 'OPEN', mergedAt: null, files: filesOf([file('src/a.ts', 3, 1)]) }));

      expect((await pullRequestRows())['#11 Open one']!.details.slice(2)).toEqual(['+3 −1', '', '0']);
    });

    it('a pull request not yet sized shows blanks, not zeros', async () => {
      await seeded(unread(numbered(12, { title: 'Unsized one' })));

      expect((await pullRequestRows())['#12 Unsized one']!.details.slice(2)).toEqual(['', '', '']);
    });

    it('an issue with a stored title reads "#N title", and one whose title has not been read yet reads "#N"', async () => {
      await seeded(
        numbered(14, { closingIssuesReferences: { nodes: [{ number: 40, title: 'Show what drives costs' }] } }),
        unread(numbered(15, { closingIssuesReferences: { nodes: [{ number: 41 }] } })),
      );

      const rows = costRows(await thePage('?period=all&group=issue'));

      expect(rows.map((r) => r.label).sort()).toEqual(['#40 Show what drives costs', '#41']);
    });

    it('a pull request with every change excluded is sized at zero, which is not blank', async () => {
      await seeded(numbered(13, { title: 'Lockfile only', files: filesOf([file('pnpm-lock.yaml', 5, 5)]) }));

      expect((await pullRequestRows())['#13 Lockfile only']!.details[2]).toBe('+0 −0');
    });
  });
});
