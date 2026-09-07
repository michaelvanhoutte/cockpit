/**
 * What changing somebody has to decide before the register is written ("Rename
 * a user, and make somebody an admin", issue 232).
 *
 * Pure, and apart from the write, for the reason `new-user.ts` is: the rules
 * worth arguing about are here and none of them needs a database
 * (`tests/unit/accounts/user-changes.test.ts`). The write is then one UPDATE.
 */

import { ADMIN, type Role } from '@cockpit/shared';
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
 * Why this change cannot be made, or `null` when it can.
 *
 * **Two refusals, and both exist because the alternative locks everybody out of
 * the admin pages for good** - there is no way back in but the SQL the
 * environment was bootstrapped with. They are separate because their reasons
 * are: "another admin can do it for you" is false when you are the only one.
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

  // Only losing the role can lock anybody out; gaining it never can.
  if (who.role !== ADMIN || change.role === ADMIN) return null;

  if (admins.filter((id) => id !== who.id).length === 0) {
    return {
      what: 'this is the only admin, so make somebody else an admin before taking this one away',
    };
  }
  /**
   * **Not because it is dangerous - because it is the mistake that cannot be
   * undone by the person making it.** An admin who takes their own role away is
   * on the far side of the gate the moment the request lands, so the page they
   * would put it back from is one they can no longer open. Another admin can,
   * which is what this says.
   */
  if (who.id === askedBy) {
    return { what: 'you cannot take your own admin away - another admin can do it for you' };
  }
  return null;
}
