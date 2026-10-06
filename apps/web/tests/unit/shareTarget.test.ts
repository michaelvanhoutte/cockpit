import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_SIZE,
  SHARE_FAILED_ADDRESS,
  SHARE_HOLDING_DATABASE,
  SHARE_HOLDING_STORE,
  SHARE_TARGET_PATH,
} from '@cockpit/shared';
import { HOLDING_DATABASE, HOLDING_STORE } from '../../src/shares';
// The worker's own script, which cannot import anything: loading it is how a
// test reaches the logic it shares with the worker.
import '../../public/share-target-sw.js';

/**
 * L1 over the script the service worker imports, with storage at the edge
 * replaced: it is the one place a share is turned into what waits. That the
 * worker really answers the POST, and the page then claims it, is the browser
 * walk in tests/e2e/capture.test.ts and the Worker's own answer is
 * apps/api/tests/integration/http/share-target.test.ts.
 */
interface HeldShare {
  id: string;
  receivedAt: string;
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string; size: number; bytes: ArrayBuffer | null }[];
}
const script = (
  globalThis as unknown as {
    cockpitShareTarget: {
      SHARE_PATH: string;
      CAPTURE_ADDRESS: string;
      FAILED_ADDRESS: string;
      DATABASE: string;
      STORE: string;
      ALLOWED_TYPES: string[];
      MAX_FILE_SIZE: number;
      isAShare: (method: string, url: string, origin: string) => boolean;
      receive: (
        form: unknown,
        store: { put: (share: HeldShare) => Promise<void>; bytesHeld: () => Promise<number> },
        id: string,
        receivedAt: string,
      ) => Promise<string>;
    };
  }
).cockpitShareTarget;

/** A share's form as the platform hands it over: fields by name, files with their bytes. */
const formOf = (fields: { title?: string; text?: string; url?: string; files?: FakeFile[] }) => ({
  getAll: (name: string) =>
    name === 'files' ? (fields.files ?? []) : [fields[name as 'title' | 'text' | 'url']].filter((v) => v !== undefined),
});
interface FakeFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}
const aFile = (name: string, type: string, bytes = 'bytes'): FakeFile => {
  const buffer = new TextEncoder().encode(bytes).buffer as ArrayBuffer;
  return { name, type, size: buffer.byteLength, arrayBuffer: () => Promise.resolve(buffer) };
};
/** A file of a size that is claimed rather than allocated. */
const aBigFile = (name: string, type: string, size: number): FakeFile => ({
  name,
  type,
  size,
  arrayBuffer: () => Promise.reject(new Error('a refused file is never read')),
});
const text = (buffer: ArrayBuffer | null) => new TextDecoder().decode(buffer ?? new ArrayBuffer(0));

/** Storage as the worker's own would be: holding what was put, or refusing. */
const holding = (refuses = false, alreadyHeld = 0) => {
  const held: HeldShare[] = [];
  return {
    held,
    bytesHeld: () => Promise.resolve(alreadyHeld + held.reduce((sum, s) => sum + s.files.reduce((n, f) => n + (f.bytes?.byteLength ?? 0), 0), 0)),
    put: (share: HeldShare) => (refuses ? Promise.reject(new Error('quota')) : Promise.resolve(void held.push(share))),
  };
};
const share = (area: ReturnType<typeof holding>, fields: Parameters<typeof formOf>[0]) =>
  script.receive(formOf(fields), area, 'share-1', '2026-10-06T08:00:00.000Z');

