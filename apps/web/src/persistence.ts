import type { Persister } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

/**
 * Where the read model's stored copy lives between visits (architecture, "The
 * read model: persisted snapshot, revalidate, push"): the query cache is
 * written to IndexedDB, so a cold open paints from the last snapshot with zero
 * blocking network requests.
 *
 * It is a module of its own rather than four lines inside `main.tsx` because
 * signing out has to be able to *remove* it. What is stored here is one
 * person's workspaces and items, and leaving it behind for whoever signs in
 * next is the leak the whole account boundary exists to prevent - and it is a
 * leak no test below a real browser can see, because it lives in the browser's
 * own storage.
 */
const CACHE_KEY = 'cockpit-query-cache-v1';

export const persister: Persister = {
  persistClient: (client) => set(CACHE_KEY, client),
  restoreClient: () => get(CACHE_KEY),
  removeClient: () => del(CACHE_KEY),
};

/** How long a stored copy stays readable offline. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
