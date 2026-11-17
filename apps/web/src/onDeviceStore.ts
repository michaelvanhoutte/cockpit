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
const stores = new Set<{ leave(): void }>();

/** Set by `freeze` and `pagehide`, cleared on coming back: a frozen page may still report itself visible. */
let frozen = false;

/** Whether this page is out of view or frozen, when a store keeps nothing open. Always false where there is no document. */
export function pageIsAway(): boolean {
  return typeof document !== 'undefined' && (frozen || document.visibilityState === 'hidden');
}

/** Whether this page is about to be, or is, frozen or discarded: when sending stops. Hidden alone is not. */
export function pageIsFrozen(): boolean {
  return frozen;
}

// At load, so a page frozen before any store is used is still known.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const leaveAll = () => {
    for (const store of stores) store.leave();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') leaveAll();
    else frozen = false;
  });
  // A page going into the back/forward cache, or about to be frozen, may not be told it is hidden first.
  window.addEventListener('pagehide', () => {
    frozen = true;
    leaveAll();
  });
  document.addEventListener('freeze', () => {
    frozen = true;
    leaveAll();
  });
  for (const back of ['resume', 'pageshow']) {
    (back === 'resume' ? document : window).addEventListener(back, () => {
      frozen = false;
    });
  }
}

export function createDeviceStore(database: string, storeName: string): UseStore {
  let connection: Promise<IDBDatabase> | null = null;
  /** Operations that have asked for the connection and not yet finished with it. */
  let using = 0;

  const close = () => {
    const closing = connection;
    connection = null;
    // `close()` lets transactions already started complete, then closes.
    void closing?.then((db) => db.close(), () => undefined);
  };

  /** The factory the connection came from: a different one (a test's fresh browser) is a different database. */
  let from: IDBFactory | null = null;

  const connect = (): Promise<IDBDatabase> => {
    if (connection && from !== indexedDB) close();
    if (connection) return connection;
    from = indexedDB;
    const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onsuccess = () => {
        const db = request.result;
        const gone = () => {
          if (connection === opening) connection = null;
        };
        // The browser closing it (storage cleared, or the like), or another copy asking to change it.
        db.onclose = gone;
        db.onversionchange = () => {
          gone();
          db.close();
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });
    connection = opening;
    // A failed open is not kept: the next use tries again.
    opening.catch(() => {
      if (connection === opening) connection = null;
    });
    return opening;
  };

  const transact = async <T>(
    mode: IDBTransactionMode,
    callback: (store: IDBObjectStore) => T | PromiseLike<T>,
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      const db = await connect();
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(storeName, mode);
      } catch (error) {
        // Closed under us, by the browser or by the page going away: open afresh, once.
        if (attempt === 0 && error instanceof DOMException && error.name === 'InvalidStateError') {
          if ((await connection?.catch(() => null)) === db) connection = null;
          continue;
        }
        throw error;
      }
      return callback(transaction.objectStore(storeName));
    }
  };

  const handle = { leave: close };

  const store: UseStore = async (mode, callback) => {
    stores.add(handle);
    using += 1;
    try {
      return await transact(mode, callback);
    } finally {
      using -= 1;
      // A write made while hidden is the only thing that may hold the store open, and only until it is done.
      if (using === 0 && pageIsAway()) close();
    }
  };
  return store;
}
