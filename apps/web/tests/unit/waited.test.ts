import { describe, expect, it } from 'vitest';
import { waitedSince } from '../../src/waited';

const NOW = Date.parse('2026-08-26T10:00:00.000Z');

describe('Triage', () => {
  describe('a row says how long its item has waited, and says nothing until it has waited a day', () => {
    // F1: how long is a pure function of two moments, and it is handed both.
    it.each([
      { situation: 'captured a fortnight ago', at: '2026-08-12T10:00:00.000Z', shows: '14d' },
      { situation: 'captured yesterday', at: '2026-08-25T09:00:00.000Z', shows: '1d' },
      { situation: 'captured this morning', at: '2026-08-26T08:00:00.000Z', shows: null },
      {
        // Not quite a day, which is the boundary the blank is on: a thing
        // captured 23 hours ago has not been waiting a day.
        situation: 'captured just under a day ago',
        at: '2026-08-25T11:00:00.000Z',
        shows: null,
      },
      {
        // A clock behind the server's, which is a real thing on a phone: this
        // must read as no time waited rather than as a negative age.
        situation: 'stamped in the future',
        at: '2026-08-27T10:00:00.000Z',
        shows: null,
      },
    ])('an item $situation', ({ at, shows }) => {
      expect(waitedSince(at, NOW)).toBe(shows);
    });
  });
});
