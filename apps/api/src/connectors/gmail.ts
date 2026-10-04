import type { JWTVerifyGetKey } from 'jose';
import { authorizationUrl, claimsFrom, normaliseAddress, type Attempt, type IssuerEndpoints } from '../auth/oidc.js';

/**
 * What connecting a Gmail account asks Google for, and what is believed and
 * kept of the answer ("Connect a Gmail account to a workspace, and disconnect
 * it", issue 724).
 *
 * Pure but for the signature check, handed in as `teams.ts` beside it takes
 * it, so every branch is provable at L1 (tests/unit/connectors/gmail.test.ts).
 */

/**
 * The permission to change mail, asked for from the first connection so
 * nobody has to connect again when taking the label off lands. Google offers
 * nothing narrower that can remove a label, so touching only `Cockpit` is
 * Cockpit's own rule rather than Google's.
 */
export const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

/** `openid email` say whose mailbox it is; the rest is the mailbox. */
const SCOPES = `openid email ${GMAIL_MODIFY}`;

/** Why a Gmail connection was not believed - the log's words, never a person's. */
export type GmailRefusal =
  | 'the reply belongs to another connection'
  | 'the account could not be read'
  | 'Google gave no refresh token'
  | 'the permission to change mail was not granted';

export interface GmailAccount {
  /** Google's own name for the person, which never changes: what makes connecting it again a refresh. */
  readonly key: string;
  /** The address, which is what the row is called. */
  readonly address: string;
}

/**
 * Where Connect sends the browser: the sign-in's own address, asking through
 * Gmail's client for the permission to change mail and for a refresh token.
 *
 * `access_type=offline` is what gets a refresh token at all, and
 * `prompt=consent` is what gets one every time rather than only the first:
 * Google hands one out only when it asks, so an account connected before,
 * disconnected elsewhere and connected again would otherwise come back with
 * none. `select_account` beside it, because several accounts may be
 * connected and each has to be chosen.
 */
export async function gmailAuthorizationUrl(
  endpoints: IssuerEndpoints,
  clientId: string,
  redirectUri: string,
  attempt: Attempt,
): Promise<string> {
  const url = new URL(await authorizationUrl(endpoints, clientId, redirectUri, attempt));
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'select_account consent');
  return url.toString();
}

/**
 * Whose mailbox this is, from an identity token Google signed for this
 * connection - or why it would not be believed. Keyed on `sub` rather than
 * the address, which a Google account can change.
 */
export async function gmailAccountFrom(
  idToken: string,
  keys: JWTVerifyGetKey,
  expected: { issuer: string; clientId: string; nonce: string },
  now: Date,
): Promise<GmailAccount | GmailRefusal> {
  const claims = await claimsFrom(idToken, keys, expected, now);
  if (typeof claims === 'string') {
    return claims === 'the identity answers a different sign-in'
      ? 'the reply belongs to another connection'
      : 'the account could not be read';
  }
  const key = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  const address = typeof claims.email === 'string' ? normaliseAddress(claims.email) : '';
  if (!key || !address) return 'the account could not be read';
  return { key, address };
}

/**
 * What is sealed into the connection: the refresh token, and the hour-long
 * access token beside it with when it lapses, which the next slices refresh
 * and re-seal in the same place - and the mailbox's key, so disconnecting
 * can tell whether another Workspace still holds the same grant. Or why
 * there is nothing worth keeping.
 *
 * **No refresh token is a refusal**, because without one the connection
 * cannot outlive the hour. **The permission to change mail missing is one
 * too**: Google's consent screen lets each permission be unticked, and a
 * connection that cannot take the label off is not the one asked for.
 */
export function gmailCredentialFrom(
  asIssued: string,
  mailboxKey: string,
  now: Date,
): { credential: string } | GmailRefusal {
  let answer: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(asIssued);
    if (!parsed || typeof parsed !== 'object') return 'Google gave no refresh token';
    answer = parsed as Record<string, unknown>;
  } catch {
    return 'Google gave no refresh token';
  }
  const refreshToken = typeof answer.refresh_token === 'string' ? answer.refresh_token : '';
  if (!refreshToken) return 'Google gave no refresh token';
  const granted = typeof answer.scope === 'string' ? answer.scope.split(' ') : [];
  if (!granted.includes(GMAIL_MODIFY)) return 'the permission to change mail was not granted';

  const accessToken = typeof answer.access_token === 'string' ? answer.access_token : null;
  const expiresIn = typeof answer.expires_in === 'number' ? answer.expires_in : null;
  return {
    credential: JSON.stringify({
      mailboxKey,
      refreshToken,
      accessToken,
      accessTokenExpiresAt:
        accessToken && expiresIn !== null ? new Date(now.getTime() + expiresIn * 1000).toISOString() : null,
    }),
  };
}

/**
 * The refresh token inside a sealed-and-opened Gmail credential, and the
 * mailbox it is for - null for a credential holding no token, and a null
 * key for one sealed without it.
 */
export function revocableIn(credential: string): { refreshToken: string; mailboxKey: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(credential);
    if (!parsed || typeof parsed !== 'object') return null;
    const { refreshToken, mailboxKey } = parsed as Record<string, unknown>;
    if (typeof refreshToken !== 'string' || !refreshToken) return null;
    return { refreshToken, mailboxKey: typeof mailboxKey === 'string' && mailboxKey ? mailboxKey : null };
  } catch {
    return null;
  }
}
