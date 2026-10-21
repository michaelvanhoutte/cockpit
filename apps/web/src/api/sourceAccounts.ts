import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { sourceAccountListSchema, type CommandResult, type RegisteredConnector, type SourceAccountList } from '@cockpit/shared';
import { connectionsDrawnOver } from '../connectionsDrawnAhead';
import { refuseWhileOffline } from '../offline';
import { api, refusal } from './client';
import { changes } from './changes';
import type { CommandArgs } from './queries';

/**
 * The connections a Workspace has, and the changes made to them ("Show a
 * connection change the moment you make it", issue 1369). Kept apart from
 * `queries.ts` because only the Connections window uses any of it, which makes
 * it that window's chunk's weight rather than the initial bundle's
 * (`bundle:budget`).
 */

/** The source accounts one Workspace has connected, oldest first. */
async function fetchSourceAccounts(workspaceId: string): Promise<SourceAccountList> {
  const res = await api.v1.workspaces[':workspaceId'].connections.$get({ param: { workspaceId } });
  if (!res.ok) throw refusal('connections', res.status);
  return sourceAccountListSchema.parse(await res.json());
}

/** What a read of this Workspace's connections is, to the queue: the scope its changes are drawn and ended under. */
const scopeOf = (workspaceId: string) => `sourceAccounts:${workspaceId}`;

/** When each read in flight began, on the queue's clock, by Workspace. */
const readsBegunAt = new Map<string, number>();

const watched = new WeakSet<QueryClient>();

/**
 * Tells the queue each time a read of a Workspace's connections lands, so the
 * changes it covers stop being drawn over it - the rule a Workspace's own read
 * follows (`watchWorkspaceReads`, `changes.ts`), for the list this window reads.
 * Done from the cache's own event for the same reason.
 */
function watchConnectionReads(client: QueryClient): void {
  if (watched.has(client)) return;
  watched.add(client);
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const [kind, workspaceId] = event.query.queryKey;
    const begunAt = kind === 'sourceAccounts' && typeof workspaceId === 'string' ? readsBegunAt.get(workspaceId) : undefined;
    if (begunAt !== undefined) changes.readLanded(scopeOf(workspaceId as string), begunAt);
  });
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
    queryFn: ({ client }) => {
      // Marked as it starts: whether a change is in the read depends on when the read *began*.
      watchConnectionReads(client);
      readsBegunAt.set(workspaceId, changes.readStarted());
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
  const version = useSyncExternalStore(changes.subscribe, changes.version, changes.version);
  const select = useMemo(
    () => {
      const labelOf = (connectorId: string, choice: string) =>
        connectors?.find((one) => one.id === connectorId)?.choice?.options.find((option) => option.value === choice)?.label;
      return (held: SourceAccountList) => changes.drawnList(held, connectionsDrawnOver(workspaceId, labelOf));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, workspaceId, connectors],
  );
  // Said rather than assumed: the tabs only render the window while it is open, and a
  // list read for a shut window would be a request nobody asked for.
  return useQuery({ ...sourceAccountsQuery(workspaceId), enabled: open, select });
}

/**
 * Reads owed for this tab's connection changes, by Workspace: made once the
 * queue has emptied, so choice and files-by-name changed together read the list
 * once and not after each (`snapshotReads.ts` does the same for a Workspace).
 */
const owed = new Map<string, QueryClient>();

changes.subscribe(readWhatIsOwed);

function readWhatIsOwed(): void {
  if (changes.unanswered() > 0) return;
  for (const [workspaceId, client] of owed) read(client, workspaceId);
  owed.clear();
}

/**
 * Reads one Workspace's connections, never in place of a read in flight: that
 * one is left to land, and followed by one more, since it may have begun before
 * the answer. A list nothing is showing is marked out of date and read when the
 * window is next opened.
 */
function read(client: QueryClient, workspaceId: string): void {
  const filters = { queryKey: ['sourceAccounts', workspaceId], exact: true };
  const query = client.getQueryCache().find(filters);
  if (!query) return;
  const alongside = { cancelRefetch: false };
  const start = () => void (query.isActive() ? client.refetchQueries(filters, alongside) : client.invalidateQueries(filters, alongside));
  const flying = query.state.fetchStatus === 'fetching';
  start();
  if (flying) void query.promise?.then(start, start);
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
    async (args) => {
      refuseWhileOffline();
      const { workspaceId } = args.payload;
      return changes.enqueue(
        args,
        () => {
          owed.set(workspaceId, client);
          readWhatIsOwed();
        },
        scopeOf(workspaceId),
      );
    },
    [client],
  );
}
