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

/** Grows as renaming and deleting land ("Rename and delete a workspace", issue 77). */
const CHANGES_THE_WORKSPACE_LIST = new Set<CommandName>(['create_workspace']);

export function useCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: CommandArgs) => sendCommand(args.name, args.payload as never),
    onSuccess: (_result, args) => {
      void queryClient.invalidateQueries({ queryKey: ['snapshot', args.payload.workspaceId] });
      // Only the changes that alter which workspaces there are, so triaging an
      // item does not refetch the list on every click.
      if (CHANGES_THE_WORKSPACE_LIST.has(args.name)) {
        void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      }
    },
  });
}
