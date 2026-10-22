import { describe, expect, it } from 'vitest';
import { analyticsLink, usageWindow } from '../../../src/accounts/usage.js';
import { dayStartsAt } from '../../../src/domain/series.js';

/**
 * Unit level: what the window of days is, and what counts as a link. Reading
 * the history itself is a query and is settled against a real register at
 * apps/api/tests/integration/http/usage.test.ts.
 */

const NOW = new Date('2026-10-02T23:30:00.000Z');

describe('User management', () => {
  describe('the usage window covers a bounded number of whole days, today included, in UTC where no zone is asked', () => {
    it.each([
      { situation: 'nothing asked', asked: undefined, days: 30, since: '2026-09-03T00:00:00.000Z' },
      { situation: 'one day', asked: '1', days: 1, since: '2026-10-02T00:00:00.000Z' },
      { situation: 'a week', asked: '7', days: 7, since: '2026-09-26T00:00:00.000Z' },
      { situation: 'the longest there is', asked: '365', days: 365, since: '2025-10-03T00:00:00.000Z' },
      { situation: 'more than the history is kept for', asked: '5000', days: 365, since: '2025-10-03T00:00:00.000Z' },
      { situation: 'zero', asked: '0', days: 30, since: '2026-09-03T00:00:00.000Z' },
      { situation: 'a negative number', asked: '-4', days: 30, since: '2026-09-03T00:00:00.000Z' },
      { situation: 'part of a day', asked: '2.5', days: 30, since: '2026-09-03T00:00:00.000Z' },
      { situation: 'something that is not a number', asked: 'a lot', days: 30, since: '2026-09-03T00:00:00.000Z' },
      { situation: 'an empty value', asked: '', days: 30, since: '2026-09-03T00:00:00.000Z' },
    ])('is $days days for $situation', ({ asked, days, since }) => {
      const window = usageWindow(asked, NOW);

      expect(window).toMatchObject({ days, since });
      expect(window.dayStarts).toHaveLength(days);
    });

    it('counts days in UTC, whichever side of midnight the instant is', () => {
      expect(usageWindow('1', new Date('2026-10-02T00:00:00.000Z')).since).toBe('2026-10-02T00:00:00.000Z');
      expect(usageWindow('1', new Date('2026-10-01T23:59:59.999Z')).since).toBe('2026-10-01T00:00:00.000Z');
    });
  });

  describe('a year of days starts each where a search for that day alone finds it', () => {
    it.each([
      { situation: 'a zone whose clocks change in the small hours', zone: 'Europe/Brussels' },
      { situation: 'a zone whose clocks jump over midnight', zone: 'America/Havana' },
      { situation: 'another zone whose clocks jump over midnight', zone: 'Asia/Beirut' },
      { situation: 'a zone whose clocks change by half an hour', zone: 'Australia/Lord_Howe' },
      { situation: 'a zone with a half-hour offset and no change', zone: 'Asia/Kolkata' },
      { situation: 'a zone that skipped a day of the calendar', zone: 'Pacific/Apia', now: '2012-03-01T12:00:00.000Z' },
    ])('is the same for $situation', ({ zone, now = '2026-12-31T12:00:00.000Z' }) => {
      const { dayStarts } = usageWindow('365', new Date(now), zone);

      expect(dayStarts).toHaveLength(365);
      expect(dayStarts.map((one) => Date.parse(one.startsAt))).toEqual(dayStarts.map((one) => dayStartsAt(one.day, zone)));
    });
  });

  describe('the link to page traffic is only ever a web address', () => {
    it.each([
      { situation: 'an https address', configured: 'https://dash.cloudflare.com/a/web-analytics', link: 'https://dash.cloudflare.com/a/web-analytics' },
      { situation: 'one with spaces around it', configured: '  https://example.com/x  ', link: 'https://example.com/x' },
      { situation: 'nothing configured', configured: undefined, link: null },
      { situation: 'an empty value', configured: '', link: null },
      { situation: 'only spaces', configured: '   ', link: null },
      { situation: 'something that is not an address', configured: 'dashboard', link: null },
      { situation: 'a script address', configured: 'javascript:alert(1)', link: null },
      { situation: 'a data address', configured: 'data:text/html,hi', link: null },
    ])('is $link for $situation', ({ configured, link }) => {
      expect(analyticsLink(configured)).toBe(link);
    });
  });
});
