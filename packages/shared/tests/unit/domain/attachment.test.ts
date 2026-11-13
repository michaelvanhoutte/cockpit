import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_SIZE,
  attachmentContentTypeSchema,
  attachmentFilenameSchema,
  resolveAttachmentType,
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
      { situation: 'a Markdown file', type: 'text/markdown', accepted: true },
      { situation: 'a plain text file', type: 'text/plain', accepted: true },
      { situation: 'a web page', type: 'text/html', accepted: false },
      { situation: 'a kind of file not on the allowlist', type: 'application/zip', accepted: false },
      { situation: 'nothing claimed at all', type: '', accepted: false },
    ])('$situation is $accepted', ({ type, accepted }) => {
      expect(attachmentContentTypeSchema.safeParse(type).success).toBe(accepted);
    });
  });

  describe('a file is taken as Markdown or plain text by its name only when the device reports no useful type', () => {
    it.each([
      { situation: 'notes.md reported as no type', name: 'notes.md', reported: '', taken: 'text/markdown' },
      { situation: 'notes.md reported as a generic type', name: 'notes.md', reported: 'application/octet-stream', taken: 'text/markdown' },
      { situation: 'notes.markdown reported as text/x-markdown', name: 'notes.markdown', reported: 'text/x-markdown', taken: 'text/markdown' },
      { situation: 'notes.md reported as plain text', name: 'notes.md', reported: 'text/plain', taken: 'text/markdown' },
      { situation: 'log.txt reported as plain text', name: 'log.txt', reported: 'text/plain', taken: 'text/plain' },
      { situation: 'log.txt reported as no type', name: 'log.txt', reported: '', taken: 'text/plain' },
      { situation: 'log.txt reported as a generic type', name: 'log.txt', reported: 'application/octet-stream', taken: 'text/plain' },
      { situation: 'NOTES.MD in capitals reported as no type', name: 'NOTES.MD', reported: '', taken: 'text/markdown' },
      { situation: 'a PNG reported as an image', name: 'photo.png', reported: 'image/png', taken: 'image/png' },
    ])('$situation is taken as $taken', ({ name, reported, taken }) => {
      expect(resolveAttachmentType(name, reported)).toBe(taken);
    });

    it.each([
      { situation: 'page.md reported as a web page', name: 'page.md', reported: 'text/html' },
      { situation: 'notes with no extension reported as no type', name: 'notes', reported: '' },
      { situation: 'log.txt reported as Markdown', name: 'log.txt', reported: 'text/markdown' },
    ])('leaves $situation as the device reported it, which is refused or kept as it was', ({ name, reported }) => {
      expect(resolveAttachmentType(name, reported)).toBe(reported);
      expect(attachmentContentTypeSchema.safeParse(resolveAttachmentType(name, reported)).success).toBe(
        reported === 'text/markdown',
      );
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
