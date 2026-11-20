import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_SIZE,
  THUMBNAIL_SIDE,
  attachmentContentTypeSchema,
  attachmentFilenameSchema,
  canBeThumbnail,
  resolveAttachmentType,
  thumbnailCopyTypeSchema,
  thumbnailSource,
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

/**
 * L1: "Item form: there is no way to mark which image stands for an Item" (issue
 * 1863). Which pictures may stand for an Item, and which part of one the small
 * copy is cut from, are pure decisions over a type and two numbers.
 */
describe('Item editing', () => {
  describe('only a picture can be an Item’s thumbnail', () => {
    it.each([
      { situation: 'a PNG', type: 'image/png', allowed: true },
      { situation: 'a JPEG', type: 'image/jpeg', allowed: true },
      { situation: 'a GIF', type: 'image/gif', allowed: true },
      { situation: 'a WebP', type: 'image/webp', allowed: true },
      { situation: 'a PDF', type: 'application/pdf', allowed: false },
      { situation: 'a clip', type: 'video/mp4', allowed: false },
      { situation: 'a text file', type: 'text/plain', allowed: false },
    ])('$situation is $allowed', ({ type, allowed }) => {
      expect(canBeThumbnail(type)).toBe(allowed);
    });

    it('makes its small copy a PNG, a JPEG or a WebP, never a GIF', () => {
      expect(thumbnailCopyTypeSchema.safeParse('image/webp').success).toBe(true);
      expect(thumbnailCopyTypeSchema.safeParse('image/gif').success).toBe(false);
    });
  });

  describe('the thumbnail is the largest centred square of the picture, scaled to 96 px', () => {
    it.each([
      { situation: 'a landscape 4000 × 3000', width: 4000, height: 3000, from: { x: 500, y: 0, side: 3000 } },
      { situation: 'a portrait 600 × 900', width: 600, height: 900, from: { x: 0, y: 150, side: 600 } },
      { situation: 'a square', width: 500, height: 500, from: { x: 0, y: 0, side: 500 } },
      { situation: 'a picture smaller than 96 px, scaled up', width: 40, height: 30, from: { x: 5, y: 0, side: 30 } },
      { situation: 'an odd-sized one, in whole pixels', width: 101, height: 50, from: { x: 25, y: 0, side: 50 } },
    ])('takes $situation from $from.x, $from.y, $from.side px square', ({ width, height, from }) => {
      expect(thumbnailSource(width, height)).toEqual(from);
    });

    it('is drawn at the side the copy has, which is 96 px', () => {
      expect(THUMBNAIL_SIDE).toBe(96);
    });
  });
});
