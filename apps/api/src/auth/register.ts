import { and, asc, eq, gt } from 'drizzle-orm';
import type { User } from '@cockpit/shared';
import { createDb } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import type { Env } from '../env.js';
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
   * Carried, and read by nothing. There is no admin-only page to guard yet, so
   * enforcing it here would be a branch with no behaviour behind it; it is on
   * the visitor so that the first page which needs one finds it already there
   * rather than having to thread it through ("Sign in by picking a name, each
   * user in their own account", issue 86).
   */
  readonly role: string;
}

/**
 * The people to choose from, by name, oldest first.
 *
 * **Names and ids only, deliberately.** This is the one read that answers
 * before anybody has signed in - it is what you look at while you are still
 * nobody - so which account a person owns and what role they hold are not in
 * the projection at all, rather than being stripped somewhere downstream.
 */
export async function listUsers(env: Env): Promise<User[]> {
  const db = createDb(env.DB);
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id));
}

/**
 * Starts a sign-in for the named person, or answers `null` when there is no
 * such person.
 *
 * The `null` is the whole refusal: a name that is not on the list cannot be
 * signed in as, and nothing is written on the way to finding that out.
 */
export async function startSession(
  env: Env,
  userId: string,
  now: Date,
): Promise<{ sessionId: string; expiresAt: string; user: User } | null> {
  const db = createDb(env.DB);
  const [found] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!found) return null;

  const sessionId = newSessionId();
  const expiresAt = endsFrom(now);
  await db
    .insert(sessions)
    .values({ id: sessionId, userId: found.id, createdAt: now.toISOString(), expiresAt });
  return { sessionId, expiresAt, user: found };
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
