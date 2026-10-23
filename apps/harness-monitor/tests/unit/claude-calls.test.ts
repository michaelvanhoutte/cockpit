import { describe, expect, it } from 'vitest';
import { keptFrom } from '../../src/claude-calls';

describe('Harness Monitor', () => {
  describe("a copy of Cockpit's Claude call is kept 12 calendar months from its call, as production keeps its record", () => {
    it.each([
      { situation: 'an ordinary day', now: '2026-10-23T12:00:00.000Z', from: '2025-10-23T12:00:00.000Z' },
      { situation: 'a 29 February, which the year before lacks', now: '2028-02-29T00:00:00.000Z', from: '2027-03-01T00:00:00.000Z' },
    ])('on $situation, copies of calls before $from are dropped', ({ now, from }) => {
      expect(new Date(keptFrom(Date.parse(now))).toISOString()).toBe(from);
    });
  });
});
