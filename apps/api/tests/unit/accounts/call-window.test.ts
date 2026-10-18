import { describe, expect, it } from 'vitest';
import {
  APP_CAPTURES_PER_MINUTE,
  TRANSCRIPTIONS_PER_MINUTE,
  admittedCalls,
  countedCalls,
  findAdmission,
} from '../../../src/accounts/call-window.js';

/** L1: how often one caller is heard in a minute - a connected app's captures, and an account's transcriptions. */

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

  describe('one connected app may find a limited number of times a minute and a day, apart from capturing', () => {
    const NOW = Date.parse('2026-09-29T10:00:00.000Z');
    const MINUTE = 60_000;
    /** `count` calls spread evenly over the day before NOW, none in the last minute. */
    const spread = (count: number) =>
      Array.from({ length: count }, (_, i) => NOW - 2 * MINUTE - Math.floor((i * 20 * 60 * MINUTE) / count));

    it.each([
      { situation: 'the first call', earlier: [], answer: 'admitted' },
      { situation: 'the 10th call inside a minute', earlier: Array.from({ length: 9 }, (_, i) => NOW - 5_000 + i), answer: 'admitted' },
      { situation: 'the 11th call inside a minute', earlier: Array.from({ length: 10 }, (_, i) => NOW - 5_000 + i), answer: 'too-many-a-minute' },
      { situation: 'a call once the minute has passed', earlier: Array.from({ length: 10 }, (_, i) => NOW - 61_000 + i), answer: 'admitted' },
      { situation: 'the 500th call inside a day', earlier: spread(499), answer: 'admitted' },
      { situation: 'the 501st call inside a day', earlier: spread(500), answer: 'too-many-today' },
      { situation: 'a call once a day has passed', earlier: spread(500).map((at) => at - 5 * 60 * MINUTE), answer: 'admitted' },
    ])('$situation', ({ earlier, answer }) => {
      expect(findAdmission(earlier, NOW).answer).toBe(answer);
    });

    it('counts a call it admits and not one it refuses, so a loop held off for a minute spends none of its day', () => {
      const tenInTheMinute = Array.from({ length: 10 }, (_, i) => NOW - 5_000 + i);

      expect(findAdmission([], NOW).calls).toEqual([NOW]);
      expect(findAdmission(tenInTheMinute, NOW).calls).toEqual(tenInTheMinute);
    });

    it('is not spent by 60 captures in the minute, which are counted apart', () => {
      const sixtyCaptures = Array.from({ length: APP_CAPTURES_PER_MINUTE }, (_, i) => NOW - 59_000 + i);

      expect(admittedCalls(sixtyCaptures, NOW, APP_CAPTURES_PER_MINUTE)).toBeNull();
      expect(findAdmission([], NOW).answer).toBe('admitted');
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
});
