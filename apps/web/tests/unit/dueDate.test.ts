import { describe, expect, it } from 'vitest';
import { deadlineOf, dueDateLabel } from '../../src/dueDate';

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

  /**
   * The pill a row wears for how near its due date is. `now` is built from
   * local calendar parts, because "today" is the viewer's own day - the same
   * reason the Filter's windows are (`filters.ts`) - so these read the same in
   * any timezone the suite runs in.
   */
  describe('a row’s pill says how near its due date is, calm at a distance and louder as it closes', () => {
    const NOW = new Date(2026, 8, 17, 15, 30).getTime();

    it('has no pill for an item with no due date', () => {
      expect(deadlineOf(null, NOW)).toBeNull();
    });

    it.each([
      { situation: 'ten days off', dueDate: '2026-09-27' },
      { situation: 'eight days off', dueDate: '2026-09-25' },
      { situation: 'months off', dueDate: '2027-01-01' },
    ])('has no pill while the deadline is $situation', ({ dueDate }) => {
      expect(deadlineOf(dueDate, NOW)).toBeNull();
    });

    it.each([
      { situation: 'seven days off', dueDate: '2026-09-24', level: 'week', label: 'Due in 7d' },
      { situation: 'three days off', dueDate: '2026-09-20', level: 'week', label: 'Due in 3d' },
      { situation: 'two days off', dueDate: '2026-09-19', level: 'near', label: 'Due in 2d' },
      { situation: 'tomorrow', dueDate: '2026-09-18', level: 'near', label: 'Due tomorrow' },
      { situation: 'today', dueDate: '2026-09-17', level: 'today', label: 'Due today' },
      { situation: 'yesterday', dueDate: '2026-09-16', level: 'over', label: 'Overdue 1d' },
      { situation: 'a week ago', dueDate: '2026-09-10', level: 'over', label: 'Overdue 7d' },
    ])('reads $situation as "$label"', ({ dueDate, level, label }) => {
      expect(deadlineOf(dueDate, NOW)).toEqual({ level, label });
    });

    it('goes on counting once it is overdue, without escalating past red', () => {
      expect(deadlineOf('2026-01-01', NOW)).toEqual({ level: 'over', label: 'Overdue 259d' });
    });

    // "Today" is the calendar day the viewer is looking from, not a span of
    // hours: a due day is still today at the very end of it, and only the next
    // calendar day makes it overdue.
    it.each([
      { situation: 'the first minute of its day', now: new Date(2026, 8, 17, 0, 1).getTime(), label: 'Due today' },
      { situation: 'the last minute of its day', now: new Date(2026, 8, 17, 23, 59).getTime(), label: 'Due today' },
      { situation: 'the first minute of the next day', now: new Date(2026, 8, 18, 0, 1).getTime(), label: 'Overdue 1d' },
    ])('reads a deadline of 2026-09-17 at $situation as "$label"', ({ now, label }) => {
      expect(deadlineOf('2026-09-17', now)?.label).toBe(label);
    });

    it('has no pill, rather than crashing, for a value that is not really a date', () => {
      expect(deadlineOf('not a date', NOW)).toBeNull();
    });
  });
});
