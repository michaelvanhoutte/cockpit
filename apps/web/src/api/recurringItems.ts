import { useCallback, useEffect, useMemo } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecurringItemList } from '@cockpit/shared';
import { recurringItemsDrawnOver } from '../recurringItemsDrawnAhead';
import { api, refusal } from './client';
import { changeList, readBegins, useDrawnOver } from './ownList';
import { snapshotQuery, type CommandArgs } from './queries';

/** The three commands that change a recurring item. */
type RecurringItemChange = Extract<CommandArgs, { name: 'create_recurring_item' | 'write_recurring_item' | 'delete_recurring_item' }>;

/**
 * The recurring items a Workspace has, and the changes made to them ("Make,
 * change and delete recurring items from the Recurring items modal", issue
 * 1449). Kept apart from `queries.ts` because only the Recurring items modal
 * uses any of it, which makes it that modal's chunk's weight rather than the
 * initial bundle's (`bundle:budget`). Drawn and read as `ownList.ts` does for
 * every window's list.
 */

/**
 * **Never served from a copy, and dropped once the modal closes**: the list is
 * read each time it opens, and a copy held longer would show what another device
 * has since changed. A change made here is drawn over the copy meanwhile
 * (`useRecurringItems`), not written into it.
 */
export const recurringItemsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['recurringItems', workspaceId],
    queryFn: async ({ client, queryKey }) => {
      readBegins(client, queryKey);
      const res = await api.v1.workspaces[':workspaceId']['recurring-items'].$get({ param: { workspaceId } });
      if (!res.ok) throw refusal('recurring items', res.status);
      return (await res.json()) as RecurringItemList;
    },
    staleTime: 0,
    gcTime: 0,
  });

/**
 * The Workspace's recurring items as the modal draws them: the list the server
 * sent, with this tab's changes not yet covered by a read of it laid over
 * (`changeQueue.ts`).
 *
 * **Read again beside the Workspace**, each time the Workspace's own read begins
 * or its copy is marked out of date - which is what an announcement of a change
 * on another device does (`snapshotReads.ts`) - while the modal is open. Closed,
 * the list is not held, so there is nothing to mark.
 */
export function useRecurringItems(workspaceId: string) {
  const client = useQueryClient();
  const over = useMemo(() => recurringItemsDrawnOver(workspaceId), [workspaceId]);
  const select = useDrawnOver<RecurringItemList>(over);
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        const [kind, id] = event.query.queryKey;
        if (kind !== 'snapshot' || id !== workspaceId || event.type !== 'updated') return;
        if (event.action.type === 'fetch' || event.action.type === 'invalidate') {
          void client.invalidateQueries({ queryKey: recurringItemsQuery(workspaceId).queryKey, exact: true }, { cancelRefetch: false });
        }
      }),
    [client, workspaceId],
  );
  return useQuery({ ...recurringItemsQuery(workspaceId), select });
}

/**
 * Sends a change to a recurring item - made, written whole or deleted. It joins
 * the tab's queue and is drawn at once (`useRecurringItems`); it settles with the
 * server's answer, or its refusal, which the caller says. **The list and the
 * Workspace are read once the queue has emptied**, not waited for: the Workspace
 * carries the rule each copy's ↻ is drawn from.
 */
export function useChangeRecurringItem(): (change: RecurringItemChange) => Promise<void> {
  const client = useQueryClient();
  return useCallback(
    async (change) => {
      const workspaceId = change.payload.workspaceId;
      const key = recurringItemsQuery(workspaceId).queryKey;
      try {
        await changeList(client, key, change, [snapshotQuery(workspaceId).queryKey]);
      } catch (failure) {
        // Refused, or never reached: the list may not be what the server holds (a recurring
        // item deleted elsewhere, or a change that did land), and no answer came to read it by.
        void client.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
        throw failure;
      }
    },
    [client],
  );
}
