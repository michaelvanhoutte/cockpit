import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { del, get, set, values } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserOutboxStore } from '../../src/captureOutboxSender';
import { browserRecordingStore } from '../../src/keptRecordings';
import { createDeviceStore } from '../../src/onDeviceStore';
import { saveRead } from '../../src/persistence';
import { browserHoldingArea } from '../../src/shares';

/**
 * L1 over the one lifecycle every on-device store goes through, against an
 * in-memory IndexedDB with no page behind it ("Capture stops keeping notes while Cockpit is also open in a frozen background tab on Android: let go of the phone's storage when hidden, and pick it up on return", issue 1804).
 * That sending lets go of its turn is tests/unit/captureOutboxSender.test.tsx.
 */

/** Every connection opened since the case began, and whether it has been closed. */
let connections: { db: IDBDatabase; closed: boolean }[] = [];

function watchConnections() {
  const real = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
    const request = real(...args);
    request.addEventListener('success', () => {
      const entry = { db: request.result, closed: false };
      const close = request.result.close.bind(request.result);
      request.result.close = () => {
        entry.closed = true;
        close();
      };
      connections.push(entry);
    });
    return request;
  });
}

const stillOpen = () => connections.filter((one) => !one.closed).length;

/** Lets every pending IndexedDB step run. */
async function settled() {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

function theTab(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  connections = [];
  watchConnections();
});

afterEach(() => {
  vi.restoreAllMocks();
  // A case that failed before its own `resume` must not leave the page frozen for the next.
  document.dispatchEvent(new Event('resume'));
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('Offline', () => {
  describe('a copy of Cockpit out of view holds no connection to the phone’s storage beyond the write that needs it', () => {
    it('lets go of it when the page is hidden with nothing being written', async () => {
      const store = createDeviceStore('db', 'things');
      await set('a', 1, store);
      expect(stillOpen()).toBe(1);

      theTab('hidden');
      await settled();

      expect(stillOpen()).toBe(0);
    });

    it('finishes a write in flight when the page is hidden, then lets go', async () => {
      const store = createDeviceStore('db', 'things');
      await set('seed', 0, store);

      await store('readwrite', (things) => {
        const put = things.put('kept', 'a');
        // Hidden with the transaction started and not yet complete.
        theTab('hidden');
        return new Promise<void>((resolve, reject) => {
          put.transaction!.oncomplete = () => resolve();
          put.transaction!.onerror = () => reject(put.transaction!.error);
        });
      });
      await settled();

      expect(stillOpen()).toBe(0);
      theTab('visible');
      expect(await get('a', store)).toBe('kept');
    });

    it('keeps a write asked for while hidden, and leaves no connection open after it', async () => {
      const store = createDeviceStore('db', 'things');
      theTab('hidden');

      await set('a', 'kept', store);
      await settled();

      expect(stillOpen()).toBe(0);
      theTab('visible');
      expect(await get('a', store)).toBe('kept');
    });

    it.each([
      { situation: 'the page is about to be frozen', event: () => document.dispatchEvent(new Event('freeze')) },
      { situation: 'the page is leaving', event: () => window.dispatchEvent(new Event('pagehide')) },
    ])('lets go of it when $situation, whatever the page says it is', async ({ event }) => {
      const store = createDeviceStore('db', 'things');
      await set('a', 1, store);

      event();
      await settled();

      expect(stillOpen()).toBe(0);
      // Back: a frozen page that is resumed is in use again.
      document.dispatchEvent(new Event('resume'));
      await set('b', 2, store);
      expect(stillOpen()).toBe(1);
    });
  });

  describe('a copy back in view reads and writes again without a reload', () => {
    it('opens a fresh connection for the next write and read after being hidden and shown', async () => {
      const store = createDeviceStore('db', 'things');
      await set('a', 'before', store);
      theTab('hidden');
      await settled();
      theTab('visible');

      await set('b', 'after', store);

      expect(await get('b', store)).toBe('after');
      expect(await values(store)).toEqual(['before', 'after']);
      expect(connections).toHaveLength(2);
      expect(stillOpen()).toBe(1);
    });

    it.each([
      { situation: 'and said so', told: true },
      { situation: 'without a word', told: false },
    ])('opens a new connection rather than failing when the browser closed it meanwhile, $situation', async ({ told }) => {
      const store = createDeviceStore('db', 'things');
      await set('a', 'before', store);
      const [first] = connections;
      first!.db.close();
      if (told) first!.db.onclose?.(new Event('close'));

      await set('b', 'after', store);
      await del('a', store);

      expect(await values(store)).toEqual(['after']);
      expect(connections).toHaveLength(2);
    });
  });

  describe('every store Cockpit keeps on the phone goes through that lifecycle', () => {
    const entry = { id: 'e1', owner: 'u', v: 1 } as never;
    it.each([
      {
        situation: 'the capture outbox',
        write: () => browserOutboxStore().put(entry),
      },
      {
        situation: 'recordings kept to retry',
        write: () => browserRecordingStore().put({ id: 'r1' } as never),
      },
      {
        situation: 'saved reads',
        write: () => saveRead({ queryKey: ['workspaces'], data: [], savedAt: 1 }),
      },
      {
        situation: 'shares held for Capture',
        write: () => browserHoldingArea().empty(),
      },
    ])('$situation lets go when hidden and opens again when used', async ({ write }) => {
      await write();
      expect(stillOpen()).toBe(1);

      theTab('hidden');
      await settled();
      expect(stillOpen()).toBe(0);

      theTab('visible');
      await write();
      expect(connections).toHaveLength(2);
      expect(stillOpen()).toBe(1);
    });
  });
});
