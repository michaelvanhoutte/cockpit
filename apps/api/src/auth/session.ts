/**
 * How long a sign-in lasts and what makes one still current.
 *
 * Pure, with the clock handed in, which is what makes every branch below
 * provable at L1 (apps/api/tests/unit/auth/session.test.ts) - the alternative
 * is a test that waits a month.
 *
 * **The row is the authority, not the cookie.** The cookie carries a name for a
 * row and nothing else: no user id, no expiry, nothing signed. So there is
 * nothing in it to forge - a value that matches no row is refused by the same
 * branch that refuses a value whose row has expired - and signing out is final,
 * because deleting the row leaves the cookie naming nothing. That is the whole
 * reason the session is real from the start even though proving *who you are*
 * is currently a list of names: when Google sign-in arrives it replaces one
 * step, how we come to believe who you are, and everything here is unchanged
 * (architecture, "App login: hand-rolled Google OIDC + own sessions").
 */

/**
 * A month. Long enough that expiry is rare in ordinary use, which matters
 * because expiring mid-visit is the case the client has to recover from rather
 * than the case it is designed around.
 */
export const SIGN_IN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** A sign-in as the register holds it. */
export interface StoredSession {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: string;
}

/**
 * What a request's cookie turned out to be worth.
 *
 * `expiresAt` on a recognised sign-in is its *new* end, not the stored one:
 * using a sign-in is what extends it, so the answer to "is this still good"
 * and the answer to "until when, now" are one decision and are returned
 * together.
 */
export type SessionVerdict =
  | { readonly recognised: false }
  | { readonly recognised: true; readonly userId: string; readonly expiresAt: string };

const NOT_RECOGNISED: SessionVerdict = { recognised: false };

/**
 * Whether the sign-in a request arrived with is still current, and how long it
 * should last from here.
 *
 * A cookie naming no row arrives as `null` and is refused by the same line that
 * refuses one whose row has run out, so a guessed value and an expired sign-in
 * are indistinguishable from outside - there is nothing to learn from the
 * difference and nothing here says which it was.
 */
export function recogniseSession(
  stored: StoredSession | null | undefined,
  now: Date,
): SessionVerdict {
  if (!stored) return NOT_RECOGNISED;
  const endsAt = Date.parse(stored.expiresAt);
  // A stored instant that cannot be read is not a sign-in that never ends. The
  // register's CHECK constraint makes this unreachable from the database; it is
  // written out because the alternative reading - NaN comparing false and the
  // sign-in being accepted forever - is the expensive way to be wrong.
  if (!Number.isFinite(endsAt) || endsAt <= now.getTime()) return NOT_RECOGNISED;
  return { recognised: true, userId: stored.userId, expiresAt: endsFrom(now) };
}

/** When a sign-in used at `now` should stop being believed. */
export function endsFrom(now: Date): string {
  return new Date(now.getTime() + SIGN_IN_LIFETIME_MS).toISOString();
}
