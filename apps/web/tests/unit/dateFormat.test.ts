import { afterEach, describe, expect, it, vi } from 'vitest';
import { dateTimeLabel, dayLabel, momentDateLabel, shortDayLabel } from '../../src/dateFormat';
import { deviceIsIn, deviceSpeaks } from './support/timeZone';

/**
 * F1: the zone and the languages are what a browser hands the formatter, so
 * both are handed to it here (`./support/timeZone`) and every case reads them
 * when it draws, the way a screen does.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dates', () => {
  describe('a moment Cockpit shows reads in the device’s time zone, as it is when the moment is drawn', () => {
    it.each([
      {
        situation: '13:05 UTC on a device in Brussels',
        moment: '2026-10-22T13:05:00.000Z',
        zone: 'Europe/Brussels',
        reads: '22 Oct 2026, 15:05',
        draw: dateTimeLabel,
      },
      {
        situation: '23:30 UTC on a device in Brussels, which is already the next day',
        moment: '2026-10-22T23:30:00.000Z',
        zone: 'Europe/Brussels',
        reads: '23 Oct 2026',
        draw: momentDateLabel,
      },
      {
        situation: '13:05 UTC on a device in New York',
        moment: '2026-10-22T13:05:00.000Z',
        zone: 'America/New_York',
        reads: '22 Oct 2026, 09:05',
        draw: dateTimeLabel,
      },
    ])('reads $situation as $reads', ({ moment, zone, reads, draw }) => {
      deviceIsIn(zone);
      deviceSpeaks('nl-BE');

      expect(draw(moment)).toBe(reads);
    });

    it('draws the next one in the zone the device is in by then', () => {
      deviceSpeaks('nl-BE');
      deviceIsIn('Europe/Brussels');
      const before = dateTimeLabel('2026-10-22T13:05:00.000Z');
      vi.restoreAllMocks();
      deviceSpeaks('nl-BE');
      deviceIsIn('America/New_York');

      expect([before, dateTimeLabel('2026-10-22T13:05:00.000Z')]).toEqual([
        '22 Oct 2026, 15:05',
        '22 Oct 2026, 09:05',
      ]);
    });
  });

  describe('the format follows the browser’s region, with the words in English', () => {
    it.each([
      { situation: 'nl-BE', languages: ['nl-BE'], reads: '22 Oct 2026, 15:05' },
      { situation: 'en-US', languages: ['en-US'], reads: 'Oct 22, 2026, 3:05 PM' },
      { situation: 'fr, then nl-BE: the first that names a region wins', languages: ['fr', 'nl-BE'], reads: '22 Oct 2026, 15:05' },
      { situation: 'fr alone: no region anywhere, so plain English', languages: ['fr'], reads: 'Oct 22, 2026, 3:05 PM' },
      { situation: 'no languages at all', languages: [], reads: 'Oct 22, 2026, 3:05 PM' },
      { situation: 'pt-BR: no English variant, so US order', languages: ['pt-BR'], reads: 'Oct 22, 2026, 3:05 PM' },
    ])('reads 13:05 UTC in Brussels as $reads for $situation', ({ languages, reads }) => {
      deviceIsIn('Europe/Brussels');
      deviceSpeaks(...languages);

      expect(dateTimeLabel('2026-10-22T13:05:00.000Z')).toBe(reads);
    });
  });

  describe('a day with no time reads as the same day in every zone, in the region’s order', () => {
    it.each([
      { situation: 'Honolulu, the far west', zone: 'Pacific/Honolulu' },
      { situation: 'Auckland, the far east', zone: 'Pacific/Auckland' },
    ])('a due date of 2026-10-22 reads as 22 Oct on a device in $situation', ({ zone }) => {
      deviceIsIn(zone);
      deviceSpeaks('nl-BE');

      expect(dayLabel('2026-10-22')).toBe('22 Oct 2026');
    });

    it.each([
      { situation: 'nl-BE', languages: ['nl-BE'], reads: '22 Oct' },
      { situation: 'en-US', languages: ['en-US'], reads: 'Oct 22' },
    ])('the phone strip’s short label reads as $reads for $situation', ({ languages, reads }) => {
      deviceSpeaks(...languages);

      expect(shortDayLabel('2026-10-22', new Date(2026, 9, 22))).toBe(reads);
    });
  });
});
