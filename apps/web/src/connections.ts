import { useNavigate, useSearch } from '@tanstack/react-router';

/**
 * How a trip out to Microsoft and back says how it went ("Connect a Microsoft
 * Teams source account", issue 485).
 *
 * **The one management window with anything in the address, and the reason is
 * the trip.** Managing dashboards, workspaces and types are windows over the
 * workspace with no address of their own (`router.tsx` says why); connecting
 * a source account leaves the application entirely, so the window has to be
 * reopened by whatever comes back - and what comes back is a redirect from
 * the Worker, which has only the address to say anything in.
 *
 * **Two values and no third**, which is the whole contract with the callback
 * route (`apps/api/src/http/app.ts`, `backToConnections`): it went through, or
 * it did not. Why it did not is in the Worker's log and never here.
 */
export type ConnectOutcome = 'connected' | 'refused';

export interface ConnectionsSearch {
  connections?: ConnectOutcome;
}

/**
 * What the address is allowed to carry of this, dropping anything else - a
 * hand-typed value cannot put a word the window never expects on screen.
 *
 * Composed with the item form's own into the shell's `validateSearch`
 * (`router.tsx`), because the layout route is the only place under the shell
 * where a search parameter can be declared at all.
 */
export function connectionsSearch(search: Record<string, unknown>): ConnectionsSearch {
  return search.connections === 'connected' || search.connections === 'refused'
    ? { connections: search.connections }
    : {};
}

/**
 * How the last connect attempt went, and how to forget it.
 *
 * Forgetting replaces rather than pushes, so closing the window collapses the
 * entry the trip back made instead of stacking a third on top of it - the same
 * movement `useItemForm` makes for the same reason.
 */
export function useConnections(): { outcome: ConnectOutcome | undefined; forget: () => void } {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ConnectionsSearch;

  return {
    outcome: search.connections,
    forget: () =>
      void navigate({
        to: '.',
        replace: true,
        search: (was) => {
          const { connections: _done, ...rest } = was as ConnectionsSearch;
          return rest;
        },
      }),
  };
}
