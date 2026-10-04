import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { gmailAccountFrom, gmailAuthorizationUrl } from '../../../src/connectors/gmail.js';
import type { IssuerEndpoints } from '../../../src/auth/oidc.js';

/**
 * L1: what connecting a Gmail account asks Google for, and which mailbox the
 * answer names ("Connect a Gmail account to a workspace, and disconnect it",
 * issue 724). Both are pure but for a signature check handed in. Whether a
 * token is believed at all is `claimsFrom`'s, exhausted in
 * tests/unit/auth/oidc.test.ts; what is stored of the answer, and what is
 * refused, needs the store and is tests/integration/http/gmail-connections.test.ts's.
 */

const ISSUER = 'https://accounts.google.test';
const CLIENT_ID = 'gmails-own-client.apps.googleusercontent.com';
const NONCE = 'the-nonce-this-connection-sent';
const NOW = new Date('2026-10-04T12:00:00.000Z');

const endpoints: IssuerEndpoints = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/o/oauth2/v2/auth`,
  tokenEndpoint: `${ISSUER}/token`,
  jwksUri: `${ISSUER}/certs`,
};

let ours: CryptoKeyPair;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  ours = await generateKeyPair('RS256', { extractable: true });
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(ours.publicKey)), alg: 'RS256' }] });
});

function identityToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ nonce: NONCE, ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt(NOW)
    .setExpirationTime(new Date(NOW.getTime() + 60 * 60 * 1000))
    .sign(ours.privateKey);
}

describe('Connector management', () => {
  describe('connecting Gmail asks Google for the permission to change mail and for a refresh token', () => {
    it('the address Connect leaves for names Gmail’s own client, that permission, offline access and the consent prompt', async () => {
      const attempt = { state: 'a-state', nonce: NONCE, codeVerifier: 'a-verifier' };

      const url = new URL(
        await gmailAuthorizationUrl(endpoints, CLIENT_ID, 'https://cockpit.test/v1/connections/gmail/callback', attempt),
      );

      expect(url.origin + url.pathname).toBe(endpoints.authorizationEndpoint);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: CLIENT_ID,
        redirect_uri: 'https://cockpit.test/v1/connections/gmail/callback',
        access_type: 'offline',
        state: 'a-state',
        nonce: NONCE,
      });
      expect(url.searchParams.get('scope')!.split(' ')).toEqual(
        expect.arrayContaining(['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify']),
      );
      expect(url.searchParams.get('prompt')!.split(' ')).toContain('consent');
    });
  });

  describe('a connected Gmail account is named by its address and known by Google’s own id for it', () => {
    it.each([
      {
        situation: 'an address written in capitals',
        claims: { sub: 'google-123', email: ' Anna@Example.com ' },
        reads: { key: 'google-123', address: 'anna@example.com' },
      },
      {
        situation: 'no address at all',
        claims: { sub: 'google-123' },
        reads: 'the account could not be read',
      },
      {
        situation: 'nobody named',
        claims: { email: 'anna@example.com' },
        reads: 'the account could not be read',
      },
    ])('reads $situation', async ({ claims, reads }) => {
      const account = await gmailAccountFrom(
        await identityToken(claims),
        keys,
        { issuer: ISSUER, clientId: CLIENT_ID, nonce: NONCE },
        NOW,
      );

      expect(account).toEqual(reads);
    });
  });
});
