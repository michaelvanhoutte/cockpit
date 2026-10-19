import { describe, expect, it } from 'vitest';
import {
  APP_CAPTURES_PER_MINUTE,
  APP_FINDS_PER_DAY,
  APP_FINDS_PER_MINUTE,
  TRANSCRIPTIONS_PER_MINUTE,
  admittedCalls,
  admittedFinds,
  countedCalls,
} from '../../../src/accounts/call-window.js';

/** L1: how often one caller is heard in a minute - a connected app's captures, and an account's transcriptions - and a connected app's finds, in a minute and in a day. */

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

  describe('one connected app may find 10 times a minute and 500 times a day', () => {
    const NOW = Date.parse('2026-10-19T10:00:00.000Z');
    const MINUTE = 60_000;
    // Ten calls inside the last minute.
    const aMinuteFull = Array.from({ length: APP_FINDS_PER_MINUTE }, (_, i) => NOW - 50_000 + i);
    // Five hundred calls over the last day, never ten in one minute: one every 2.8 minutes, the oldest 23 hours and 20 minutes ago.
    const aDayFull = Array.from({ length: APP_FINDS_PER_DAY }, (_, i) => NOW - (i + 1) * 2.8 * MINUTE).reverse();

    it('keeps the limits it says', () => {
      expect([APP_FINDS_PER_MINUTE, APP_FINDS_PER_DAY]).toEqual([10, 500]);
    });

    it.each([
      { situation: 'the first call', earlier: [] as number[], answer: 'admitted' },
      { situation: 'the 10th call inside a minute', earlier: aMinuteFull.slice(1), answer: 'admitted' },
      { situation: 'the 11th call inside a minute', earlier: aMinuteFull, answer: 'a-minute' },
      { situation: 'an 11th call once the first ten have aged out of the minute', earlier: aMinuteFull.map((at) => at - 20_000), answer: 'admitted' },
      { situation: 'the 500th call inside a day', earlier: aDayFull.slice(1), answer: 'admitted' },
      { situation: 'the 501st call inside a day', earlier: aDayFull, answer: 'a-day' },
      { situation: 'a call once the oldest of the day have aged out', earlier: aDayFull.map((at) => at - 50 * MINUTE), answer: 'admitted' },
    ])('answers $answer for $situation', ({ earlier, answer }) => {
      const counted = admittedFinds(earlier, NOW);
      expect(counted.admitted ? 'admitted' : counted.limit).toBe(answer);
    });

    it('counts a call it admits and leaves the count as it was for one it refuses, so a caller that waits is let in', () => {
      const counted = admittedFinds(aMinuteFull.slice(1), NOW);
      expect(counted.admitted && counted.calls).toHaveLength(APP_FINDS_PER_MINUTE);
      const refused = admittedFinds(aMinuteFull, NOW);
      expect(refused.admitted).toBe(false);
      expect(admittedFinds(aMinuteFull, NOW + 2 * MINUTE).admitted).toBe(true);
    });

    it('is apart from capture: a grant at its capture limit in the minute still finds', () => {
      const captures = Array.from({ length: APP_CAPTURES_PER_MINUTE }, (_, i) => NOW - 50_000 + i);
      expect(admittedCalls(captures, NOW, APP_CAPTURES_PER_MINUTE)).toBeNull();
      // The find count is its own list, which captures are never added to.
      expect(admittedFinds([], NOW).admitted).toBe(true);
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
