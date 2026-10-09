import type { ConnectedAccountIdentity, Connector, OAuthDescriptor } from '@cockpit/connector-sdk';
import { authorizationUrl, claimsFrom, type Attempt } from '../auth/oidc.js';
import { endpointsFor, exchangeCode, keysOf, spendCode } from '../auth/issuer.js';
import type { Env } from '../env.js';
import { getConnector } from './registry.js';

/**
 * Signing a Workspace in to any registered source, driven by what the source's
 * connector says about its own sign-in ("Connect and disconnect a source
 * through one generic sign-in flow", issue 892): where to send the browser,
 * which client to ask as, and, once the source has answered, which account it
 * named.
 *
 * What stays in the routes (`http/app.ts`) is the navigation: the Workspace
 * and account carried in the attempt cookie, the session check, sealing and
 * the command that stores. What is here is the conversation with the source,
 * which differs per source only in what the connector's description says.
 */

/** A registered connector that signs in with OAuth, and how. */
export interface SignIn {
  readonly connector: Connector;
  readonly auth: OAuthDescriptor;
}

/**
 * The sign-in the connector registered under this id describes, or `null` for
 * an id nothing is registered under and for a connector with no sign-in to
 * run - both are the same "nothing to connect here".
 */
export function signInOf(env: Env, connectorId: string): SignIn | null {
  const connector = getConnector(env, connectorId);
  if (!connector || connector.manifest.auth.kind !== 'oauth2') return null;
  return { connector, auth: connector.manifest.auth };
}

/**
 * The client the source issued this Cockpit, read from the settings the
 * connector names, or `null` where either is not set - a deployment nobody has
 * configured for this, which is nothing a person did.
 */
export function clientOf(
  env: Env,
  auth: OAuthDescriptor,
): { clientId: string; clientSecret: string } | null {
  const settings = env as unknown as Record<string, unknown>;
  const read = (name: string) => (typeof settings[name] === 'string' ? (settings[name] as string).trim() : '');
  const clientId = read(auth.clientSettings.id);
  const clientSecret = read(auth.clientSettings.secret);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Where the source is told to send the browser back: one address per source
 * and the same for every Workspace, because it has to be character-for-
 * character a redirect URI registered with the source, and a per-Workspace
 * address could never be. Which Workspace asked is carried in the attempt
 * cookie, where the browser cannot choose it (`auth/gate.ts`).
 */
export function callbackUrlFor(env: Env, connectorId: string): string {
  return new URL(`/v1/connections/${encodeURIComponent(connectorId)}/callback`, env.APP_ORIGIN).toString();
}

/** Where to send the browser to be asked whose account this is. */
export async function authorizationRequest(
  env: Env,
  sign: SignIn,
  client: { clientId: string },
  attempt: Attempt,
): Promise<string> {
  const { endpoints, scopes } = sign.auth;
  const where =
    'issuer' in endpoints
      ? await endpointsFor(endpoints.issuer)
      : { authorizationEndpoint: endpoints.authorizationUrl };
  return authorizationUrl(
    where,
    client.clientId,
    callbackUrlFor(env, sign.connector.manifest.id),
    attempt,
    scopes.join(' '),
    sign.auth.authorizationParams,
  );
}

/** Why a sign-in was not completed - the log's words, never a person's. */
export type SignInRefusal =
  | 'the exchange was refused'
  | 'the identity could not be read'
  | 'the identity answers a different sign-in'
  | 'the account could not be read'
  | 'the grant was refused';

export type AccountSignedIn =
  | { readonly signedIn: true; readonly account: ConnectedAccountIdentity; readonly asIssued: string }
  | {
      readonly signedIn: false;
      readonly refusal: SignInRefusal;
      /** The code the connector's own account step gave for the grant it refused, where it listed one. */
      readonly because?: string;
    };

/**
 * Spends the code the source sent the browser back with and says whose
 * account that was.
 *
 * **`asIssued` is the token response exactly as the source answered it**, and
 * is what the credential is sealed from: picking fields out of it here would
 * decide, today, which of them a connector may use later.
 */
export async function accountSignedIn(
  env: Env,
  sign: SignIn,
  client: { clientId: string; clientSecret: string },
  code: string,
  attempt: Attempt,
  now: Date,
): Promise<AccountSignedIn> {
  const { endpoints } = sign.auth;
  const spend = {
    code,
    codeVerifier: attempt.codeVerifier,
    redirectUri: callbackUrlFor(env, sign.connector.manifest.id),
  };

  let asIssued: string;
  let claims: Record<string, unknown> | null = null;
  if ('issuer' in endpoints) {
    const discovered = await endpointsFor(endpoints.issuer);
    const exchanged = await exchangeCode(discovered, client, spend);
    if (!exchanged) return refused('the exchange was refused');
    // Believed for the same five reasons signing in believes a token, then
    // read by the connector for what it knows about its own source.
    const believed = await claimsFrom(
      exchanged.idToken,
      keysOf(discovered),
      { issuer: discovered.issuer, clientId: client.clientId, nonce: attempt.nonce },
      now,
    );
    if (typeof believed === 'string') {
      return refused(
        believed === 'the identity answers a different sign-in'
          ? believed
          : 'the identity could not be read',
      );
    }
    asIssued = exchanged.asIssued;
    claims = believed as Record<string, unknown>;
  } else {
    const spent = await spendCode(endpoints.tokenUrl, client, spend);
    if (spent === null) return refused('the exchange was refused');
    asIssued = spent;
  }

  const tokenResponse = parsedObject(asIssued);
  if (!tokenResponse) return refused('the account could not be read');
  const account = sign.connector.accountFrom?.({ claims, tokenResponse }) ?? null;
  if (!account) return refused('the account could not be read');
  if ('refused' in account) {
    // Only a code the description lists is carried on: the window has a
    // sentence for those, and anything else is a plain refusal.
    const listed = Object.hasOwn(sign.auth.refusals ?? {}, account.refused);
    return {
      signedIn: false,
      refusal: 'the grant was refused',
      ...(listed ? { because: account.refused } : {}),
    };
  }
  return { signedIn: true, account, asIssued };
}

function refused(refusal: SignInRefusal): AccountSignedIn {
  return { signedIn: false, refusal };
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
