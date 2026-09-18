import type { JWTVerifyGetKey } from 'jose';
import { claimsFrom } from '../auth/oidc.js';

/**
 * Who Microsoft says a Workspace has just connected ("Connect a Microsoft
 * Teams source account", issue 485).
 *
 * **Identity only.** The scopes asked for are the three signing in already
 * asks for (`SCOPES`, auth/oidc.ts) and no Graph scope at all, so this reads
 * an account's name and nothing in its tenant - which is also what keeps an
 * Entra registration out of the admin-consent prompt an application asking
 * for directory data would land in.
 *
 * Pure, and provable at L1 against real tokens (tests/unit/connectors/teams.ts):
 * the signature check is handed in, the same way `identityFrom` beside it
 * takes its key set.
 */

/** Why a Teams sign-in was not believed - the log's words, never a person's. */
export type ConnectRefusal =
  | 'the reply belongs to another connection'
  | 'the account could not be read';

export interface TeamsAccount {
  /**
   * Which account at Microsoft this is, and the whole of what makes
   * connecting the same one twice a refresh rather than a second row.
   *
   * **Tenant and object id where the token carries them**, which is what
   * Microsoft returns: `tid` names the directory and `oid` names the person
   * inside it, and the pair is the same for that person however many
   * applications they sign in to. **`sub` otherwise**, which every OpenID
   * Connect issuer guarantees and which is stable for one person at one
   * application - so a stub issuer standing in for Microsoft locally
   * (scripts/lib/stub-issuer.mjs) keys on something equally stable rather
   * than on nothing. The issue left the exact key to be confirmed against a
   * real token, and this is that answer: prefer what Microsoft gives, fall
   * back to what OIDC promises.
   */
  readonly key: string;
  /** What the row calls it: the name Microsoft gave, or the address it signs in with. */
  readonly displayName: string;
}

/**
 * Reads the account out of an identity token, or says why it would not be
 * believed. Everything about *whether* to believe it is `claimsFrom`'s, which
 * signing in uses for the same five checks.
 */
export async function teamsAccountFrom(
  idToken: string,
  keys: JWTVerifyGetKey,
  expected: { issuer: string; clientId: string; nonce: string },
  now: Date,
): Promise<TeamsAccount | ConnectRefusal> {
  const claims = await claimsFrom(idToken, keys, expected, now);
  if (typeof claims === 'string') {
    return claims === 'the identity answers a different sign-in'
      ? 'the reply belongs to another connection'
      : 'the account could not be read';
  }

  const tenant = text(claims.tid);
  const object = text(claims.oid);
  const subject = text(claims.sub);
  const key = tenant && object ? `${tenant}:${object}` : subject;
  // No key is no account: a token naming nobody is one there is nothing to
  // connect, and it must never fall back to a constant that two people would
  // share a row under.
  if (!key) return 'the account could not be read';

  // **No `email_verified` here, unlike signing in.** Nothing is keyed on the
  // address - the key above is - so an address Microsoft has not checked is a
  // label on a row rather than a way into somebody's account.
  const displayName = text(claims.name) || text(claims.preferred_username) || text(claims.email);
  return { key, displayName: displayName || `Microsoft account ${key}` };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
