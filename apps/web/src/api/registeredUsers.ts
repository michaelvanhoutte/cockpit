import { useCallback } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  registeredUserListSchema,
  userAddedSchema,
  userChangedSchema,
  userDeletedSchema,
  uuidv7,
  type AddUser,
  type ChangeUser,
  type RegisteredUserList,
  type SetAccess,
  type UserAdded,
  type UserChanged,
} from '@cockpit/shared';
import { usersDrawnOver, type ShownUsers } from '../registeredUsersDrawnAhead';
import { api, refusal } from './client';
import { readBegins, requestToChangeList, useDrawnOver } from './ownList';
import { meQuery } from './queries';

/**
 * Who can sign in, and the admin's changes to them: adding somebody, renaming
 * them and setting their role, taking their access away or giving it back, and
 * deleting them ("See who can sign in, on a page only an admin can open", issue
 * 230; "Show a connected app or user change the moment you make it", issue 1371).
 * Kept apart from `queries.ts` and `client.ts` because only the Users window
 * uses any of it, which makes it that window's chunk's weight rather than the
 * initial bundle's (`bundle:budget`). Drawn and read as `ownList.ts` does for
 * every window's list.
 */

/**
 * Why somebody could not be added, changed or deleted, in the server's words,
 * for the box, the form or the undo bar to show: they name what is wrong with
 * what was typed, which rule stopped it, and which address is already somebody's.
 */
export class UserRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserRefused';
  }
}

/**
 * Everyone this Cockpit knows. A 403 arrives as an ordinary failure rather than
 * as `NotSignedIn`, for the reason `fetchUsage` gives (`client.ts`).
 */
async function fetchRegisteredUsers(): Promise<RegisteredUserList> {
  const res = await api.v1.admin.users.$get();
  if (!res.ok) throw refusal('users', res.status);
  return registeredUserListSchema.parse(await res.json());
}

/**
 * Everyone this Cockpit knows, for the admin page.
 *
 * **Not held as long as the others.** A workspace list goes stale when you
 * change it yourself; this one goes stale when somebody else does, and the
 * whole point of the page is to show who can currently sign in - so it is
 * re-read on opening rather than served from a copy taken minutes ago.
 */
export const registeredUsersQuery = queryOptions({
  queryKey: ['registeredUsers'],
  queryFn: async ({ client, queryKey }) => {
    readBegins(client, queryKey);
    return fetchRegisteredUsers();
  },
  staleTime: 0,
});

/**
 * The register as the window draws it: the list the server sent, with this tab's
 * changes not yet covered by a read of it laid over (`registeredUsersDrawnAhead.ts`).
 * Read only while open: the register holds other people's addresses and is never
 * fetched for somebody who has not asked for it.
 */
export function useRegisteredUsers(open: boolean) {
  const select = useDrawnOver<ShownUsers>(usersDrawnOver);
  return useQuery({ ...registeredUsersQuery, enabled: open, select });
}

/**
 * A refusal keeps the server's own words, because they name what is wrong - which
 * address is already somebody's, what a name leaves nothing of, which rule stopped
 * a change. Anything that is not a refusal is reported as a failure rather than
 * pretending to be one. `refused` are the statuses that are one: a 404 is among
 * them for a change, because somebody who is no longer in the register is a fact
 * about this page being out of date.
 */
async function refusedOrDone(res: Response, refused: readonly number[], what: string): Promise<Response> {
  if (refused.includes(res.status)) {
    const { error } = (await res.json()) as { error: string };
    throw new UserRefused(error);
  }
  if (!res.ok) throw refusal(what, res.status);
  return res;
}

async function addUser(body: AddUser, signal: AbortSignal): Promise<UserAdded> {
  const res = await api.v1.admin.users.$post({ json: body }, { init: { signal } });
  return userAddedSchema.parse(await (await refusedOrDone(res, [409, 400], 'adding a user')).json());
}

async function changeUser({ userId, ...body }: ChangeUser & { userId: string }, signal: AbortSignal): Promise<UserChanged> {
  const res = await api.v1.admin.users[':userId'].$patch({ param: { userId }, json: body }, { init: { signal } });
  return userChangedSchema.parse(await (await refusedOrDone(res, [409, 404, 400], 'changing a user')).json());
}

/** Its own request rather than a field on the change, for the reason the route is its own: it ends the sign-ins that person holds. */
async function setAccess({ userId, ...body }: SetAccess & { userId: string }, signal: AbortSignal): Promise<UserChanged> {
  const res = await api.v1.admin.users[':userId'].access.$patch({ param: { userId }, json: body }, { init: { signal } });
  return userChangedSchema.parse(await (await refusedOrDone(res, [409, 404, 400], 'changing access')).json());
}

async function deleteUser(userId: string, signal: AbortSignal): Promise<void> {
  const res = await api.v1.admin.users[':userId'].$delete({ param: { userId } }, { init: { signal } });
  userDeletedSchema.parse(await (await refusedOrDone(res, [409, 404], 'deleting a user')).json());
}

/**
 * Adding somebody. It joins the tab's queue and is drawn at once, with the name
 * and address typed; it settles with what the server answered - whether their
 * account was ready - or with its refusal, which the caller says. **What the
 * server decides, the person's id, fills in when the list is read**, once the
 * queue has emptied.
 */
export function useAddUser(): (body: AddUser) => Promise<UserAdded> {
  const client = useQueryClient();
  return useCallback(
    (body) =>
      requestToChangeList(
        client,
        registeredUsersQuery.queryKey,
        { name: 'add_user', payload: { userId: uuidv7(), name: body.name, email: body.email } },
        (signal) => addUser(body, signal),
      ),
    [client],
  );
}

/**
 * Renaming somebody and setting their role ("Rename a user, and make somebody
 * an admin", issue 232). **The sign-in is read with the list**, because one of the
 * people an admin can rename is themselves, and the name in the header comes from
 * `me`; and a role changes what that person is offered.
 */
export function useChangeUser(): (change: ChangeUser & { userId: string }) => Promise<UserChanged> {
  const client = useQueryClient();
  return useCallback(
    (change) =>
      requestToChangeList(
        client,
        registeredUsersQuery.queryKey,
        { name: 'change_user', payload: change },
        (signal) => changeUser(change, signal),
        [meQuery.queryKey],
      ),
    [client],
  );
}

/**
 * Taking somebody's access away, or giving it back ("Take somebody's access away
 * without taking their work", issue 233). The sign-in is read with the list, for
 * the reason a rename does.
 */
export function useSetAccess(): (change: SetAccess & { userId: string }) => Promise<UserChanged> {
  const client = useQueryClient();
  return useCallback(
    (change) =>
      requestToChangeList(
        client,
        registeredUsersQuery.queryKey,
        { name: 'set_user_access', payload: change },
        (signal) => setAccess(change, signal),
        [meQuery.queryKey],
      ),
    [client],
  );
}

/** Deleting somebody. Only the list is read: nobody can delete themselves, so what `me` says cannot have changed. */
export function useDeleteUser(): (userId: string) => Promise<void> {
  const client = useQueryClient();
  return useCallback(
    (userId) =>
      requestToChangeList(client, registeredUsersQuery.queryKey, { name: 'delete_user', payload: { userId } }, (signal) => deleteUser(userId, signal)),
    [client],
  );
}
