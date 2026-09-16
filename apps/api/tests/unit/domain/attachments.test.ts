import { describe, expect, it } from 'vitest';
import { attachmentFromCommand, attachmentR2Key } from '../../../src/domain/attachments.js';

describe('Item editing', () => {
  describe("a file attached to an item is stored under an account- and item-scoped key", () => {
    it('joins the account, the item and the attachment, in that order', () => {
      expect(attachmentR2Key('tenant-default', 'item-1', 'attachment-1')).toBe(
        'tenant-default/item-1/attachment-1',
      );
    });
  });

  describe('the row an attached file writes', () => {
    it('carries what was uploaded, addressed at the key its bytes are stored under', () => {
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
});
