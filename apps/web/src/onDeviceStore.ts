import type { UseStore } from 'idb-keyval';

/**
 * The one way Cockpit opens an IndexedDB store on the device, and the few reads
 * and writes it makes there: the capture outbox, kept recordings, saved reads
 * and held shares ("Capture stops keeping notes while Cockpit is also open in a
 * frozen background tab on Android: let go of the phone's storage when hidden,
 * and pick it up on return", issue 1804). A `UseStore` of idb-keyval's shape,
 * but where its `createStore` keeps one connection for the life of the page,
 * this one:
 *
 * - **opens on first use** and again on the next after it was closed - by the
 *   page being hidden, or by the browser;
 * - **closes when the page is hidden, frozen or leaving**, letting writes in
 *   flight finish first (a closing connection waits for its transactions);
 * - **keeps no connection beyond a write made while hidden**.
 *
 * Why: Chrome freezes a background page, and a copy frozen holding a
 * connection with a transaction on it blocks every other copy's write to the
 * same store for as long as it lives. A copy with nothing open cannot.
 */

/** Everything this device has open, so one listener serves them all. */
const stores = new Set<() => void>();

/** Set by `freeze` and `pagehide`, cleared on coming back: a frozen page may still report itself visible. */
let frozen = false;

/** Whether this page is out of view or frozen, when a store keeps nothing open. Always false where there is no document. */
export function pageIsAway(): boolean {
  return frozen || globalThis.document?.visibilityState === 'hidden';
}

/** Whether this page is about to be, or is, frozen or discarded: when sending stops. Hidden alone is not. */
export function pageIsFrozen(): boolean {
  return frozen;
}

const listeners = new Set<(frozen: boolean) => void>();

/**
 * Told, after the page counts as frozen (`freeze`, `pagehide`) or as running again (`resume`, `pageshow`,
 * visible), so what is read inside the listener is already up to date.
 */
export function onPage(listener: (frozen: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// At load, so a page frozen before any store is used is still known.
if (typeof window !== 'undefined') {
  const leaveAll = () => {
    for (const leave of stores) leave();
  };
  const change = (to: boolean) => () => {
    frozen = to;
    if (to) leaveAll();
    for (const listener of [...listeners]) listener(to);
  };
  const freezing = change(true);
  const running = change(false);
  // A page going into the back/forward cache, or about to be frozen, may not be told it is hidden first.
  document.addEventListener('freeze', freezing);
  window.addEventListener('pagehide', freezing);
  document.addEventListener('resume', running);
  window.addEventListener('pageshow', running);
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? leaveAll() : running()));
}

export function createDeviceStore(database: string, storeName: string): UseStore {
  let connection: Promise<IDBDatabase> | null = null;
  /** Operations that have asked for the connection and not yet finished with it. */
  let using = 0;

  const close = () => {
    const closing = connection;
    connection = null;
    // `close()` lets transactions already started complete, then closes; a failed open has nothing to close.
    void closing?.then((db) => db.close(), () => undefined);
  };
  stores.add(close);

  const open = () => {
    const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
      // A connection that is gone or failed is not kept, but only if it is still the current one.
      const forget = () => {
        if (connection === opening) connection = null;
      };
      const request = indexedDB.open(database);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onsuccess = () => {
        // The browser closing it (storage cleared, or the like).
        request.result.onclose = forget;
        resolve(request.result);
      };
      request.onerror = () => {
        forget();
        reject(request.error);
      };
    });
    return (connection = opening);
  };

  return async (mode, callback) => {
    using += 1;
    try {
      for (let retried = false; ; retried = true) {
        const opening = (connection ??= open());
        const db = await opening;
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(storeName, mode);
        } catch (error) {
          // Closed under us without a word: open afresh, once.
          if (retried || !(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error;
          if (connection === opening) connection = null;
          continue;
        }
        return await callback(transaction.objectStore(storeName));
      }
    } finally {
      using -= 1;
      // A write made while hidden is the only thing that may hold the store open, and only until it is done.
      if (using === 0 && pageIsAway()) close();
    }
  };
}

const answer = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Settles on the transaction, not the request: a write that aborted must not look kept. */
export function settled<T>(transaction: IDBTransaction, result: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    transaction.oncomplete = () => resolve(result());
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('Not kept.'));
  });
}

export const get = (key: IDBValidKey, store: UseStore) => store('readonly', (things) => answer(things.get(key)));
export const values = (store: UseStore) => store('readonly', (things) => answer(things.getAll()));
export const entries = <K extends IDBValidKey, V>(store: UseStore) =>
  store('readonly', async (things) => {
    const [keys, found] = await Promise.all([answer(things.getAllKeys()), answer(things.getAll())]);
    return keys.map((key, at): [K, V] => [key as K, found[at] as V]);
  });
const write = (store: UseStore, change: (things: IDBObjectStore) => unknown) =>
  store('readwrite', (things) => (change(things), settled(things.transaction, () => undefined)));
export const set = (key: IDBValidKey, value: unknown, store: UseStore) => write(store, (things) => things.put(value, key));
export const del = (key: IDBValidKey, store: UseStore) => write(store, (things) => things.delete(key));
export const clear = (store: UseStore) => write(store, (things) => things.clear());
