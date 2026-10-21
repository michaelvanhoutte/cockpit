import type { RegisteredUser } from '@cockpit/shared';
import type { Drawn } from './drawnAhead';

/** A person as the Users window draws them: the register's row, and whether it is one this tab added that the server has not been read for. */
export type ShownUser = RegisteredUser & {
  /** Added here and not yet read back: its id is this tab's own and the server's is not known, so there is nothing yet to change it by. */
  pending?: true;
};

export interface ShownUsers {
  users: ShownUser[];
}

/**
 * What the Users window shows of a change the server has not answered yet, or has
 * answered and no read of the list has landed since ("Show a connected app or user
 * change the moment you make it", issue 1371).
 *
 * **The list as the server sent it, with the change applied to a copy**, as
 * `connectionsDrawnAhead.ts` does for connections: the held list is never written
 * to, so a read in flight cannot flip the screen back. It lives in the window's
 * own chunk, since nothing else draws a user.
 *
 * - **Add:** the person at once, with the name and address typed (the address as
 *   the register keeps it), an ordinary user who has never signed in, in the account
 *   the register makes for them, named for them. The id the server decides is not
 *   predicted, so the row is `pending` until the list is read. Placed where the
 *   register's own order puts it, by name, so it does not jump when it is read. One
 *   the list already holds, by name and address, is left alone: a read begun before
 *   the answer can hold them already. Somebody else's address is drawn all the same,
 *   until the refusal takes the row away.
 * - **Rename, change the role:** the row has them; the account the person owns is
 *   named after them, as the server names it.
 * - **Block, unblock:** the row says it has no access, or stops saying so.
 * - **Delete:** the row is gone.
 *
 * A change the server will refuse is drawn all the same until the refusal puts the
 * list back.
 */
export function usersDrawnOver(list: ShownUsers, changes: readonly Drawn[]): ShownUsers {
  const rewrite = (held: ShownUsers, id: string, change: (user: ShownUser) => ShownUser): ShownUsers => ({
    users: held.users.map((user) => (user.id === id ? change(user) : user)),
  });
  return changes.reduce((held, change) => {
    switch (change.name) {
      case 'add_user': {
        const { userId: id, name, email } = change.payload;
        const address = email.trim().toLowerCase();
        const named = name.trim();
        if (held.users.some((user) => user.email === address && user.name === named)) return held;
        const added: ShownUser = {
          id,
          name: named,
          email: address,
          role: 'user',
          accountName: named,
          lastSignedInAt: null,
          disabled: false,
          pending: true,
        };
        const before = held.users.findIndex((user) => user.name.toLowerCase() > named.toLowerCase());
        const at = before === -1 ? held.users.length : before;
        return { users: [...held.users.slice(0, at), added, ...held.users.slice(at)] };
      }
      case 'change_user': {
        const { userId: id, name, role } = change.payload;
        const named = name.trim();
        return rewrite(held, id, (user) => ({ ...user, name: named, role, accountName: named }));
      }
      case 'set_user_access':
        return rewrite(held, change.payload.userId, (user) => ({ ...user, disabled: change.payload.disabled }));
      case 'delete_user':
        return { users: held.users.filter((user) => user.id !== change.payload.userId) };
      default:
        return held;
    }
  }, list);
}
