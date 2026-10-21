import type {
  ConnectedAccountIdentity,
  OAuthDescriptor,
  SignInRefused,
  SignInReply,
} from '@cockpit/connector-sdk';

/**
 * How a Workspace connects an Outlook mailbox, described for the host to run:
 * permission to read and change mail, a refresh token to outlive the hour an
 * access token lasts, and the three reasons a grant is refused.
 */

/** Microsoft's multi-tenant endpoint, because whose tenant somebody connects is theirs to choose. */
export const MICROSOFT_ISSUER = 'https://login.microsoftonline.com/common/v2.0';

/**
 * The delegated permission to read and change the signed-in person's own mail.
 * Asked for from the first connection so nobody has to connect again when
 * changing the mark follows; Microsoft offers nothing narrower that can set a
 * flag or a category.
 */
export const MAIL_READ_WRITE = 'Mail.ReadWrite';

/** The tenant Microsoft gives every personal account (Outlook.com, Hotmail): not a work or school directory. */
export const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

/**
 * Why a grant is refused, as the codes `accountFrom` answers and the sentences
 * the Connections window shows for them: each names the one thing that would
 * make the next attempt go through.
 */
export const OUTLOOK_REFUSALS = {
  'personal-account':
    'Cockpit connects Outlook for Microsoft 365 work or school accounts only, so nothing was stored. Connect again with a work or school account.',
  'no-refresh-token':
    'Microsoft did not let Cockpit stay signed in, so nothing was stored. Connect again, and accept the permission to stay signed in.',
  'permission-missing':
    'Microsoft did not give Cockpit permission to read and change your mail, so nothing was stored. Connect again and accept it, or ask your administrator to approve Cockpit.',
} as const satisfies Record<string, string>;

/**
 * `offline_access` is what gets a refresh token at all. The client is the
 * multi-tenant Entra application Teams connections already use, so people who
 * connected Teams are not asked again for anything but the mail permission.
 */
export function outlookSignIn(issuer: string = MICROSOFT_ISSUER): OAuthDescriptor {
  return {
    kind: 'oauth2',
    endpoints: { issuer },
    scopes: ['openid', 'email', 'profile', 'offline_access', MAIL_READ_WRITE],
    clientSettings: { id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET' },
    refusals: OUTLOOK_REFUSALS,
  };
}

/**
 * Whose mailbox a verified identity token names - or why the grant is not the
 * one asked for.
 *
 * **Keyed on tenant and object id**, which Microsoft keeps for a person
 * whatever their address becomes; nothing less than both is an account. **A
 * personal account is refused** by its tenant. **No refresh token and a missing
 * `Mail.ReadWrite` are refusals too**: the grant lets the person untick or an
 * administrator withhold the permission, and a connection that cannot read or
 * change mail is not the one asked for.
 */
export function outlookAccountFrom(reply: SignInReply): ConnectedAccountIdentity | SignInRefused | null {
  const claims = reply.claims;
  if (!claims) return null;
  const tenant = text(claims.tid);
  const object = text(claims.oid);
  if (!tenant || !object) return null;

  if (tenant.toLowerCase() === CONSUMER_TENANT) return { refused: 'personal-account' };
  if (!text(reply.tokenResponse.refresh_token)) return { refused: 'no-refresh-token' };
  if (!grants(text(reply.tokenResponse.scope))) return { refused: 'permission-missing' };

  // The sign-in address first, as Gmail names its connections, so two mailboxes under one name stay apart.
  const displayName = text(claims.preferred_username) || text(claims.email) || text(claims.name);
  const key = `${tenant}:${object}`;
  return { key, displayName: displayName || `Microsoft account ${key}` };
}

/** Whether a granted scope list holds the mail permission, named bare or by its resource. */
function grants(scope: string): boolean {
  return scope
    .split(/\s+/)
    .some((one) => one.toLowerCase() === MAIL_READ_WRITE.toLowerCase() || one.toLowerCase().endsWith(`/${MAIL_READ_WRITE.toLowerCase()}`));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
