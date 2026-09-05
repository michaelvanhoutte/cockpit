import { describe, expect, it } from 'vitest';
import { howLongAgo } from '../../src/capture';

/**
 * F1, and pure: it is arithmetic over an elapsed time. What the Capture page
 * does with it - one of these beside every note it has just captured - is
 * tests/unit/pages/CapturePage.test.tsx.
 */
describe('Capture', () => {
  describe('how long ago a note was captured reads in the largest whole unit that has passed', () => {
    const second = 1000;
    const minute = 60 * second;
    const hour = 60 * minute;
    const day = 24 * hour;

    it.each([
      { situation: 'a note captured a moment ago', ago: 0, reads: 'now' },
      { situation: 'seconds, which nobody counts', ago: 59 * second, reads: 'now' },
      { situation: 'a whole minute', ago: minute, reads: '1m' },
      { situation: 'most of an hour', ago: 59 * minute, reads: '59m' },
      { situation: 'an hour, rounded down to it', ago: 90 * minute, reads: '1h' },
      { situation: 'most of a day', ago: 23 * hour, reads: '23h' },
      { situation: 'a page left open overnight', ago: 30 * hour, reads: '1d' },
      // A clock put back while the page was open, which is a note captured in
      // the future. Reads as *now* rather than as a negative age.
      { situation: 'a clock that went backwards', ago: -hour, reads: 'now' },
      { situation: 'a page left open for a week', ago: 8 * day, reads: '8d' },
    ])('$situation', ({ ago, reads }) => {
      expect(howLongAgo(ago)).toBe(reads);
    });
  });
});
