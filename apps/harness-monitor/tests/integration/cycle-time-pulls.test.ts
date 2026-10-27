import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { cycleTimeView } from '../../src/cycle-time-store';
import { cycleCheck, cyclePull, cycleRound, emptyTheDatabase, sendPulls, storedPulls } from './support';

beforeEach(emptyTheDatabase);

/** A pull request's local check kinds as the JSON answer gives them. */
const answeredLocalParts = async (number: number) => {
  const response = await SELF.fetch('https://monitor.test/cycle-time?format=json&period=all');
  return ((await response.json()) as { pulls: { number: number; time: { localParts: unknown } }[] }).pulls.find((p) => p.number === number)!.time.localParts;
};

/** Two rounds of four checks, the second one's last check a fluke on its first attempt. */
const twoRoundsOfFour = (number: number, over: Record<string, unknown> = {}) =>
  cyclePull(number, {
    rounds: [
      cycleRound([cycleCheck('Checks', 60_000), cycleCheck('Lint', 90_000), cycleCheck('Test', 200_000), cycleCheck('E2E (F3)', 400_000, { last: true })], { sha: 'a'.repeat(40) }),
      cycleRound([cycleCheck('Checks', 60_000), cycleCheck('Lint', 90_000), cycleCheck('Test', 200_000), cycleCheck('E2E (F3)', 400_000, { last: true })], { sha: 'b'.repeat(40) }),
    ],
    ...over,
  });

