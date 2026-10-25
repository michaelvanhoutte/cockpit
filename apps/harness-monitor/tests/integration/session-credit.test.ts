import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { fakeGitHub, linked, pageOf, pullRequest, pullRequestRows, runHourly, startJob } from './github-support';
import {
  costRows,
  cyclePull,
  emptyTheDatabase,
  micros,
  pullRequestFigures,
  send,
  sendPulls,
  spend,
  splitTokens,
  splitTotals,
  theBarePage,
  theExport,
  thePage,
  thePullRequest,
  withPrices,
} from './support';

/** The worktree branch a session scopes on: no pull request names it. */
const WORKTREE = 'claude/worktree';
/** Two branches with pull requests, by different authors. */
const A = 'b/A';
const B = 'b/B';
const UNATTRIBUTED = '~unattributed';

const minute = (n: number) => `2026-10-01T10:${String(n).padStart(2, '0')}:00Z`;
/** A request of `dollars` in session s1 at minute `at`. */
const ask = (id: string, dollars: number, branch: string | null, category: string, at: number, over: Record<string, unknown> = {}) =>
  spend(id, dollars, { sessionId: 's1', branch, category, time: minute(at), ...over });

interface Link {
  issue?: number | null;
  engineer?: string;
  state?: string;
  parent?: number | null;
  parentTitle?: string | null;
}
/** A branch linked to a pull request, as the hourly job leaves it. */
async function linkBranch(branch: string, pr: number, { issue = null, engineer = 'alice', state = 'MERGED', parent = null, parentTitle = null }: Link = {}) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO branch_links (branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at, issue_parent, issue_parent_title)
     VALUES (?1, ?2, ?3, ?4, '2026-10-02T10:00:00Z', ?5, ?6, '2026-10-02T10:00:00Z', 0, ?7, ?8)`,
  )
    .bind(branch, pr, `Pull request ${pr}`, state, issue, engineer, parent, parentTitle)
    .run();
}
/** Linking has caught up, after every request these tests send. */
const linkingCaughtUp = () =>
  env.DB.prepare(`INSERT INTO link_state (id, page_cursor, last_success_at) VALUES (1, NULL, ?1) ON CONFLICT (id) DO UPDATE SET last_success_at = ?1`)
    .bind(Date.parse('2026-10-02T00:00:00Z'))
    .run();
/** The two pull requests: A closes issue 11 and is alice's, B closes issue 12 and is bob's. */
async function linkTheBranches() {
  await linkBranch(A, 1, { issue: 11, engineer: 'alice' });
  await linkBranch(B, 2, { issue: 12, engineer: 'bob' });
  await linkingCaughtUp();
}
/** The nightly rebuild, started by hand as `pnpm harness:run rebuild` starts it. */
async function rebuild() {
  expect((await startJob('rebuild')).status).toBe(200);
}

type Grouping = 'issue' | 'engineer' | 'day';
/** The costs table by a grouping: each row's label with its total. */
async function rowsBy(group: Grouping, query = '') {
  return Object.fromEntries(costRows(await thePage(`?period=all&group=${group}${query}`)).map((r) => [r.label, r.total]));
}
/** What a grouping's rows add up to, in millionths of a dollar. */
/** The cycle time page, as a visitor opens it. */
const theCycleTime = (query: string) => SELF.fetch(`https://monitor.test/cycle-time${query}`);
const sumOf = (rows: Record<string, string>) => Object.values(rows).reduce((sum, total) => sum + micros(total), 0);

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Harness Monitor', () => {
  describe("a request from a branch no pull request names is credited to the pull request of the nearest request in its session that has one", () => {
    const situations: { situation: string; requests: ReturnType<typeof ask>[]; issues: Record<string, string>; engineers: Record<string, string> }[] = [
      {
        situation: 'scoping on the worktree branch, then the session builds on a linked branch',
        requests: [ask('r1', 1, WORKTREE, 'scoping-planning', 1), ask('r2', 2, A, 'building', 2)],
        issues: { '#11': '$3.00' },
        engineers: { alice: '$3.00' },
      },
      {
        situation: "requests after the session's last linked request",
        requests: [ask('r1', 2, A, 'building', 1), ask('r2', 1, WORKTREE, 'after-push', 2)],
        issues: { '#11': '$3.00' },
        engineers: { alice: '$3.00' },
      },
      {
        situation: 'requests between linked branches A and B in one session',
        requests: [ask('r1', 2, A, 'building', 1), ask('r2', 1, WORKTREE, 'building', 2), ask('r3', 4, B, 'building', 3)],
        issues: { '#11': '$2.00', '#12': '$5.00' },
        engineers: { bob: '$5.00', alice: '$2.00' },
      },
      {
        situation: 'a subagent of the session',
        requests: [ask('r1', 1, WORKTREE, 'scoping-planning', 1, { subagent: true }), ask('r2', 2, A, 'building', 2)],
        issues: { '#11': '$3.00' },
        engineers: { alice: '$3.00' },
      },
      {
        situation: 'a request with no branch in the session',
        requests: [ask('r1', 1, null, 'scoping-planning', 1), ask('r2', 2, A, 'building', 2)],
        issues: { '#11': '$3.00' },
        engineers: { alice: '$3.00' },
      },
      {
        situation: 'an Outside the process request in the same place',
        requests: [ask('r1', 1, WORKTREE, 'outside-process', 1), ask('r2', 2, A, 'building', 2)],
        issues: { '#11': '$2.00', Unattributed: '$1.00' },
        engineers: { alice: '$2.00', Unattributed: '$1.00' },
      },
      {
        situation: 'an Unphased request in the same place',
        requests: [ask('r1', 1, WORKTREE, 'unphased', 1), ask('r2', 2, A, 'building', 2)],
        issues: { '#11': '$2.00', Unattributed: '$1.00' },
        engineers: { alice: '$2.00', Unattributed: '$1.00' },
      },
      {
        situation: 'a session that never reaches a linked branch',
        requests: [ask('r1', 1, WORKTREE, 'scoping-planning', 1), ask('r2', 2, WORKTREE, 'building', 2)],
        issues: { Unattributed: '$3.00' },
        engineers: { Unattributed: '$3.00' },
      },
      {
        situation: 'another session on the same unlinked branch that never reaches a linked one',
        requests: [ask('r1', 1, WORKTREE, 'scoping-planning', 1), ask('r2', 2, A, 'building', 2), ask('r3', 5, WORKTREE, 'scoping-planning', 3, { sessionId: 's2' })],
        issues: { '#11': '$3.00', Unattributed: '$5.00' },
        engineers: { alice: '$3.00', Unattributed: '$5.00' },
      },
    ];

    it.each(situations)('$situation', async ({ requests, issues, engineers }) => {
      await linkTheBranches();
      await send(requests);

      await rebuild();

      expect(await rowsBy('issue')).toEqual(issues);
      expect(await rowsBy('engineer')).toEqual(engineers);
    });

    it.each(['scoping-planning', 'building', 'local-code-review', 'local-security-review', 'after-push', 'process-review'])('a %s request is credited', async (category) => {
      await linkTheBranches();
      await send([ask('r1', 1, WORKTREE, category, 1, category === 'local-code-review' ? { reviewLevel: 'high' } : {}), ask('r2', 2, A, 'building', 2)]);

      await rebuild();

      expect(await rowsBy('issue')).toEqual({ '#11': '$3.00' });
    });
  });

  describe('credit reaches the issue, the engineer and the outcome, never the pull request', () => {
    const scopedThenBuilt = [ask('r1', 1, WORKTREE, 'scoping-planning', 1), ask('r2', 2, A, 'building', 2)];

    it("a credited pull request that closes a child issue joins its parent's row", async () => {
      await linkBranch(A, 1, { issue: 21, engineer: 'alice', parent: 20, parentTitle: 'Whole run' });
      await linkingCaughtUp();
      await send(scopedThenBuilt);

      await rebuild();

      expect(await rowsBy('issue')).toEqual({ '#20 Whole run': '$3.00' });
    });

    it('a credited pull request that names no issue is counted under No issue', async () => {
      await linkBranch(A, 1, { issue: null, engineer: 'alice' });
      await linkingCaughtUp();
      await send(scopedThenBuilt);

      await rebuild();

      expect(await rowsBy('issue')).toEqual({ 'No issue': '$3.00' });
    });

    it('filtered to the pull request\'s author the credited cost is included, and filtered to Unattributed it is not', async () => {
      await linkTheBranches();
      await send([...scopedThenBuilt, ask('r3', 5, WORKTREE, 'outside-process', 3)]);

      await rebuild();

      expect(await rowsBy('issue', '&engineer=alice')).toEqual({ '#11': '$3.00' });
      expect(await rowsBy('issue', `&engineer=${UNATTRIBUTED}`)).toEqual({ Unattributed: '$5.00' });
      expect(Object.values(await rowsBy('day', '&engineer=alice'))).toEqual(['$3.00']);
    });

    it('coloured by outcome the credited cost takes the credited pull request\'s outcome', async () => {
      await linkBranch(A, 1, { issue: 11, state: 'OPEN' });
      await linkingCaughtUp();
      await send(scopedThenBuilt);

      await rebuild();

      const [row] = costRows(await thePage('?period=all&group=issue&split=outcome'));
      expect(row!.colours).toBe('Still open $3.00');
    });

    it("by pull request the session's branch keeps its own row naming the issue, and the pull request's own row is unchanged", async () => {
      await linkTheBranches();
      await send(scopedThenBuilt);

      await rebuild();

      const rows = await pullRequestRows();
      expect(Object.fromEntries(Object.entries(rows).map(([label, row]) => [label, [row.sub, row.total]]))).toEqual({
        '#1 Pull request 1': ['Issue #11', '$2.00'],
        [WORKTREE]: ['Issue #11', '$1.00'],
      });
    });

    it('a branch whose requests are credited to two issues reads several issues', async () => {
      await linkTheBranches();
      await send([ask('r1', 1, WORKTREE, 'scoping-planning', 1), ask('r2', 2, A, 'building', 2), ask('r3', 1, WORKTREE, 'building', 3), ask('r4', 4, B, 'building', 4)]);

      await rebuild();

      expect((await pullRequestRows())[WORKTREE]).toMatchObject({ sub: 'several issues', total: '$2.00' });
    });

    it("the credited pull request's own cost is unchanged on its page and in cycle time", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
      await linkTheBranches();
      await send(scopedThenBuilt);
      await sendPulls([cyclePull(1, { mergedAt: '2026-10-02T10:00:00Z', head: A })]);

      await rebuild();

      expect(pullRequestFigures(await (await thePullRequest(1, '?period=all')).text()).total).toBe('$2.00');
      const cycle = await (await theCycleTime('?group=pr')).text();
      expect(cycle).toContain('<a href="/pr/1">$2.00</a>');
    });

    it('a branch that later gets a pull request of its own is counted under it, not under its credit', async () => {
      await linkTheBranches();
      await send(scopedThenBuilt);
      await rebuild();
      expect(await rowsBy('issue')).toEqual({ '#11': '$3.00' });

      await linkBranch(WORKTREE, 3, { issue: 13, engineer: 'carol' });

      expect(await rowsBy('issue')).toEqual({ '#11': '$2.00', '#13': '$1.00' });
      expect(await rowsBy('engineer')).toEqual({ alice: '$2.00', carol: '$1.00' });
      const rows = await pullRequestRows();
      expect(rows['#3 Pull request 3']).toMatchObject({ sub: 'Issue #13', total: '$1.00' });
      expect(rows[WORKTREE]).toBeUndefined();
    });

    it('an issue re-parented and read again by linking moves the credited cost to the new parent with no rebuild', async () => {
      const child = (parent: number) =>
        pullRequest({
          number: 5,
          headRefName: A,
          closingIssuesReferences: { nodes: [{ number: 21, title: 'Child', parent: { number: parent, title: `Whole ${parent}` } }] },
        });
      await send(scopedThenBuilt);
      await linked(child(20));
      await rebuild();
      expect(await rowsBy('issue')).toEqual({ '#20 Whole 20': '$3.00' });

      await linked(child(30));

      expect(await rowsBy('issue')).toEqual({ '#30 Whole 30': '$3.00' });
    });
  });

  describe('credit waits for a rebuild after linking has seen the pull request, and until then the branch is linking', () => {
    const NOON = new Date('2026-10-02T12:00:00Z');
    const scopedThenBuilt = [ask('r1', 1, WORKTREE, 'scoping-planning', 1), ask('r2', 2, 'b/build', 'building', 2)];
    const subOf = async () => (await pullRequestRows())[WORKTREE]?.sub;
    const linkTheBuild = async () => {
      fakeGitHub(() => pageOf([pullRequest({ number: 979, headRefName: 'b/build' })]));
      vi.useFakeTimers({ toFake: ['Date'], now: NOON });
      await runHourly();
    };

    it('a request that arrived after the last rebuild is linking, and by engineer still Unattributed', async () => {
      await send(scopedThenBuilt);
      await linkTheBuild();
      await rebuild();
      expect(await subOf()).toBe('Issue #971');

      await send([ask('r3', 4, WORKTREE, 'building', 3, { time: '2026-10-02T12:30:00Z' })]);

      expect(await subOf()).toBe('linking…');
      expect(await rowsBy('engineer')).toEqual({ michaelvanhoutte: '$3.00', Unattributed: '$4.00' });
    });

    it('linking that caught up with no rebuild since leaves the branch linking, and a rebuild after it credits the issue', async () => {
      await send(scopedThenBuilt);

      await linkTheBuild();
      expect(await subOf()).toBe('linking…');
      expect(await rowsBy('engineer')).toEqual({ michaelvanhoutte: '$2.00', Unattributed: '$1.00' });

      await rebuild();
      expect(await subOf()).toBe('Issue #971');
      expect(await rowsBy('engineer')).toEqual({ michaelvanhoutte: '$3.00' });
    });
  });

  describe('crediting moves cost between rows and never changes a total', () => {
    const everything = [
      ask('r1', 1, WORKTREE, 'scoping-planning', 1),
      ask('r2', 2, A, 'building', 2),
      ask('r3', 4, WORKTREE, 'building', 3),
      ask('r4', 8, B, 'building', 4),
      ask('r5', 16, WORKTREE, 'outside-process', 5),
      ask('r6', 32, null, 'after-push', 6, { sessionId: 's2' }),
    ];
    const figures = async () => ({
      byDay: costRows(await thePage('?period=all&group=day')).map((r) => [r.label, r.total]),
      issue: sumOf(await rowsBy('issue')),
      engineer: sumOf(await rowsBy('engineer')),
    });

    it('the total by day, by issue and by engineer is the same before and after a rebuild credits', async () => {
      await linkTheBranches();
      await send(everything);
      const before = await figures();
      expect(before.issue).toBe(63_000_000);

      await rebuild();

      expect(await figures()).toEqual(before);
      expect(await rowsBy('issue')).not.toEqual(await rowsBy('issue', '&engineer=bob'));
    });

    it('a rebuild run twice gives the same totals', async () => {
      await linkTheBranches();
      await send(everything);
      await rebuild();
      const once = await splitTotals();

      await rebuild();

      expect(await splitTotals()).toEqual(once);
    });

    it('a request sent twice after the migration is counted once', async () => {
      await linkTheBranches();
      await send(everything);
      await rebuild();
      const once = await splitTotals();

      await send(everything);

      expect(await splitTotals()).toEqual(once);
    });
  });

  describe('deployed totals read the same across the migration', () => {
    /** The Monitor as the release before this one left it: the old totals holding every request, and no credited totals, credits or credit mark. */
    async function asTheReleaseBefore() {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO daily_split_totals (day, branch, category, model, ran_where, subagent, requests, cost_micros, unpriced_requests,
             unpriced_input_tokens, unpriced_output_tokens, unpriced_cache_creation_tokens, unpriced_cache_read_tokens, last_at,
             input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
           SELECT day, branch, category, model, ran_where, subagent, requests, cost_micros, unpriced_requests,
             unpriced_input_tokens, unpriced_output_tokens, unpriced_cache_creation_tokens, unpriced_cache_read_tokens, last_at,
             input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
           FROM daily_credited_totals`,
        ),
        env.DB.prepare('DROP TABLE daily_credited_totals'),
        env.DB.prepare('DROP TABLE request_credits'),
        env.DB.prepare('ALTER TABLE link_state DROP COLUMN credited_through'),
      ]);
    }
    const migrate = async () => {
      const migration = inject('migrations').find((m) => m.name.startsWith('0025_credited_totals'))!;
      for (const query of migration.queries) await env.DB.prepare(query).run();
    };
    const scopedThenBuilt = [ask('r1', 1, WORKTREE, 'scoping-planning', 1), ask('r2', 2, A, 'building', 2)];

    it('with old totals stored and no rebuild yet the page reads the same figures and nothing is credited', async () => {
      await linkTheBranches();
      await send(scopedThenBuilt);
      const before = { issue: await rowsBy('issue'), engineer: await rowsBy('engineer'), tokens: await splitTokens() };
      expect(before.issue).toEqual({ '#11': '$2.00', Unattributed: '$1.00' });
      await asTheReleaseBefore();

      await migrate();

      expect({ issue: await rowsBy('issue'), engineer: await rowsBy('engineer'), tokens: await splitTokens() }).toEqual(before);
    });

    it('a rebuild after the migration credits the old figures and keeps their total', async () => {
      await linkTheBranches();
      await send(scopedThenBuilt);
      await asTheReleaseBefore();
      await migrate();

      await rebuild();

      expect(await rowsBy('issue')).toEqual({ '#11': '$3.00' });
    });

    it('a request arriving after the migration is counted in the new totals only', async () => {
      await linkTheBranches();
      await send(scopedThenBuilt);
      await asTheReleaseBefore();
      await migrate();

      await send([ask('r3', 4, A, 'building', 3)]);

      const old = await env.DB.prepare('SELECT SUM(requests) AS requests FROM daily_split_totals').first<{ requests: number }>();
      const current = await env.DB.prepare('SELECT SUM(requests) AS requests FROM daily_credited_totals').first<{ requests: number }>();
      expect([old!.requests, current!.requests]).toEqual([2, 3]);
    });
  });

  describe('the export says what the page says', () => {
    const [BRANCH, PULL_REQUEST, ISSUE, ENGINEER, COST] = [2, 3, 4, 5, 14];
    const requests = [ask('r1', 1, WORKTREE, 'scoping-planning', 1), ask('r2', 2, A, 'building', 2), ask('r3', 4, WORKTREE, 'outside-process', 3)];
    beforeEach(async () => {
      await linkTheBranches();
      await send(requests);
      await rebuild();
    });

    it('a credited request has its issue and engineer filled and no pull request', async () => {
      const { rows } = await theExport('?period=all');

      expect(rows.map((r) => [r[BRANCH], r[PULL_REQUEST], r[ISSUE], r[ENGINEER]])).toEqual([
        [WORKTREE, '', '11', 'alice'],
        [A, '1', '11', 'alice'],
        [WORKTREE, '', '', ''],
      ]);
    });

    it("filtered to the author it includes the credited rows, and its dollars match the page's engineer total", async () => {
      const { rows } = await theExport('?period=all&engineer=alice');

      expect(rows).toHaveLength(2);
      expect(rows.reduce((sum, r) => sum + Number(r[COST]), 0) * 1e6).toBe(micros((await rowsBy('engineer', '&engineer=alice')).alice!));
    });

    it('filtered to Unattributed it leaves the credited rows out', async () => {
      const { rows } = await theExport(`?period=all&engineer=${UNATTRIBUTED}`);

      expect(rows.map((r) => r[COST])).toEqual(['4.000000']);
    });
  });

  describe("the starting-context chart, filtered by engineer, credits a session's start through its first request", () => {
    /** The points of the starting-context chart, or 'empty' where it has none. */
    async function startingContext(query: string) {
      const html = await theBarePage(`?period=all&${query}`);
      const section = /<section class="trend" aria-labelledby="starting-context">(.*?)<\/section>/s.exec(html)![1]!;
      return section.includes('data-empty="starting-context"') ? 'empty' : [...section.matchAll(/<title>(.*?)<\/title>/g)].map((t) => t[1]!.split(' · ').slice(1).join(' · '));
    }

    it('a session starting with scoping on its worktree branch, credited, starts under the author and not Unattributed', async () => {
      await linkTheBranches();
      await send([ask('r1', 1, WORKTREE, 'scoping-planning', 1), ask('r2', 2, A, 'building', 2)]);

      await rebuild();

      expect(await startingContext('engineer=alice')).toEqual([expect.stringContaining('500,000 tokens')]);
      expect(await startingContext(`engineer=${UNATTRIBUTED}`)).toBe('empty');
    });

    it('a session whose first request is Outside the process starts Unattributed', async () => {
      await linkTheBranches();
      await send([ask('r1', 1, WORKTREE, 'outside-process', 1), ask('r2', 2, A, 'building', 2)]);

      await rebuild();

      expect(await startingContext('engineer=alice')).toBe('empty');
      expect(await startingContext(`engineer=${UNATTRIBUTED}`)).toEqual([expect.stringContaining('500,000 tokens')]);
    });
  });
});
