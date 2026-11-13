import type { ConnectedAccountIdentity, OAuthDescriptor, PermissionDescriptor, SignInReply } from '@cockpit/connector-sdk';

/**
 * How a Workspace connects a Microsoft Teams account ("Connect a Microsoft
 * Teams source account", issue 485), described for the host to run ("Connect
 * and disconnect a source through one generic sign-in flow", issue 892).
 *
 * **Asked in tiers** ("Read pasted Teams links: connecting Teams asks for no read
 * permission", issue 1754): the most it can read, then less, and last who the
 * person is and nothing in their tenant. Microsoft refuses a whole sign-in
 * when one permission in it needs an administrator, so each refusal of that
 * kind asks again for the next tier, which is what keeps an organisation that
 * will not approve a read from refusing the connection altogether. Nothing is
 * read in a tier that asks for no Graph scope: the last is what connecting
 * Teams was before, and the three identity scopes are what signing in to
 * Cockpit already asks for.
 */

/**
 * Microsoft's multi-tenant endpoint, because whose tenant somebody connects is
 * theirs to choose. Its discovery document names itself with `{tenantid}`
 * where a real tenant goes, which the host knows how to read.
 */
export const MICROSOFT_ISSUER = 'https://login.microsoftonline.com/common/v2.0';

/** Who the person is: the three scopes signing in to Cockpit asks, and no Graph scope at all. */
const IDENTITY = ['openid', 'email', 'profile'];

/** What a Teams connection may be granted, as the codes the tiers name and the card's words for each. */
export const TEAMS_PERMISSIONS = [
  { code: 'chats', granted: 'Reads pasted chat links' },
  { code: 'channels', withheld: "Channel posts need your IT's approval" },
] as const satisfies readonly PermissionDescriptor[];

export function teamsSignIn(issuer: string = MICROSOFT_ISSUER): OAuthDescriptor {
  return {
    kind: 'oauth2',
    endpoints: { issuer },
    scopes: [...IDENTITY],
    tiers: [
      { scopes: [...IDENTITY, 'offline_access', 'Chat.Read', 'ChannelMessage.Read.All'], grants: ['chats', 'channels'] },
      { scopes: [...IDENTITY, 'offline_access', 'Chat.Read'], grants: ['chats'] },
      { scopes: [...IDENTITY], grants: [] },
    ],
    permissions: [...TEAMS_PERMISSIONS],
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
  // The sign-in address first, as Gmail names its connections, so two accounts under one name stay apart.
  const displayName = text(claims.preferred_username) || text(claims.email) || text(claims.name);
  return { key, displayName: displayName || `Microsoft account ${key}` };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
