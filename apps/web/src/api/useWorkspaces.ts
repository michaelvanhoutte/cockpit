import { useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceList } from '@cockpit/shared';
import { changes } from './changes';
import { workspacesQuery } from './queries';

/**
 * The Workspaces as the screen draws them: the list the server sent, with this
 * tab's unanswered Workspace changes applied over it (`changeQueue.ts`) - so a
 * tab, the colour the page is painted in and every place that offers a
 * Workspace agree about a rename, a colour, a delete or an order not yet
 * answered. The held list, and the one saved on the device, stay as the server
 * sent them.
 */
export function useWorkspaces() {
  const version = useSyncExternalStore(changes.subscribe, changes.version, changes.version);
  const select = useMemo(
    () => (held: WorkspaceList) => changes.drawnList(held),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  return useQuery({ ...workspacesQuery, select });
}
