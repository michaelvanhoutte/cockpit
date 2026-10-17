import { describe, expect, it } from 'vitest';
import type { SignInReply } from '@cockpit/connector-sdk';
import { MAIL_READ_WRITE, OUTLOOK_REFUSALS, createOutlookConnector } from '../../src/index.js';
import { CONSUMER_TENANT } from '../../src/sign-in.js';
import { GraphWorld } from './outlook-world.js';

/**
 * L1: how a Workspace connects an Outlook mailbox ("Build Outlook as a
 * connector package on the SDK, unregistered", issue 1046). Whether the
 * identity token is believed at all is the host's, before `accountFrom` is
 * asked; what the grant is worth once it is, is this connector's alone.
 */

const connector = new GraphWorld().connector();

const GRANTED = `openid profile email ${MAIL_READ_WRITE}`;
const WORK = { tid: 'contoso-tenant', oid: 'anna-object', name: 'Anna Peeters', preferred_username: 'anna@contoso.example' };

function accountFor(claims: Record<string, unknown> | null, tokenResponse: Record<string, unknown>) {
  const reply: SignInReply = { claims, tokenResponse };
  return connector.accountFrom!(reply);
}

describe('Connector management', () => {
  describe('connecting Outlook asks Microsoft for mail permission that lasts', () => {
    it('describes a sign-in at Microsoft’s multi-tenant issuer with offline access and the mail permission, through the existing Microsoft client', () => {
      const { auth } = connector.manifest;

      expect(auth).toMatchObject({
        kind: 'oauth2',
        endpoints: { issuer: 'https://login.microsoftonline.com/common/v2.0' },
        clientSettings: { id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET' },
      });
      expect(auth.kind === 'oauth2' && auth.scopes).toEqual(expect.arrayContaining(['offline_access', MAIL_READ_WRITE]));
    });

    it('signs in at the issuer it was told to, where one overrides Microsoft', () => {
      const local = createOutlookConnector({ clientId: 'c', clientSecret: 's', callsPerRun: 1, issuer: 'http://localhost:9000' });

      expect(local.manifest.auth).toMatchObject({ endpoints: { issuer: 'http://localhost:9000' } });
    });

    it('declares every refusal with the sentence the Connections window shows for it', () => {
      expect(connector.manifest.auth).toMatchObject({ refusals: OUTLOOK_REFUSALS });
      for (const sentence of Object.values(OUTLOOK_REFUSALS)) expect(sentence).toMatch(/nothing was stored/);
    });

    it('offers the flag to start, and the category Cockpit as the other choice', () => {
      expect(connector.manifest.choice?.options).toEqual([
        { value: 'flag', label: 'Flagged', listed: 'flagged' },
        { value: 'category', label: 'Category Cockpit', listed: 'with category Cockpit' },
      ]);
      expect(connector.manifest).toMatchObject({ pulled: true });
    });
  });

  describe('an Outlook grant is accepted only for a work or school account that gave a refresh token and the mail permission', () => {
    it.each([
      {
        situation: 'a work account with a refresh token and the mail permission',
        claims: WORK,
        tokens: { refresh_token: 'r', scope: GRANTED },
        becomes: { key: 'contoso-tenant:anna-object', displayName: 'Anna Peeters' },
      },
      {
        situation: 'a work account whose name is missing, so its address names it',
        claims: { ...WORK, name: undefined },
        tokens: { refresh_token: 'r', scope: GRANTED },
        becomes: { key: 'contoso-tenant:anna-object', displayName: 'anna@contoso.example' },
      },
      {
        situation: 'the permission named by its resource',
        claims: WORK,
        tokens: { refresh_token: 'r', scope: `openid https://graph.microsoft.com/${MAIL_READ_WRITE}` },
        becomes: { key: 'contoso-tenant:anna-object', displayName: 'Anna Peeters' },
      },
      {
        situation: 'a personal Microsoft account, by its tenant',
        claims: { ...WORK, tid: CONSUMER_TENANT.toUpperCase() },
        tokens: { refresh_token: 'r', scope: GRANTED },
        becomes: { refused: 'personal-account' },
      },
      {
        situation: 'a grant without the mail permission',
        claims: WORK,
        tokens: { refresh_token: 'r', scope: 'openid profile email User.Read' },
        becomes: { refused: 'permission-missing' },
      },
      {
        situation: 'a grant with no refresh token',
        claims: WORK,
        tokens: { scope: GRANTED },
        becomes: { refused: 'no-refresh-token' },
      },
      {
        situation: 'a reply with no identity token',
        claims: null,
        tokens: { refresh_token: 'r', scope: GRANTED },
        becomes: null,
      },
      {
        situation: 'a reply naming no tenant',
        claims: { oid: 'anna-object', name: 'Anna' },
        tokens: { refresh_token: 'r', scope: GRANTED },
        becomes: null,
      },
      {
        situation: 'a reply naming no person',
        claims: { tid: 'contoso-tenant' },
        tokens: { refresh_token: 'r', scope: GRANTED },
        becomes: null,
      },
    ])('$situation', ({ claims, tokens, becomes }) => {
      expect(accountFor(claims, tokens)).toEqual(becomes);
    });
  });

  describe('disconnecting Outlook never signs the person out of Microsoft', () => {
    it('offers no revoke, since the only call that ends Microsoft’s tokens ends every application’s', () => {
      expect(connector.revoke).toBeUndefined();
    });
  });
});