describe('Capture', () => {
  describe('what is shared is kept on this device and Capture opens on it', () => {
    it('agrees with the rest of the app on where it is posted to and where it opens', () => {
      expect(script.SHARE_PATH).toBe(SHARE_TARGET_PATH);
      expect(script.CAPTURE_ADDRESS).toBe('/capture');
      expect(script.FAILED_ADDRESS).toBe(SHARE_FAILED_ADDRESS);
    });

    it('agrees with the page on where shares are held, and with Attachments on what is kept', () => {
      expect([script.DATABASE, script.STORE]).toEqual([SHARE_HOLDING_DATABASE, SHARE_HOLDING_STORE]);
      expect([HOLDING_DATABASE, HOLDING_STORE]).toEqual([SHARE_HOLDING_DATABASE, SHARE_HOLDING_STORE]);
      expect([...script.ALLOWED_TYPES].sort()).toEqual([...ATTACHMENT_CONTENT_TYPES].sort());
      expect(script.MAX_FILE_SIZE).toBe(MAX_ATTACHMENT_SIZE);
    });

    it.each([
      { situation: 'a POST to the share address of this app', method: 'POST', url: 'https://cockpit.test/share-target', is: true },
      { situation: 'a POST to the share address of another origin', method: 'POST', url: 'https://elsewhere.test/share-target', is: false },
      { situation: 'a visit to the share address', method: 'GET', url: 'https://cockpit.test/share-target', is: false },
      { situation: 'a POST to the script beside it', method: 'POST', url: 'https://cockpit.test/share-target-sw.js', is: false },
    ])('takes only a share posted to this app: $situation', ({ method, url, is }) => {
      expect(script.isAShare(method, url, 'https://cockpit.test')).toBe(is);
    });

    it.each([
      { situation: 'a type Attachments refuse', file: aFile('notes.txt', 'text/plain', 'secret') },
      { situation: 'a file over the cap', file: aBigFile('huge.png', 'image/png', MAX_ATTACHMENT_SIZE + 1) },
    ])('keeps $situation by name, type and size and no bytes, for Capture to refuse', async ({ file }) => {
      const area = holding();

      expect(await share(area, { files: [file, aFile('photo.png', 'image/png')] })).toBe('/capture');

      const kept = area.held[0]!.files;
      expect(kept.map((f) => [f.name, f.size, f.bytes === null])).toEqual([
        [file.name, file.size, true],
        ['photo.png', 5, false],
      ]);
    });

    it('opens Capture with the "couldn\'t receive" signal where what waits would pass the cap', async () => {
      const area = holding(false, 4 * MAX_ATTACHMENT_SIZE);

      const opened = await share(area, { files: [aFile('photo.png', 'image/png')] });

      expect(opened).toBe(SHARE_FAILED_ADDRESS);
      expect(area.held).toEqual([]);
    });

    it('holds one photo as one share with that file, and opens Capture', async () => {
      const area = holding();

      const opened = await share(area, { files: [aFile('photo.jpg', 'image/jpeg', 'jpeg bytes')] });

      expect(opened).toBe('/capture');
      expect(area.held).toHaveLength(1);
      expect(area.held[0]).toMatchObject({ id: 'share-1', receivedAt: '2026-10-06T08:00:00.000Z', text: '', url: '' });
      expect(area.held[0]!.files.map((f) => [f.name, f.type, text(f.bytes)])).toEqual([
        ['photo.jpg', 'image/jpeg', 'jpeg bytes'],
      ]);
    });

    it('holds several files shared together as one share holding all of them', async () => {
      const area = holding();

      await share(area, { files: [aFile('a.png', 'image/png'), aFile('b.pdf', 'application/pdf')] });

      expect(area.held).toHaveLength(1);
      expect(area.held[0]!.files.map((f) => f.name)).toEqual(['a.png', 'b.pdf']);
    });

    it.each([
      { situation: 'text only', fields: { text: 'Ask Ada about it' }, held: { text: 'Ask Ada about it', url: '', title: '', files: 0 } },
      { situation: 'a link only', fields: { url: 'https://example.com/a' }, held: { text: '', url: 'https://example.com/a', title: '', files: 0 } },
      {
        situation: 'a title, text, link and a file together',
        fields: { title: 'A page', text: 'Worth a read', url: 'https://example.com/a', files: [aFile('a.png', 'image/png')] },
        held: { text: 'Worth a read', url: 'https://example.com/a', title: 'A page', files: 1 },
      },
    ])('holds $situation with its words', async ({ fields, held }) => {
      const area = holding();

      expect(await share(area, fields)).toBe('/capture');

      expect(area.held).toHaveLength(1);
      const kept = area.held[0]!;
      expect({ text: kept.text, url: kept.url, title: kept.title, files: kept.files.length }).toEqual(held);
    });

    it.each([
      { situation: 'an empty form', fields: {} },
      { situation: 'blank words and a file with nothing in it', fields: { text: '  ', url: '', files: [aFile('', '', '')] } },
    ])('opens Capture and holds nothing where $situation is shared', async ({ fields }) => {
      const area = holding();

      expect(await share(area, fields)).toBe('/capture');

      expect(area.held).toEqual([]);
    });

    it('opens Capture with the "couldn\'t receive" signal where storage is refused', async () => {
      const area = holding(true);

      const opened = await share(area, { files: [aFile('photo.jpg', 'image/jpeg')] });

      expect(opened).toBe(SHARE_FAILED_ADDRESS);
      expect(area.held).toEqual([]);
    });
  });
});
