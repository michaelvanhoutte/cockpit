import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../env.js';
import type { IssuerEndpoints } from './oidc.js';

/**
 * The half of signing in that talks to Google: where it answers, which keys it
 * is signing with today, and spending a code for an identity.
 *
 * It is here rather than in oidc.ts so that everything deciding *what to
 * believe* stays pure and provable at L1. What is left in this file is I/O with
 * no branching worth proving anywhere but against a real issuer, which
 * tests/integration/http/sign-in.test.ts does against the stub.
 */

/**
 * Google, unless something says otherwise.
 *
 * **`OIDC_ISSUER` is how local development and the browser suite point at the
 * stub issuer**, which is what lets them run the same flow this file runs
 * against Google - one sign-in path everywhere, rather than a bypass in the
 * application defended by a variable being unset. No deployed environment sets
 * it (apps/api/wrangler.jsonc), and the day one did, it would be signing people
 * in against whatever it named: it is configuration with the weight of a
 * secret, and docs/deployment.md says so where the secrets are listed.
 */
const GOOGLE = 'https://accounts.google.com';

export function issuerFor(env: Env): string {
  return env.OIDC_ISSUER?.trim() || GOOGLE;
}

/**
 * Where an issuer says it answers, from its own discovery document.
 *
 * Asked rather than written down, because an issuer is entitled to move its own
 * endpoints and Google periodically does; and cached for the life of the
 * isolate, because the answer changes on the order of years while a sign-in
 * asks for it twice. A failed lookup is not cached: the next sign-in asks
 * again rather than inheriting a bad minute.
 */
const discovered = new Map<string, Promise<IssuerEndpoints>>();

export function endpointsFor(issuer: string): Promise<IssuerEndpoints> {
  const known = discovered.get(issuer);
  if (known) return known;

  const asking = discover(issuer).catch((error: unknown) => {
    discovered.delete(issuer);
    throw error;
  });
  discovered.set(issuer, asking);
  return asking;
}

async function discover(issuer: string): Promise<IssuerEndpoints> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`${issuer} answered ${response.status} about itself`);
  const document = (await response.json()) as Record<string, unknown>;
  const endpoints = {
    issuer: asUrl(document.issuer, 'issuer'),
    authorizationEndpoint: asUrl(document.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: asUrl(document.token_endpoint, 'token_endpoint'),
    jwksUri: asUrl(document.jwks_uri, 'jwks_uri'),
  };
  // An issuer that names somebody else as itself is the one thing here worth
  // refusing outright: every later check is made against this name.
  if (endpoints.issuer !== issuer) {
    throw new Error(`${issuer} calls itself ${endpoints.issuer}`);
  }
  return endpoints;
}

function asUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    throw new Error(`discovery document has no usable ${field}`);
  }
  return value;
}

/**
 * The issuer's current signing keys.
 *
 * `createRemoteJWKSet` does the fetching, the caching and the re-fetch when a
 * token arrives signed by a key it has not seen, which is what makes an
 * issuer's key rotation invisible here. One per `jwks_uri`, because each holds
 * that cache.
 */
const keySets = new Map<string, JWTVerifyGetKey>();

export function keysOf(endpoints: IssuerEndpoints): JWTVerifyGetKey {
  const known = keySets.get(endpoints.jwksUri);
  if (known) return known;
  const keys = createRemoteJWKSet(new URL(endpoints.jwksUri));
  keySets.set(endpoints.jwksUri, keys);
  return keys;
}

/**
 * Spends the code for an identity token, or answers `null`.
 *
 * The verifier goes with it, which is what proves this is the same sign-in the
 * code was issued to - and the reason a code intercepted in the browser's
 * history or a referrer header is worth nothing on its own.
 *
 * A refusal here is not distinguished from a network failure, because the
 * answer is the same either way and neither is anything the person signing in
 * can act on. The status goes to the log.
 */
export async function exchangeCode(
  endpoints: IssuerEndpoints,
  credentials: { clientId: string; clientSecret: string },
  reply: { code: string; codeVerifier: string; redirectUri: string },
): Promise<string | null> {
  const response = await fetch(endpoints.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: reply.code,
      code_verifier: reply.codeVerifier,
      redirect_uri: reply.redirectUri,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });

  if (!response.ok) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `the issuer refused to exchange a code: ${response.status}`,
      }),
    );
    return null;
  }

  const body = (await response.json()) as { id_token?: unknown };
  return typeof body.id_token === 'string' && body.id_token ? body.id_token : null;
}
