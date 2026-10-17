import { useEffect, useState, type ReactNode } from 'react';
import { IsRestoringProvider, QueryClientProvider, hashKey, type Query, type QueryClient } from '@tanstack/react-query';
import { clear, createStore, del, entries, set, type UseStore } from 'idb-keyval';
import { checkSavedRead, hasCheck } from './savedReads';

/**
 * Where the reads this device saved live between visits (architecture, "The
 * read model: persisted snapshot, revalidate, push"): **one IndexedDB record
 * per read**, each with the time it was saved, replaced only when that same
 * read answers again. A Workspace opened last week is still there after a
 * visit that opened only another one.
 *
 * Its own database, apart from the capture outbox, kept recordings and held
 * shares, so wiping it at sign-out or on a new version never reaches a capture
 * still waiting to send.
 */
const DATABASE = 'cockpit-saved-reads';
const STORE = 'reads';

let store: UseStore | undefined;
const savedReads = () => (store ??= createStore(DATABASE, STORE));

/** The single whole-cache record earlier builds wrote, in idb-keyval's own default database. */
const OLD_SINGLE_RECORD = 'cockpit-query-cache-v1';

/** How long a saved read stays readable offline, counted from when it was saved. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SavedRead {
  queryKey: readonly unknown[];
  data: unknown;
  savedAt: number;
}

/** Saved only where `savedReads.ts` names the check it is restored through. */
function worthSaving(query: Query): boolean {
  return hasCheck(query.queryKey) && query.state.status === 'success';
}

/** What the last restore found, for the screens that say so. */
const restored = {
  /** By Workspace: when its drawn copy was saved, and how many Items it left out. */
  leftOut: new Map<string, { savedAt: number; count: number }>(),
  /** Query hashes of saved reads this version cannot convert. */
  unusable: new Set<string>(),
};

/**
 * How many Items the Workspace's copy on screen left out, as saved by an older
 * version - zero once the server has answered, since `dataUpdatedAt` then
 * moves past the saved time.
 */
export function itemsLeftOut(workspaceId: string, dataUpdatedAt: number): number {
  const found = restored.leftOut.get(workspaceId);
  return found && found.savedAt === dataUpdatedAt ? found.count : 0;
}

/** Whether this read was saved here but in a shape this version cannot draw. */
export function savedReadUnusable(queryKey: readonly unknown[]): boolean {
  return restored.unusable.has(hashKey(queryKey));
}

/**
 * Puts every saved read that converts into `client`, at the time it was saved.
 * Expired reads are deleted, as is the old single record. A read that does not
 * convert is left on disk to be replaced by its next answer, and remembered as
 * unusable for the screens that say so.
 */
export async function restoreSavedReads(client: QueryClient, now = Date.now()): Promise<void> {
  restored.leftOut.clear();
  restored.unusable.clear();
  try {
    await del(OLD_SINGLE_RECORD);
  } catch {
    // No usable IndexedDB: nothing was saved, so nothing to remove.
  }
  let found: [IDBValidKey, SavedRead][];
  try {
    found = await entries<IDBValidKey, SavedRead>(savedReads());
  } catch {
    return;
  }
  for (const [hash, read] of found) {
    if (now - read.savedAt > CACHE_MAX_AGE_MS) {
      void del(hash, savedReads()).catch(() => {});
      continue;
    }
    const checked = checkSavedRead(read.queryKey, read.data);
    if (checked === 'unchecked') continue;
    if (checked === 'unusable') {
      restored.unusable.add(String(hash));
      continue;
    }
    client.setQueryData(read.queryKey, checked.data, { updatedAt: read.savedAt });
    if (read.queryKey[0] === 'snapshot' && checked.itemsLeftOut > 0) {
      restored.leftOut.set(String(read.queryKey[1]), { savedAt: read.savedAt, count: checked.itemsLeftOut });
    }
  }
}

/**
 * Saves each read as it answers, and deletes a read's record when it leaves
 * the cache - a deleted Workspace's copy, or sign-out emptying it. Returns the
 * unsubscribe.
 */
export function saveReadsAsTheyAnswer(client: QueryClient): () => void {
  return client.getQueryCache().subscribe((event) => {
    if (event.type === 'removed') {
      void del(event.query.queryHash, savedReads()).catch(() => {});
      return;
    }
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const { query } = event;
    if (!worthSaving(query)) return;
    void saveRead({ queryKey: query.queryKey, data: query.state.data, savedAt: query.state.dataUpdatedAt }).catch(
      () => {},
    );
  });
}

/** Saves one read over whatever was saved for the same query. */
export function saveRead(read: SavedRead): Promise<void> {
  return set(hashKey(read.queryKey), read, savedReads());
}

/** Deletes every saved read, and nothing else this device keeps. */
export async function forgetEverySavedRead(): Promise<void> {
  restored.leftOut.clear();
  restored.unusable.clear();
  await clear(savedReads());
}

/**
 * The app, drawn from the checked saved reads and re-read behind them - both
 * halves of architecture, "The read model: persisted snapshot, revalidate,
 * push".
 *
 * **Held back for the one read of IndexedDB**, which is local and takes
 * milliseconds: the router reads the cache the moment it mounts (`beforeLoad`
 * in `router.tsx`), and mounted ahead of the restore it finds nothing and goes
 * to a network that may not be there.
 *
 * **Everything restored is invalidated on the way out.** A restored read keeps
 * the time it was saved, so `staleTime` would call one saved a second before a
 * reload fresh and re-read nothing - and a change the server took, whose own
 * re-read had not landed when the page went away, would stay missing.
 */
export function PaintedFromTheStoredCopy({
  client,
  children,
}: {
  client: QueryClient;
  children: ReactNode;
}) {
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    let current = true;
    let stop: (() => void) | undefined;
    void restoreSavedReads(client).then(() => {
      if (!current) return;
      stop = saveReadsAsTheyAnswer(client);
      setRestoring(false);
      void client.invalidateQueries();
    });
    return () => {
      current = false;
      stop?.();
    };
  }, [client]);
  return (
    <QueryClientProvider client={client}>
      <IsRestoringProvider value={restoring}>{restoring ? null : children}</IsRestoringProvider>
    </QueryClientProvider>
  );
}
