import { describe, expect, it } from 'vitest';
import { readNeedsNoting } from '../../../src/mcp/connected-apps.js';

/** L1: how often an app's last read is noted ("Read a Panel from an app allowed only to read, and open Capture from its address", issue 1445). */
describe('MCP connections', () => {
  describe('an app’s last read is noted at most every ten minutes, so a widget does not spend the day’s writes on it', () => {
    const AT = '2026-10-23T12:00:00.000Z';

    it.each([
      { situation: 'no read noted yet', last: null, noted: true },
      { situation: 'one noted that does not read as a time', last: 'yesterday-ish', noted: true },
      { situation: 'one noted a minute ago', last: '2026-10-23T11:59:00.000Z', noted: false },
      { situation: 'one noted nine minutes and fifty-nine seconds ago', last: '2026-10-23T11:50:01.000Z', noted: false },
      { situation: 'one noted ten minutes ago', last: '2026-10-23T11:50:00.000Z', noted: true },
    ])('notes it, or not, for $situation', ({ last, noted }) => {
      expect(readNeedsNoting(last, AT)).toBe(noted);
    });
  });
});
