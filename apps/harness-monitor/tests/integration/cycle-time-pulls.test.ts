import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { cycleCheck, cyclePull, cycleRound, emptyTheDatabase, sendPulls, storedPulls } from './support';

beforeEach(emptyTheDatabase);

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
