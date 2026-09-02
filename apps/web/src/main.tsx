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
      // `v2` because a workspace gained a fourth colour ("Modernise the app
      // shell", issue 125), and a stored copy written before it has three.
      //
      // **The buster has to move whenever the shape of what is stored does.**
      // What is restored here is never re-validated - the schemas parse
      // responses on the way in from the network (api/client.ts), not the copy
      // read back out of IndexedDB - so a stale shape is not rejected, it is
      // rendered. Three-colour workspaces paint a shell with no bar: the tab
      // you are on stops being filled and stops joining the strip, and the
      // strip itself has no colour at all. Revalidation fixes it a moment
      // later online, and never fixes it offline, which is the case the stored
      // copy exists for in the first place.
      //
      // The cost is that everyone's stored copy is dropped once on the deploy
      // that ships this, and the first open after it has to reach the network.
      // That is the right way round: a cold open is a moment, a shell painted
      // from a shape the code no longer expects is a week.
      persistOptions={{ persister, maxAge: CACHE_MAX_AGE_MS, buster: 'v2' }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
);
