import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_SIZE } from '@cockpit/shared';
import { checkAttachmentFiles } from '../../src/attachmentQueue';

/**
 * L1: the check every attach path runs a file through (the Item's form, the
 * Capture form, a shared file). That each form really queues or uploads what
 * it accepts is in the component tests beside it.
 */
describe('Item editing', () => {
  describe('a Markdown or plain text file is attached like a PDF, under the same 25 MB limit', () => {
    it.each([
      { situation: 'a .md the device reports no type for', name: 'notes.md', type: '', taken: 'text/markdown' },
      { situation: 'a .markdown reported as a generic type', name: 'notes.markdown', type: 'application/octet-stream', taken: 'text/markdown' },
      { situation: 'a .txt the device reports no type for', name: 'log.txt', type: '', taken: 'text/plain' },
      { situation: 'a .txt reported as plain text', name: 'log.txt', type: 'text/plain', taken: 'text/plain' },
    ])('accepts $situation, carrying $taken on to the upload', async ({ name, type, taken }) => {
      const file = new File(['# Café — 東京'], name, { type });

      const { accepted, rejections } = checkAttachmentFiles([file]);

      expect(rejections).toEqual([]);
      expect(accepted.map((f) => [f.name, f.type])).toEqual([[name, taken]]);
      expect(await accepted[0]!.text()).toBe('# Café — 東京');
    });

    it('refuses a .txt over 25 MB, naming the limit', () => {
      const big = new File(['x'], 'huge.txt', { type: 'text/plain' });
      Object.defineProperty(big, 'size', { value: MAX_ATTACHMENT_SIZE + 1 });

      const { accepted, rejections } = checkAttachmentFiles([big]);

      expect(accepted).toEqual([]);
      expect(rejections).toEqual(['"huge.txt" is over the 25 MB limit.']);
    });

    it('refuses a file a name cannot vouch for, because the device reported a specific type', () => {
      const { accepted, rejections } = checkAttachmentFiles([new File(['<p>'], 'page.md', { type: 'text/html' })]);

      expect(accepted).toEqual([]);
      expect(rejections).toEqual(['"page.md" is not a kind of file Cockpit accepts.']);
    });

    it('leaves a file already of an accepted type as it is', () => {
      const photo = new File(['png'], 'photo.png', { type: 'image/png' });

      expect(checkAttachmentFiles([photo]).accepted[0]).toBe(photo);
    });
  });
});
