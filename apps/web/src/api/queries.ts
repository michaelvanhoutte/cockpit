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
 * What has to be re-read once a change has landed, and **not finished until it
 * has been**. One function, so the two senders above cannot come to disagree
 * about it.
 *
 * The waiting is the part worth explaining. A change used to be done the moment
 * the server accepted it, with the re-read left running behind it — which is
 * fine for a change that carries only its own fields, and wrong for the filing
 * commands, which carry the panel's *whole order* and have it checked against
 * what the server holds. Filing two items onto one panel one after the other
 * then sent the second order from a snapshot that did not have the first item
 * in it yet, and the server correctly refused it as an order that is not the
 * panel's. It only ever lost the race on a slow machine, which is exactly the
 * kind of bug that reaches somebody else's laptop first.
 *
 * So every change waits, rather than the filing ones waiting and the rest not:
 * the cost is that a control stays busy until the list behind it agrees, which
 * is the moment the change is really done.
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
  return Promise.all(reread);
}

export function useCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: CommandArgs) => sendCommand(args.name, args.payload as never),
    // Returned rather than called and dropped, because React Query waits on
    // what a mutation's own `onSuccess` returns: the caller's `onSuccess` then
    // runs on a snapshot that already has this change in it, and `isPending`
    // covers the re-read.
    onSuccess: (_result, args) => afterChanging(queryClient, args),
  });
}
