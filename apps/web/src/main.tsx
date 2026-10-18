import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { NotSignedIn } from './api/client';
import { statusOf } from './api/loadFailure';
import { CACHE_MAX_AGE_MS } from './persistence';
import { HoldForTheServer, Opening } from './opening';
import { createAppRouter } from './router';
import { Updating } from './components/Updating';
import { UndoWhatJustHappened } from './undo';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    // Never paused by the offline switch: a change is refused before it is sent
    // while offline (`offline.ts`), and a paused one would sit unsent and read
    // as saved.
    mutations: { networkMode: 'always' },
    queries: {
      gcTime: CACHE_MAX_AGE_MS, // keep reads a week so a visit can move between them
      /**
       * Retrying a refusal is only ever a delay. A request refused for not
       * being signed in, or for the role the person holds, will be refused
       * identically twice more, and what it costs is the seconds before the
       * logon page or the refusal appears - so the answer is taken the first
       * time it is given.
       */
      retry: (attempt, error) =>
        !(error instanceof NotSignedIn) && statusOf(error) !== '403' && attempt < 2,
    },
  },
});

const router = createAppRouter(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Opening client={queryClient}>
      {/* Around the whole app rather than inside the shell, so a change made
          in the Inbox column and one made on a panel are offered back in the
          same place - and so wrapping it costs no re-indent of a file it has
          nothing else to do with. The bar positions itself over the page. */}
      {/* Outside the router and outside the shell, because a build that cannot
          read what the server says is not in a state any screen can be trusted
          to render - including the logon page, which hangs off the root rather
          than off the shell.

          Inside the provider that opens the visit, though, and that way round
          matters: the open's read of the server (opening.tsx) is usually the
          first to come back in a shape this build cannot understand, and this
          has to be watching the cache before it does. Its check for a new
          version and the open's wait on the server start together, which is why
          the router is held below rather than the whole of this. */}
      <Updating>
        <UndoWhatJustHappened>
          <HoldForTheServer>
            <RouterProvider router={router} />
          </HoldForTheServer>
        </UndoWhatJustHappened>
      </Updating>
    </Opening>
  </StrictMode>,
);
