import { useCallback } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { appDisconnectedSchema, connectedAppListSchema, type ConnectedAppList } from '@cockpit/shared';
import { connectedAppsDrawnOver } from '../connectedAppsDrawnAhead';
import { api, refusal } from './client';
import { readBegins, requestToChangeList, useDrawnOver } from './ownList';

/**
 * The apps a person allowed into their Cockpit, and disconnecting one ("See the
 * apps connected to your Cockpit, and disconnect one", issue 600; "Show a
 * connected app or user change the moment you make it", issue 1371). Kept apart
 * from `queries.ts` because only the MCP connections window and the one that
 * sends an Item to Claude use any of it, which makes it theirs to carry rather than
 * the initial bundle's (`bundle:budget`). Drawn and read as `ownList.ts` does for
 * every window's list.
 */

/**
 * **Never served from a copy**: what is connected *now*, which another tab may
 * have changed. A disconnect made here is drawn over the copy meanwhile
 * (`useConnectedApps`), not written into it.
 */
export const connectedAppsQuery = queryOptions({
  queryKey: ['connectedApps'],
  queryFn: async ({ client, queryKey }) => {
    readBegins(client, queryKey);
    const res = await api.v1['connected-apps'].$get();
    if (!res.ok) throw refusal('connected apps', res.status);
    return connectedAppListSchema.parse(await res.json());
  },
  staleTime: 0,
});

/** The apps as the window draws them: the list the server sent, with this tab's disconnects not yet covered by a read of it laid over. */
export function useConnectedApps(open: boolean) {
  const select = useDrawnOver<ConnectedAppList>(connectedAppsDrawnOver);
  return useQuery({ ...connectedAppsQuery, enabled: open, select });
}

async function disconnect(appId: string, signal: AbortSignal): Promise<void> {
  const res = await api.v1['connected-apps'][':appId'].$delete({ param: { appId } }, { init: { signal } });
  // Already gone, from another tab: the list is simply out of date.
  if (res.status === 404) return;
  if (!res.ok) throw refusal('disconnecting an app', res.status);
  appDisconnectedSchema.parse(await res.json());
}

/**
 * Disconnects an app. It joins the tab's queue and is drawn at once
 * (`useConnectedApps`); it settles with the server's answer, or its refusal,
 * which the caller says. **The list is read once the queue has emptied**, not
 * waited for.
 */
export function useDisconnectApp(): (appId: string) => Promise<void> {
  const client = useQueryClient();
  return useCallback(
    (appId) => requestToChangeList(client, connectedAppsQuery.queryKey, { name: 'disconnect_app', payload: { appId } }, (signal) => disconnect(appId, signal)),
    [client],
  );
}
