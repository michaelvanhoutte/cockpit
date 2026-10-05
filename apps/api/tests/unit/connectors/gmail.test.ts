import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import type { ItemType } from '@cockpit/shared';
import {
  cockpitLabelIn,
  conversationFrom,
  credentialRefreshed,
  gmailAccountFrom,
  gmailAuthorizationUrl,
  gmailCredentialIn,
  historyPage,
  stillLabelled,
  usableAccessToken,
} from '../../../src/connectors/gmail.js';
import { typeToBringInAs } from '../../../src/domain/item-types.js';
import { COCKPIT_LABEL_ID, historyAnswer, historyRecord, labelsAnswer, message, threadAnswer } from '../../gmail-payloads.js';
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

describe('Capture', () => {
  describe('an Item from Gmail carries the conversation’s subject, text, sender and link, as a Task', () => {
    const address = 'anna@example.com';
    it.each([
      {
        situation: 'a plain-text message',
        thread: threadAnswer('t-plain', [
          message('t-plain', {
            id: 'm1',
            sentAt: '2026-10-01T08:30:00Z',
            subject: 'Quarterly figures',
            from: '"Pieter Claes" <pieter@example.com>',
            plain: 'Send the Q3 figures\r\nbefore Friday.',
          }),
        ]),
        becomes: {
          title: 'Quarterly figures',
          text: 'Send the Q3 figures\nbefore Friday.',
          sender: 'Pieter Claes',
          sentAt: '2026-10-01T08:30:00.000Z',
        },
      },
      {
        situation: 'an HTML-only message',
        thread: threadAnswer('t-html', [
          message('t-html', {
            id: 'm1',
            sentAt: '2026-10-01T08:30:00Z',
            subject: 'Lunch',
            from: 'lotte@example.com',
            html: '<html><head><style>p{color:red}</style></head><body><p>Lunch on <b>Thursday</b>?</p><p>Fish &amp; chips&nbsp;&#8212; Lotte</p></body></html>',
          }),
        ]),
        becomes: { title: 'Lunch', text: 'Lunch on Thursday?\nFish & chips — Lotte', sender: 'lotte@example.com' },
      },
      {
        situation: 'a message with both parts, whose plain text is read',
        thread: threadAnswer('t-both', [
          message('t-both', { id: 'm1', sentAt: '2026-10-01T08:30:00Z', subject: 'Both', plain: 'Plain words', html: '<p>HTML words</p>' }),
        ]),
        becomes: { title: 'Both', text: 'Plain words', sender: 'Pieter Claes' },
      },
      {
        situation: 'several labelled messages, and a reply after them that is not',
        thread: threadAnswer('t-many', [
          message('t-many', { id: 'm1', sentAt: '2026-10-01T08:00:00Z', subject: 'Contract', plain: 'First draft' }),
          message('t-many', { id: 'm2', sentAt: '2026-10-02T08:00:00Z', subject: 'Re: Contract', plain: 'Signed version' }),
          message('t-many', {
            id: 'm3',
            sentAt: '2026-10-03T08:00:00Z',
            subject: 'Re: Contract',
            plain: 'Thanks!',
            labelled: false,
          }),
        ]),
        becomes: { title: 'Re: Contract', text: 'Signed version', sentAt: '2026-10-02T08:00:00.000Z' },
      },
      {
        situation: 'no subject',
        thread: threadAnswer('t-none', [message('t-none', { id: 'm1', sentAt: '2026-10-01T08:30:00Z', plain: 'Untitled words' })]),
        becomes: { title: '(no subject)', text: 'Untitled words' },
      },
      {
        situation: 'no text at all',
        thread: threadAnswer('t-empty', [message('t-empty', { id: 'm1', sentAt: '2026-10-01T08:30:00Z', subject: 'Only a subject', plain: '' })]),
        becomes: { title: 'Only a subject', text: 'Only a subject' },
      },
      {
        situation: 'text that cannot be read',
        thread: threadAnswer('t-garbled', [
          ((sent) => ({ ...sent, payload: { ...sent.payload, body: { size: 3, data: '%%%' } } }))(
            message('t-garbled', { id: 'm1', sentAt: '2026-10-01T08:30:00Z', subject: 'Garbled', plain: 'unused' }),
          ),
        ]),
        becomes: { title: 'Garbled', text: 'Garbled' },
      },
    ])('$situation', ({ thread, becomes }) => {
      const conversation = conversationFrom(thread, COCKPIT_LABEL_ID, address);

      expect(conversation).toMatchObject({ threadId: thread.id, ...becomes });
      expect(conversation!.link).toBe(`https://mail.google.com/mail/?authuser=anna%40example.com#all/${thread.id}`);
    });

    it.each([
      { situation: 'an account with its Task type', types: ['acc-type-action', 'acc-type-thought'], becomes: 'acc-type-action' },
      { situation: 'an account without its Task type', types: ['acc-type-thought', 'acc-type-other'], becomes: 'acc-type-thought' },
      { situation: 'an account with neither', types: ['acc-type-other'], becomes: 'acc-type-other' },
    ])('is a Task in $situation, else what any other unattended capture takes', ({ types, becomes }) => {
      const live = types.map((id, position) => ({ id, tenantId: 'acc', name: id, color: '#6f62b5', position, createdAt: '2026-10-01T00:00:00.000Z' }));

      expect(typeToBringInAs(live as ItemType[], 'acc-type-action', 'acc-type-thought')?.id).toBe(becomes);
    });
  });
});

