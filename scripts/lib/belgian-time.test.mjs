import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatDate } from './belgian-time.mjs';

describe('The published architecture page', () => {
  describe('every day is written in Belgian time and format', () => {
    for (const { situation, utc, date } of [
      { situation: 'a summer afternoon', utc: '2026-10-22T13:05:09Z', date: '22 Oct 2026' },
      { situation: 'a time before midnight in Greenwich that is already tomorrow in Brussels', utc: '2026-10-21T22:30:00Z', date: '22 Oct 2026' },
      { situation: 'a winter evening still today in Brussels', utc: '2026-12-03T22:59:59Z', date: '3 Dec 2026' },
      { situation: 'the minute the clocks go forward', utc: '2026-03-29T01:00:00Z', date: '29 Mar 2026' },
    ]) {
      it(`${situation} reads ${date}`, () => {
        for (const instant of [utc, new Date(utc), Date.parse(utc)]) assert.equal(formatDate(instant), date);
      });
    }
  });
});
