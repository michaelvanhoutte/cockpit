import { describe, expect, it } from 'vitest';
import {
  APP_CAPTURES_PER_MINUTE,
  FINDS_PER_DAY,
  FINDS_PER_MINUTE,
  TRANSCRIPTIONS_PER_MINUTE,
  admittedCalls,
  admittedFind,
  countedCalls,
  type FindCalls,
} from '../../../src/accounts/call-window.js';

/**
 * L1: how often one caller is heard in a minute - a connected app's captures,
 * and an account's transcriptions - and how often a connected app may find. That
 * a refusal reaches the app in words is tests/integration/http/find-items.test.ts.
 */

describe('Connector management', () => {
  describe('one connected app is heard a limited number of times a minute', () => {
    const NOW = Date.parse('2026-09-29T10:00:00.000Z');
    const full = Array.from({ length: APP_CAPTURES_PER_MINUTE }, (_, i) => NOW - 59_000 + i);

    it.each([
      { situation: 'the first call', earlier: [], admitted: true },
      { situation: 'a call past the limit', earlier: full, admitted: false },
      { situation: 'a call once the oldest have aged out', earlier: full.map((at) => at - 2_000), admitted: true },
    ])('$situation', ({ earlier, admitted }) => {
      expect(admittedCalls(earlier, NOW, APP_CAPTURES_PER_MINUTE) !== null).toBe(admitted);
    });
  });

  describe('an account is held to a limited number of transcriptions a minute, refused ones included', () => {
    const NOW = Date.parse('2026-09-29T10:00:00.000Z');
    const full = Array.from({ length: TRANSCRIPTIONS_PER_MINUTE }, (_, i) => NOW - 30_000 + i);

    it('admits up to the limit and then refuses, counting the refused one', () => {
      expect(TRANSCRIPTIONS_PER_MINUTE).toBe(20);
      const refused = countedCalls(full, NOW, TRANSCRIPTIONS_PER_MINUTE);

      expect(refused.admitted).toBe(false);
      expect(refused.calls).toContain(NOW);
    });

    it('keeps no more than the limit, however many are refused', () => {
      const flood = Array.from({ length: 1000 }, (_, i) => NOW + i);

      expect(countedCalls(flood, NOW + 1000, TRANSCRIPTIONS_PER_MINUTE).calls).toHaveLength(TRANSCRIPTIONS_PER_MINUTE);
    });

    it('stays refused while the account keeps asking, even once the admitted ones have aged out', () => {
      const keptAsking = Array.from({ length: TRANSCRIPTIONS_PER_MINUTE }, (_, i) => NOW + 20_000 + i);
      const later = NOW + 45_000;

      expect(countedCalls([...full, ...keptAsking], later, TRANSCRIPTIONS_PER_MINUTE).admitted).toBe(false);
      expect(countedCalls(full, later, TRANSCRIPTIONS_PER_MINUTE).admitted).toBe(true);
    });
  });

  describe('a connected app may find 10 times a minute and 500 times a day, apart from its captures', () => {
    const NOW = Date.parse('2026-10-19T10:00:00.000Z');
    const callsAt = (...times: number[]): FindCalls => ({ minute: times, day: '2026-10-19', today: times.length });

    /** Calls, one after another, as the account keeps count of them. */
    function findingTimes(times: number[], from?: FindCalls) {
      let held = from;
      const answers: string[] = [];
      for (const at of times) {
        const { answer, calls } = admittedFind(held, at);
        answers.push(answer);
        held = calls;
      }
      return { answers, held };
    }

    it('admits the first call, and 10 in a minute, and refuses the 11th saying it is the minute', () => {
      expect([FINDS_PER_MINUTE, FINDS_PER_DAY]).toEqual([10, 500]);
      const { answers } = findingTimes(Array.from({ length: 11 }, (_, n) => NOW + n * 1000));

      expect(answers.slice(0, 10)).toEqual(Array(10).fill('admitted'));
      expect(answers[10]).toBe('too-many-this-minute');
    });

    it('admits a call again once the minute has gone by', () => {
      const full = findingTimes(Array.from({ length: 10 }, (_, n) => NOW + n * 1000)).held;

      expect(admittedFind(full, NOW + 61_000).answer).toBe('admitted');
      expect(admittedFind(full, NOW + 30_000).answer).toBe('too-many-this-minute');
    });

    it('refuses the 501st in a day saying it is the day, though the minute is clear', () => {
      const spent: FindCalls = { minute: [], day: '2026-10-19', today: FINDS_PER_DAY };

      expect(admittedFind(spent, NOW).answer).toBe('too-many-today');
      expect(admittedFind({ ...spent, today: FINDS_PER_DAY - 1 }, NOW).answer).toBe('admitted');
    });

    it('says the day, not the minute, where both are spent, since waiting a minute would not help', () => {
      const spent: FindCalls = callsAt(...Array.from({ length: 10 }, (_, n) => NOW - n * 1000));

      expect(admittedFind({ ...spent, today: FINDS_PER_DAY }, NOW).answer).toBe('too-many-today');
    });

    it('starts the count again on the next UTC day', () => {
      const spent: FindCalls = { minute: [], day: '2026-10-19', today: FINDS_PER_DAY };

      expect(admittedFind(spent, Date.parse('2026-10-20T00:00:01.000Z')).answer).toBe('admitted');
      expect(admittedFind(spent, Date.parse('2026-10-19T23:59:59.000Z')).answer).toBe('too-many-today');
    });

    it('does not count a refused call against the day', () => {
      const full = findingTimes(Array.from({ length: 10 }, (_, n) => NOW + n * 1000)).held!;

      const refused = admittedFind(full, NOW + 20_000);

      expect(refused.answer).toBe('too-many-this-minute');
      expect(refused.calls.today).toBe(10);
    });

    it('is not spent by captures, which are counted apart', () => {
      const captures = Array.from({ length: APP_CAPTURES_PER_MINUTE }, (_, n) => NOW - 59_000 + n);

      expect(admittedCalls(captures, NOW, APP_CAPTURES_PER_MINUTE)).toBeNull();
      expect(admittedFind(undefined, NOW).answer).toBe('admitted');
    });
  });
});
