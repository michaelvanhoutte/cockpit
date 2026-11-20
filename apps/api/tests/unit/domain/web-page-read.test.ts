import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import { applyPastedLinkRead, captureItem } from '../../../src/domain/items.js';

/**
 * L1: which Items a read page may be written onto ("Capture link summaries",
 * issue 1853): an Own note - typed, shared or captured over MCP - and never an
 * app's capture or an Item already read.
 */

const read = {
  commandId: '018f0000-0000-7000-8000-000000000001',
  workspaceId: 'ws-work',
  issuedAt: '2026-08-12T10:00:01.000Z',
  itemId: '018f0000-0000-7000-8000-000000000002',
  capturedFrom: { source: 'web', sourceId: 'abc', sourceLink: 'https://example.com/a', sender: 'example.com' },
  capturedMessage: 'https://example.com/a',
  texts: { title: 'The page', description: 'Gist.', readings: [] },
};
const note = (overrides: Partial<Item>): Item => ({
  ...captureItem(
    { commandId: read.commandId, workspaceId: 'ws-work', issuedAt: '2026-08-12T10:00:00.000Z', itemId: read.itemId, message: read.capturedMessage },
    'tenant',
  ),
  ...overrides,
});

describe('Capture', () => {
  describe('a read page is written onto an Own note once, and onto nothing else', () => {
    it.each([
      { situation: 'a typed note', item: note({}), becomes: 'web' },
      { situation: 'a note captured over MCP', item: note({ source: 'mcp', sourceId: 'client-1', sender: 'Claude' }), becomes: 'web' },
      { situation: 'an app’s capture', item: note({ source: 'gmail', sourceId: 'msg-1' }), becomes: null },
      { situation: 'a note already read', item: note({ source: 'web', sourceId: 'abc', sourceLink: 'https://example.com/a' }), becomes: null },
    ])('$situation', ({ item, becomes }) => {
      expect(applyPastedLinkRead(item, read)?.source ?? null).toBe(becomes);
    });

    it('names the site as the sender and the link as the source link, leaving the typed note', () => {
      expect(applyPastedLinkRead(note({ source: 'mcp', sourceId: 'client-1', sender: 'Claude' }), read)).toMatchObject({
        sender: 'example.com',
        sourceLink: 'https://example.com/a',
        capturedMessage: 'https://example.com/a',
        title: 'The page',
      });
    });
  });
});
