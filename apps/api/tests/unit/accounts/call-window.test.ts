import { describe, expect, it } from 'vitest';
import { HOOK_CALLS_PER_MINUTE, admittedCalls } from '../../../src/accounts/call-window.js';

/** L1: how often one caller is heard in a minute, for the Claude Code hooks and a connected app's captures alike. */

describe('Connector management', () => {
  describe('one connection is heard a limited number of times a minute', () => {
    const NOW = Date.parse('2026-09-29T10:00:00.000Z');
    const full = Array.from({ length: HOOK_CALLS_PER_MINUTE }, (_, i) => NOW - 59_000 + i);

    it.each([
      { situation: 'the first call', earlier: [], admitted: true },
      { situation: 'a call past the limit', earlier: full, admitted: false },
      { situation: 'a call once the oldest have aged out', earlier: full.map((at) => at - 2_000), admitted: true },
    ])('$situation', ({ earlier, admitted }) => {
      expect(admittedCalls(earlier, NOW, HOOK_CALLS_PER_MINUTE) !== null).toBe(admitted);
    });
  });
});
