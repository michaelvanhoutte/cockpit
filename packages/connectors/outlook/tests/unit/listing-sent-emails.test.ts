import { describe, expect, it } from 'vitest';
import { SourceError, type OnDemandHost } from '@cockpit/connector-sdk';
import type { FakeHost } from './fake-host.js';
import { GraphWorld, SENT_ITEMS_ID, signedInHost } from './outlook-world.js';
import { recipientsIn, sentEmailsIn } from '../../src/sent.js';

/**
 * L1, against a fake host and Microsoft Graph faked at the network, from the
 * shapes Graph documents: *Follow a sent email…* lists the newest messages in
 * Sent Items ("Follow a sent email… in Capture", issue 1710). Which mailboxes
 * are listed together and what a pick makes are the host's, proved at L2
 * (apps/api/tests/integration/connectors/sent-emails-on-the-host.test.ts).
 */

/** The host a listing is made through: the connection's credential. */
function onDemand(host: FakeHost): OnDemandHost {
  return {
    getCredentials: () => host.getCredentials(),
    setCredentials: (credentials) => host.setCredentials(credentials),
    getState: async () => null,
    log: (level, message, data) => host.log(level, message, data),
  };
}

describe('Triage', () => {
  describe('Follow a sent email… lists the newest messages in Sent Items', () => {
    it('lists them newest first, each with its conversation, subject, recipients, time, link and first lines', async () => {
      const world = new GraphWorld();
      world.arrives('sent-old', {
        folder: SENT_ITEMS_ID,
        subject: 'Offer for the lease',
        text: 'Our offer is below.',
        to: [{ name: 'Sofie Maes', address: 'sofie@example.com' }, { address: 'legal@example.com' }],
        receivedAt: '2026-10-06T14:40:00Z',
        conversation: 'conversation-lease',
      });
      world.arrives('sent-new', {
        folder: SENT_ITEMS_ID,
        subject: 'Quote for the kitchen',
        text: 'Attached is the quote.',
        to: [{ name: 'Marc Lambrecht', address: 'marc@example.com' }],
        receivedAt: '2026-10-08T09:15:00Z',
        conversation: 'conversation-kitchen',
      });

      const listed = await world.connector().listRecentSent!(onDemand(signedInHost()), 10);

      expect(listed).toEqual([
        {
          conversationId: 'conversation-kitchen',
          subject: 'Quote for the kitchen',
          to: 'Marc Lambrecht',
          sentAt: '2026-10-08T09:15:00.000Z',
          link: 'https://outlook.office365.com/owa/?ItemID=sent-new&exvsurl=1&viewmodel=ReadMessageItem',
          excerpt: 'Attached is the quote.',
        },
        {
          conversationId: 'conversation-lease',
          subject: 'Offer for the lease',
          to: 'Sofie Maes, legal@example.com',
          sentAt: '2026-10-06T14:40:00.000Z',
          link: 'https://outlook.office365.com/owa/?ItemID=sent-old&exvsurl=1&viewmodel=ReadMessageItem',
          excerpt: 'Our offer is below.',
        },
      ]);
    });

    it('asks Sent Items alone for the newest ten, in one read, and changes nothing', async () => {
      const world = new GraphWorld();
      for (let n = 1; n <= 12; n += 1) {
        world.arrives(`sent-${n}`, { folder: SENT_ITEMS_ID, receivedAt: `2026-10-${String(n).padStart(2, '0')}T09:00:00Z` });
      }
      world.arrives('received', { subject: 'Not sent' });
      world.forget();

      const listed = await world.connector().listRecentSent!(onDemand(signedInHost()), 10);

      expect(listed).toHaveLength(10);
      expect(listed[0]!.sentAt).toBe('2026-10-12T09:00:00.000Z');
      expect(world.requests).toEqual([
        'GET /v1.0/me/mailFolders/sentitems/messages?$top=30&$orderby=sentDateTime desc&$select=id,conversationId,subject,toRecipients,sentDateTime,bodyPreview,webLink,isDraft',
      ]);
    });

    it('leaves out a draft, which is in Sent Items for no one', async () => {
      const world = new GraphWorld();
      world.arrives('sent', { folder: SENT_ITEMS_ID, receivedAt: '2026-10-08T09:00:00Z' });
      world.arrives('unsent', { folder: SENT_ITEMS_ID, draft: true, receivedAt: '2026-10-09T09:00:00Z' });

      const listed = await world.connector().listRecentSent!(onDemand(signedInHost()), 10);

      expect(listed.map((one) => one.conversationId)).toEqual(['conversation-of-sent']);
    });

    it('calls a message with no subject by Outlook’s own words for it', async () => {
      const world = new GraphWorld();
      world.arrives('sent', { folder: SENT_ITEMS_ID, subject: '' });

      const [first] = await world.connector().listRecentSent!(onDemand(signedInHost()), 10);

      expect(first!.subject).toBe('(no subject)');
    });

    it('refreshes an expired sign-in once and saves the renewed credential', async () => {
      const world = new GraphWorld();
      world.arrives('sent', { folder: SENT_ITEMS_ID });
      const host = signedInHost({ expiresAt: '2026-10-09T11:00:00.000Z' });

      const listed = await world.connector().listRecentSent!(onDemand(host), 10);

      expect(listed).toHaveLength(1);
      expect(host.credentialsSaved).toHaveLength(1);
    });
  });

  describe('when Outlook cannot be read', () => {
    it('says Outlook did not answer, without the request address', async () => {
      const world = new GraphWorld();
      world.failures.push({ prefix: 'sentitems', status: 503 });

      const failure = await world
        .connector()
        .listRecentSent!(onDemand(signedInHost()), 10)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SourceError);
      expect((failure as SourceError).message).toBe('Outlook did not answer. Try again in a moment.');
    });

    it('says what Outlook refused', async () => {
      const world = new GraphWorld();
      world.failures.push({ prefix: 'sentitems', status: 403 });

      const failure = await world
        .connector()
        .listRecentSent!(onDemand(signedInHost()), 10)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SourceError);
      expect((failure as SourceError).message).toBe('Outlook refused the request (403)');
    });
  });

  describe('recipients', () => {
    it.each([
      [[{ emailAddress: { name: 'Steven Noels', address: 's@example.com' } }, { emailAddress: { name: '', address: 'p@example.com' } }], 'Steven Noels, p@example.com'],
      [[], null],
      [undefined, null],
    ])('reads %j as %j', (recipients, shown) => {
      expect(recipientsIn(recipients)).toBe(shown);
    });
  });

  describe('one conversation written in more than once', () => {
    it('is listed once, by its newest message, and the rest of the ten are other conversations', () => {
      const sent = (id: string, conversationId: string, sentDateTime: string) => ({ id, conversationId, subject: id, sentDateTime });
      const answer = {
        value: [
          sent('m-1', 't-a', '2026-10-01T09:00:00Z'),
          sent('m-5', 't-a', '2026-10-05T09:00:00Z'),
          sent('m-3', 't-b', '2026-10-03T09:00:00Z'),
          sent('m-2', 't-c', '2026-10-02T09:00:00Z'),
        ],
      };

      expect(sentEmailsIn(answer, 10).map((one) => one.subject)).toEqual(['m-5', 'm-3', 'm-2']);
      expect(sentEmailsIn(answer, 2).map((one) => one.subject)).toEqual(['m-5', 'm-3']);
    });
  });
});
