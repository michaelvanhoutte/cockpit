import { describe, expect, it } from 'vitest';
import { captureDay } from '../../../src/domain/capture-day.js';

/**
 * "Read a due date you say when you capture, on your own calendar" (issue
 * 1077): the day "tomorrow" counts from, worked out from the instant a note
 * was captured and the time zone it was captured in - pure, so every calendar
 * edge is held here and the store only proves it is wired in
 * (tests/integration/http/note-cleanup.test.ts).
 */
describe('Capture', () => {
  describe('a note is read on the calendar day it was captured, where it was captured', () => {
    it.each([
      {
        situation: 'captured at half past midnight in Brussels, still the day before in UTC',
        capturedAt: '2026-10-12T22:30:00.000Z',
        timeZone: 'Europe/Brussels',
        expected: { date: '2026-10-13', weekday: 'Tuesday' },
      },
      {
        situation: 'captured at half past eleven at night in New York, already the next day in UTC',
        capturedAt: '2026-10-14T03:30:00.000Z',
        timeZone: 'America/New_York',
        expected: { date: '2026-10-13', weekday: 'Tuesday' },
      },
      {
        situation: 'captured late on the night the clocks go back in Brussels',
        // 23:30 on the winter clock; on the summer clock it would be past midnight.
        capturedAt: '2026-10-25T22:30:00.000Z',
        timeZone: 'Europe/Brussels',
        expected: { date: '2026-10-25', weekday: 'Sunday' },
      },
      {
        situation: 'captured offline on a Monday and sent on the Tuesday',
        capturedAt: '2026-10-12T09:00:00.000Z',
        timeZone: 'Europe/Brussels',
        expected: { date: '2026-10-12', weekday: 'Monday' },
      },
      {
        situation: 'captured with a time zone name nobody knows',
        capturedAt: '2026-10-12T09:00:00.000Z',
        timeZone: 'Mars/Olympus_Mons',
        expected: null,
      },
      {
        situation: 'captured with no time zone',
        capturedAt: '2026-10-12T09:00:00.000Z',
        timeZone: null,
        expected: null,
      },
    ])('$situation', ({ capturedAt, timeZone, expected }) => {
      expect(captureDay(capturedAt, timeZone)).toEqual(expected);
    });
  });
});
