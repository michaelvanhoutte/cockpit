import type {
  ConnectedAccountIdentity,
  OAuthDescriptor,
  SignInRefused,
  SignInReply,
} from '@cockpit/connector-sdk';

/**
 * How a Workspace connects a Gmail mailbox, described for the host to run: the
 * permission to change mail, a refresh token to outlive the hour an access
 * token lasts, and the two reasons a grant is refused.
 */

/**
 * The permission to change mail, asked for from the first connection so nobody
 * has to connect again when taking the label off lands. Google offers nothing
 * narrower that can remove a label, so touching only the mark followed is
 * Cockpit's own rule rather than Google's.
 */
export const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

/** Google's own issuer, whose discovery document names its endpoints and signing keys. */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

/**
 * Why a grant is refused, as the codes `accountFrom` answers and the sentences
 * the Connections window shows for them: each names the one thing that would
 * make the next attempt go through.
 */
export const GMAIL_REFUSALS = {
  'no-refresh-token':
    'Google did not let Cockpit stay signed in, so nothing was stored. Remove Cockpit under third-party access in your Google account, then connect again.',
  'permission-missing':
    'Google did not give Cockpit permission to change your mail, so nothing was stored. Connect again, and tick the Gmail box on Google’s last screen.',
} as const satisfies Record<string, string>;

/**
 * `access_type=offline` is what gets a refresh token at all, and
 * `prompt=consent` is what gets one every time rather than only the first:
 * Google hands one out only when it asks, so an account connected before,
 * disconnected elsewhere and connected again would otherwise come back with
 * none. `select_account` beside it, because several accounts may be connected
 * and each has to be chosen.
 */
export function gmailSignIn(issuer: string = GOOGLE_ISSUER): OAuthDescriptor {
  return {
    kind: 'oauth2',
    endpoints: { issuer },
    scopes: ['openid', 'email', GMAIL_MODIFY],
    clientSettings: { id: 'GMAIL_CLIENT_ID', secret: 'GMAIL_CLIENT_SECRET' },
    authorizationParams: { access_type: 'offline', prompt: 'select_account consent' },
    refusals: GMAIL_REFUSALS,
  };
}

/**
 * Whose mailbox a verified identity token names - or why the grant is not the
 * one asked for.
 *
 * **Keyed on `sub`, not the address**, which a Google account can change. The
 * address, lower-cased, is what the connection is called. **No refresh token is
 * a refusal**, because without one the connection cannot outlive the hour.
 * **The permission to change mail missing is one too**: Google's consent screen
 * lets each permission be unticked, and a connection that cannot take the label
 * off is not the one asked for.
 */
export function gmailAccountFrom(reply: SignInReply): ConnectedAccountIdentity | SignInRefused | null {
  const claims = reply.claims;
  if (!claims) return null;
  const key = text(claims.sub);
  const address = text(claims.email).toLowerCase();
  if (!key || !address) return null;

  if (!text(reply.tokenResponse.refresh_token)) return { refused: 'no-refresh-token' };
  const granted = text(reply.tokenResponse.scope).split(/\s+/);
  if (!granted.includes(GMAIL_MODIFY)) return { refused: 'permission-missing' };

  return { key, displayName: address };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
