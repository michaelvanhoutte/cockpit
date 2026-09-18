import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { teamsAccountFrom } from '../../../src/connectors/teams.js';

/**
 * L1, against real tokens and a real key, for the reason
 * tests/unit/auth/oidc.test.ts gives about the sign-in half: this decides
 * which account at Microsoft a Workspace has connected, and getting the key
 * wrong is two people sharing a row or one person collecting a row per
 * sign-in.
 *
 * Whether a token is believed at all is not re-proved here - that is
 * `claimsFrom`'s, exhausted in oidc.test.ts - beyond the one case that shows
 * this asks it.
 */

const ISSUER = 'https://login.microsoftonline.com/a-tenant/v2.0';
const CLIENT_ID = 'the-entra-application';
const NONCE = 'the-nonce-this-connection-sent';
const NOW = new Date('2026-09-18T12:00:00.000Z');

let ours: CryptoKeyPair;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  ours = await generateKeyPair('RS256', { extractable: true });
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(ours.publicKey)), alg: 'RS256' }] });
});

function identityToken(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ nonce: NONCE, ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(typeof claims.sub === 'string' ? claims.sub : 'ms-subject-for-this-app')
    .setIssuedAt(NOW)
    .setExpirationTime(new Date(NOW.getTime() + 60 * 60 * 1000))
    .sign(ours.privateKey);
}

function accountFor(token: string) {
  return teamsAccountFrom(token, keys, { issuer: ISSUER, clientId: CLIENT_ID, nonce: NONCE }, NOW);
}

describe('Connector management', () => {
  describe('which account at the source was connected is read off what the source signed', () => {
    /**
     * The issue left this open ("the exact uniqueness key ... is confirmed
     * against what the id_token actually returns during the build"), and this
     * is the answer: the pair Microsoft returns where it returns it, and the
     * subject every OpenID Connect issuer promises where it does not.
     */
    it.each([
      {
        situation: 'the directory and the person in it, where the source names both',
        claims: { tid: 'a-tenant', oid: 'a-person' },
        key: 'a-tenant:a-person',
      },
      {
        situation: 'who the source says this is, where it names no directory',
        claims: {},
        key: 'ms-subject-for-this-app',
      },
      {
        situation: 'who the source says this is, where it names a directory and nobody in it',
        claims: { tid: 'a-tenant' },
        key: 'ms-subject-for-this-app',
      },
    ])('is $situation', async ({ claims, key }) => {
      await expect(accountFor(await identityToken(claims))).resolves.toMatchObject({ key });
    });

    /**
     * Two people in one directory are two connections, and one person in two
     * directories is two as well - which is what the pair being the key means
     * rather than either half of it.
     */
    it('tells two accounts apart by either half of the pair', async () => {
      const one = await accountFor(await identityToken({ tid: 'atlas', oid: 'ada' }));
      const otherPerson = await accountFor(await identityToken({ tid: 'atlas', oid: 'michael' }));
      const otherTenant = await accountFor(await identityToken({ tid: 'novy', oid: 'ada' }));

      expect(new Set([one, otherPerson, otherTenant].map((a) => (a as { key: string }).key)).size).toBe(3);
    });

    it('refuses a token naming nobody at all', async () => {
      await expect(accountFor(await identityToken({ sub: '' }))).resolves.toBe(
        'the account could not be read',
      );
    });

    /**
     * The one case here about believing the token rather than reading it: it
     * proves the checks are asked on this path, which is all this level can
     * say about them.
     */
    it('refuses a token answering a different connection', async () => {
      const token = await new SignJWT({ nonce: 'the-nonce-of-some-other-connection' })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject('ms-subject-for-this-app')
        .setIssuedAt(NOW)
        .setExpirationTime(new Date(NOW.getTime() + 60 * 60 * 1000))
        .sign(ours.privateKey);

      await expect(accountFor(token)).resolves.toBe('the reply belongs to another connection');
    });
  });

  describe('a connected source account is listed under a name that says whose it is', () => {
    it.each([
      {
        situation: 'the name the source gives',
        claims: { name: '  Ada Lovelace ', preferred_username: 'ada@atlas.example' },
        called: 'Ada Lovelace',
      },
      {
        situation: 'the address it signs in with, where the source gives no name',
        claims: { preferred_username: 'ada@atlas.example' },
        called: 'ada@atlas.example',
      },
      {
        situation: 'its other address, where there is no name and no username',
        claims: { email: 'ada@atlas.example' },
        called: 'ada@atlas.example',
      },
      {
        situation: 'which account it is, where the source says nothing readable at all',
        claims: { tid: 'atlas', oid: 'ada' },
        called: 'Microsoft account atlas:ada',
      },
    ])('is called $situation', async ({ claims, called }) => {
      await expect(accountFor(await identityToken(claims))).resolves.toMatchObject({
        displayName: called,
      });
    });

    /**
     * Signing in refuses an address the issuer has not checked, because the
     * register is keyed on it. Nothing here is: the key above is, and the
     * address is a label. Refusing one would turn a connection Microsoft is
     * perfectly happy with into a failure nobody could act on.
     */
    it('is listed even where the source has not checked the address', async () => {
      await expect(
        accountFor(await identityToken({ email: 'ada@atlas.example', email_verified: false })),
      ).resolves.toMatchObject({ displayName: 'ada@atlas.example' });
    });
  });
});
