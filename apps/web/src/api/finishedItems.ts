import { useMemo } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { withFinishedItems } from '../finishedItems';
import { fetchFinishedItems } from './client';
import { changes } from './changes';
import { snapshotQuery } from './queries';
import { useDrawnSelect } from './useSnapshot';

/**
 * A Workspace's finished Items, a read of their own ("Fetch a Workspace's
 * finished Items the first time All items opens", issue 1434).
 *
 * **Read once per tab and kept**: the first time *All items* opens, or an
 * address names an Item the Workspace's read does not hold. A later opening
 * draws the copy held and fetches nothing, which is why it is never stale by
 * time and is not dropped when nothing shows it.
 *
 * **Kept current by the Workspace's own reads** (`snapshotReads.ts`): an
 * announcement, or a change this tab made, re-reads it beside the Workspace
 * while *All items* is on screen, and marks it out of date otherwise, to be read
 * on the next opening. **Never saved for offline use** (`savedReads.ts` names no
 * check for it), so *All items* opened without a connection says it needs one.
 */
export const finishedItemsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['finishedItems', workspaceId],
    queryFn: () => fetchFinishedItems(workspaceId),
    staleTime: Infinity,
    gcTime: Infinity,
  });

/**
 * The Workspace as the screen draws it with its finished Items: the read of the
 * Workspace and the read of its finished Items merged by Item
 * (`withFinishedItems`), with this tab's unanswered changes drawn over both, so
 * a finished Item reopened from *All items* reads To do before the server has
 * answered.
 *
 * **Reads the finished Items when asked to**: always, with no `itemId` (*All
 * items*); with one, only once the Workspace's read is held and lacks that Item
 * (an address naming a finished Item), so the form says the Item is gone only
 * after the finished read has been made.
 */
export function useSnapshotWithFinishedItems(workspaceId: string, { itemId }: { itemId?: string } = {}) {
  const workspace = useQuery(snapshotQuery(workspaceId));
  const drawn = useDrawnSelect();
  // An Item is lacking when neither the Workspace's read nor the Workspace as drawn holds it: one this tab has just
  // made is drawn but not read yet, and one it has just dismissed is read but no longer drawn, and neither asks.
  // A Workspace this tab has just added is not on the server yet, as `snapshotQuery` knows.
  const lacking =
    itemId !== undefined &&
    workspace.data !== undefined &&
    !workspace.data.items.some((item) => item.id === itemId) &&
    !drawn(workspace.data).items.some((item) => item.id === itemId);
  const wanted = (itemId === undefined || lacking) && !changes.beingAdded(workspaceId);
  const finished = useQuery({ ...finishedItemsQuery(workspaceId), enabled: wanted });
  const data = useMemo(
    () => (workspace.data ? drawn(withFinishedItems(workspace.data, finished.data)) : undefined),
    [workspace.data, finished.data, drawn],
  );
  // Asked for and not yet answered, nor refused, nor waiting for a connection that is not there.
  const reading = wanted && finished.data === undefined && !finished.isError && finished.fetchStatus !== 'paused';
  // Asked for and not answered because it could not be: refused, or waiting on a connection that is not there.
  const unread = wanted && finished.data === undefined && !reading;
  // A copy held and out of date, being read again: an Item it lacks may be in what is coming.
  const refreshing = wanted && finished.data !== undefined && finished.isFetching;
  return { data, workspace, finished, reading, unread, refreshing };
}
