import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Role } from '@cockpit/shared';
import { createDb } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import type { Env } from '../env.js';
import type { Identity } from './oidc.js';
import { endsFrom, type StoredSession } from './session.js';

/**
 * The register's half of signing in: who the people are, and which sign-ins are
 * current.
 *
 * It is in D1 with the list of accounts and for the same reason - every
 * question here is asked *before* an account is known, so there is nowhere else
 * to ask it. An account's own store is addressed by account name, and the name
 * is exactly what these queries are for.
 */

/** Everything the gate learned about whoever sent the request. */
export interface Visitor {
  readonly userId: string;
  readonly name: string;
  /** The account whose store holds this person's work. */
  readonly accountName: string;
  /**
   * What this person may open: `auth/admin.ts` reads it off the visitor and
   * nothing else does ("See who can sign in, on a page only an admin can open",
   * issue 230). It rode here unread from "Sign in by picking a name, each user
   * in their own account" (issue 86) so that the first page needing one would
   * find it already there, which is what that turn out to have bought.
   *
   * **Read per request, from the register**, which is why taking somebody's
   * admin away applies to the sign-in they are already holding rather than to
   * their next one.
   *
   * Typed as the two roles there are, like the column it is read from
   * (`db/schema.ts`) and the contract it is answered into: it is the same value
   * all the way through, and leaving it `string` here would widen it back at
   * the one boundary where it is compared.
   */
  readonly role: Role;
}

/**
 * Signs in whoever Google says this is, or answers `null` because they are not
 * somebody this Cockpit knows.
 *
 * **The register is the allowlist** ("Sign in with Google, and retire the list
 * of names", issue 196). Proving who you are at Google is not the same as being
 * entitled to an account here, and nothing in this function creates one: a
 * person is put in the register deliberately, and everyone else is refused
 * having had nothing written on their behalf.
 *
 * Somebody is looked for by their Google identity first and by their address
 * only if that finds nobody, which is what makes a changed address harmless and
 * a *reassigned* one safe: the identity never changes and is never reissued,
 * while an address can be given to somebody new. The first sign-in is the one
 * that has only the address to go on, and recording the identity then is what
 * closes that door behind it.
 */
export async function signInWithGoogle(
  env: Env,
  identity: Identity,
  now: Date,
): Promise<{ sessionId: string; expiresAt: string; user: SigningIn } | null> {
  const db = createDb(env.DB);

  const [known] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.googleSubject, identity.subject));
  if (known) return startVisit(env, known, now);

  const [byAddress] = await db
    .select({ id: users.id, name: users.name, googleSubject: users.googleSubject })
    .from(users)
    .where(eq(users.email, identity.email));
  // Somebody whose address this is, but who is a different Google account than
  // the one that claimed it: refused, because an address given to a new owner
  // would otherwise be a way into the previous owner's account.
  if (!byAddress || byAddress.googleSubject) return null;

  const recorded = await db
    .update(users)
    .set({ googleSubject: identity.subject })
    .where(and(eq(users.id, byAddress.id), isNull(users.googleSubject)));
  // Two first sign-ins at once: the other one recorded an identity while this
  // one was deciding, so this request no longer knows whose account it is
  // looking at and refuses rather than guessing. The next attempt finds the
  // recorded identity by the query above and succeeds.
  if (!recorded.meta.changes) return null;

  return startVisit(env, { id: byAddress.id, name: byAddress.name }, now);
}

/**
 * Who a sign-in is being started for, which is a row's id and name and nothing
 * else.
 *
 * **Its own type rather than the wire's `User`**, which the browser's needs
 * widen: `User` gained a role for the app to decide what to offer ("See who can
 * sign in, on a page only an admin can open", issue 230), and typing the
 * sign-in path against it would have this query read a column no caller of it
 * reads. What is signed in with is the register's business; what is shown is
 * the contract's.
 */
type SigningIn = { id: string; name: string };

/**
 * A sign-in of its own, always: whatever the browser arrived holding is neither
 * read nor reused, so there is nothing to fix a session onto.
 */
async function startVisit(
  env: Env,
  user: SigningIn,
  now: Date,
): Promise<{ sessionId: string; expiresAt: string; user: SigningIn }> {
  const sessionId = newSessionId();
  const expiresAt = endsFrom(now);
  await createDb(env.DB)
    .insert(sessions)
    .values({ id: sessionId, userId: user.id, createdAt: now.toISOString(), expiresAt });
  return { sessionId, expiresAt, user };
}

/**
 * The sign-in a cookie names, together with who it belongs to - one query,
 * because the gate needs both on every request and asking twice would double
 * the register's traffic for nothing.
 *
 * Whether it is still current is not decided here: that is `recogniseSession`,
 * which is pure and where the rules are proved.
 */
export async function sessionHeld(
  env: Env,
  sessionId: string,
): Promise<{ session: StoredSession; visitor: Visitor } | null> {
  const db = createDb(env.DB);
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      name: users.name,
      accountName: users.accountId,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId));
  if (!row) return null;

  return {
    session: { id: row.id, userId: row.userId, expiresAt: row.expiresAt },
    visitor: {
      userId: row.userId,
      name: row.name,
      accountName: row.accountName,
      role: row.role,
    },
  };
}

/**
 * Pushes a sign-in's end out, because it was used.
 *
 * Guarded on the row not having expired in the meantime, so that a request
 * arriving at the same moment a sign-in runs out cannot resurrect it: the read
 * and this write are two round trips to D1, and without the guard the second
 * would happily extend a row the first had already found dead.
 */
export async function extendSession(
  env: Env,
  sessionId: string,
  expiresAt: string,
  now: Date,
): Promise<void> {
  const db = createDb(env.DB);
  await db
    .update(sessions)
    .set({ expiresAt })
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now.toISOString())));
}

/**
 * Ends a sign-in for good. The row is the authority, so once it is gone the
 * same cookie value names nothing and is refused like any other.
 */
export async function endSession(env: Env, sessionId: string): Promise<void> {
  const db = createDb(env.DB);
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * 256 bits from the platform's own CSPRNG, hex-encoded.
 *
 * The value is the entire credential - it names a row and carries nothing else
 * - so its only defence is being unguessable, and it is generated here rather
 * than derived from anything about the user.
 */
function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
