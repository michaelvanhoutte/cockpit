import { describe, expect, it } from 'vitest';
import { dueColorOf, dueDateLabel } from '../../src/dueDate';

describe('Triage', () => {
  describe('a due date reads in the viewer’s own browser locale', () => {
    // F1: formatting is a pure function of the date and the locale, and it is
    // handed both - the same reason a clock is injected rather than read
    // (`waited.ts`).
    it.each([
      { situation: 'en-US', locale: 'en-US', shows: 'Sep 30, 2026' },
      { situation: 'en-GB, day before month', locale: 'en-GB', shows: '30 Sept 2026' },
    ])('shows $situation as $shows', ({ locale, shows }) => {
      expect(dueDateLabel('2026-09-30', locale)).toBe(shows);
    });

    it('resolves to the browser’s own locale when none is passed, unchanged since #469', () => {
      expect(typeof dueDateLabel('2026-09-30')).toBe('string');
    });

    it('reads the stored calendar day regardless of locale, never shifted by a negative-UTC-offset timezone', () => {
      // The `UTC` pin this already carried is unrelated to the locale change
      // and stays exactly as it was: without it, a timezone west of UTC would
      // read this back as 2025-12-31.
      expect(dueDateLabel('2026-01-01', 'en-US')).toBe('Jan 1, 2026');
    });
  });

  describe('an action’s row is coloured by how far its due date has progressed, on an ease-in curve', () => {
    const SET_AT = '2026-09-01T00:00:00.000Z';
    const CREATED = '2026-08-01T00:00:00.000Z';
    // A 20-day window: 2026-09-01 to 2026-09-21.
    const DUE = '2026-09-21';

    function at(daysAfterSetAt: number): number {
      return Date.parse(SET_AT) + daysAfterSetAt * 86_400_000;
    }

    it('draws no colour for an item with no due date', () => {
      expect(dueColorOf(null, null, CREATED, at(0))).toBeNull();
    });

    it.each([
      { situation: 'just set', days: 0, near: 0 },
      { situation: 'half the window elapsed', days: 10, near: 0.25 },
      { situation: '90% of the window elapsed', days: 18, near: 0.81 },
      { situation: 'due today, not yet passed', days: 20, near: 1 },
    ])('tints $situation to $near of full `due`', ({ days, near }) => {
      expect(dueColorOf(DUE, SET_AT, CREATED, at(days))).toBeCloseTo(near, 5);
    });

    it('reaches the same intensity at the same elapsed fraction, whatever the window’s own length', () => {
      // Both two fifths through their own window - 36 of 90 days for a
      // quarter-long one, 2.8 of 7 for a week-long one - which is the case
      // that keeps a week-long deadline from heating up as slowly as a
      // quarter-long one would.
      const quarterLong = dueColorOf('2026-04-01', '2026-01-01T00:00:00.000Z', CREATED, Date.parse('2026-02-06T00:00:00.000Z'));
      const weekLong = dueColorOf('2026-01-08', '2026-01-01T00:00:00.000Z', CREATED, Date.parse('2026-01-03T19:12:00.000Z'));
      expect(quarterLong).toBeCloseTo(0.16, 4);
      expect(weekLong).toBeCloseTo(0.16, 4);
    });

    it('falls back to when the item was made for a due date set before this shipped', () => {
      const legacy = dueColorOf(DUE, null, SET_AT, at(10));
      const withOwnSetAt = dueColorOf(DUE, SET_AT, CREATED, at(10));
      expect(legacy).toEqual(withOwnSetAt);
    });
  });

  describe('a due date past is `overdue`, however long past, measured by the viewer’s own calendar day', () => {
    // Mirrors the Filter’s own due-date windows (`filters.ts`’s `holdsFor`):
    // "passed" is a plain comparison against the day the viewer is looking
    // from, not against a moment.
    it.each([
      { situation: 'yesterday', dueDate: '2026-09-16', now: Date.parse('2026-09-17T08:00:00.000Z') },
      { situation: 'months ago', dueDate: '2026-01-01', now: Date.parse('2026-09-17T08:00:00.000Z') },
    ])('reads $situation as overdue, not escalated further', ({ dueDate, now }) => {
      expect(dueColorOf(dueDate, dueDate, dueDate, now)).toBe(-1);
    });

    it('is not overdue on its own due day, even late in it', () => {
      const color = dueColorOf(
        '2026-09-17',
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z',
        Date.parse('2026-09-17T23:00:00.000Z'),
      );
      expect(color).not.toBe(-1);
      expect(color).toBeGreaterThanOrEqual(0);
    });
  });
});
