import { describe, expect, it } from 'vitest';
import {
  firstDayAfter,
  firstNextOn,
  readBack,
  repeatOf,
  repeatsTitle,
  ruleLabel,
  type RepeatRule,
  type Series,
} from '../../../src/domain/series.js';

/**
 * L1: how a repeat is said ("Set an Item to repeat from its form, and see the
 * rule on its row", issue 1406) - the line under the Repeats popover, the day
 * Next on starts from, and the row's hover - and the day it comes back on next
 * ("Bring a repeating Item back on its day", issue 1407). Pure: the days are
 * given, never read.
 */

const weekly: RepeatRule = { frequency: 'weekly', nextOn: '2026-11-02', dueAfterDays: 5 };

describe('Item editing', () => {
  describe('the read-back says the rule, the next day and the due day', () => {
    it.each<{ situation: string; rule: RepeatRule; says: string }>([
      { situation: 'weekly from a Monday, due 5 days on', rule: weekly, says: 'Weekly on Monday · next Mon 2 Nov · due Sat 7 Nov' },
      {
        situation: 'quarterly from the 1st of January',
        rule: { frequency: 'quarterly', nextOn: '2027-01-01', dueAfterDays: null },
        says: 'Quarterly on the 1st of Jan, Apr, Jul, Oct · next Fri 1 Jan',
      },
      {
        situation: 'quarterly from the middle of November',
        rule: { frequency: 'quarterly', nextOn: '2026-11-15', dueAfterDays: 0 },
        says: 'Quarterly on the 15th of Nov, Feb, May, Aug · next Sun 15 Nov · due Sun 15 Nov',
      },
      {
        situation: 'monthly from the 31st',
        rule: { frequency: 'monthly', nextOn: '2026-12-31', dueAfterDays: null },
        says: 'Monthly on the 31st · next Thu 31 Dec',
      },
      {
        situation: 'monthly from the 22nd, 2nd and 23rd, which take their own endings',
        rule: { frequency: 'monthly', nextOn: '2026-10-22', dueAfterDays: null },
        says: 'Monthly on the 22nd · next Thu 22 Oct',
      },
      {
        situation: 'yearly',
        rule: { frequency: 'yearly', nextOn: '2026-11-02', dueAfterDays: 14 },
        says: 'Yearly on 2 November · next Mon 2 Nov · due Mon 16 Nov',
      },
      {
        situation: 'daily',
        rule: { frequency: 'daily', nextOn: '2026-10-23', dueAfterDays: null },
        says: 'Daily · next Fri 23 Oct',
      },
      {
        situation: 'a due gap that crosses the month',
        rule: { frequency: 'weekly', nextOn: '2026-10-29', dueAfterDays: 7 },
        says: 'Weekly on Thursday · next Thu 29 Oct · due Thu 5 Nov',
      },
      {
        situation: 'a due gap that crosses into a fifth-digit year, which still reads as a day',
        rule: { frequency: 'weekly', nextOn: '9999-12-31', dueAfterDays: 1 },
        says: 'Weekly on Friday · next Fri 31 Dec · due Sat 1 Jan',
      },
      {
        situation: 'a year typed only as far as two digits, which keeps its own weekday',
        rule: { frequency: 'weekly', nextOn: '0050-01-01', dueAfterDays: null },
        says: 'Weekly on Saturday · next Sat 1 Jan',
      },
    ])('$situation', ({ rule, says }) => {
      expect(readBack(rule)).toBe(says);
    });

    it('leaves out the due part when no due gap is set', () => {
      expect(readBack({ ...weekly, dueAfterDays: null })).not.toContain('due');
    });
  });

  describe('Next on starts one period from today', () => {
    it.each<{ situation: string; frequency: RepeatRule['frequency']; today: string; next: string }>([
      { situation: 'weekly picked on a Thursday', frequency: 'weekly', today: '2026-10-22', next: '2026-10-29' },
      { situation: 'daily', frequency: 'daily', today: '2026-10-31', next: '2026-11-01' },
      { situation: 'monthly picked on 31 January, which February cannot hold', frequency: 'monthly', today: '2026-01-31', next: '2026-02-28' },
      { situation: 'monthly picked on 31 January in a leap year', frequency: 'monthly', today: '2028-01-31', next: '2028-02-29' },
      { situation: 'quarterly across the end of the year', frequency: 'quarterly', today: '2026-11-30', next: '2027-02-28' },
      { situation: 'yearly picked on a leap day', frequency: 'yearly', today: '2028-02-29', next: '2029-02-28' },
    ])('$situation', ({ frequency, today, next }) => {
      expect(firstNextOn(today, frequency)).toBe(next);
    });
  });

  describe('a repeating Item comes back on the next day its rule counts from Next on, never on one already passed', () => {
    it.each<{ situation: string; frequency: RepeatRule['frequency']; from: string; after: string; next: string }>([
      { situation: 'weekly, the day after it came back', frequency: 'weekly', from: '2026-11-02', after: '2026-11-02', next: '2026-11-09' },
      { situation: 'daily', frequency: 'daily', from: '2026-11-02', after: '2026-11-02', next: '2026-11-03' },
      { situation: 'quarterly', frequency: 'quarterly', from: '2027-01-01', after: '2027-01-01', next: '2027-04-01' },
      { situation: 'yearly', frequency: 'yearly', from: '2026-11-02', after: '2026-11-02', next: '2027-11-02' },
      { situation: 'monthly on the 31st, in a month of 30 days', frequency: 'monthly', from: '2027-03-31', after: '2027-03-31', next: '2027-04-30' },
      { situation: 'monthly on the 31st, back on the 31st the month after', frequency: 'monthly', from: '2027-03-31', after: '2027-04-30', next: '2027-05-31' },
      { situation: 'quarterly on the 31st, through a short quarter', frequency: 'quarterly', from: '2027-01-31', after: '2027-04-30', next: '2027-07-31' },
      { situation: 'yearly on 29 February, in a year without one', frequency: 'yearly', from: '2028-02-29', after: '2028-02-29', next: '2029-02-28' },
      { situation: 'yearly on 29 February, back on it in the next leap year', frequency: 'yearly', from: '2028-02-29', after: '2031-02-28', next: '2032-02-29' },
      { situation: 'weekly, three weeks after a day missed', frequency: 'weekly', from: '2026-11-02', after: '2026-11-25', next: '2026-11-30' },
      { situation: 'weekly, on a day it comes round on', frequency: 'weekly', from: '2026-11-02', after: '2026-11-16', next: '2026-11-23' },
      { situation: 'monthly, years after the day it counts from', frequency: 'monthly', from: '2026-01-31', after: '2030-02-27', next: '2030-02-28' },
      { situation: 'daily, from a Next on still to come', frequency: 'daily', from: '2026-12-01', after: '2026-11-02', next: '2026-12-01' },
    ])('$situation', ({ frequency, from, after, next }) => {
      expect(firstDayAfter(from, frequency, after)).toBe(next);
    });
  });

  describe("a repeating row's hover names the rule, and a row that does not repeat has none", () => {
    it.each<{ situation: string; rule: RepeatRule; says: string }>([
      { situation: 'weekly from a Monday', rule: weekly, says: 'Repeats weekly on Monday' },
      { situation: 'daily', rule: { ...weekly, frequency: 'daily' }, says: 'Repeats daily' },
      { situation: 'yearly', rule: { ...weekly, frequency: 'yearly' }, says: 'Repeats yearly on 2 November' },
    ])('$situation', ({ rule, says }) => {
      expect(repeatsTitle(rule)).toBe(says);
      expect(ruleLabel(rule)).toBe(says.replace(/^Repeats (.)/u, (_all, first: string) => first.toUpperCase()));
    });

    const series: Series = {
      id: '018f0000-0000-7000-8000-000000000001',
      tenantId: 'tenant',
      ...weekly,
      timeZone: 'Europe/Brussels',
      stoppedAt: null,
    };

    it.each([
      { situation: 'an Item whose series is running', item: { seriesId: series.id }, series: [series], rule: weekly },
      { situation: 'an Item whose series is stopped', item: { seriesId: series.id }, series: [{ ...series, stoppedAt: '2026-10-22T10:00:00.000Z' }], rule: null },
      { situation: 'an Item that has never repeated', item: { seriesId: null }, series: [series], rule: null },
      { situation: 'an Item naming a series the Workspace does not carry', item: { seriesId: series.id }, series: [], rule: null },
    ])('reads $situation as its rule or none', ({ item, series: held, rule }) => {
      expect(repeatOf(item, held)).toEqual(rule);
    });
  });
});
