import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { NotSignedIn } from './api/client';
import { CACHE_MAX_AGE_MS, PaintedFromTheStoredCopy } from './persistence';
import { createAppRouter } from './router';
import { Updating } from './components/Updating';
import { UndoWhatJustHappened } from './undo';
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
    <PaintedFromTheStoredCopy client={queryClient}>
      {/* Around the whole app rather than inside the shell, so a change made
          in the Inbox column and one made on a panel are offered back in the
          same place - and so wrapping it costs no re-indent of a file it has
          nothing else to do with. The bar positions itself over the page. */}
      {/* Outside the router and outside the shell, because a build that cannot
          read what the server says is not in a state any screen can be trusted
          to render - including the logon page, which hangs off the root rather
          than off the shell.

          Inside the stored copy's provider, though, and that way round matters:
          the re-read it starts on the way out of the restore (persistence.tsx)
          is usually the first read to come back in a shape this build cannot
          understand, and this has to be watching the cache before it does. */}
      <Updating>
        <UndoWhatJustHappened>
          <RouterProvider router={router} />
        </UndoWhatJustHappened>
      </Updating>
    </PaintedFromTheStoredCopy>
  </StrictMode>,
);
