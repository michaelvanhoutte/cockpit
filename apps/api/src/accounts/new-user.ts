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
 * The address, in the one spelling the register compares by.
 *
 * **Folded, because the unique index compares what is written** (`db/schema.ts`).
 * Two rows differing only in case would both be allowed in and only one would
 * ever be found, so whatever writes an address has to settle on a spelling
 * first - and this is that decision, made in one place so signing in and adding
 * a person cannot disagree about who somebody is.
 */
export function foldAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Whether an address is shaped like one.
 *
 * Deliberately shallow: something before an `@`, something after it, and a dot
 * in the domain. **Whether a Google account is behind it is not knowable here**
 * and is answered the first time that person signs in, so a stricter rule would
 * only refuse addresses that work.
 */
export function addressLooksReal(address: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(foldAddress(address));
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

  for (let suffix = 1; ; suffix += 1) {
    const ending = suffix === 1 ? part : `${part}-${suffix}`;
    // Bounded again after the suffix: a name that only just fitted must not be
    // pushed past the limit by being disambiguated.
    const account = `${ACCOUNT_PREFIX}${ending}`.slice(0, ACCOUNT_NAME_LIMIT);
    const ids = { accountId: account, userId: `${USER_PREFIX}${ending}` };
    if (!taken(ids)) return ids;
  }
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
  if (foldAddress(address).length === 0) {
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
