import { describe, expect, it } from 'vitest';
import { READ_PANELS_SCOPE, kindOfScope, scopeToGrant } from '../../../src/mcp/scope.js';
import { readNeedsNoting } from '../../../src/mcp/connected-apps.js';

/**
 * L1: what an app is allowed to be, from what it asks for ("Read a Panel from an
 * app allowed only to read, and open Capture from its address", issue 1445). That
 * a grant of either kind then reaches only its own addresses is
 * tests/integration/http/panel-reads-access.test.ts.
 */
describe('MCP connections', () => {
  describe('an app that asks to read your Panels is allowed that alone, and any other app is allowed to capture as it always was', () => {
    it.each([
      { situation: 'asks for nothing, as Claude does', asks: [], granted: [], kind: 'captures' },
      { situation: 'asks for a scope Cockpit has no use for', asks: ['offline_access'], granted: ['offline_access'], kind: 'captures' },
      { situation: 'asks to read your Panels', asks: [READ_PANELS_SCOPE], granted: [READ_PANELS_SCOPE], kind: 'reads-panels' },
      {
        situation: 'asks to read your Panels and for something else too',
        asks: ['offline_access', READ_PANELS_SCOPE, 'create_items'],
        granted: [READ_PANELS_SCOPE],
        kind: 'reads-panels',
      },
    ])('$situation', ({ asks, granted, kind }) => {
      expect(scopeToGrant(asks)).toEqual(granted);
      expect(kindOfScope(scopeToGrant(asks))).toBe(kind);
    });

    it('reads a grant made before the scope existed, which holds none, as one that captures', () => {
      expect(kindOfScope([])).toBe('captures');
    });
  });

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
