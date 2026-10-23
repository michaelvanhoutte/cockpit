import { describe, expect, it } from 'vitest';
import { firstDayAfter, type RepeatFrequency } from '@cockpit/shared';
import { countedFrom, dayStartsAt, decideRepeat, masterContentOf, type SeriesRow } from '../../../src/domain/series.js';

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

  /** A Brussels series as its row holds it. */
  const aSeries = (over: Partial<SeriesRow>): SeriesRow => ({
    id: '018f0000-0000-7000-8000-000000000001',
    tenantId: 'account',
    frequency: 'monthly',
    nextOn: '2027-01-31',
    dueAfterDays: null,
    timeZone: 'Europe/Brussels',
    stoppedAt: null,
    anchorOn: null,
    lastOn: null,
    createdAt: '2027-01-01T09:00:00.000Z',
    updatedAt: '2027-01-01T09:00:00.000Z',
    ...over,
  });

  /** The day a series comes back on after the one it shows next. */
  const theDayAfter = (row: Pick<SeriesRow, 'anchorOn' | 'nextOn' | 'frequency'>) =>
    firstDayAfter(countedFrom(row), row.frequency, row.nextOn);

  describe('a repeating Item comes back on the rule it shows, after the day it shows next', () => {
    it.each([
      { situation: 'monthly from the 31st, on the last day of February, is the 31st again', frequency: 'monthly', anchorOn: '2027-01-31', nextOn: '2027-02-28', after: '2027-03-31' },
      { situation: 'set before the day it was set from was kept, from its Next on', frequency: 'monthly', anchorOn: null, nextOn: '2027-01-31', after: '2027-02-28' },
      { situation: 'weekly, its Next on moved to a Wednesday by an older Cockpit, on Wednesdays', frequency: 'weekly', anchorOn: '2027-11-01', nextOn: '2027-11-10', after: '2027-11-17' },
    ] as const)('$situation', ({ frequency, anchorOn, nextOn, after }) => {
      expect(theDayAfter({ frequency: frequency as RepeatFrequency, anchorOn, nextOn })).toBe(after);
    });
  });

  describe('a change to a repeating Item’s rule keeps the day it comes back on unless Next on is moved', () => {
    it.each([
      {
        situation: 'Daily turned Weekly on its Friday, started again after Never once that Friday has passed, comes back on the next Friday',
        own: { frequency: 'daily', anchorOn: '2027-11-01', nextOn: '2027-11-05', lastOn: '2027-11-04', stoppedAt: '2027-11-04T10:00:00.000Z' },
        sent: { frequency: 'weekly', nextOn: '2027-11-05' },
        issuedAt: '2027-11-10T09:00:00.000Z',
        nextOn: '2027-11-12',
      },
      {
        situation: 'Daily from the 31st turned Monthly on 28 February comes back on the 28th',
        own: { frequency: 'daily', anchorOn: '2027-01-31', nextOn: '2027-02-28', lastOn: '2027-02-27', stoppedAt: null },
        sent: { frequency: 'monthly', nextOn: '2027-02-28' },
        issuedAt: '2027-02-27T09:00:00.000Z',
        nextOn: '2027-02-28',
        after: '2027-03-28',
      },
      {
        situation: 'running, its day passed before it could come round, keeps that day so it still comes back',
        own: { frequency: 'weekly', anchorOn: '2027-11-05', nextOn: '2027-11-05', lastOn: null, stoppedAt: null },
        sent: { frequency: 'weekly', nextOn: '2027-11-05' },
        issuedAt: '2027-11-10T09:00:00.000Z',
        nextOn: '2027-11-05',
      },
      {
        situation: 'sent the evening before the day came round, from a tab that read before it did, keeps the day it moved to',
        own: { frequency: 'monthly', anchorOn: '2027-01-31', nextOn: '2027-03-31', lastOn: '2027-02-28', stoppedAt: null },
        sent: { frequency: 'monthly', nextOn: '2027-02-28' },
        // 23:59 in Brussels on the 27th.
        issuedAt: '2027-02-27T22:59:00.000Z',
        nextOn: '2027-03-31',
      },
      {
        situation: 'moved back to today, the day it came round, comes back today',
        own: { frequency: 'monthly', anchorOn: '2027-01-31', nextOn: '2027-03-31', lastOn: '2027-02-28', stoppedAt: null },
        sent: { frequency: 'monthly', nextOn: '2027-02-28' },
        issuedAt: '2027-02-28T10:00:00.000Z',
        nextOn: '2027-02-28',
      },
    ] as { situation: string; own: Partial<SeriesRow>; sent: { frequency: RepeatFrequency; nextOn: string }; issuedAt: string; nextOn: string; after?: string }[])('$situation', ({ own, sent, issuedAt, nextOn, after }) => {
      const decided = decideRepeat(
        aSeries(own),
        {
          commandId: '018f0000-0000-7000-8000-000000000002',
          issuedAt,
          workspaceId: 'ws',
          itemId: '018f0000-0000-7000-8000-000000000003',
          seriesId: '018f0000-0000-7000-8000-000000000001',
          repeat: { ...sent, dueAfterDays: 3, timeZone: 'Europe/Brussels' },
        },
        'account',
      );

      expect(decided).toMatchObject({ kind: 'write', row: { nextOn } });
      if (after !== undefined) expect(theDayAfter((decided as { row: SeriesRow }).row)).toBe(after);
    });
  });
});

describe('Item editing', () => {
  describe('a recurring item set from an Item is named as that Item’s row names it', () => {
    const item = { workspaceId: 'ws-1', description: 'Go through the open items', priority: 'high' as const };
    it.each([
      { situation: 'by its title', title: 'Weekly review', nextAction: 'Call the plumber', named: 'Weekly review' },
      { situation: 'with no title, by its next action on one line', title: '', nextAction: 'Call\nthe plumber', named: 'Call the plumber' },
      { situation: 'with only spaces for a title, by its next action', title: '  ', nextAction: 'Call the plumber', named: 'Call the plumber' },
      { situation: 'with neither, as Untitled', title: '', nextAction: null, named: 'Untitled' },
    ])('$situation', ({ title, nextAction, named }) => {
      expect(masterContentOf({ ...item, title, nextAction })).toEqual({
        workspaceId: 'ws-1',
        title: named,
        description: 'Go through the open items',
        priority: 'high',
      });
    });
  });
});
