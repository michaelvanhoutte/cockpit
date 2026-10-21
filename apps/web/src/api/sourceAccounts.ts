import { useCallback, useMemo } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { sourceAccountListSchema, type CommandResult, type RegisteredConnector, type SourceAccountList } from '@cockpit/shared';
import { connectionsDrawnOver } from '../connectionsDrawnAhead';
import { api, refusal } from './client';
import { changeList, readBegins, useDrawnOver } from './ownList';
import type { CommandArgs } from './queries';

/**
 * The connections a Workspace has, and the changes made to them ("Show a
 * connection change the moment you make it", issue 1369). Kept apart from
 * `queries.ts` because only the Connections window uses any of it, which makes
 * it that window's chunk's weight rather than the initial bundle's
 * (`bundle:budget`). Drawn and read as `ownList.ts` does for every window's list.
 */

/** The source accounts one Workspace has connected, oldest first. */
async function fetchSourceAccounts(workspaceId: string): Promise<SourceAccountList> {
  const res = await api.v1.workspaces[':workspaceId'].connections.$get({ param: { workspaceId } });
  if (!res.ok) throw refusal('connections', res.status);
  return sourceAccountListSchema.parse(await res.json());
}

/**
 * **Never served from a copy.** The window says what is connected *now*, and
 * the two moments it is read are the two where a copy would be wrong: coming
 * back from Microsoft, where the row was made a redirect ago, and reopening
 * it after a disconnect made in another tab. A change made here is drawn over
 * the copy meanwhile (`useSourceAccounts`), not written into it.
 */
export const sourceAccountsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['sourceAccounts', workspaceId],
    queryFn: ({ client, queryKey }) => {
      readBegins(client, queryKey);
      return fetchSourceAccounts(workspaceId);
    },
    staleTime: 0,
  });

/**
 * The Workspace's connections as the window draws them: the list the server sent,
 * with this tab's changes not yet covered by a read of it laid over (`changeQueue.ts`).
 * `connectors` is how a changed choice is named in its connector's words.
 */
export function useSourceAccounts(workspaceId: string, open: boolean, connectors: RegisteredConnector[] | undefined) {
  const over = useMemo(() => {
    const labelOf = (connectorId: string, choice: string) =>
      connectors?.find((one) => one.id === connectorId)?.choice?.options.find((option) => option.value === choice)?.label;
    return connectionsDrawnOver(workspaceId, labelOf);
  }, [workspaceId, connectors]);
  const select = useDrawnOver<SourceAccountList>(over);
  // Said rather than assumed: the tabs only render the window while it is open, and a
  // list read for a shut window would be a request nobody asked for.
  return useQuery({ ...sourceAccountsQuery(workspaceId), enabled: open, select });
}

/**
 * Sends a connection change - a disconnect, or a change of its choice or of
 * whether it files by name. It joins the tab's queue and is drawn at once
 * (`useSourceAccounts`); it settles with the server's answer, or its refusal,
 * which the caller says. **The list is read once the queue has emptied**, not
 * waited for.
 */
export function useChangeConnection(): (args: CommandArgs) => Promise<CommandResult> {
  const client = useQueryClient();
  return useCallback(
    (args) => changeList(client, sourceAccountsQuery(args.payload.workspaceId).queryKey, args),
    [client],
  );
}
