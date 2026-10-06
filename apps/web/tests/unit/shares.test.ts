import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { browserHoldingArea, whatArrived } from '../../src/shares';
import { useArrived } from '../../src/shareClaim';
import { aShare, aSharedPhoto as aPhoto, holdAShare, howManyAreHeld } from './support/shares';

/**
 * F1 over the page's side of the holding area, against a fake IndexedDB shaped
 * as the service worker's script writes it (public/share-target-sw.js). What the
 * form then draws is tests/unit/components/CaptureNote.test.tsx; whether the
 * page claims at all is tests/unit/pages/CapturePage.test.tsx.
 */
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('Capture', () => {
  describe('the Capture page puts what was shared on the note', () => {
    it('puts a held photo on the note as a file to queue', () => {
      const arrived = whatArrived([aShare({ files: [aPhoto()] })]);

      expect(arrived?.message).toBe('');
      expect(arrived?.files.map((f) => [f.name, f.type])).toEqual([['photo.png', 'image/png']]);
    });

    it.each([
      { situation: 'text and a link', share: { text: 'Worth a read', url: 'https://example.com/a' }, note: 'Worth a read\nhttps://example.com/a' },
      { situation: 'a title, text and a link', share: { title: 'A page', text: 'Worth a read', url: 'https://example.com/a' }, note: 'A page\nWorth a read\nhttps://example.com/a' },
      { situation: 'a link that begins as another link in the text does', share: { text: 'Worth a read https://example.com/page2', url: 'https://example.com/page' }, note: 'Worth a read https://example.com/page2\nhttps://example.com/page' },
      { situation: 'text that is a word of the title', share: { title: 'Great article about X', text: 'X' }, note: 'Great article about X\nX' },
      { situation: 'a link the text already holds', share: { text: 'Worth a read https://example.com/a', url: 'https://example.com/a' }, note: 'Worth a read https://example.com/a' },
    ])('puts $situation in the note, text first', ({ share, note }) => {
      expect(whatArrived([aShare(share)])?.message).toBe(note);
    });

    it('puts two shares on the one note, the earlier one first, with all their files', () => {
      const later = aShare({ id: 'b', receivedAt: '2026-10-06T09:00:00.000Z', text: 'second', files: [aPhoto('two.png')] });
      const earlier = aShare({ id: 'a', receivedAt: '2026-10-06T08:00:00.000Z', text: 'first', files: [aPhoto('one.png')] });

      const arrived = whatArrived([later, earlier]);

      expect(arrived?.message).toBe('first\n\nsecond');
      expect(arrived?.files.map((f) => f.name)).toEqual(['one.png', 'two.png']);
    });

    it('puts nothing on the note where nothing usable is held', () => {
      expect(whatArrived([])).toBeNull();
      expect(whatArrived([{ not: 'a share' }, aShare()])).toBeNull();
    });

    it('is emptied once claimed, so reading it again finds nothing', async () => {
      await holdAShare(aShare({ id: 'a', text: 'first' }));
      await holdAShare(aShare({ id: 'b', text: 'second' }));

      expect(await browserHoldingArea().takeAll()).toHaveLength(2);
      expect(await howManyAreHeld()).toBe(0);
    });

    it.each([
      { situation: 'is refused', area: () => ({ takeAll: () => Promise.reject(new Error('refused')), empty: async () => {} }) },
      {
        situation: 'is not there at all',
        area: () => {
          throw new ReferenceError('indexedDB is not defined');
        },
      },
    ])('puts nothing on the note, and says nothing, where the browser\'s storage $situation', async ({ area }) => {
      const { result } = renderHook(() => useArrived(true, area));

      // Past the claim, which a refusal answers by finding nothing.
      await waitFor(() => expect(result.current.arrived).toBeNull());
    });

    it('keeps a file the Attachment rules refuse, without its bytes, to be refused as a drop is', () => {
      const arrived = whatArrived([aShare({ files: [{ name: 'huge.png', type: 'image/png', size: 30_000_000, bytes: null }] })]);

      expect(arrived?.files.map((f) => [f.name, f.size])).toEqual([['huge.png', 30_000_000]]);
    });
  });

  describe('a share is never lost to signing in, and signing out removes it', () => {
    afterEach(() => vi.restoreAllMocks());

    it('hands over nothing, and keeps what is held, where the clear is aborted', async () => {
      await holdAShare(aShare({ text: 'Worth a read' }));
      vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore) {
        this.transaction.abort();
        return undefined as never;
      });

      await expect(browserHoldingArea().takeAll()).rejects.toBeDefined();

      vi.restoreAllMocks();
      expect(await howManyAreHeld()).toBe(1);
    });

    it('settles, as a refusal, where emptying is aborted, so signing out is not left waiting', async () => {
      await holdAShare(aShare());
      vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore) {
        this.transaction.abort();
        return undefined as never;
      });

      await expect(browserHoldingArea().empty()).rejects.toBeDefined();
    });
  });
});
