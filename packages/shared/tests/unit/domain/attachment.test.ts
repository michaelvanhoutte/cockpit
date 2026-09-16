import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_SIZE,
  attachmentContentTypeSchema,
  attachmentFilenameSchema,
} from '../../../src/domain/attachment.js';

/**
 * L1: which files are attachable, and which filenames are refused, are pure
 * decisions over a string. That the refusal is reachable through a real
 * upload, and comes back as a 400/413 rather than a 500, is proved at the
 * interface, in apps/api/tests/integration/http/attachments.test.ts.
 */
describe('Item editing', () => {
  describe('what may be attached to an item', () => {
    it.each([
      { situation: 'an image', type: 'image/png', accepted: true },
      { situation: 'a short clip', type: 'video/mp4', accepted: true },
      { situation: 'a document', type: 'application/pdf', accepted: true },
      { situation: 'a kind of file not on the allowlist', type: 'application/zip', accepted: false },
      { situation: 'nothing claimed at all', type: '', accepted: false },
    ])('$situation is $accepted', ({ type, accepted }) => {
      expect(attachmentContentTypeSchema.safeParse(type).success).toBe(accepted);
    });
  });

  describe('a filename is a single line', () => {
    it.each([
      { situation: 'an ordinary name', typed: 'receipt.png', accepted: true },
      { situation: 'a name broken over two lines', typed: 'receipt\n.png', accepted: false },
      { situation: 'an empty name', typed: '', accepted: false },
      { situation: 'a name at the 255-character cap', typed: `${'a'.repeat(251)}.png`, accepted: true },
      { situation: 'a name over the 255-character cap', typed: `${'a'.repeat(252)}.png`, accepted: false },
    ])('$situation is $accepted', ({ typed, accepted }) => {
      expect(attachmentFilenameSchema.safeParse(typed).success).toBe(accepted);
    });
  });

  it('caps a stored file at 25MB', () => {
    expect(MAX_ATTACHMENT_SIZE).toBe(25 * 1024 * 1024);
  });
});
