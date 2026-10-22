import { describe, expect, it } from 'vitest';
import { dayStartsAt } from '../../../src/domain/series.js';

/**
 * L1: when a repeating Item's day starts ("Bring a repeating Item back on its
 * day, as a fresh copy", issue 1407) - at midnight on the calendar of the time
 * zone its rule was set in, or at the first moment of that day where the clocks
 * jump over midnight. Pure: the days and zones are given; nothing reads the clock.
 */

describe('Item editing', () => {
  describe('a repeating Item’s day starts at midnight on its own calendar, a day the clocks change included', () => {
    it.each([
      { situation: 'in Brussels in winter', day: '2027-01-11', zone: 'Europe/Brussels', starts: '2027-01-10T23:00:00.000Z' },
      { situation: 'in Brussels in summer', day: '2027-07-12', zone: 'Europe/Brussels', starts: '2027-07-11T22:00:00.000Z' },
      { situation: 'in Brussels on the day the clocks go forward', day: '2027-03-28', zone: 'Europe/Brussels', starts: '2027-03-27T23:00:00.000Z' },
      { situation: 'in Brussels on the day the clocks go back', day: '2027-10-31', zone: 'Europe/Brussels', starts: '2027-10-30T22:00:00.000Z' },
      { situation: 'in New York, behind UTC', day: '2027-01-11', zone: 'America/New_York', starts: '2027-01-11T05:00:00.000Z' },
      { situation: 'in Kiritimati, fourteen hours ahead', day: '2027-01-11', zone: 'Pacific/Kiritimati', starts: '2027-01-10T10:00:00.000Z' },
      { situation: 'in Kathmandu, a quarter-hour off the hour', day: '2027-01-11', zone: 'Asia/Kathmandu', starts: '2027-01-10T18:15:00.000Z' },
      // Beirut's clocks go from midnight straight to one: the day starts at one, an hour from the day before.
      { situation: 'in Beirut, whose clocks jump over midnight', day: '2027-03-28', zone: 'Asia/Beirut', starts: '2027-03-27T22:00:00.000Z' },
      { situation: 'on UTC', day: '2027-01-11', zone: 'UTC', starts: '2027-01-11T00:00:00.000Z' },
    ])('$situation', ({ day, zone, starts }) => {
      expect(new Date(dayStartsAt(day, zone)!).toISOString()).toBe(starts);
    });

    it('is unknown for a zone that cannot be read', () => {
      expect(dayStartsAt('2027-01-11', 'Mars/Olympus_Mons')).toBeNull();
    });
  });
});
