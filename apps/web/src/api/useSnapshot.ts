import { useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from './changes';
import { snapshotQuery } from './queries';

/**
 * A Workspace as the screen draws it: the copy the server sent, with this tab's
 * unanswered changes applied over it (`changeQueue.ts`).
 *
 * **What every reader of Items uses**, so a row, the Inbox, the form and a
 * count can never disagree about a change the server has not answered. A reader
 * of something a change does not touch may keep to `snapshotQuery`; the held
 * copy, and the one saved on the device, stay exactly what the server sent.
 */
export function useSnapshot(workspaceId: string, options: { enabled?: boolean } = {}) {
  const version = useSyncExternalStore(changes.subscribe, changes.version, changes.version);
  // Rebuilt when the changes do, which is what makes the query select again.
  const select = useMemo(
    () => (held: WorkspaceSnapshot) => changes.drawnOver(held),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  return useQuery({ ...snapshotQuery(workspaceId), ...options, select });
}
