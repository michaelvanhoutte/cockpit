import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { cycleCheck, cyclePull, cycleRound, cycleTimeline, emptyTheDatabase, sendPulls, sendTimelines, storedPulls, storedTimelines } from './support';

beforeEach(emptyTheDatabase);

/** A pull request of two rounds, the first with a fluke and the steps and files it failed on. */
const twoRounds = (number: number, over: Record<string, unknown> = {}) =>
  cyclePull(number, {
    rounds: [
      cycleRound([cycleCheck('Test', 200_000, { failure: 'fluke', flukeMs: 100_000, failedSteps: ['Run the tests'], failedFiles: ['a.test.ts'] }), cycleCheck('Test', 100_000, { attempt: 2, last: true })], { sha: 'a'.repeat(40) }),
      cycleRound([cycleCheck('Test', 300_000, { last: true })], { sha: 'b'.repeat(40) }),
    ],
    ...over,
  });

/** Every row stored under cycle time's pull requests, rounds, checks and failures. */
const thePullRows = async () =>
  Promise.all(['cycle_time_pulls', 'cycle_time_rounds', 'cycle_time_checks', 'cycle_time_failures'].map(async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));

const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

describe('Harness Monitor', () => {
  describe("a merged pull request's timeline is stored with it, and a later send of the pull request replaces its timeline", () => {
    it.each([
      {
        situation: 'a pull request sent with its timeline is stored with that one timeline',
        sends: [[twoRounds(5, { timeline: cycleTimeline(2) })]],
        stored: { 5: cycleTimeline(2) },
      },
      {
        situation: 'the same pull request sent again with a different timeline keeps only the newer',
        sends: [[twoRounds(5, { timeline: cycleTimeline(2, 'Lint') })], [twoRounds(5, { timeline: cycleTimeline(2, 'Test') })]],
        stored: { 5: cycleTimeline(2, 'Test') },
      },
      {
        situation: 'two pull requests in one send each keep their own',
        sends: [[twoRounds(5, { timeline: cycleTimeline(2, 'Lint') }), cyclePull(6, { timeline: cycleTimeline(1, 'E2E (F3)') })]],
        stored: { 5: cycleTimeline(2, 'Lint'), 6: cycleTimeline(1, 'E2E (F3)') },
      },
      {
        situation: 'the same pull request sent again without a timeline is left with none',
        sends: [[twoRounds(5, { timeline: cycleTimeline(2) })], [twoRounds(5)]],
        stored: {},
      },
    ])('$situation', async ({ sends, stored }) => {
      for (const pulls of sends) expect((await sendPulls(pulls)).status).toBe(200);

      expect(await storedTimelines()).toEqual(stored);
    });

    it('a send with one timeline that does not fit its pull request stores nothing of any of its pull requests', async () => {
      const response = await sendPulls([cyclePull(1, { timeline: cycleTimeline(1) }), twoRounds(2, { timeline: cycleTimeline(3) }), cyclePull(3, { timeline: cycleTimeline(1) })]);

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('Pull request 1 (#2): has a timeline of 3 rounds, but it has 2.');
      expect(await storedPulls()).toEqual([]);
      expect(await storedTimelines()).toEqual({});
    });
  });

  describe('a timeline sent alone is stored beside the pull request the Monitor holds, and never touches the pull request', () => {
    it('a timeline for a held pull request is stored, leaving its row, rounds, checks and failures as they were', async () => {
      await sendPulls([twoRounds(5)]);
      const before = await thePullRows();

      const response = await sendTimelines([{ number: 5, timeline: cycleTimeline(2) }]);

      expect(response.status).toBe(200);
      expect(await storedTimelines()).toEqual({ 5: cycleTimeline(2) });
      expect(await thePullRows()).toEqual(before);
    });

    it.each([
      {
        situation: 'a timeline for a pull request the Monitor does not hold',
        timelines: [{ number: 5, timeline: cycleTimeline(2) }, { number: 9, timeline: cycleTimeline(1) }],
        error: 'Timeline 1 (#9): is for a pull request the Monitor does not hold; send the pull request first.',
      },
      {
        situation: "a timeline whose round count differs from the stored pull request's",
        timelines: [{ number: 5, timeline: cycleTimeline(2) }, { number: 6, timeline: cycleTimeline(2) }],
        error: 'Timeline 1 (#6): has a timeline of 2 rounds, but the stored pull request has 1.',
      },
    ])('$situation refuses the send, naming it, and stores none of it', async ({ timelines, error }) => {
      await sendPulls([twoRounds(5), cyclePull(6)]);

      const response = await sendTimelines(timelines);

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(error);
      expect(await storedTimelines()).toEqual({});
    });

    it('the same window sent twice stores one timeline per pull request, unchanged', async () => {
      await sendPulls([twoRounds(5), cyclePull(6)]);
      const window = [{ number: 5, timeline: cycleTimeline(2) }, { number: 6, timeline: cycleTimeline(1) }];

      await sendTimelines(window);
      await sendTimelines(window);

      expect(await storedTimelines()).toEqual({ 5: cycleTimeline(2), 6: cycleTimeline(1) });
    });

    it.each([
      { situation: 'with no key', headers: {} },
      { situation: 'with a wrong key', headers: { authorization: 'Bearer not-the-key' } },
    ])('a send $situation is refused, and nothing is stored', async ({ headers }) => {
      await sendPulls([cyclePull(6)]);

      const response = await sendTimelines([{ number: 6, timeline: cycleTimeline(1) }], headers);

      expect(response.status).toBe(401);
      expect(await storedTimelines()).toEqual({});
    });
  });

  describe('a send of timelines stopped partway keeps what it stored, and running it again completes it', () => {
    it("the first batch stored and the second refused keeps the first's timelines, and the second's pull requests have none until it is sent again whole", async () => {
      await sendPulls([cyclePull(1), cyclePull(2), cyclePull(3), twoRounds(4)]);
      const first = [{ number: 1, timeline: cycleTimeline(1) }, { number: 2, timeline: cycleTimeline(1) }];
      const second = [{ number: 3, timeline: cycleTimeline(1) }, { number: 4, timeline: cycleTimeline(1) }];

      expect((await sendTimelines(first)).status).toBe(200);
      expect((await sendTimelines(second)).status).toBe(400);
      expect(Object.keys(await storedTimelines())).toEqual(['1', '2']);

      await sendTimelines(first);
      await sendTimelines([second[0], { number: 4, timeline: cycleTimeline(2) }]);

      expect(await storedTimelines()).toEqual({ 1: cycleTimeline(1), 2: cycleTimeline(1), 3: cycleTimeline(1), 4: cycleTimeline(2) });
    });
  });
});
