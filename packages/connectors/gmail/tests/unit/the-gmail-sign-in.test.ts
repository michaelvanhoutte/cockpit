import { describe, expect, it } from 'vitest';
import type { SignInReply } from '@cockpit/connector-sdk';
import { GMAIL_MODIFY, GMAIL_REFUSALS, createGmailConnector } from '../../src/index.js';
import { signedInHost, GmailWorld, REVOKE_URL, TOKEN_URL } from './gmail-world.js';

/**
 * L1: how a Workspace connects a Gmail mailbox and disconnects it ("Build Gmail
 * as a connector package on the SDK, unregistered", issue 943). Whether the
 * identity token is believed at all is the host's, before `accountFrom` is
 * asked; what the grant is worth once it is, is this connector's alone.
 */

const world = new GmailWorld();
const connector = world.connector();

const GRANTED = `openid email ${GMAIL_MODIFY}`;

function accountFor(claims: Record<string, unknown> | null, tokenResponse: Record<string, unknown>) {
  const reply: SignInReply = { claims, tokenResponse };
  return connector.accountFrom!(reply);
}

describe('Connector management', () => {
  describe('connecting Gmail asks Google for the permission to change mail and for a refresh token', () => {
    it('describes a sign-in with the mailbox scope, offline access and a forced consent screen, through Gmail’s own client', () => {
      const { auth } = connector.manifest;

      expect(auth).toMatchObject({
        kind: 'oauth2',
        endpoints: { issuer: 'https://accounts.google.com' },
        clientSettings: { id: 'GMAIL_CLIENT_ID', secret: 'GMAIL_CLIENT_SECRET' },
        authorizationParams: { access_type: 'offline' },
      });
      expect(auth.kind === 'oauth2' && auth.scopes).toEqual(['openid', 'email', GMAIL_MODIFY]);
      expect(auth.kind === 'oauth2' && auth.authorizationParams?.prompt?.split(' ')).toContain('consent');
    });

    it('signs in at the issuer it was told to, where one overrides Google', () => {
      const local = createGmailConnector({ clientId: 'c', clientSecret: 's', issuer: 'http://localhost:9000' });

      expect(local.manifest.auth).toMatchObject({ endpoints: { issuer: 'http://localhost:9000' } });
    });

    it('declares every refusal with the sentence the Connections window shows for it', () => {
      expect(connector.manifest.auth).toMatchObject({ refusals: GMAIL_REFUSALS });
      for (const sentence of Object.values(GMAIL_REFUSALS)) expect(sentence).toMatch(/nothing was stored/);
    });
  });

  describe('a Gmail grant is accepted only with a refresh token and the permission to change mail', () => {
    it.each([
      {
        situation: 'a refresh token and the mailbox permission',
        claims: { sub: 'google-123', email: ' Anna@Example.com ' },
        tokens: { refresh_token: 'r', scope: GRANTED },
        becomes: { key: 'google-123', displayName: 'anna@example.com' },
      },
      {
        situation: 'no refresh token',
        claims: { sub: 'google-123', email: 'anna@example.com' },
        tokens: { scope: GRANTED },
        becomes: { refused: 'no-refresh-token' },
      },
      {
        situation: 'an empty refresh token',
        claims: { sub: 'google-123', email: 'anna@example.com' },
        tokens: { refresh_token: '', scope: GRANTED },
        becomes: { refused: 'no-refresh-token' },
      },
      {
        situation: 'the permission to change mail unticked',
        claims: { sub: 'google-123', email: 'anna@example.com' },
        tokens: { refresh_token: 'r', scope: 'openid email' },
        becomes: { refused: 'permission-missing' },
      },
      {
        situation: 'no scope reported at all',
        claims: { sub: 'google-123', email: 'anna@example.com' },
        tokens: { refresh_token: 'r' },
        becomes: { refused: 'permission-missing' },
      },
      {
        situation: 'no address',
        claims: { sub: 'google-123' },
        tokens: { refresh_token: 'r', scope: GRANTED },
        becomes: null,
      },
      {
        situation: 'nobody named',
        claims: { email: 'anna@example.com' },
        tokens: { refresh_token: 'r', scope: GRANTED },
        becomes: null,
      },
    ])('reads $situation', ({ claims, tokens, becomes }) => {
      expect(accountFor(claims, tokens)).toEqual(becomes);
    });

    it('reads a reply with no identity token as nobody', () => {
      expect(accountFor(null, { refresh_token: 'r', scope: GRANTED })).toBeNull();
    });

    it('names a refusal only by a code the sign-in description has a sentence for', () => {
      const refused = [
        accountFor({ sub: 's', email: 'a@example.com' }, { scope: GRANTED }),
        accountFor({ sub: 's', email: 'a@example.com' }, { refresh_token: 'r', scope: 'openid' }),
      ].map((one) => (one as { refused: string }).refused);

      for (const code of refused) expect(Object.keys(GMAIL_REFUSALS)).toContain(code);
    });
  });

  describe('disconnecting Gmail cancels the grant at Google', () => {
    it('revokes the refresh token the connection held', async () => {
      const gone = new GmailWorld();
      const host = signedInHost();

      await gone.connector().revoke!(await host.getCredentials());

      expect(gone.revoked).toEqual(['the-refresh-token']);
    });

    it('revokes where the issuer’s discovery document says, when it was not told', async () => {
      const seen: string[] = [];
      const fetched: typeof fetch = async (input, init) => {
        const url = String(input);
        seen.push(url);
        if (url.endsWith('/.well-known/openid-configuration')) {
          return Response.json({ token_endpoint: TOKEN_URL, revocation_endpoint: REVOKE_URL });
        }
        return world.fetch(input, init);
      };
      const discovering = createGmailConnector({
        clientId: 'c',
        clientSecret: 's',
        issuer: 'https://accounts.discovery-case.test',
        fetch: fetched,
      });

      await discovering.revoke!(await signedInHost().getCredentials());

      expect(seen[0]).toBe('https://accounts.discovery-case.test/.well-known/openid-configuration');
      expect(world.revoked).toContain('the-refresh-token');
    });

    it.each([
      { situation: 'Google refusing', setup: (w: GmailWorld) => void (w.revokeStatus = 400) },
      { situation: 'a credential holding no refresh token', setup: () => undefined, credentials: { credential: '{}' } },
    ])('fails, for the host to log, on $situation', async ({ setup, credentials }) => {
      const failing = new GmailWorld();
      setup(failing);

      await expect(
        failing.connector().revoke!(credentials ?? (await signedInHost().getCredentials())),
      ).rejects.toThrow();
    });
  });
});