describe('Capture', () => {
  describe('a history page is read into the conversations that gained the label', () => {
    const labelled = ['INBOX', COCKPIT_LABEL_ID];
    it.each([
      {
        situation: 'a label added to an old conversation',
        records: [historyRecord('11', { labelled: 'm1', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: labelled })],
        gained: ['t-old'],
      },
      {
        situation: 'a new message arriving already labelled, as a filter does it',
        records: [historyRecord('11', { added: 'm2', threadId: 't-new', labelIds: labelled })],
        gained: ['t-new'],
      },
      {
        situation: 'a reply in a conversation already labelled, arriving without the label',
        records: [historyRecord('11', { added: 'm3', threadId: 't-old', labelIds: ['INBOX', 'UNREAD'] })],
        gained: [],
      },
      {
        situation: 'the label added and taken off again within the page',
        records: [
          historyRecord('11', { labelled: 'm1', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: labelled }),
          historyRecord('12', { unlabelled: 'm1', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: ['INBOX'] }),
        ],
        gained: [],
      },
      {
        situation: 'another label added',
        records: [historyRecord('11', { labelled: 'm1', threadId: 't-old', with: ['STARRED'], labelIds: ['INBOX', 'STARRED'] })],
        gained: [],
      },
      {
        situation: 'two messages of one conversation labelled',
        records: [
          historyRecord('11', { labelled: 'm1', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: labelled }),
          historyRecord('12', { labelled: 'm2', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: labelled }),
        ],
        gained: ['t-old'],
      },
      { situation: 'nothing having changed', records: [], gained: [] },
    ])('reads $situation as $gained', ({ records, gained }) => {
      expect(historyPage(historyAnswer(records), COCKPIT_LABEL_ID).gained).toEqual(gained);
    });

    it('carries the mailbox’s position, and where the next page starts', () => {
      expect(historyPage(historyAnswer([], { historyId: '99', nextPageToken: 'more' }), COCKPIT_LABEL_ID)).toMatchObject({
        historyId: '99',
        nextPageToken: 'more',
      });
      expect(historyPage(historyAnswer([], { historyId: '99' }), COCKPIT_LABEL_ID).nextPageToken).toBeNull();
    });
  });

  describe('a history page names every conversation whose label it may have taken off or put back', () => {
    const labelled = ['INBOX', COCKPIT_LABEL_ID];
    it.each([
      {
        situation: 'the label removed',
        records: [historyRecord('11', { unlabelled: 'm1', threadId: 't-off', with: [COCKPIT_LABEL_ID], labelIds: ['INBOX'] })],
        changed: ['t-off'],
      },
      {
        situation: 'a labelled message moved to the bin',
        records: [historyRecord('11', { labelled: 'm1', threadId: 't-bin', with: ['TRASH'], labelIds: ['TRASH', COCKPIT_LABEL_ID] })],
        changed: ['t-bin'],
      },
      {
        situation: 'a labelled message taken out of the bin',
        records: [historyRecord('11', { unlabelled: 'm1', threadId: 't-back', with: ['TRASH'], labelIds: labelled })],
        changed: ['t-back'],
      },
      {
        situation: 'a message deleted for good',
        records: [historyRecord('11', { deleted: 'm1', threadId: 't-gone' })],
        changed: ['t-gone'],
      },
      {
        situation: 'the label added again',
        records: [historyRecord('11', { labelled: 'm1', threadId: 't-again', with: [COCKPIT_LABEL_ID], labelIds: labelled })],
        changed: ['t-again'],
      },
      {
        situation: 'another label added or removed',
        records: [
          historyRecord('11', { labelled: 'm1', threadId: 't-star', with: ['STARRED'], labelIds: ['STARRED', COCKPIT_LABEL_ID] }),
          historyRecord('12', { unlabelled: 'm1', threadId: 't-star', with: ['UNREAD'], labelIds: labelled }),
        ],
        changed: [],
      },
      {
        situation: 'a reply arriving without the label',
        records: [historyRecord('11', { added: 'm3', threadId: 't-old', labelIds: ['INBOX', 'UNREAD'] })],
        changed: [],
      },
    ])('reads $situation as $changed', ({ records, changed }) => {
      expect(historyPage(historyAnswer(records), COCKPIT_LABEL_ID).changed).toEqual(changed);
    });
  });

  describe('a conversation counts as labelled while a message carrying the label is outside the bin', () => {
    it.each([
      { situation: 'one labelled message', messages: [{ labelled: true }], counts: true },
      { situation: 'the label taken off its only message', messages: [{ labelled: false }], counts: false },
      { situation: 'its only labelled message in the bin', messages: [{ labelled: true, trashed: true }], counts: false },
      {
        situation: 'one labelled message binned and another still labelled',
        messages: [{ labelled: true, trashed: true }, { labelled: true }],
        counts: true,
      },
      { situation: 'no messages left', messages: [], counts: false },
    ])('$situation: $counts', ({ messages, counts }) => {
      const thread = threadAnswer(
        't',
        messages.map((one, at) => message('t', { id: `m${at}`, sentAt: '2026-10-01T08:30:00Z', plain: 'x', ...one })),
      );
      expect(stillLabelled(thread, COCKPIT_LABEL_ID)).toBe(counts);
    });
  });
});

