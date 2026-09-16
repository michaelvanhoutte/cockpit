import { describe, expect, it } from 'vitest';
import { attachmentFromCommand, attachmentR2Key, inGroupsOf } from '../../../src/domain/attachments.js';

describe('Item editing', () => {
  describe("a file attached to an item is stored under an account- and item-scoped key", () => {
    it('joins the account, the item and the attachment, in that order', () => {
      expect(attachmentR2Key('tenant-default', 'item-1', 'attachment-1')).toBe(
        'tenant-default/item-1/attachment-1',
      );
    });
  });

  describe('the row an attached file writes', () => {
    it('carries what was attached, addressed at the key its bytes are stored under', () => {
      const row = attachmentFromCommand(
        {
          commandId: 'command-1',
          issuedAt: '2026-09-16T10:00:00.000Z',
          workspaceId: 'ws-1',
          attachmentId: 'attachment-1',
          itemId: 'item-1',
          filename: 'receipt.png',
          size: 1024,
          contentType: 'image/png',
        },
        'tenant-default',
      );

      expect(row).toEqual({
        id: 'attachment-1',
        tenantId: 'tenant-default',
        itemId: 'item-1',
        r2Key: 'tenant-default/item-1/attachment-1',
        filename: 'receipt.png',
        size: 1024,
        contentType: 'image/png',
        createdAt: '2026-09-16T10:00:00.000Z',
      });
    });
  });

  describe("resetting the guest account cleans up R2 in groups small enough for one call", () => {
    it.each([
      { situation: 'nothing to clean up', count: 0, sizes: [] },
      { situation: 'fewer than one group', count: 3, sizes: [3] },
      { situation: 'exactly one group', count: 4, sizes: [4] },
      { situation: 'one more than a group holds', count: 5, sizes: [4, 1] },
      { situation: 'exactly two groups', count: 8, sizes: [4, 4] },
    ])('$situation ($count keys) makes groups sized $sizes', ({ count, sizes }) => {
      const keys = Array.from({ length: count }, (_, i) => `key-${i}`);

      const groups = inGroupsOf(keys, 4);

      expect(groups.map((group) => group.length)).toEqual(sizes);
      expect(groups.flat()).toEqual(keys);
    });
  });
});
