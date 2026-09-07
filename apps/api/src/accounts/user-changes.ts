/**
 * What changing somebody has to decide before the register is written ("Rename
 * a user, and make somebody an admin", issue 232).
 *
 * Pure, and apart from the write, for the reason `new-user.ts` is: the rules
 * worth arguing about are here and none of them needs a database
 * (`tests/unit/accounts/user-changes.test.ts`). The write is then one UPDATE.
 */

import { losingAdminIsRefused, type Role } from '@cockpit/shared';
import type { Refusal } from './new-user.js';

/** What an admin asked to change about somebody. */
export interface UserChange {
  name: string;
  role: Role;
}

/** Somebody as the register currently holds them, in the parts a change reads. */
export interface AsHeld {
  id: string;
  /**
   * `string` rather than `Role`, for the reason `roleOpens` takes one
   * (`auth/admin.ts`): the column is asserted at compile time and held by a
   * CHECK at runtime, and this is what has to be right if either is ever
   * wrong.
   */
  role: string;
}

/**
 * Why this change cannot be made, or `null` when it can - in the words the
 * person who asked for it reads.
 *
 * **Which changes are refused is `losingAdminIsRefused`'s and is shared with
 * the form**, so the choice the page draws as unavailable and the change the
 * server turns away cannot come apart. What is here is the sentence each refusal
 * is said in, and the one rule the form has no part in: a name is needed.
 *
 * Everything else is allowed on purpose. A name another user already holds is
 * accepted, because names have never been unique here and the register does not
 * ask them to be; making somebody an admin is never refused, since the danger is
 * only ever in taking the role away.
 */
export function whatStopsChanging({
  who,
  change,
  askedBy,
  admins,
}: {
  who: AsHeld;
  change: UserChange;
  /** The id of the admin asking, which two of the rules are about. */
  askedBy: string;
  /** Everybody the register holds the admin role for, this person included. */
  admins: readonly string[];
}): Refusal | null {
  if (change.name.trim().length === 0) return { what: 'a name is needed' };

  const losing = losingAdminIsRefused({
    who,
    role: change.role,
    askedBy,
    admins: admins.length,
  });
  /**
   * The second reason is not that it is dangerous - it is the mistake that
   * cannot be undone by the person making it. An admin who takes their own role
   * away is on the far side of the gate the moment the request lands, so the
   * page they would put it back from is one they can no longer open. Another
   * admin can, which is what this says.
   */
  if (losing === 'the last admin') {
    return {
      what: 'this is the only admin, so make somebody else an admin before taking this one away',
    };
  }
  if (losing === 'your own') {
    return { what: 'you cannot take your own admin away - another admin can do it for you' };
  }
  return null;
}
