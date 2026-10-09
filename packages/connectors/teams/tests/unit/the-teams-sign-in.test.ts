import { describe, expect, it } from 'vitest';
import type { SignInReply } from '@cockpit/connector-sdk';
import { createTeamsConnector } from '../../src/index.js';
import { BOT_APP_ID } from './bot-framework.js';

/**
 * L1: which account at Microsoft a verified identity token names, and what the
 * connection is called ("Connect and disconnect a source through one generic
 * sign-in flow", issue 892). Whether a token is believed at all is the host's,
 * before it is handed over (apps/api/tests/unit/auth/oidc.test.ts); what the
 * claims are worth once they are is this connector's alone, so they are handed
 * in directly.
 */

const connector = createTeamsConnector({ appId: BOT_APP_ID });

function accountFor(claims: Record<string, unknown> | null) {
  const reply: SignInReply = { claims, tokenResponse: {} };
  return connector.accountFrom!(reply);
}

describe('Connector management', () => {
  describe('which account at the source was connected is read off what the source signed', () => {
    /**
     * The key is the pair Microsoft returns where it returns it, and the
     * subject every OpenID Connect issuer promises where it does not.
     */
    it.each([
      {
        situation: 'the directory and the person in it, where the source names both',
        claims: { sub: 'ms-subject-for-this-app', tid: 'a-tenant', oid: 'a-person' },
        key: 'a-tenant:a-person',
      },
      {
        situation: 'who the source says this is, where it names no directory',
        claims: { sub: 'ms-subject-for-this-app' },
        key: 'ms-subject-for-this-app',
      },
      {
        situation: 'who the source says this is, where it names a directory and nobody in it',
        claims: { sub: 'ms-subject-for-this-app', tid: 'a-tenant' },
        key: 'ms-subject-for-this-app',
      },
    ])('is $situation', ({ claims, key }) => {
      expect(accountFor(claims)).toMatchObject({ key });
    });

    /**
     * Two people in one directory are two connections, and one person in two
     * directories is two as well - which is what the pair being the key means
     * rather than either half of it.
     */
    it('tells two accounts apart by either half of the pair', () => {
      const keys = [
        { sub: 's', tid: 'atlas', oid: 'ada' },
        { sub: 's', tid: 'atlas', oid: 'michael' },
        { sub: 's', tid: 'novy', oid: 'ada' },
      ].map((claims) => (accountFor(claims) as { key: string }).key);

      expect(new Set(keys).size).toBe(3);
    });

    it.each([
      { situation: 'a token naming nobody at all', claims: { sub: '' } },
      { situation: 'a reply with no identity token to read', claims: null },
    ])('names no account for $situation', ({ claims }) => {
      expect(accountFor(claims)).toBeNull();
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
    ])('is called $situation', ({ claims, called }) => {
      expect(accountFor({ sub: 's', ...claims })).toMatchObject({ displayName: called });
    });

    /**
     * Signing in refuses an address the issuer has not checked, because the
     * register is keyed on it. Nothing here is: the key above is, and the
     * address is a label. Refusing one would turn a connection Microsoft is
     * perfectly happy with into a failure nobody could act on.
     */
    it('is listed even where the source has not checked the address', () => {
      expect(accountFor({ sub: 's', email: 'ada@atlas.example', email_verified: false })).toMatchObject({
        displayName: 'ada@atlas.example',
      });
    });
  });

  describe('a connector says how it is signed in to, and the host runs it', () => {
    it('asks as the Entra application for an identity and no Graph scope, through Microsoft unless pointed elsewhere', () => {
      expect(connector.manifest.auth).toEqual({
        kind: 'oauth2',
        endpoints: { issuer: 'https://login.microsoftonline.com/common/v2.0' },
        scopes: ['openid', 'email', 'profile'],
        clientSettings: { id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET' },
      });
      expect(
        createTeamsConnector({ appId: BOT_APP_ID, issuer: 'https://stub.test' }).manifest.auth,
      ).toMatchObject({ endpoints: { issuer: 'https://stub.test' } });
    });
  });
});
