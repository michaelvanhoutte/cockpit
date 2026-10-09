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
 * callback routes (`apps/api/src/http/app.ts`, `backToConnections`). Why it
 * did not is in the Worker's log, and here only where the person can act on
 * it: the connector and the code its own account step refused the grant with,
 * whose sentence the connector's listing holds (issue 941).
 */
export type ConnectOutcome = 'connected' | 'refused';

const OUTCOMES: readonly unknown[] = ['connected', 'refused'] satisfies ConnectOutcome[];

export interface ConnectionsSearch {
  connections?: ConnectOutcome;
  /**
   * Which connector refused and its code for why, where a connector's own
   * account step refused the grant. Only codes: the sentence comes from the
   * connector's listing (`ManageConnections`), so an address cannot put its
   * own words on screen.
   */
  by?: string;
  because?: string;
}

/** Who refused a grant, and the code it gave. */
export interface RefusedBecause {
  connectorId: string;
  code: string;
}

const CODE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * What the address is allowed to carry of this, dropping anything else - a
 * hand-typed value cannot put a word the window never expects on screen.
 *
 * Composed with the item form's own into the shell's `validateSearch`
 * (`router.tsx`), because the layout route is the only place under the shell
 * where a search parameter can be declared at all.
 */
export function connectionsSearch(search: Record<string, unknown>): ConnectionsSearch {
  if (!OUTCOMES.includes(search.connections)) return {};
  const connections = search.connections as ConnectOutcome;
  const { by, because } = search;
  return connections === 'refused' && typeof by === 'string' && typeof because === 'string' && CODE.test(by) && CODE.test(because)
    ? { connections, by, because }
    : { connections };
}

/**
 * How the last connect attempt went, and how to forget it.
 *
 * Forgetting replaces rather than pushes, so closing the window collapses the
 * entry the trip back made instead of stacking a third on top of it - the same
 * movement `useItemForm` makes for the same reason.
 */
export function useConnections(): {
  outcome: ConnectOutcome | undefined;
  because: RefusedBecause | undefined;
  forget: () => void;
} {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ConnectionsSearch;

  return {
    outcome: search.connections,
    because: search.by && search.because ? { connectorId: search.by, code: search.because } : undefined,
    forget: () =>
      void navigate({
        to: '.',
        replace: true,
        search: (was) => {
          const { connections: _done, by: _by, because: _because, ...rest } = was as ConnectionsSearch;
          return rest;
        },
      }),
  };
}
