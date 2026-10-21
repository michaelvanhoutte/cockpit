import { useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from './changes';
import { snapshotQuery } from './queries';

/**
 * What turns a held copy into the one the screen draws, for a query of a
 * snapshot to `select` with. Rebuilt when the queue's changes are, which is what
 * makes the query select again.
 */
export function useDrawnSelect(): (held: WorkspaceSnapshot) => WorkspaceSnapshot {
  const version = useSyncExternalStore(changes.subscribe, changes.version, changes.version);
  return useMemo(
    () => (held: WorkspaceSnapshot) => changes.drawnOver(held),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
}

/**
 * A Workspace as the screen draws it: the copy the server sent, with this tab's
 * unanswered changes applied over it (`changeQueue.ts`).
 *
 * **What every reader of Items or filings uses**, so a row, the Inbox, the form,
 * a count and a Panel's contents can never disagree about a change the server
 * has not answered. A reader of something a change does not touch may keep to
 * `snapshotQuery`; the held copy, and the one saved on the device, stay exactly
 * what the server sent.
 */
export function useSnapshot(workspaceId: string, options: { enabled?: boolean } = {}) {
  const select = useDrawnSelect();
  return useQuery({ ...snapshotQuery(workspaceId), ...options, select });
}
