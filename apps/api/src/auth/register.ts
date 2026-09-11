import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Role } from '@cockpit/shared';
import { GUEST_ACCOUNT_NAME, GUEST_USER_ID } from '../accounts/new-user.js';
import { admitNewcomer, hasNoAccess } from '../accounts/register.js';
import { createDb } from '../db/client.js';
import { sessions, tenants, users } from '../db/schema.js';
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
 * Signs in whoever Google says this is, making them a user and an account of
 * their own where the register has never seen them - or says which of the two
 * refusals this is: an address that belongs to a different Google account, or
 * somebody whose access was taken away.
 *
 * **Anybody with a Google account gets in** ("Sign in with any Google account,
 * so a recruiter doesn't need to be added first", issue 343), which reverses
 * the register being the allowlist ("Sign in with Google, and retire the list
 * of names", issue 196): Cockpit is also a demo that somebody has to be able to
 * walk up to. What the register still decides is *whose* row a sign-in opens,
 * and anybody it already holds is found exactly as before.
 *
 * **Read again after losing a race to write.** Two first sign-ins of one
 * stranger at once both find nothing and both write; the register's uniqueness
 * lets one through, and the other reads again and finds it - so exactly one
 * person is made and both sign-ins land in their account. Bounded, because a
 * write can only lose to one that has already committed, so a second loss in
 * a row is two different strangers deriving the same ids twice over.
 */
export async function signInWithGoogle(
  env: Env,
  identity: Identity,
  now: Date,
): Promise<SignIn> {
  for (let read = 1; read <= READS_BEFORE_GIVING_UP; read += 1) {
    const known = await signInSomebodyKnown(env, identity, now);
    if (known) return known;

    const admitted = await admitNewcomer(env, identity, now);
    if (admitted) {
      return { ...(await startVisit(env, admitted.user, now)), newAccount: admitted.accountId };
    }
  }
  // Said without the address: the register logs ids, never who they belong to.
  throw new Error(`a first sign-in lost a race to write ${READS_BEFORE_GIVING_UP} times`);
}

const READS_BEFORE_GIVING_UP = 3;

/**
 * Signs in somebody the register already holds, or answers `null` where it
 * holds nobody by either their Google identity or their address.
 *
 * Somebody is looked for by their Google identity first and by their address
 * only if that finds nobody, which is what makes a changed address harmless and
 * a *reassigned* one safe: the identity never changes and is never reissued,
 * while an address can be given to somebody new. The first sign-in of somebody
 * an admin added is the one that has only the address to go on, and recording
 * the identity then is what closes that door behind it.
 */
async function signInSomebodyKnown(
  env: Env,
  identity: Identity,
  now: Date,
): Promise<SignIn | null> {
  const db = createDb(env.DB);

  const [known] = await db
    .select({ id: users.id, name: users.name, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.googleSubject, identity.subject));
  if (known) {
    if (hasNoAccess(known.disabledAt)) return TURNED_AWAY;
    // Narrowed here rather than handed on whole, for the reason `SigningIn`
    // exists: what is signed in with is a row's id and name, and a column that
    // rode along would be one this path publishes without meaning to.
    return startVisit(env, { id: known.id, name: known.name }, now);
  }

  const [byAddress] = await db
    .select({
      id: users.id,
      name: users.name,
      googleSubject: users.googleSubject,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(eq(users.email, identity.email));
  if (!byAddress) return null;
  // Somebody whose address this is, but who is a different Google account than
  // the one that claimed it: refused, because an address given to a new owner
  // would otherwise be a way into the previous owner's account.
  if (byAddress.googleSubject) return NOT_KNOWN;
  /**
   * Answered before the identity is recorded, so somebody whose access was
   * taken away before they ever signed in is turned away without this Cockpit
   * learning which Google account they are. It is also the honest order: they
   * are refused for having no access, not for being a stranger.
   */
  if (hasNoAccess(byAddress.disabledAt)) return TURNED_AWAY;

  const recorded = await db
    .update(users)
    .set({ googleSubject: identity.subject })
    .where(and(eq(users.id, byAddress.id), isNull(users.googleSubject)));
  // Two first sign-ins at once: the other one recorded an identity while this
  // one was deciding, so this request no longer knows whose account it is
  // looking at and refuses rather than guessing. The next attempt finds the
  // recorded identity by the query above and succeeds.
  if (!recorded.meta.changes) return NOT_KNOWN;

  return startVisit(env, { id: byAddress.id, name: byAddress.name }, now);
}

/**
 * What signing in came to: a visit, or which of the two refusals this was.
 *
 * **They are told apart on purpose**, and the person is told which ("Take
 * somebody's access away without taking their work", issue 233). Saying "that
 * Google account cannot sign in here" to somebody whose access was removed
 * would be a false statement to a real colleague, who would go looking for a
 * sign-in problem that is not theirs to fix. The cost is that anyone trying the
 * address learns this Cockpit holds it - a disclosure taken knowingly, and the
 * smaller harm of the two.
 *
 * `not known` is now only an address held by a different Google account than
 * the one claiming it, since anybody the register has never seen is admitted.
 */
export type SignIn = Visit | { signedIn: false; because: 'not known' | 'access removed' };

/**
 * The half of that which happened: what the browser is given to carry, and
 * whose it is.
 *
 * Named separately because `startVisit` itself never refuses - whatever calls
 * it has already decided somebody may sign in, so its own return would make
 * every caller narrow past a branch that cannot occur there.
 */
export type Visit = {
  signedIn: true;
  sessionId: string;
  expiresAt: string;
  user: SigningIn;
  /**
   * The account this sign-in made, where it made one - for the route to open
   * straight away, the way adding somebody opens theirs (`http/app.ts`).
   */
  newAccount?: string;
};

const NOT_KNOWN = { signedIn: false, because: 'not known' } as const;
const TURNED_AWAY = { signedIn: false, because: 'access removed' } as const;

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
 * The one guest account, which everybody who continues as a guest shares
 * ("Sign in as a guest, without a password", issue 354). Its ids live with the
 * derivation that must never hand them to anybody else (`accounts/new-user.ts`).
 * Concurrent guests deliberately land in the same account and see each other's
 * work, which the daily reset that follows this issue is what makes safe.
 */
export { GUEST_ACCOUNT_NAME, GUEST_USER_ID };
const GUEST_NAME = 'Guest';

/**
 * Signs whoever asked into that account, making it the first time anybody does
 * - unless the id is not really the guest's, which is checked rather than
 * assumed.
 *
 * **Nothing decides whether a stranger is allowed in**: that is the whole
 * feature, and what gates it is the environment offering the route at all
 * (`env.GUEST_SIGN_IN`, read where the route is). The guest is a row the
 * product puts there, shared by everybody, where a Google sign-in makes each
 * stranger an account of their own.
 *
 * Both writes ignore a conflict on the id, which is what makes two first
 * presses at the same instant come to one account: whichever write lost wrote
 * nothing, and both go on to read the row that is actually there. The tenant
 * goes first because the user's account is a real foreign key to it.
 *
 * **The row is read back and checked before anybody is signed into it.** These
 * ids have the shape `idsForNewUser` gives a real person, and though it never
 * hands them out (`accounts/new-user.ts`), a restored backup or a hand-written
 * row still can - and then both inserts above would conflict and write nothing,
 * and this would sign a stranger straight into that person's real account with
 * whatever role they hold. What no real user ever has is a null address -
 * `addUser` requires one and a Google sign-in brings one - so a row with one is
 * never anybody's but the guest's, and the guest is refused right along with a
 * disabled one rather than trusted on sight.
 *
 * **The role is checked too, and not because the insert above could ever write
 * `admin`.** Nothing stops an admin later promoting the row this makes through
 * the ordinary "Rename a user, and make somebody an admin" page (issue 232) -
 * it reads like any other person in that list. This is the one place that
 * mistake is answered: no *new* guest sign-in completes once it has happened.
 * A session already open when it happens is not touched here - the gate reads
 * a visitor's role fresh on every request (`auth/gate.ts`), the same way any
 * other promotion or demotion takes effect, and closing that door wider than
 * this route belongs to whatever answers it for everybody else, not to guest
 * sign-in alone.
 */
export async function signInAsGuest(env: Env, now: Date): Promise<SignIn> {
  const db = createDb(env.DB);
  const createdAt = now.toISOString();

  await db
    .insert(tenants)
    .values({ id: GUEST_ACCOUNT_NAME, name: GUEST_NAME, createdAt })
    .onConflictDoNothing({ target: tenants.id });
  await db
    .insert(users)
    .values({
      id: GUEST_USER_ID,
      name: GUEST_NAME,
      accountId: GUEST_ACCOUNT_NAME,
      role: 'user',
      createdAt,
    })
    .onConflictDoNothing({ target: users.id });

  const [row] = await db
    .select({ email: users.email, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, GUEST_USER_ID));
  if (!row || row.email != null || row.role !== 'user' || hasNoAccess(row.disabledAt)) {
    return TURNED_AWAY;
  }

  return startVisit(env, { id: GUEST_USER_ID, name: GUEST_NAME }, now);
}

/**
 * A sign-in of its own, always: whatever the browser arrived holding is neither
 * read nor reused, so there is nothing to fix a session onto.
 *
 * **The register's `last_signed_in_at` is written in the same batch** ("Show
 * when each person last signed in, on the admin page", issue 342): this
 * function runs only for a deliberate sign-in - a real round trip through
 * Google, or a press of "Continue as guest" - never when a session merely
 * renews itself (`extendSession`), so it is the one place that distinction
 * already exists to write from. Through `createDb`, like every other write
 * and read in this file, rather than a raw `env.DB.prepare(...)` - a column
 * renamed in `db/schema.ts` then fails to typecheck here instead of failing
 * at runtime the first time somebody signs in.
 */
async function startVisit(env: Env, user: SigningIn, now: Date): Promise<Visit> {
  const sessionId = newSessionId();
  const expiresAt = endsFrom(now);
  const at = now.toISOString();
  const db = createDb(env.DB);
  await db.batch([
    db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: at, expiresAt }),
    db.update(users).set({ lastSignedInAt: at }).where(eq(users.id, user.id)),
  ]);
  return { signedIn: true, sessionId, expiresAt, user };
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
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId));
  if (!row) return null;
  /**
   * **The second lock on access being taken away.** Disabling somebody deletes
   * the sign-ins they hold, and no new one can be made for them, so no request
   * should ever reach here holding one - except in the moment where a sign-in
   * lands as the disabling commits, which is the one thing that ordering cannot
   * close. What that would otherwise buy is a live session for somebody whose
   * access was removed, which is the failure this whole issue exists to
   * prevent; it is caught here rather than left to expire.
   */
  if (hasNoAccess(row.disabledAt)) return null;

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
