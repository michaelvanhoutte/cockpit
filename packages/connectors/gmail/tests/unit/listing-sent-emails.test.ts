import { describe, expect, it } from 'vitest';
import { SourceError, type OnDemandHost } from '@cockpit/connector-sdk';
import type { FakeHost } from './fake-host.js';
import { ADDRESS, GmailWorld, signedInHost } from './gmail-world.js';
import { recipientsIn } from '../../src/sent.js';

/**
 * L1, against a fake host and Gmail faked at the network: *Follow a sent
 * email…* lists the newest emails sent from the mailbox ("Follow a sent email…
 * in Capture", issue 1710). Which mailboxes are listed together and what a pick
 * makes are the host's, proved at L2
 * (apps/api/tests/integration/connectors/sent-emails-on-the-host.test.ts).
 */

/** The host a listing is made through: the connection's credential, and the state its last check saved. */
function onDemand(host: FakeHost, state: unknown = { address: ADDRESS }): OnDemandHost {
  return {
    getCredentials: () => host.getCredentials(),
    setCredentials: (credentials) => host.setCredentials(credentials),
    getState: async () => state,
    log: (level, message, data) => host.log(level, message, data),
  };
}

describe('Triage', () => {
  describe('Follow a sent email… lists the newest emails sent from the mailbox', () => {
    it('lists them newest first, each with its conversation, subject, recipients, time and first lines', async () => {
      const world = new GmailWorld();
      world.sends('t-old', 'Offer for the lease', '"Sofie Maes" <sofie@example.com>, legal@example.com', '2026-10-06T14:40:00Z', 'Our offer is below.');
      world.sends('t-new', 'Quote for the kitchen', 'Marc Lambrecht <marc@example.com>', '2026-10-08T09:15:00Z', 'Attached is the quote.');

      const listed = await world.connector().listRecentSent!(onDemand(signedInHost({ choice: 'star' })), 10);

      expect(listed).toEqual([
        {
          conversationId: 't-new',
          subject: 'Quote for the kitchen',
          to: 'Marc Lambrecht',
          sentAt: '2026-10-08T09:15:00.000Z',
          link: 'https://mail.google.com/mail/?authuser=anna%40example.com#all/t-new',
          excerpt: 'Attached is the quote.',
        },
        {
          conversationId: 't-old',
          subject: 'Offer for the lease',
          to: 'Sofie Maes, legal@example.com',
          sentAt: '2026-10-06T14:40:00.000Z',
          link: 'https://mail.google.com/mail/?authuser=anna%40example.com#all/t-old',
          excerpt: 'Our offer is below.',
        },
      ]);
    });

    it('asks for the ten newest in the Sent label alone, reads each once, and changes nothing', async () => {
      const world = new GmailWorld();
      for (let n = 1; n <= 12; n += 1) {
        world.sends(`t-${n}`, `Mail ${n}`, 'x@example.com', `2026-10-${String(n).padStart(2, '0')}T09:00:00Z`);
      }
      world.arrives('inbox-only', 'Received, not sent', 'Hello.', ['star']);
      world.forget();

      const listed = await world.connector().listRecentSent!(onDemand(signedInHost({ choice: 'star' })), 10);

      expect(listed.map((one) => one.conversationId)).toEqual(['t-12', 't-11', 't-10', 't-9', 't-8', 't-7', 't-6', 't-5', 't-4', 't-3']);
      expect(world.requests.filter((one) => one.startsWith('GET /gmail/v1/users/me/messages?'))).toEqual([
        'GET /gmail/v1/users/me/messages?labelIds=SENT&maxResults=10',
      ]);
      expect(world.requests.every((one) => one.startsWith('GET '))).toBe(true);
      // The list, and one read of each email.
      expect(world.gmailCalls()).toBe(11);
    });

    it('leaves out a draft, an email in the bin and one received', async () => {
      const world = new GmailWorld();
      world.sends('t-kept', 'Kept', 'a@example.com', '2026-10-08T09:00:00Z');
      world.sends('t-binned', 'Binned', 'a@example.com', '2026-10-07T09:00:00Z');
      world.binEmail('t-binned');
      world.drafts('t-kept');
      world.arrives('t-received', 'Received', 'Hello.', ['star']);

      const listed = await world.connector().listRecentSent!(onDemand(signedInHost({ choice: 'star' })), 10);

      expect(listed.map((one) => one.conversationId)).toEqual(['t-kept']);
    });

    it('lists nothing, with no further call, for a mailbox that has sent nothing', async () => {
      const world = new GmailWorld();

      const listed = await world.connector().listRecentSent!(onDemand(signedInHost({ choice: 'star' })), 10);

      expect(listed).toEqual([]);
      expect(world.gmailCalls()).toBe(1);
    });

    it('asks Gmail for the mailbox address when no check has saved it, so the link names it', async () => {
      const world = new GmailWorld();
      world.sends('t-1', 'Hello', 'a@example.com', '2026-10-08T09:00:00Z');

      const [first] = await world.connector().listRecentSent!(onDemand(signedInHost({ choice: 'star' }), null), 10);

      expect(first!.link).toBe('https://mail.google.com/mail/?authuser=anna%40example.com#all/t-1');
    });

    it('refreshes an expired sign-in once and saves the renewed credential', async () => {
      const world = new GmailWorld();
      world.sends('t-1', 'Hello', 'a@example.com', '2026-10-08T09:00:00Z');
      const host = signedInHost({ choice: 'star', expiresAt: '2026-10-09T11:00:00.000Z' });

      const listed = await world.connector().listRecentSent!(onDemand(host), 10);

      expect(listed).toHaveLength(1);
      expect(host.credentialsSaved).toHaveLength(1);
    });
  });

  describe('when Gmail cannot be read', () => {
    it('says Gmail did not answer, without the request address', async () => {
      const world = new GmailWorld();
      world.sends('t-1', 'Hello', 'a@example.com', '2026-10-08T09:00:00Z');
      world.failures.push({ prefix: 'messages', status: 503 });

      const failure = await world
        .connector()
        .listRecentSent!(onDemand(signedInHost({ choice: 'star' })), 10)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SourceError);
      expect((failure as SourceError).message).toBe('Gmail did not answer. Try again in a moment.');
    });

    it('says the sign-in is lost when Google no longer accepts it', async () => {
      const world = new GmailWorld();
      world.acceptedToken = 'another-token';
      world.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } };

      const failure = await world
        .connector()
        .listRecentSent!(onDemand(signedInHost({ choice: 'star' })), 10)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SourceError);
    });
  });

  describe('recipients', () => {
    it.each([
      ['"Noels, Steven" <steven@example.com>, pieter@example.com', 'Noels, Steven, pieter@example.com'],
      ['<only@example.com>', 'only@example.com'],
      ['   ', null],
      [null, null],
    ])('reads %j as %j', (header, shown) => {
      expect(recipientsIn(header)).toBe(shown);
    });
  });
});
