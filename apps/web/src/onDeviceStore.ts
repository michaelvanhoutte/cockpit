import type { UseStore } from 'idb-keyval';

/**
 * The one way Cockpit opens an IndexedDB store on the device: the capture
 * outbox, kept recordings, saved reads and held shares ("Capture stops keeping notes while Cockpit is also open in a frozen background tab on Android: let go of the phone's storage when hidden, and pick it up on return", issue 1804). It is a drop-in
 * `UseStore` for idb-keyval's `get`/`set`/`values`/`del`, but where idb-keyval's
 * `createStore` keeps one connection for the life of the page, this one:
 *
 * - **opens on first use** and again on the next after it was closed - by the
 *   page being hidden, or by the browser;
 * - **closes when the page is hidden, frozen or leaving**, letting writes in flight
 *   finish first (a closing connection waits for its transactions);
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
  const [freezing, running] = [change(true), change(false)];
  // A page going into the back/forward cache, or about to be frozen, may not be told it is hidden first.
  for (const [target, event, then] of [
    [document, 'freeze', freezing],
    [window, 'pagehide', freezing],
    [document, 'resume', running],
    [window, 'pageshow', running],
    [document, 'visibilitychange', () => (document.visibilityState === 'hidden' ? leaveAll() : running())],
  ] as const)
    target.addEventListener(event, then);
}

export function createDeviceStore(database: string, storeName: string): UseStore {
  let connection: Promise<IDBDatabase> | null = null;
  /** Operations that have asked for the connection and not yet finished with it. */
  let using = 0;

  const close = () => {
    // `close()` lets transactions already started complete, then closes.
    void connection?.then((db) => db.close());
    connection = null;
  };
  stores.add(close);

  return async (mode, callback) => {
    using += 1;
    try {
      // A failed open is not kept: the next use tries again.
      connection ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onupgradeneeded = () => request.result.createObjectStore(storeName);
        request.onsuccess = () => {
          // The browser closing it (storage cleared, or the like) is not told to anyone else.
          request.result.onclose = () => (connection = null);
          resolve(request.result);
        };
        request.onerror = () => {
          connection = null;
          reject(request.error);
        };
      });
      // Nothing can close it between its opening and this, which are one run of microtasks.
      const db = await connection;
      return await callback(db.transaction(storeName, mode).objectStore(storeName));
    } finally {
      using -= 1;
      // A write made while hidden is the only thing that may hold the store open, and only until it is done.
      if (using === 0 && pageIsAway()) close();
    }
  };
}

// The few reads and writes the app makes, replacing idb-keyval's, whose default store keeps a connection open for good.
const answer = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Settles on the transaction, not the request: a write that aborted must not look kept. */
const kept = (things: IDBObjectStore) =>
  new Promise<void>((resolve, reject) => {
    things.transaction.oncomplete = () => resolve();
    things.transaction.onabort = () => reject(things.transaction.error);
  });

export const get = (key: IDBValidKey, store: UseStore) => store('readonly', (things) => answer(things.get(key)));
export const values = (store: UseStore) => store('readonly', (things) => answer(things.getAll()));
export const entries = <K extends IDBValidKey, V>(store: UseStore) =>
  store('readonly', async (things) => {
    const [keys, found] = await Promise.all([answer(things.getAllKeys()), answer(things.getAll())]);
    return keys.map((key, at): [K, V] => [key as K, found[at] as V]);
  });
export const set = (key: IDBValidKey, value: unknown, store: UseStore) =>
  store('readwrite', (things) => (things.put(value, key), kept(things)));
export const del = (key: IDBValidKey, store: UseStore) =>
  store('readwrite', (things) => (things.delete(key), kept(things)));
export const clear = (store: UseStore) => store('readwrite', (things) => (things.clear(), kept(things)));
