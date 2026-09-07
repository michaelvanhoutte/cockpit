/**
 * What adding a user has to decide before the register is touched: the ids the
 * two rows get, and whether the address is one at all.
 *
 * Pure, and apart from the write, because every rule worth arguing about is
 * here and none of it needs a database to be proved
 * (`tests/unit/accounts/new-user.test.ts`). The write is then the short part:
 * two rows, one batch.
 */

/**
 * How long an account's name may be.
 *
 * **A backup writes an account's name as a file name** (`scripts/lib/backup.mjs`)
 * and a Windows path stops at 260 characters, so a name is bounded here rather
 * than discovered to be unusable on the day somebody takes a backup. 48 leaves
 * room for the directory a backup goes in and the `.json` after it.
 */
export const ACCOUNT_NAME_LIMIT = 48;

const ACCOUNT_PREFIX = 'tenant-';
const USER_PREFIX = 'user-';

/**
 * The address, in the one spelling the register compares by - which is
 * `normaliseAddress`, taken from the sign-in rather than written again.
 *
 * **Two foldings would be two identities.** Signing in looks a person up by the
 * address Google gave, and adding one writes the address an admin typed; if
 * those ever settled differently - one stripping a `+tag` or Gmail's dots and
 * the other not - the person added would simply be refused at sign-in, with
 * nothing anywhere reporting an error. So there is one function and this is a
 * name for it.
 */
export { normaliseAddress as foldAddress } from '../auth/oidc.js';
import { normaliseAddress } from '../auth/oidc.js';

/**
 * Whether an address is shaped like one.
 *
 * Deliberately shallow: something before an `@`, something after it, and a dot
 * in the domain. **Whether a Google account is behind it is not knowable here**
 * and is answered the first time that person signs in, so a stricter rule would
 * only refuse addresses that work.
 */
export function addressLooksReal(address: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normaliseAddress(address));
}

/**
 * The part of an id derived from somebody's name, or `null` when their name
 * leaves nothing usable.
 *
 * **Case folded upper-then-lower rather than lowercased**, so `Straße` derives
 * `strasse` rather than losing the letter: `ß` has no single-character
 * uppercase, and upper-then-lower is what turns it into something an id can
 * hold.
 */
export function nameAsIdPart(name: string): string | null {
  const folded = name.toUpperCase().toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ACCOUNT_NAME_LIMIT - ACCOUNT_PREFIX.length);
  const trimmed = slug.replace(/-+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/** The two ids a new person and their account get. */
export interface NewIds {
  accountId: string;
  userId: string;
}

/**
 * The ids for somebody being added, or `null` when their name leaves nothing an
 * id can be made of.
 *
 * **Two people may share a name and both get in.** Names have never been unique
 * in this product and the register does not ask them to be; what it enforces is
 * the address. So a derived id already taken is extended - `anna`, `anna-2`,
 * `anna-3` - rather than refused, and the pair keeps the same suffix so a person
 * and their account still read as belonging together.
 *
 * `taken` answers for both ids at once, because either being in use means this
 * number is not free: they are handed out as a pair and nothing would be gained
 * by an account called `anna-2` whose owner is `user-anna-3`.
 */
export function idsForNewUser(name: string, taken: (ids: NewIds) => boolean): NewIds | null {
  const part = nameAsIdPart(name);
  if (!part) return null;

  const room = ACCOUNT_NAME_LIMIT - ACCOUNT_PREFIX.length;
  for (let suffix = 1; suffix <= SUFFIXES_TRIED; suffix += 1) {
    const tag = suffix === 1 ? '' : `-${suffix}`;
    /**
     * **Room is made for the suffix rather than taken from it**, which is what
     * makes this loop finish. Appending `-2` and then cutting the result back
     * to the limit produced the *same* string every time for a name that
     * already filled it - `tenant-<41 letters>` truncating identically at every
     * suffix - so the candidate stopped changing while the register went on
     * saying it was taken, and the request spun until the Worker's CPU limit
     * killed it. Trimming the name instead means every suffix is a different id.
     */
    const base = part.slice(0, room - tag.length).replace(/-+$/, '');
    if (!base) return null;

    const ending = `${base}${tag}`;
    const ids = { accountId: `${ACCOUNT_PREFIX}${ending}`, userId: `${USER_PREFIX}${ending}` };
    if (!taken(ids)) return ids;
  }
  // Bounded rather than endless: a register holding a thousand people of one
  // name is not a case to keep searching, and a refusal an admin can read beats
  // a request that never answers.
  return null;
}

/** How many people of one name can be told apart before adding says no. */
const SUFFIXES_TRIED = 1000;

/**
 * The prefix every id this name could derive begins with - what a lookup has to
 * search on to see all of them.
 *
 * **It is shorter than the name derives**, and that is the whole point: a
 * candidate with a suffix has room made for it by trimming the name, so
 * `tenant-<40 letters>-2` does *not* begin with `tenant-<40 letters>`. A lookup
 * keyed on the untruncated part cannot see the suffixed ids at all - it hands
 * out one that is already somebody's, the insert is refused by the register's
 * own uniqueness, and the person is told to try again for ever, since every
 * attempt derives the same id. Reserving the longest tag here is what keeps
 * this and `idsForNewUser` from disagreeing about what an id can look like.
 *
 * Trailing dashes are trimmed for the same reason they are in a candidate: a
 * prefix ending in one would not be a prefix of a base that had it trimmed.
 */
export function idSearchPrefix(name: string): string | null {
  const part = nameAsIdPart(name);
  if (!part) return null;
  const room = ACCOUNT_NAME_LIMIT - ACCOUNT_PREFIX.length - `-${SUFFIXES_TRIED}`.length;
  return part.slice(0, room).replace(/-+$/, '') || part;
}

/** Why somebody could not be added, in words the person who typed it can act on. */
export type Refusal = { what: string };

/**
 * What is wrong with what was typed, or `null` when nothing is.
 *
 * The address is checked before the name because it is the one that makes a
 * user real: the register is the allowlist, so a row without an address is
 * somebody nobody can sign in as.
 */
export function whatIsWrongWith({ name, address }: { name: string; address: string }): Refusal | null {
  if (normaliseAddress(address).length === 0) {
    return { what: 'an address is what somebody signs in with, so it is needed' };
  }
  if (!addressLooksReal(address)) {
    return { what: `${address.trim()} is not an address somebody could sign in with` };
  }
  if (name.trim().length === 0) return { what: 'a name is needed' };
  if (nameAsIdPart(name) === null) {
    return { what: `${name.trim()} leaves nothing an account could be named after` };
  }
  return null;
}
