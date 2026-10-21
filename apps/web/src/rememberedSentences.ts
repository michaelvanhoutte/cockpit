import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { rememberedSentenceListSchema, type CommandResult, type RememberedSentenceList, type WorkspaceList } from '@cockpit/shared';
import { refuseWhileOffline } from './offline';
import { api, refusal } from './api/client';
import { changes } from './api/changes';
import type { CommandArgs } from './api/queries';
import { sentencesDrawnOver } from './rememberedSentencesDrawnAhead';

/**
 * The account's remembered sentences ("See and change what Cockpit remembers",
 * issue 1164), read by Settings to list and by the review window to name those
 * a proposal learned from, and the changes made to them ("Show a
 * remembered-sentence change the moment you make it", issue 1370). Its own
 * module so the window's chunk does not carry Settings' section, nor the
 * initial bundle any of this (`bundle:budget`).
 */

/** What a read of the list is, to the queue: the scope its changes are drawn and ended under. */
const SCOPE = 'rememberedSentences';

/** When the read in flight began, on the queue's clock. */
let readBegunAt: number | undefined;

const watched = new WeakSet<QueryClient>();

/**
 * Tells the queue each time a read of the list lands, so the changes it covers
 * stop being drawn over it - the rule a Workspace's own read follows
 * (`watchWorkspaceReads`, `changes.ts`). Done from the cache's own event for the
 * same reason.
 */
function watchReads(client: QueryClient): void {
  if (watched.has(client)) return;
  watched.add(client);
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    if (event.query.queryKey[0] === 'rememberedSentences' && readBegunAt !== undefined) changes.readLanded(SCOPE, readBegunAt);
  });
}

export const rememberedSentencesQuery = queryOptions({
  queryKey: ['rememberedSentences'],
  queryFn: async ({ client }) => {
    // Marked as it starts: whether a change is in the read depends on when the read *began*.
    watchReads(client);
    readBegunAt = changes.readStarted();
    const res = await api.v1['remembered-sentences'].$get();
    if (!res.ok) throw refusal('remembered sentences', res.status);
    return rememberedSentenceListSchema.parse(await res.json());
  },
  // What is kept *now*: a sentence may have been changed from another tab.
  staleTime: 0,
});

/**
 * The sentences as the window draws them: the list the server sent, with this
 * tab's changes not yet covered by a read of it laid over (`changeQueue.ts`).
 */
export function useRememberedSentences() {
  const client = useQueryClient();
  const version = useSyncExternalStore(changes.subscribe, changes.version, changes.version);
  const select = useMemo(
    () => {
      const nameOf = (workspaceId: string) =>
        client.getQueryData<WorkspaceList>(['workspaces'])?.workspaces.find((one) => one.id === workspaceId)?.name;
      return (held: RememberedSentenceList) => changes.drawnList(held, sentencesDrawnOver(nameOf));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, client],
  );
  return useQuery({ ...rememberedSentencesQuery, select });
}

/** The tab with a read of the list owed, once its queue has emptied (`snapshotReads.ts` does the same for a Workspace). */
let owed: QueryClient | undefined;

changes.subscribe(readWhatIsOwed);

function readWhatIsOwed(): void {
  if (!owed || changes.unanswered() > 0) return;
  const client = owed;
  owed = undefined;
  read(client);
}

/**
 * Reads the list, never in place of a read in flight: that one is left to
 * land, and followed by one more, since it may have begun before the answer. A
 * list nothing is showing is marked out of date and read when it is next shown.
 */
function read(client: QueryClient): void {
  const filters = { queryKey: rememberedSentencesQuery.queryKey, exact: true };
  const query = client.getQueryCache().find(filters);
  if (!query) return;
  const alongside = { cancelRefetch: false };
  const start = () => void (query.isActive() ? client.refetchQueries(filters, alongside) : client.invalidateQueries(filters, alongside));
  const flying = query.state.fetchStatus === 'fetching';
  start();
  if (flying) void query.promise?.then(start, start);
}

/**
 * Sends a sentence change - kept, reworded or forgotten. It joins the tab's
 * queue and is drawn at once (`useRememberedSentences`); it settles with the
 * server's answer, or its refusal, which the caller says. **The list is read
 * once the queue has emptied**, not waited for, and no Workspace is read at all.
 */
export function useChangeSentence(): (args: CommandArgs) => Promise<CommandResult> {
  const client = useQueryClient();
  return useCallback(
    async (args) => {
      refuseWhileOffline();
      return changes.enqueue(
        args,
        () => {
          owed = client;
          readWhatIsOwed();
        },
        SCOPE,
      );
    },
    [client],
  );
}
