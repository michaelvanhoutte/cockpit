import { describe, expect, it } from 'vitest';
import { readCapture } from '../../../src/mcp/create-item.js';
import { MOST_FILE_BYTES_PER_CALL, bytesOf, readAddFiles, resolveRemovals } from '../../../src/mcp/files.js';
import { readUpdate } from '../../../src/mcp/update-item.js';

/**
 * L1: how the files an app sends are read against the form's own file types and
 * name rule and the per-call cap, before any byte is stored ("MCP changes and
 * deletes: add and remove files in create_item and update_item", issue 1813).
 * That a file lands on the Item and opens is
 * tests/integration/http/update-item-files.test.ts.
 */

const ID = '018f0000-0000-7000-8000-000000000001';
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const file = (name: string, content_type: string, bytes: Uint8Array = new Uint8Array([1, 2, 3, 4, 5])) => ({
  name,
  content_type,
  content_base64: b64(bytes),
});
/** A file of exactly `size` decoded bytes. */
const sized = (name: string, size: number) => file(name, 'application/pdf', new Uint8Array(size).fill(7));

describe('MCP connections', () => {
  describe('a file argument is read against the form’s types and the per-call cap, before any byte is stored', () => {
    it('accepts a PDF, a PNG and a Markdown file, each with its decoded size', () => {
      const read = readAddFiles([
        file('quote.pdf', 'application/pdf', new Uint8Array(10)),
        file('photo.png', 'image/png', new Uint8Array(3)),
        file('notes.md', 'text/markdown', new Uint8Array(7)),
      ]);

      expect(read).toMatchObject({ ok: true });
      if (!read.ok) return;
      expect(read.files.map((one) => [one.name, one.contentType, one.size])).toEqual([
        ['quote.pdf', 'application/pdf', 10],
        ['photo.png', 'image/png', 3],
        ['notes.md', 'text/markdown', 7],
      ]);
      expect(bytesOf(read.files[1]!.base64)).toEqual(new Uint8Array(3));
    });

    it('reads a Markdown name sent with no useful type as the form does', () => {
      const read = readAddFiles([file('notes.md', 'application/octet-stream')]);
      expect(read.ok && read.files[0]!.contentType).toBe('text/markdown');
    });

    it.each([
      { situation: 'a program', name: 'setup.exe', type: 'application/x-msdownload' },
      { situation: 'an archive', name: 'files.zip', type: 'application/zip' },
    ])('refuses $situation, with the types accepted', ({ name, type }) => {
      const read = readAddFiles([file(name, type)]);

      expect(read).toMatchObject({ ok: false });
      if (read.ok) return;
      expect(read.refusal).toContain(name);
      expect(read.refusal).toContain('application/pdf');
      expect(read.refusal).toContain('image/png');
    });

    it('refuses contents that are not base64, naming the file', () => {
      const read = readAddFiles([{ name: 'quote.pdf', content_type: 'application/pdf', content_base64: 'not base64 at all!' }]);
      expect(read).toEqual({ ok: false, refusal: 'The contents of "quote.pdf" are not base64.' });
    });

    it('refuses files whose decoded sizes add up to over 10 MB, and says nothing was added', () => {
      const half = MOST_FILE_BYTES_PER_CALL / 2;
      expect(readAddFiles([sized('a.pdf', half), sized('b.pdf', half)])).toMatchObject({ ok: true });

      const read = readAddFiles([sized('a.pdf', half), sized('b.pdf', half), sized('c.pdf', 1)]);

      expect(read).toMatchObject({ ok: false });
      if (read.ok) return;
      expect(read.refusal).toContain('10 MB');
      expect(read.refusal).toContain('Nothing was added');
    });

    it('refuses an empty file', () => {
      expect(readAddFiles([{ name: 'empty.pdf', content_type: 'application/pdf', content_base64: '' }])).toMatchObject({ ok: false });
      expect(readAddFiles([{ name: 'empty.pdf', content_type: 'application/pdf', content_base64: '====' }])).toMatchObject({ ok: false });
    });

    it('refuses a file name over the attachment name limit, and one over a line', () => {
      expect(readAddFiles([file(`${'a'.repeat(252)}.pdf`, 'application/pdf')])).toMatchObject({ ok: false });
      expect(readAddFiles([file('two\nlines.pdf', 'application/pdf')])).toMatchObject({ ok: false });
      expect(readAddFiles([file(`${'a'.repeat(251)}.pdf`, 'application/pdf')])).toMatchObject({ ok: true });
    });

    it('is read the same where update_item and create_item take it, so a bad file changes and captures nothing', () => {
      const bad = [file('setup.exe', 'application/zip')];

      expect(readUpdate({ id: ID, title: 'New title', add_files: bad })).toMatchObject({ ok: false });
      expect(readCapture({ message: 'Note', add_files: bad }, [])).toMatchObject({ ok: false });
      expect(readUpdate({ id: ID, add_files: [file('quote.pdf', 'application/pdf')], remove_files: ['old.pdf'] })).toMatchObject({
        ok: true,
        fields: { files: { add: [{ name: 'quote.pdf' }], remove: ['old.pdf'] } },
      });
    });
  });

  describe('a file to remove is found by the name find_items shows, among the files the item has', () => {
    const files = [
      { id: 'f1', filename: 'quote.pdf' },
      { id: 'f2', filename: 'photo.png' },
      { id: 'f3', filename: 'photo.png' },
    ];

    it('finds a name one file has', () => {
      expect(resolveRemovals(['quote.pdf'], files)).toEqual({ ok: true, remove: [{ id: 'f1', filename: 'quote.pdf' }] });
    });

    it('refuses a name the item has no file of, naming the files it has', () => {
      const found = resolveRemovals(['missing.pdf'], files);
      expect(found).toMatchObject({ ok: false });
      if (found.ok) return;
      expect(found.refusal).toContain('"quote.pdf", "photo.png", "photo.png"');
    });

    it('refuses a name two files share, so that none is removed', () => {
      const found = resolveRemovals(['quote.pdf', 'photo.png'], files);
      expect(found).toMatchObject({ ok: false });
      if (found.ok) return;
      expect(found.refusal).toContain('none was removed');
    });
  });
});
