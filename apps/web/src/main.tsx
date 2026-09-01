import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { RouterProvider } from '@tanstack/react-router';
import { NotSignedIn } from './api/client';
import { CACHE_MAX_AGE_MS, persister } from './persistence';
import { createAppRouter } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: CACHE_MAX_AGE_MS, // keep snapshots a week so offline read works
      /**
       * Retrying a refusal is only ever a delay. A request refused for not
       * being signed in will be refused identically twice more, and what it
       * costs is the seconds before the logon page appears - so the answer is
       * taken the first time it is given.
       */
      retry: (attempt, error) => !(error instanceof NotSignedIn) && attempt < 2,
    },
  },
});

const router = createAppRouter(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: CACHE_MAX_AGE_MS, buster: 'v1' }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
);
