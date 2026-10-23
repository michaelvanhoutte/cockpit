import { afterEach, describe, expect, it, vi } from 'vitest';
import { deadlineOf, dueDateLabel, shortDueDateLabel } from '../../src/dueDate';
import { deviceSpeaks } from './support/timeZone';

describe('Triage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('a due date reads in the viewer’s own browser region', () => {
    // F1: formatting is a pure function of the date and the browser's
    // languages, which the test hands the device (`dateFormat.ts`).
    it.each([
      { situation: 'en-US', languages: ['en-US'], shows: 'Sep 30, 2026' },
      { situation: 'en-GB, day before month', languages: ['en-GB'], shows: '30 Sept 2026' },
    ])('shows $situation as $shows', ({ languages, shows }) => {
      deviceSpeaks(...languages);

      expect(dueDateLabel('2026-09-30')).toBe(shows);
    });

    it('resolves to the browser’s own languages when none is handed in', () => {
      expect(typeof dueDateLabel('2026-09-30')).toBe('string');
    });

    it('reads the stored calendar day regardless of region, never shifted by a negative-UTC-offset timezone', () => {
      // The `UTC` pin this carries is what keeps a date-only value from
      // shifting: without it, a timezone west of UTC would read this back as
      // 2025-12-31.
      deviceSpeaks('en-US');

      expect(dueDateLabel('2026-01-01')).toBe('Jan 1, 2026');
    });
  });

  describe('a picked day on a phone reads as day and month, with the year only when it is not this year', () => {
    // F1: a pure formatter of the date, today and the browser's region. "This
    // year" is the viewer's own calendar year, so today is built from local parts.
    const today = new Date(2026, 9, 13);
    it.each([
      { situation: 'a day this year', picked: '2026-10-29', reads: '29 Oct' },
      { situation: 'a day next year', picked: '2027-12-29', reads: '29 Dec 27' },
      { situation: '1 Jan next year, the day after this year ends', picked: '2027-01-01', reads: '1 Jan 27' },
      { situation: 'a day last year', picked: '2025-10-29', reads: '29 Oct 25' },
    ])('reads $situation as $reads', ({ picked, reads }) => {
      deviceSpeaks('en-GB');

      expect(shortDueDateLabel(picked, today)).toBe(reads);
    });

    it('reads 31 Dec of this year without the year', () => {
      deviceSpeaks('en-GB');

      expect(shortDueDateLabel('2026-12-31', today)).toBe('31 Dec');
    });
  });

  /**
   * The pill a row wears for how near its due date is. `now` is built from
   * local calendar parts, because "today" is the viewer's own day - the same
   * reason the Filter's windows are (`packages/shared/src/domain/filters.ts`) - so these read the same in
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
