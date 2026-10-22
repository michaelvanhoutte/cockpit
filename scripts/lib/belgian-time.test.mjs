import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addDays,
  belgianDay,
  dayStartsBetween,
  formatClock,
  formatClockMinutes,
  formatDate,
  formatDateTime,
  formatDayMonth,
  nextRoundTime,
  offsetMs,
  startOfDay,
} from './belgian-time.mjs';

const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();

describe('Published harness reports', () => {
  describe('every moment is written in Belgian time and format', () => {
    for (const { situation, utc, dateTime, date, clock } of [
      { situation: 'a summer afternoon', utc: '2026-10-22T13:05:09Z', dateTime: '22 Oct 2026, 15:05', date: '22 Oct 2026', clock: '15:05:09' },
      { situation: 'a time before midnight in Greenwich that is already tomorrow in Brussels', utc: '2026-10-21T22:30:00Z', dateTime: '22 Oct 2026, 00:30', date: '22 Oct 2026', clock: '00:30:00' },
      { situation: 'a winter morning', utc: '2026-12-03T08:09:00Z', dateTime: '3 Dec 2026, 09:09', date: '3 Dec 2026', clock: '09:09:00' },
      { situation: 'the minute the clocks go forward', utc: '2026-03-29T01:00:00Z', dateTime: '29 Mar 2026, 03:00', date: '29 Mar 2026', clock: '03:00:00' },
    ]) {
      it(`${situation} reads ${dateTime}`, () => {
        for (const instant of [utc, new Date(utc), at(utc)]) {
          assert.equal(formatDateTime(instant), dateTime);
          assert.equal(formatDate(instant), date);
          assert.equal(formatClock(instant), clock);
        }
        assert.equal(formatClockMinutes(utc), clock.slice(0, 5));
      });
    }

    it('writes a day without its year', () => {
      assert.equal(formatDayMonth('2026-10-21T22:30:00Z'), '22 Oct');
    });
  });

  describe('a day turns at Belgian midnight, 23 or 25 hours long across a change of clock', () => {
    it('starts a day at 22:00 UTC the evening before in summer and 23:00 in winter', () => {
      assert.equal(iso(startOfDay('2026-10-22')), '2026-10-21T22:00:00.000Z');
      assert.equal(iso(startOfDay('2026-12-03')), '2026-12-02T23:00:00.000Z');
    });

    it('is 25 hours long on 25 Oct 2026 and 23 on 29 Mar 2026', () => {
      assert.equal((startOfDay('2026-10-26') - startOfDay('2026-10-25')) / 3_600_000, 25);
      assert.equal((startOfDay('2026-03-30') - startOfDay('2026-03-29')) / 3_600_000, 23);
    });

    it('names the Belgian day an instant falls on', () => {
      assert.equal(belgianDay('2026-10-21T21:59:59Z'), '2026-10-21');
      assert.equal(belgianDay('2026-10-21T22:00:00Z'), '2026-10-22');
      assert.equal(belgianDay('2026-12-03T22:59:59Z'), '2026-12-03');
      assert.equal(belgianDay('2026-12-03T23:00:00Z'), '2026-12-04');
    });

    it('lists the midnights inside a range, none before its start', () => {
      assert.deepEqual(dayStartsBetween(at('2026-10-24T12:00:00Z'), at('2026-10-27T12:00:00Z')).map(iso), ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', '2026-10-26T23:00:00.000Z']);
      assert.deepEqual(dayStartsBetween(at('2026-10-21T22:00:00Z'), at('2026-10-21T23:00:00Z')).map(iso), ['2026-10-21T22:00:00.000Z']);
      assert.deepEqual(dayStartsBetween(at('2026-10-21T22:00:01Z'), at('2026-10-22T10:00:00Z')), []);
    });

    it('counts calendar days, so a change of clock never moves one', () => {
      assert.equal(addDays('2026-10-24', 2), '2026-10-26');
      assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    });
  });

  describe('a tick falls on a round time on the Belgian clock', () => {
    it('reads the offset in force: an hour in winter, two in summer', () => {
      assert.equal(offsetMs('2026-12-03T08:09:00Z'), 3_600_000);
      assert.equal(offsetMs('2026-10-22T13:05:00Z'), 7_200_000);
    });

    it('finds the next whole hour in Brussels, not in Greenwich, for a step of several hours', () => {
      assert.equal(iso(nextRoundTime(at('2026-10-22T13:05:00Z'), 3 * 3_600_000)), '2026-10-22T16:00:00.000Z');
      assert.equal(iso(nextRoundTime(at('2026-12-03T13:05:00Z'), 3 * 3_600_000)), '2026-12-03T14:00:00.000Z');
    });

    it('returns an instant that is already round, and the next one after it', () => {
      assert.equal(iso(nextRoundTime(at('2026-10-22T14:00:00Z'), 3_600_000)), '2026-10-22T14:00:00.000Z');
      assert.equal(iso(nextRoundTime(at('2026-10-22T14:00:00.001Z'), 3_600_000)), '2026-10-22T15:00:00.000Z');
    });

    it('steps from one Belgian midnight to the next across the change of clock', () => {
      const day = 24 * 3_600_000;
      const first = nextRoundTime(at('2026-10-24T12:00:00Z'), day);
      const second = nextRoundTime(first + 1, day);
      assert.deepEqual([first, second].map(iso), ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);
    });
  });
});
