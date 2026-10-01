import { eq } from 'drizzle-orm';
import { hasNoAccess } from '../accounts/register.js';
import { GUEST_USER_ID } from '../accounts/new-user.js';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Env } from '../env.js';

/**
 * Who a grant acts for, and how that is asked again on every call ("Connect
 * Claude to Cockpit, and capture an item from it", issue 599).
 *
 * **What a grant carries is a person, never an account name.** An account name
 * is derived from what somebody is called, and a deleted person's name - and
 * with it their ids - is handed to whoever is added under it next
 * (`accounts/new-user.ts`). So a grant holds the person's id *and* the Google
 * identity they consented with, which is never reissued, and both have to
 * still be one row in the register for a call to act at all. Somebody new
 * under a reused id has a different identity and is nobody this grant knows.
 */

/** What the OAuth library stores, encrypted, beside a grant - and hands back on every call. */
export interface GrantProps {
  readonly userId: string;
  /** Google's own name for the person who consented (`users.google_subject`). */
  readonly subject: string;
  /** What the app registered itself as, which every capture it makes is signed with. */
  readonly clientName: string;
}

/** The account a call acts in, read from the register on the call itself, and the app making it. */
export interface GrantHolder {
  readonly accountName: string;
  readonly clientName: string;
}

/**
 * Who may consent: somebody signed in with Google, which is the register's
 * `google_subject` being there - or `null` for anybody else.
 *
 * **The guest is nobody here**, and that is the point rather than an
 * oversight: the guest account is shared by every stranger who presses
 * "Continue as guest", so a grant made from it would let any of them hand an
 * app the run of an account all the others use. It has no Google identity to
 * hold, which this refuses on already; the id is checked as well, so a guest
 * row an admin somehow gave an identity still cannot consent.
 */
export async function whoCanConsent(env: Env, userId: string): Promise<{ subject: string } | null> {
  if (userId === GUEST_USER_ID) return null;
  const [row] = await createDb(env.DB)
    .select({ subject: users.googleSubject, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!row || !row.subject || hasNoAccess(row.disabledAt)) return null;
  return { subject: row.subject };
}

/**
 * The person a grant acts for, as the register holds them now - or `null`
 * where they are gone, are somebody else under the same id, or have had their
 * access taken away since they consented. Asked on every call and on every
 * refresh (`oauth.ts`), which is what makes deleting or disabling somebody cut
 * an app off at once rather than when its token runs out.
 */
export async function grantHolder(env: Env, props: unknown): Promise<GrantHolder | null> {
  if (!isGrantProps(props) || props.userId === GUEST_USER_ID) return null;
  const [row] = await createDb(env.DB)
    .select({ accountName: users.accountId, subject: users.googleSubject, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, props.userId));
  if (!row || row.subject !== props.subject || hasNoAccess(row.disabledAt)) return null;
  return { accountName: row.accountName, clientName: props.clientName };
}

/** Whether what came back is what this application stored - a grant from an older release need not be. */
function isGrantProps(props: unknown): props is GrantProps {
  if (!props || typeof props !== 'object') return false;
  const { userId, subject, clientName } = props as Record<string, unknown>;
  return (
    typeof userId === 'string' &&
    userId.length > 0 &&
    typeof subject === 'string' &&
    subject.length > 0 &&
    typeof clientName === 'string'
  );
}
