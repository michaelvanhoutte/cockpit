import type { ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider, type Persister } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

/**
 * Where the read model's stored copy lives between visits (architecture, "The
 * read model: persisted snapshot, revalidate, push"): the query cache is
 * written to IndexedDB, so a cold open paints from the last snapshot with zero
 * blocking network requests.
 *
 * It is a module of its own rather than a few lines inside `main.tsx` because
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

/**
 * `v4` because an item's one text became three: `preview` is gone and a captured
 * message and a description are in its place, and a title can now be empty
 * ("Edit an item's title and description on a form of its own", issue 159). A
 * copy from before it draws rows labelled by a title that is no longer the only
 * label there is, with nothing behind the disclosure and no mark where a
 * description would be. `v3` was an item losing its status and gaining a
 * completion time and a type ("An item is either yours to deal with or finished
 * with", issue 154; "Capture a thought or an action, and see which it is", issue
 * 155), and a workspace's stored copy gaining the account's types beside its
 * items. `v2` was a workspace's fourth colour ("Modernise the app shell", issue
 * 125).
 *
 * **The buster has to move whenever the shape of what is stored does.** What is
 * restored here is never re-validated - the schemas parse responses on the way
 * in from the network (api/client.ts), not the copy read back out of IndexedDB
 * - so a stale shape is not rejected, it is rendered. Three-colour workspaces
 * paint a shell with no bar: the tab you are on stops being filled and stops
 * joining the strip, and the strip itself has no colour at all. Revalidation
 * fixes it a moment later online, and never fixes it offline, which is the case
 * the stored copy exists for in the first place.
 *
 * The cost is that everyone's stored copy is dropped once on the deploy that
 * ships a move, and the first open after it has to reach the network. That is
 * the right way round: a cold open is a moment, a shell painted from a shape
 * the code no longer expects is a week.
 */
export const CACHE_BUSTER = 'v4';

/**
 * The app, painted from the copy the last visit left behind and re-read behind
 * it - both halves of the promise in architecture, "The read model: persisted
 * snapshot, revalidate, push".
 *
 * **`onSuccess` is the second half.** A restored query keeps the
 * `dataUpdatedAt` of the visit that wrote it, so `staleTime` calls a copy
 * written a second before a reload fresh and re-reads nothing - and a change
 * the server took, whose own re-read had not landed when the page went away, is
 * then missing from what is drawn and stays missing. A panel dragged to a new
 * size comes back the size it was. Invalidating on the way out of the restore
 * is what stops the copy being taken for an answer.
 *
 * Nothing waits on it: the children render from what was restored and the
 * re-read arrives behind them, so a cold open still makes no blocking request.
 * Offline it fails and the copy stays on screen, which is what it is kept for.
 */
export function PaintedFromTheStoredCopy({
  client,
  children,
}: {
  client: QueryClient;
  children: ReactNode;
}) {
  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{ persister, maxAge: CACHE_MAX_AGE_MS, buster: CACHE_BUSTER }}
      onSuccess={() => client.invalidateQueries()}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
