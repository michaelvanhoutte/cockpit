import { useCallback } from 'react';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import { fetchMe, fetchSnapshot, fetchUsers, fetchWorkspaces, sendCommand } from './client';

/**
 * The people to choose from on the logon page.
 *
 * No `staleTime`, deliberately, where every other read here has one: this is
 * the one query that survives a visit ending (`session/forget.ts`), so a stale
 * copy of it would outlive the sign-out that produced it and could still be on
 * screen a week later, listing somebody who has since been removed. It paints
 * from the copy in hand and re-reads behind it, which costs one request on the
 * one page where there is nothing else to do.
 */
export const usersQuery = queryOptions({
  queryKey: ['users'],
  queryFn: fetchUsers,
});

/**
 * Who Cockpit believes you are.
 *
 * This is the app's session check as well as the name in the header, and it is
 * one query rather than two because they are one question. It is deliberately
 * *not* awaited before anything paints: the standing rule is never to block
 * paint on auth (architecture, "Performance budgets and the standing rules"),
 * so the cached view goes up and this settles behind it.
 */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: fetchMe,
  staleTime: 60_000,
});

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

/**
 * The changes after which the list of workspaces is not what it was: which
 * workspaces there are, what they are called, what colour they wear, and what
 * order they are in.
 */
const CHANGES_THE_WORKSPACE_LIST = new Set<CommandName>([
  'create_workspace',
  'rename_workspace',
  'delete_workspace',
  // The list arrives in the order the tabs are drawn in, so moving one changes
  // the list itself rather than a field of it ("Reorder workspaces", issue 31).
  'reorder_workspaces',
  // The tabs carry each workspace's colour, and the page is painted in it, so
  // a theme change moves what the list holds as much as a rename does.
  'set_workspace_theme',
]);

/**
 * The changes that are not finished until the workspace has been read again,
 * because **the next one of them is built from what this one left behind**.
 *
 * Filing sends the panel's whole order and the server checks it against the
 * order it holds, so filing a second item straight after the first built its
 * order from a workspace that did not have the first item in it yet, and was
 * refused. Removing one is here for the same reason from the other end: it
 * changes the order the next filing will send.
 *
 * **Only these.** Making every change wait is the same fix and it was tried
 * first; it broke adding a dashboard, whose own success handler navigates to
 * the dashboard it just made. Waiting first meant the new dashboard appeared in
 * the bar *before* that navigation ran, so the navigation could land while
 * somebody was already typing a panel name on the dashboard they were still on
 * - remounting the board and taking what they had typed with it. A change that
 * carries only its own fields has nothing to wait for, so it does not.
 */
const IS_BUILT_ON_THE_LAST_ONE = new Set<CommandName>([
  'move_item_to_panel',
  'add_item_to_panel',
  'remove_item_from_panel',
]);

/**
 * Sends one change and re-reads what it touched, without a mutation's state
 * around it - the same two steps `useCommand` takes, for the callers that need
 * neither `isPending` nor `error` on a control.
 *
 * It exists for undo ("Undo what just happened", issue 144), where the change is
 * sent from a bar in the shell long after the row that made the original change
 * has left the screen. A mutation belongs to the component that holds it, and
 * the whole point of an undo is that it outlives one.
 */
export function useSendCommand(): (args: CommandArgs) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (args: CommandArgs) => {
      await sendCommand(args.name, args.payload as never);
      await afterChanging(queryClient, args);
    },
    [queryClient],
  );
}

/**
 * What has to be re-read once a change has landed. One function, so the two
 * senders above cannot come to disagree about it.
 *
 * Returned rather than dropped for the changes in `IS_BUILT_ON_THE_LAST_ONE`,
 * which is where the reason lives; every other change finishes the moment the
 * server takes it, as they always have.
 */
function afterChanging(queryClient: QueryClient, args: CommandArgs): Promise<unknown> | void {
  if (args.name === 'delete_workspace') {
    // Dropped, not re-read. There is nothing to revalidate: the snapshot of a
    // deleted workspace is a 404 for good, so invalidating it would fetch one
    // on every delete. And the copy has to go rather than merely go stale - the
    // cache is persisted for a week (main.tsx), so leaving it there means a
    // deleted workspace's items can still be painted from it.
    queryClient.removeQueries({ queryKey: ['snapshot', args.payload.workspaceId] });
    return;
  }

  const reread = [queryClient.invalidateQueries({ queryKey: ['snapshot', args.payload.workspaceId] })];
  // Only the changes that alter which workspaces there are, so triaging an item
  // does not refetch the list on every click.
  if (CHANGES_THE_WORKSPACE_LIST.has(args.name)) {
    reread.push(queryClient.invalidateQueries({ queryKey: ['workspaces'] }));
  }

  if (IS_BUILT_ON_THE_LAST_ONE.has(args.name)) return Promise.all(reread);
}

export function useCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: CommandArgs) => sendCommand(args.name, args.payload as never),
    // Returned rather than called and dropped, because React Query waits on
    // what a mutation's own `onSuccess` returns. For the changes that hand it
    // back a promise, the caller's `onSuccess` then runs on a workspace that
    // already has this change in it and `isPending` covers the re-read; for the
    // rest it is `undefined` and nothing waits.
    onSuccess: (_result, args) => afterChanging(queryClient, args),
  });
}
