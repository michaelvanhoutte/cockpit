import type { ConnectedAccountIdentity, OAuthDescriptor, SignInReply } from '@cockpit/connector-sdk';

/**
 * How a Workspace connects a Microsoft Teams account ("Connect a Microsoft
 * Teams source account", issue 485), described for the host to run ("Connect
 * and disconnect a source through one generic sign-in flow", issue 892).
 *
 * **Identity only.** The scopes asked for are the three signing in to Cockpit
 * already asks for and no Graph scope at all, so this reads an account's name
 * and nothing in its tenant - which is also what keeps an Entra registration
 * out of the admin-consent prompt an application asking for directory data
 * would land in.
 */

/**
 * Microsoft's multi-tenant endpoint, because whose tenant somebody connects is
 * theirs to choose. Its discovery document names itself with `{tenantid}`
 * where a real tenant goes, which the host knows how to read.
 */
export const MICROSOFT_ISSUER = 'https://login.microsoftonline.com/common/v2.0';

export function teamsSignIn(issuer: string = MICROSOFT_ISSUER): OAuthDescriptor {
  return {
    kind: 'oauth2',
    endpoints: { issuer },
    scopes: ['openid', 'email', 'profile'],
    clientSettings: { id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET' },
  };
}

/**
 * Which account at Microsoft a verified identity token names, or `null` where
 * it names nobody.
 *
 * **Tenant and object id where the token carries them**, which is what
 * Microsoft returns: `tid` names the directory and `oid` names the person
 * inside it, and the pair is the same for that person however many
 * applications they sign in to. **`sub` otherwise**, which every OpenID
 * Connect issuer guarantees and which is stable for one person at one
 * application - so a stub issuer standing in for Microsoft locally
 * (scripts/lib/stub-issuer.mjs) keys on something equally stable rather than
 * on nothing.
 */
export function teamsAccountFrom(reply: SignInReply): ConnectedAccountIdentity | null {
  const claims = reply.claims;
  if (!claims) return null;

  const tenant = text(claims.tid);
  const object = text(claims.oid);
  const subject = text(claims.sub);
  const key = tenant && object ? `${tenant}:${object}` : subject;
  // No key is no account: a token naming nobody is one there is nothing to
  // connect, and it must never fall back to a constant that two people would
  // share a row under.
  if (!key) return null;

  // **No `email_verified` here, unlike signing in.** Nothing is keyed on the
  // address - the key above is - so an address Microsoft has not checked is a
  // label on a row rather than a way into somebody's account.
  const displayName = text(claims.name) || text(claims.preferred_username) || text(claims.email);
  return { key, displayName: displayName || `Microsoft account ${key}` };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
