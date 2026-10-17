import { describe, expect, it } from 'vitest';
import {
  APP_CAPTURES_PER_MINUTE,
  TRANSCRIPTIONS_PER_MINUTE,
  admittedCalls,
  countedCalls,
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
