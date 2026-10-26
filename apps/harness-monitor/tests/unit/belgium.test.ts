import { describe, expect, it } from 'vitest';
import { addDays, belgianDay, belgianDaySql, formatClock, formatClockMinutes, formatDate, formatDateTime, formatDay, formatDayMonth, nextRoundTime, offsetMs, startOfDay, weekStart } from '../../src/belgium';

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;

describe('Harness Monitor', () => {
  describe('every time it shows is Belgian time in Belgian format', () => {
    it.each([
      { situation: 'a summer afternoon', iso: '2026-10-22T13:05:00Z', dateTime: '22 Oct 2026, 15:05', date: '22 Oct 2026' },
      { situation: 'a time before midnight UTC that is already tomorrow in Brussels', iso: '2026-10-21T22:30:00Z', dateTime: '22 Oct 2026, 00:30', date: '22 Oct 2026' },
      { situation: 'a winter morning', iso: '2026-12-03T08:09:00Z', dateTime: '3 Dec 2026, 09:09', date: '3 Dec 2026' },
      { situation: 'the hour the clocks go forward', iso: '2026-03-29T01:00:00Z', dateTime: '29 Mar 2026, 03:00', date: '29 Mar 2026' },
    ])('$situation reads $dateTime', ({ iso, dateTime, date }) => {
      expect(formatDateTime(at(iso))).toBe(dateTime);
      expect(formatDate(at(iso))).toBe(date);
    });

    it('a Belgian day, kept as YYYY-MM-DD, reads as the same day written out', () => {
      expect(formatDay('2026-10-22')).toBe('22 Oct 2026');
      expect(formatDay('2026-12-03')).toBe('3 Dec 2026');
    });
  });

  describe('the day a request is counted on is the Belgian day of its exact time', () => {
    it.each([
      { situation: 'the last second before Brussels midnight in summer', iso: '2026-10-21T21:59:59Z', day: '2026-10-21' },
      { situation: 'the first second after it', iso: '2026-10-21T22:00:00Z', day: '2026-10-22' },
      { situation: 'the last second before Brussels midnight in winter', iso: '2026-12-03T22:59:59Z', day: '2026-12-03' },
      { situation: 'the first second after it', iso: '2026-12-03T23:00:00Z', day: '2026-12-04' },
    ])('$situation ($iso) is $day', ({ iso, day }) => {
      expect(belgianDay(at(iso))).toBe(day);
    });

    it('a Belgian day starts at its own midnight, one hour earlier in UTC in winter and two in summer, across the clock changes', () => {
      expect(new Date(startOfDay('2026-10-22')).toISOString()).toBe('2026-10-21T22:00:00.000Z');
      expect(new Date(startOfDay('2026-12-03')).toISOString()).toBe('2026-12-02T23:00:00.000Z');
      expect(new Date(startOfDay('2026-03-29')).toISOString()).toBe('2026-03-28T23:00:00.000Z');
      expect(new Date(startOfDay('2026-03-30')).toISOString()).toBe('2026-03-29T22:00:00.000Z');
      expect(new Date(startOfDay('2026-10-25')).toISOString()).toBe('2026-10-24T22:00:00.000Z');
      expect(new Date(startOfDay('2026-10-26')).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    });

    it('the clock-change rule behind the SQL agrees with the platform on both sides of every change from 2024 to 2099', () => {
      const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', hour: 'numeric', hourCycle: 'h23' });
      const wrong: string[] = [];
      for (let year = 2024; year <= 2099; year++) {
        for (const month of [2, 9]) {
          // The last Sunday of the month, 01:00 UTC: probe the minute before, the change itself, and a day either side.
          const lastDay = new Date(Date.UTC(year, month + 1, 0));
          const change = Date.UTC(year, month, lastDay.getUTCDate() - lastDay.getUTCDay(), 1);
          for (const t of [change - 60_000, change, change + 60_000, change - 24 * HOUR, change + 24 * HOUR, change + 22 * HOUR]) {
            if (Number(clock.format(t)) !== Math.floor(((t + offsetMs(t)) % (24 * HOUR)) / HOUR)) wrong.push(new Date(t).toISOString());
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it('the SQL names every clock change of those years', () => {
      const sql = belgianDaySql('occurred_at');

      expect(sql.match(/WHEN/g)).toHaveLength(76);
      expect(sql).toContain(`occurred_at >= ${Date.UTC(2026, 2, 29, 1)} AND occurred_at < ${Date.UTC(2026, 9, 25, 1)} THEN ${2 * HOUR}`);
    });
  });

  describe('weeks start on Monday', () => {
    it.each([
      { day: '2026-10-26', monday: '2026-10-26' },
      { day: '2026-10-25', monday: '2026-10-19' },
      { day: '2026-10-28', monday: '2026-10-26' },
    ])('$day is in the week of $monday', ({ day, monday }) => {
      expect(weekStart(day)).toBe(monday);
    });

    it('adding days is calendar arithmetic', () => {
      expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
      expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    });
  });

  describe('a strip’s clock times are Belgian clock times', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const ticksBetween = (from: string, to: string, step: number) => {
      const out: string[] = [];
      for (let t = nextRoundTime(at(from), step); t < at(to); t = nextRoundTime(t + 1, step)) out.push(iso(t));
      return out;
    };

    it.each([
      { situation: 'a summer afternoon', iso: '2026-10-22T13:05:09Z', clock: '15:05:09' },
      { situation: 'a time before midnight in Greenwich that is already tomorrow in Brussels', iso: '2026-10-21T22:30:00Z', clock: '00:30:00' },
      { situation: 'a winter morning', iso: '2026-12-03T08:09:00Z', clock: '09:09:00' },
    ])('$situation reads $clock, or without its seconds', ({ iso: instant, clock }) => {
      expect(formatClock(at(instant))).toBe(clock);
      expect(formatClockMinutes(at(instant))).toBe(clock.slice(0, 5));
    });

    it('writes a day without its year', () => {
      expect(formatDayMonth(at('2026-10-21T22:30:00Z'))).toBe('22 Oct');
    });

    it('finds the next whole hour in Brussels, not in Greenwich, for a step of several hours', () => {
      expect(iso(nextRoundTime(at('2026-10-22T13:05:00Z'), 3 * HOUR))).toBe('2026-10-22T16:00:00.000Z');
      expect(iso(nextRoundTime(at('2026-12-03T13:05:00Z'), 3 * HOUR))).toBe('2026-12-03T14:00:00.000Z');
    });

    it('returns an instant that is already round, and the next one after it', () => {
      expect(iso(nextRoundTime(at('2026-10-22T14:00:00Z'), HOUR))).toBe('2026-10-22T14:00:00.000Z');
      expect(iso(nextRoundTime(at('2026-10-22T14:00:00.001Z'), HOUR))).toBe('2026-10-22T15:00:00.000Z');
    });

    it('steps from one Belgian midnight to the next across the change of clock', () => {
      const first = nextRoundTime(at('2026-10-24T12:00:00Z'), 24 * HOUR);
      expect([first, nextRoundTime(first + 1, 24 * HOUR)].map(iso)).toEqual(['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);
    });

    it('ticks both 02:00s of the night the clocks go back, an hour apart', () => {
      expect(ticksBetween('2026-10-24T22:30:00Z', '2026-10-25T02:30:00Z', HOUR)).toEqual(['2026-10-24T23:00:00.000Z', '2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z', '2026-10-25T02:00:00.000Z']);
    });

    it('skips the time that does not exist the night the clocks go forward, so a two-hour step stays on even hours', () => {
      expect(ticksBetween('2026-03-28T22:30:00Z', '2026-03-29T03:30:00Z', 2 * HOUR)).toEqual(['2026-03-28T23:00:00.000Z', '2026-03-29T02:00:00.000Z']);
    });
  });
});
