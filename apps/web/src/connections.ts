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
 * **It went through, or it did not**, which is the whole contract with the
 * callback routes (`apps/api/src/http/app.ts`, `backToConnections`) - Gmail's
 * going through having a value of its own, since what it says next differs
 * ("Connect a Gmail account to a workspace, and disconnect it", issue 724).
 * Why it did not is in the Worker's log, and here only where the person can
 * act on it: they cancelled, or Google's consent screen left the Gmail
 * permission unticked or handed no refresh token. Anything else is `refused`.
 */
export type ConnectOutcome =
  | 'connected'
  | 'gmail-connected'
  | 'refused'
  | 'cancelled'
  | 'gmail-permission-missing'
  | 'gmail-no-refresh-token';

const OUTCOMES: readonly unknown[] = [
  'connected',
  'gmail-connected',
  'refused',
  'cancelled',
  'gmail-permission-missing',
  'gmail-no-refresh-token',
] satisfies ConnectOutcome[];

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
  return OUTCOMES.includes(search.connections) ? { connections: search.connections as ConnectOutcome } : {};
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
