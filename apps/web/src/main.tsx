import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import type { Persister } from '@tanstack/react-query-persist-client';
import { RouterProvider } from '@tanstack/react-router';
import { del, get, set } from 'idb-keyval';
import { createAppRouter } from './router';
import './styles.css';

/**
 * The read model (architecture §5.2): the query cache persists to IndexedDB,
 * so a cold open paints from the last snapshot with zero blocking network
 * requests, then revalidates in the background.
 */
const CACHE_KEY = 'cockpit-query-cache-v1';

const persister: Persister = {
  persistClient: (client) => set(CACHE_KEY, client),
  restoreClient: () => get(CACHE_KEY),
  removeClient: () => del(CACHE_KEY),
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 7 * 24 * 60 * 60 * 1000, // keep snapshots a week so offline read works
      retry: 2,
    },
  },
});

const router = createAppRouter(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: 7 * 24 * 60 * 60 * 1000, buster: 'v1' }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
);
