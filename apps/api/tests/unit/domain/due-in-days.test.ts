import { describe, expect, it } from 'vitest';
import { dueDateIsTheConnections, dueDateOnArrival, sourceDay } from '../../../src/domain/due-in-days.js';

/**
 * "Give each email a Gmail or Outlook connection brings in a due date a set
 * number of days out" (issue 1409): the arithmetic is pure, so it is proved
 * here; that the store writes it, and when, is
 * tests/integration/connectors/due-date-from-the-connection.test.ts.
 */
describe('Connector management', () => {
  describe('a connection that gives a due date gives every Item it brings in one, so many calendar days after the day it arrives', () => {
    it.each([
      { situation: 'three days on, within the month', arrives: '2026-10-22T09:00:00.000Z', zones: [], days: 3, due: '2026-10-25' },
      { situation: 'three days on, over the end of a month', arrives: '2026-10-30T09:00:00.000Z', zones: [], days: 3, due: '2026-11-02' },
      { situation: 'one day on, over the end of a year', arrives: '2026-12-31T09:00:00.000Z', zones: [], days: 1, due: '2027-01-01' },
      { situation: 'a year of days on, over a leap day', arrives: '2027-03-01T09:00:00.000Z', zones: [], days: 365, due: '2028-02-29' },
      {
        situation: 'arriving at 23:30 UTC with the latest capture in Brussels, counted from the next day',
        arrives: '2026-10-22T23:30:00.000Z',
        zones: ['Europe/Brussels'],
        days: 3,
        due: '2026-10-26',
      },
      {
        situation: 'arriving at 23:30 UTC with the latest capture in Los Angeles, counted from the same day',
        arrives: '2026-10-22T23:30:00.000Z',
        zones: ['America/Los_Angeles'],
        days: 3,
        due: '2026-10-25',
      },
      {
        situation: 'the latest capture zone being one this runtime cannot read, counted in the next one',
        arrives: '2026-10-22T23:30:00.000Z',
        zones: ['Mars/Olympus_Mons', 'Europe/Brussels'],
        days: 3,
        due: '2026-10-26',
      },
      {
        situation: 'no capture zone being known, counted from the UTC day',
        arrives: '2026-10-22T23:30:00.000Z',
        zones: [],
        days: 3,
        due: '2026-10-25',
      },
      {
        situation: 'only zones this runtime cannot read, counted from the UTC day',
        arrives: '2026-10-22T23:30:00.000Z',
        zones: ['Mars/Olympus_Mons'],
        days: 3,
        due: '2026-10-25',
      },
    ])('when $situation', ({ arrives, zones, days, due }) => {
      expect(dueDateOnArrival(arrives, zones, days)).toBe(due);
    });
  });

  describe('a due date is still the connection’s only while you have neither set nor cleared it and it is the one the connection gave', () => {
    it.each([
      { situation: 'it is the one the connection gave', item: { dueDate: '2026-10-25', dueDateChosenAt: null }, given: '2026-10-25', expected: true },
      { situation: 'a reading replaced it', item: { dueDate: '2026-10-30', dueDateChosenAt: null }, given: '2026-10-25', expected: false },
      { situation: 'you set it, to the date the connection gave', item: { dueDate: '2026-10-25', dueDateChosenAt: '2026-10-23T09:00:00.000Z' }, given: '2026-10-25', expected: false },
      { situation: 'you cleared it', item: { dueDate: null, dueDateChosenAt: '2026-10-23T09:00:00.000Z' }, given: '2026-10-25', expected: false },
      { situation: 'the connection gave none', item: { dueDate: '2026-10-25', dueDateChosenAt: null }, given: null, expected: false },
      { situation: 'it holds none and the connection gave none', item: { dueDate: null, dueDateChosenAt: null }, given: null, expected: false },
    ])('when $situation', ({ item, given, expected }) => {
      expect(dueDateIsTheConnections(item, given)).toBe(expected);
    });
  });
});

describe('Connector management', () => {
  describe('a day a source gives is taken only when it is a real calendar day', () => {
    it.each([
      { situation: 'a day', given: '2031-06-14', day: '2031-06-14' },
      { situation: 'a leap day', given: '2028-02-29', day: '2028-02-29' },
      { situation: 'a day that does not exist', given: '2031-02-30', day: null },
      { situation: 'a month that does not exist', given: '2031-13-01', day: null },
      { situation: 'a day without its leading zero', given: '2031-1-5', day: null },
      { situation: 'a day with a time on it', given: '2031-06-14T00:00:00Z', day: null },
      { situation: 'something that is not text', given: 20310614, day: null },
    ])('takes $situation as $day', ({ given, day }) => {
      expect(sourceDay(given)).toBe(day);
    });
  });
});