describe('Harness Monitor', () => {
  describe('a merged pull request of cycle time is stored once, with its rounds and their checks, and a later send of it replaces it', () => {
    it('a pull request with two rounds of four checks is one pull request, two rounds and eight checks', async () => {
      const response = await sendPulls([twoRoundsOfFour(101)]);

      expect(response.status).toBe(200);
      expect(await storedPulls()).toEqual([{ pull_number: 101, recorded: 1, rounds: 2, checks: 8, failures: 0, fluke_ms: null }]);
    });

    it('the same pull request sent again with a fluke found since is stored once, now with the fluke and what failed', async () => {
      await sendPulls([twoRoundsOfFour(101)]);
      const withAFluke = twoRoundsOfFour(101, {
        rounds: [
          cycleRound(
            [
              cycleCheck('Test', 200_000, { failure: 'fluke', flukeMs: 150_000, failedSteps: ['Run the tests'], failedFiles: ['a.test.ts', 'b.test.ts'] }),
              cycleCheck('Test', 150_000, { attempt: 2, last: true }),
            ],
            { sha: 'c'.repeat(40) },
          ),
        ],
      });

      await sendPulls([withAFluke]);

      expect(await storedPulls()).toEqual([{ pull_number: 101, recorded: 1, rounds: 1, checks: 2, failures: 3, fluke_ms: 150_000 }]);
    });

    it('two overlapping sends store each pull request once, with the later send\'s values', async () => {
      await sendPulls([cyclePull(1), cyclePull(2, { title: 'before' })]);
      await sendPulls([cyclePull(2, { title: 'after', recorded: false, codingMs: null, localMs: null }), cyclePull(3)]);

      expect(await storedPulls()).toEqual([
        { pull_number: 1, recorded: 1, rounds: 1, checks: 1, failures: 0, fluke_ms: null },
        { pull_number: 2, recorded: 0, rounds: 1, checks: 1, failures: 0, fluke_ms: null },
        { pull_number: 3, recorded: 1, rounds: 1, checks: 1, failures: 0, fluke_ms: null },
      ]);
    });
  });

  describe('a pull request with no session record is stored and answered as not recorded, never as zero', () => {
    it('its writing and local-check times answer as not recorded, beside the CI time it did have', async () => {
      await sendPulls([cyclePull(7, { recorded: false, start: { at: '2026-10-01T09:00:00Z', from: 'first-commit' }, codingMs: null, localMs: null, localReviews: null })]);

      const response = await SELF.fetch('https://monitor.test/cycle-time?format=json&period=all');
      const [pull] = ((await response.json()) as { pulls: { number: number; recorded: boolean; time: Record<string, number | null>; balance: unknown; localReviews: unknown }[] }).pulls;

      expect(pull).toMatchObject({
        number: 7,
        recorded: false,
        time: { codingMs: null, localMs: null, ciMs: 300_000 },
        balance: null,
        localReviews: null,
      });
    });
  });

  describe("a pull request's local reviews are stored and answered by kind beside the combined figure, and as not recorded where it was stored without the kinds", () => {
    const answered = async (number: number) => {
      const response = await SELF.fetch('https://monitor.test/cycle-time?format=json&period=all');
      return ((await response.json()) as { pulls: { number: number; localReviews: unknown }[] }).pulls.find((p) => p.number === number)!.localReviews;
    };

    it.each([
      {
        situation: 'a code review and a security review',
        sent: { count: 2, ms: 300_000, byKind: { 'code-review': { count: 1, ms: 240_000 }, 'security-review': { count: 1, ms: 120_000 } } },
        answer: { count: 2, ms: 300_000, byKind: { 'code-review': { count: 1, ms: 240_000 }, 'security-review': { count: 1, ms: 120_000 } } },
      },
      {
        situation: 'a code review and no security review, which is zero of that kind',
        sent: { count: 1, ms: 240_000, byKind: { 'code-review': { count: 1, ms: 240_000 }, 'security-review': { count: 0, ms: 0 } } },
        answer: { count: 1, ms: 240_000, byKind: { 'code-review': { count: 1, ms: 240_000 }, 'security-review': { count: 0, ms: 0 } } },
      },
      { situation: 'reviews sent without their kinds, as before they were kept', sent: { count: 2, ms: 300_000 }, answer: { count: 2, ms: 300_000, byKind: null } },
      { situation: 'no review marked', sent: null, answer: null },
    ])('$situation', async ({ sent, answer }) => {
      await sendPulls([cyclePull(5, { localReviews: sent })]);

      expect(await answered(5)).toEqual(answer);
    });

    it('a later send of the same pull request replaces the kinds with its own', async () => {
      await sendPulls([cyclePull(5, { localReviews: { count: 2, ms: 300_000 } })]);
      await sendPulls([cyclePull(5)]);

      expect(await answered(5)).toMatchObject({ byKind: { 'code-review': { ms: 180_000 }, 'security-review': { ms: 120_000 } } });
    });
  });

  describe("a pull request's local check kinds, each minute counted once, are stored and answered as sent, and as not split by kind where it was stored without them", () => {
    const parts = { 'code-review': 120_000, 'security-review': 0, test: 150_000, browser: 30_000 };
    // The page's own view, which draws them.
    const inThePagesView = async (number: number) => (await cycleTimeView(env.DB, 0)).pulls.find((p) => p.number === number)!.time.localParts;

    it.each([
      { situation: 'a send carrying the four', sent: { localParts: parts }, answer: parts },
      { situation: 'a send from a job that does not send them yet', sent: {}, answer: null },
      { situation: 'a pull request with no session record', sent: { recorded: false, codingMs: null, localMs: null, localReviews: null }, answer: null },
    ])('$situation', async ({ sent, answer }) => {
      await sendPulls([cyclePull(5, sent)]);

      expect(await answeredLocalParts(5)).toEqual(answer);
      expect(await inThePagesView(5)).toEqual(answer);
    });

    it('the same pull request sent again with them is stored once, now carrying them', async () => {
      await sendPulls([cyclePull(5)]);
      await sendPulls([cyclePull(5, { localParts: parts })]);

      expect(await storedPulls()).toHaveLength(1);
      expect(await answeredLocalParts(5)).toEqual(parts);
    });
  });

  describe('a send whose local check kinds do not add up to the local time is refused whole, and nothing in it is stored', () => {
    it.each([
      {
        situation: 'kinds adding up to a minute more than the local time',
        localParts: { 'code-review': 120_000, 'security-review': 60_000, test: 120_000, browser: 60_000 },
        over: {},
        error: 'Pull request 1 (#9): has localParts adding up to 360000 ms, not its localMs of 300000.',
      },
      {
        situation: 'a kind that is negative',
        localParts: { 'code-review': 360_000, 'security-review': -60_000, test: 0, browser: 0 },
        over: {},
        error: 'Pull request 1 (#9): has localParts.security-review -60000, which is not a whole number of milliseconds, zero or more.',
      },
      {
        situation: 'kinds on a pull request with no session record',
        localParts: { 'code-review': 0, 'security-review': 0, test: 0, browser: 0 },
        over: { recorded: false, codingMs: null, localMs: null },
        error: 'Pull request 1 (#9): has localParts but no session record.',
      },
    ])('$situation', async ({ localParts, over, error }) => {
      const response = await sendPulls([cyclePull(1, { localParts: { 'code-review': 300_000, 'security-review': 0, test: 0, browser: 0 } }), cyclePull(9, { ...over, localParts })]);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(error);
      expect(await storedPulls()).toEqual([]);
    });
  });

  describe('keeping the local check kinds leaves every pull request already stored as it was', () => {
    it('a pull request stored before, with its rounds, checks and review kinds, keeps every figure, its kinds not split', async () => {
      await sendPulls([cyclePull(5, { rounds: [cycleRound([cycleCheck('Test', 200_000, { failure: 'fluke', flukeMs: 100_000, failedFiles: ['a.test.ts'] }), cycleCheck('Test', 100_000, { attempt: 2, last: true })])] })]);
      const LOCAL_PARTS = ['local_code_review_ms', 'local_security_review_ms', 'local_test_ms', 'local_browser_ms'];
      for (const column of LOCAL_PARTS) await env.DB.prepare(`ALTER TABLE cycle_time_pulls DROP COLUMN ${column}`).run();
      const tables = async () =>
        Promise.all(['cycle_time_pulls', 'cycle_time_rounds', 'cycle_time_checks', 'cycle_time_failures'].map(async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));
      const before = await tables();
      const migration = inject('migrations').find((m) => m.name.startsWith('0023_cycle_time_local_parts'))!;

      for (const query of migration.queries) await env.DB.prepare(query).run();

      const [pulls, ...beneath] = await tables();
      expect(pulls).toEqual(before[0]!.map((row) => ({ ...row, ...Object.fromEntries(LOCAL_PARTS.map((column) => [column, null])) })));
      expect(beneath).toEqual(before.slice(1));
      expect(await answeredLocalParts(5)).toBeNull();
    });
  });

  describe("each check attempt's running time is stored and answered as sent, and as not recorded where the attempt was stored without one", () => {
    /** One round's Test failing and re-run, then E2E, each attempt with `running` minutes of running time, or none sent. */
    const withRunning = (number: number, running: (number | undefined)[] = []) => {
      const over = (index: number) => (running[index] === undefined ? {} : { runningMs: running[index]! * 60_000 });
      return cyclePull(number, {
        rounds: [
          cycleRound([
            cycleCheck('Test', 200_000, { failure: 'fluke', flukeMs: 100_000, ...over(0) }),
            cycleCheck('Test', 100_000, { attempt: 2, ...over(1) }),
            cycleCheck('E2E (F3)', 300_000, { last: true, ...over(2) }),
          ]),
        ],
      });
    };
    const answeredRunning = async (number: number) => {
      const response = await SELF.fetch('https://monitor.test/cycle-time?format=json&period=all');
      const pulls = ((await response.json()) as { pulls: { number: number; rounds: { checks: { runningMs: number | null }[] }[] }[] }).pulls;
      return pulls.find((p) => p.number === number)!.rounds.flatMap((r) => r.checks.map((c) => c.runningMs));
    };
    // The page's own view, which draws them.
    const inThePagesView = async (number: number) => (await cycleTimeView(env.DB, 0)).pulls.find((p) => p.number === number)!.rounds.flatMap((r) => r.checks.map((c) => c.runningMs));

    it.each([
      { situation: 'a send carrying running times, one of them nothing', running: [4, 3, 0], answer: [240_000, 180_000, 0] },
      { situation: 'a send from a job that does not send them yet', running: [], answer: [null, null, null] },
    ])('$situation', async ({ running, answer }) => {
      await sendPulls([withRunning(5, running)]);

      expect(await answeredRunning(5)).toEqual(answer);
      expect(await inThePagesView(5)).toEqual(answer);
    });

    it('the same pull request sent again with them is stored once, now carrying them', async () => {
      await sendPulls([withRunning(5)]);
      await sendPulls([withRunning(5, [4, 3, 20])]);

      expect(await storedPulls()).toEqual([{ pull_number: 5, recorded: 1, rounds: 1, checks: 3, failures: 0, fluke_ms: 100_000 }]);
      expect(await answeredRunning(5)).toEqual([240_000, 180_000, 1_200_000]);
    });
  });

  describe('a send whose running times are wrong is refused whole, and nothing in it is stored', () => {
    const roundOf = (...runningMs: (number | undefined)[]) =>
      cycleRound(runningMs.map((ms, index) => cycleCheck('Test', 100_000, { attempt: index + 1, last: index === runningMs.length - 1, ...(ms === undefined ? {} : { runningMs: ms }) })));

    it.each([
      {
        situation: 'a negative running time',
        rounds: [roundOf(240_000, -60_000)],
        error: 'Pull request 1 (#9): round 0 (bbbbbbb) check 1 (Test) has runningMs -60000, which is not a whole number of milliseconds, zero or more.',
      },
      {
        situation: "running times on some of a pull request's attempts and not others",
        rounds: [roundOf(240_000, 180_000), roundOf(undefined)],
        error: 'Pull request 1 (#9): has runningMs on 2 of its 3 check attempts; it is sent on all of them or none.',
      },
    ])('$situation', async ({ rounds, error }) => {
      const response = await sendPulls([cyclePull(1, { rounds: [roundOf(60_000)] }), cyclePull(9, { rounds })]);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(error);
      expect(await storedPulls()).toEqual([]);
    });
  });

  describe("storing each check attempt's running time leaves every pull request already stored as it was", () => {
    it('a pull request stored before, with its rounds, checks and failures, keeps every figure, each attempt not recorded', async () => {
      await sendPulls([cyclePull(5, { rounds: [cycleRound([cycleCheck('Test', 200_000, { failure: 'fluke', flukeMs: 100_000, failedFiles: ['a.test.ts'] }), cycleCheck('Test', 100_000, { attempt: 2, last: true })])] })]);
      await env.DB.prepare('ALTER TABLE cycle_time_checks DROP COLUMN running_ms').run();
      const tables = async () =>
        Promise.all(['cycle_time_pulls', 'cycle_time_rounds', 'cycle_time_checks', 'cycle_time_failures'].map(async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));
      const before = await tables();
      const migration = inject('migrations').find((m) => m.name.startsWith('0024_cycle_time_check_running'))!;

      for (const query of migration.queries) await env.DB.prepare(query).run();

      const [pulls, rounds, checks, failures] = await tables();
      expect([pulls, rounds, failures]).toEqual([before[0], before[1], before[3]]);
      expect(checks).toEqual(before[2]!.map((row) => ({ ...row, running_ms: null })));
      const response = await SELF.fetch('https://monitor.test/cycle-time?format=json&period=all');
      const [answered] = ((await response.json()) as { pulls: { rounds: { checks: { runningMs: number | null }[] }[] }[] }).pulls;
      expect(answered!.rounds[0]!.checks.map((c) => c.runningMs)).toEqual([null, null]);
    });
  });

  describe('the Monitor says when its newest stored pull request merged, where the next send reads from', () => {
    it.each([
      { situation: 'with nothing stored', sent: [], newestMerge: null },
      {
        situation: 'with pull requests stored',
        sent: [cyclePull(1, { mergedAt: '2026-10-22T08:00:00Z' }), cyclePull(2, { mergedAt: '2026-10-20T08:00:00Z' })],
        newestMerge: '2026-10-22T08:00:00.000Z',
      },
    ])('$situation', async ({ sent, newestMerge }) => {
      if (sent.length > 0) await sendPulls(sent);

      const response = await SELF.fetch('https://monitor.test/v1/cycle-time');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ newestMerge });
    });
  });

  describe("a send of cycle time's pull requests without the write key stores nothing", () => {
    it.each([
      { situation: 'with no key', headers: {} },
      { situation: 'with a wrong key', headers: { authorization: 'Bearer not-the-key' } },
    ])('a send $situation is refused', async ({ headers }) => {
      const response = await sendPulls([cyclePull(1)], headers);

      expect(response.status).toBe(401);
      expect(await storedPulls()).toEqual([]);
    });
  });

  describe('a send holding any pull request of the wrong shape is refused whole, saying which and why', () => {
    it('one bad pull request among good ones stores none of the send', async () => {
      const bad = cyclePull(9, { rounds: [cycleRound([cycleCheck('Test', -1)])] });

      const response = await sendPulls([cyclePull(1), bad, cyclePull(3)]);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/^Pull request 1 \(#9\): round 0 \(bbbbbbb\) check 0 \(Test\) has heldMs -1/);
      expect(await storedPulls()).toEqual([]);
    });
  });
});
