import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import { fetchSnapshot, fetchWorkspaces, sendCommand } from './client';

export const workspacesQuery = queryOptions({
  queryKey: ['workspaces'],
  queryFn: fetchWorkspaces,
  staleTime: 60_000,
});

/** The read model: one snapshot per workspace (§5.2), revalidated in the background. */
export const snapshotQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => fetchSnapshot(workspaceId),
    staleTime: 15_000,
  });

/** A correctly paired { name, payload } for any command, as a discriminated union. */
export type CommandArgs = {
  [N in CommandName]: { name: N; payload: CommandPayload<N> };
}[CommandName];

/** Grows as reordering lands ("Reorder workspaces", issue 31). */
const CHANGES_THE_WORKSPACE_LIST = new Set<CommandName>([
  'create_workspace',
  'rename_workspace',
  'delete_workspace',
  // The tabs carry each workspace's colour, and the page is painted in it, so
  // a theme change moves what the list holds as much as a rename does.
  'set_workspace_theme',
]);

export function useCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: CommandArgs) => sendCommand(args.name, args.payload as never),
    onSuccess: (_result, args) => {
      if (args.name === 'delete_workspace') {
        // Dropped, not re-read. There is nothing to revalidate: the snapshot of
        // a deleted workspace is a 404 for good, so invalidating it would fetch
        // one on every delete. And the copy has to go rather than merely go
        // stale - the cache is persisted for a week (main.tsx), so leaving it
        // there means a deleted workspace's items can still be painted from it.
        queryClient.removeQueries({ queryKey: ['snapshot', args.payload.workspaceId] });
      } else {
        void queryClient.invalidateQueries({ queryKey: ['snapshot', args.payload.workspaceId] });
      }
      // Only the changes that alter which workspaces there are, so triaging an
      // item does not refetch the list on every click.
      if (CHANGES_THE_WORKSPACE_LIST.has(args.name)) {
        void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      }
    },
  });
}