describe('Connector management', () => {
  describe('a Gmail connection is checked only where the mailbox has a label called Cockpit', () => {
    it.each([
      { situation: 'a label called Cockpit', answer: labelsAnswer(), finds: COCKPIT_LABEL_ID },
      { situation: 'one called cockpit, Gmail keeping names whatever their case', answer: labelsAnswer({ named: 'cockpit' }), finds: COCKPIT_LABEL_ID },
      { situation: 'no such label', answer: labelsAnswer({ cockpit: false }), finds: null },
      { situation: 'a label whose name only starts Cockpit', answer: labelsAnswer({ named: 'Cockpit/Later' }), finds: null },
      { situation: 'an answer with no labels in it', answer: {}, finds: null },
    ])('finds $situation', ({ answer, finds }) => {
      expect(cockpitLabelIn(answer)).toBe(finds);
    });
  });

  describe('a Gmail sign-in’s access token is used while it lasts, and refreshed into the same credential', () => {
    const credential = {
      mailboxKey: 'google-anna',
      refreshToken: 'the-refresh-token',
      accessToken: 'the-access-token',
      accessTokenExpiresAt: '2026-10-04T12:30:00.000Z',
    };

    it.each([
      { situation: 'half an hour left', expiresAt: '2026-10-04T12:30:00.000Z', uses: 'the-access-token' },
      { situation: 'under a minute left', expiresAt: '2026-10-04T12:00:30.000Z', uses: null },
      { situation: 'lapsed', expiresAt: '2026-10-04T11:00:00.000Z', uses: null },
      { situation: 'no expiry recorded', expiresAt: null, uses: null },
    ])('uses the cached one with $situation', ({ expiresAt, uses }) => {
      expect(usableAccessToken({ ...credential, accessTokenExpiresAt: expiresAt }, NOW)).toBe(uses);
    });

    it('keeps the refresh token Google does not rotate, beside the new access token and when it lapses', () => {
      const refreshed = credentialRefreshed(credential, { access_token: 'a-new-one', expires_in: 3599, token_type: 'Bearer' }, NOW);

      expect(refreshed).toEqual({
        mailboxKey: 'google-anna',
        refreshToken: 'the-refresh-token',
        accessToken: 'a-new-one',
        accessTokenExpiresAt: '2026-10-04T12:59:59.000Z',
      });
      expect(gmailCredentialIn(JSON.stringify(refreshed))).toEqual(refreshed);
      expect(credentialRefreshed(credential, { error: 'invalid_grant' }, NOW)).toBeNull();
    });
  });
});