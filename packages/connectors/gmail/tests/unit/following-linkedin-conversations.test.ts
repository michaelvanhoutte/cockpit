import { describe, expect, it } from 'vitest';
import type { SourceItem } from '@cockpit/connector-sdk';
import { linkedInThreadOf } from '../../src/linkedin.js';
import {
  LINKEDIN_THREAD,
  linkedInConnectionRequest,
  linkedInNotification,
  notificationLeadingTo,
  type LinkStyle,
} from '../linkedin-notifications.js';
import type { FakeHost } from './fake-host.js';
import { GmailWorld, signedInHost } from './gmail-world.js';

/**
 * L1, against a fake host and Gmail faked at the network: a LinkedIn message
 * notification starred in Gmail brings in the LinkedIn conversation as the one
 * the Item follows, and a later notification about it - in any Gmail
 * conversation, starred or not - is their turn ("Follow the LinkedIn
 * conversation instead of the notification", issue 1711). The notification
 * emails are reconstructed, not captured (tests/linkedin-notifications.ts).
 * What a turn does to the Item is the host's, proved there
 * (apps/api/tests/integration/connectors/linkedin-conversations-on-the-host.test.ts).
 */

const LINKEDIN_LINK = `https://www.linkedin.com/messaging/thread/${LINKEDIN_THREAD}/`;
const CONVERSATION = `linkedin:${LINKEDIN_THREAD}`;

/** A connection following the star, having read the mailbox once: the position stars are counted from. */
async function connectedByStar(world: GmailWorld): Promise<FakeHost> {
  const host = signedInHost({ choice: 'star' });
  await world.connector().sync(host);
  return host;
}

/** The next check of the same connection. */
async function checked(world: GmailWorld, host: FakeHost): Promise<FakeHost> {
  const next = host.next();
  await world.connector().sync(next);
  return next;
}

/** The only Item emitted, which a case has to have. */
function theItem(host: FakeHost): SourceItem {
  expect(host.emitted).toHaveLength(1);
  return host.emitted[0]!;
}

/** A notification starred and brought in: the LinkedIn conversation an open Item now follows. */
async function followed(): Promise<{ world: GmailWorld; host: FakeHost }> {
  const world = new GmailWorld();
  const first = await connectedByStar(world);
  world.receives(linkedInNotification('t-1', { id: 'n-1', sentAt: '2026-10-06T09:00:00Z' }));
  world.star('n-1');
  const host = await checked(world, first);
  expect(await host.followedConversations()).toEqual([CONVERSATION]);
  world.forget();
  return { world, host };
}

describe('Capture', () => {
  describe('a starred LinkedIn message notification makes an Item that follows the LinkedIn conversation, not the email', () => {
    it.each([
      { language: 'en', link: 'direct', text: 'Shall we have dinner on Thursday? I know a good place in Ghent.' },
      { language: 'en', link: 'comm', text: 'Shall we have dinner on Thursday? I know a good place in Ghent.' },
      { language: 'en', link: 'redirect', text: 'Shall we have dinner on Thursday? I know a good place in Ghent.' },
      { language: 'nl', link: 'direct', text: 'Zullen we donderdag samen gaan eten? Ik ken een goede plek in Gent.' },
      { language: 'nl', link: 'comm', text: 'Zullen we donderdag samen gaan eten? Ik ken een goede plek in Gent.' },
      { language: 'nl', link: 'redirect', text: 'Zullen we donderdag samen gaan eten? Ik ken een goede plek in Gent.' },
    ] as const)('reads a $language notification linking by $link as Steven’s turn in the LinkedIn thread', async ({ language, link, text }) => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      world.receives(linkedInNotification('t-1', { id: 'n-1', sentAt: '2026-10-06T09:00:00Z', language, link: link as LinkStyle }));
      world.star('n-1');

      const second = await checked(world, first);

      const item = theItem(second);
      expect(item).toMatchObject({ sourceId: 't-1', choice: 'star' });
      expect(item.conversation).toEqual({
        id: CONVERSATION,
        link: LINKEDIN_LINK,
        latest: { by: 'them', from: 'Steven Noels', at: '2026-10-06T09:00:00.000Z', excerpt: text },
        messageCount: 1,
        startedAt: '2026-10-06T09:00:00.000Z',
        withWhom: 'Steven Noels',
      });
    });

    it('keeps no tracking token of the email in what it reports', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      world.receives(linkedInNotification('t-1', { id: 'n-1', sentAt: '2026-10-06T09:00:00Z', link: 'redirect' }));
      world.star('n-1');

      const second = await checked(world, first);

      expect(JSON.stringify(theItem(second).conversation)).not.toMatch(/midToken|trkEmail|fake-e/);
    });

    it('reads a notification with no HTML part from its text', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      world.receives(linkedInNotification('t-1', { id: 'n-1', sentAt: '2026-10-06T09:00:00Z', plainOnly: true }));
      world.star('n-1');

      const second = await checked(world, first);

      expect(theItem(second).conversation).toMatchObject({ id: CONVERSATION, link: LINKEDIN_LINK });
    });

    it('counts the notifications of the thread that are about the same conversation, and names the latest', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      world.receives(linkedInNotification('t-1', { id: 'n-1', sentAt: '2026-10-05T09:00:00Z', text: 'Hello Michael' }));
      world.receives(linkedInNotification('t-1', { id: 'n-2', sentAt: '2026-10-06T09:00:00Z', text: 'Are you there?' }));
      world.receives(linkedInNotification('t-1', { id: 'n-3', sentAt: '2026-10-07T09:00:00Z', thread: '2-b3RoZXItY29udmVyc2F0aW9u', name: 'Els Maes', text: 'Another person' }));
      world.star('n-1');

      const second = await checked(world, first);

      expect(theItem(second).conversation).toMatchObject({
        id: 'linkedin:2-b3RoZXItY29udmVyc2F0aW9u',
        messageCount: 1,
        withWhom: 'Els Maes',
        latest: { excerpt: 'Another person' },
      });
    });
  });

  describe('anything that is not a LinkedIn message notification is plain mail', () => {
    it.each([
      { situation: 'a link to a look-alike host', address: `https://www.linkedin.com.evil.example/messaging/thread/${LINKEDIN_THREAD}/` },
      { situation: 'a link to another site’s messaging address', address: `https://evil.example/messaging/thread/${LINKEDIN_THREAD}/` },
      { situation: 'a link to a LinkedIn page that is no conversation', address: 'https://www.linkedin.com/jobs/view/3800000000/' },
      { situation: 'a LinkedIn redirect that leaves LinkedIn', address: `https://www.linkedin.com/e/v2?e=fake&url=${encodeURIComponent(`https://evil.example/messaging/thread/${LINKEDIN_THREAD}/`)}` },
      { situation: 'a redirect through another site', address: `https://evil.example/r?url=${encodeURIComponent(LINKEDIN_LINK)}` },
      { situation: 'a plain-http link', address: `http://www.linkedin.com/messaging/thread/${LINKEDIN_THREAD}/` },
      { situation: 'a thread id that is no id', address: 'https://www.linkedin.com/messaging/thread/%3Cscript%3E/' },
    ])('keeps no link: $situation', async ({ address }) => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      world.receives(notificationLeadingTo('t-1', { id: 'n-1', sentAt: '2026-10-06T09:00:00Z', address }));
      world.star('n-1');

      const second = await checked(world, first);

      expect(theItem(second).conversation).toMatchObject({ id: 't-1', link: expect.stringContaining('mail.google.com') });
    });

    it('is plain mail when a LinkedIn email is no message notification, a connection request', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      world.receives(linkedInConnectionRequest('t-1', { id: 'n-1', sentAt: '2026-10-06T09:00:00Z' }));
      world.star('n-1');

      const second = await checked(world, first);

      expect(theItem(second).conversation).toMatchObject({ id: 't-1', link: expect.stringContaining('mail.google.com') });
    });

    it('is plain mail when the sender is not LinkedIn, whatever link the email carries', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      world.receives(
        notificationLeadingTo('t-1', { id: 'n-1', sentAt: '2026-10-06T09:00:00Z', address: LINKEDIN_LINK, from: 'Pieter Claes <pieter@example.com>' }),
      );
      world.star('n-1');

      const second = await checked(world, first);

      expect(theItem(second).conversation).toMatchObject({ id: 't-1' });
    });

    it.each([
      { address: LINKEDIN_LINK, thread: LINKEDIN_THREAD },
      { address: `https://www.linkedin.com/comm/messaging/thread/${LINKEDIN_THREAD}/?trk=eml`, thread: LINKEDIN_THREAD },
      { address: `https://www.linkedin.com/e/v2?url=${encodeURIComponent(`https://www.linkedin.com/comm/messaging/thread/${LINKEDIN_THREAD}/`)}`, thread: LINKEDIN_THREAD },
      { address: 'https://www.linkedin.com/messaging/', thread: null },
      { address: 'not an address', thread: null },
    ])('reads the thread of $address as $thread', ({ address, thread }) => {
      expect(linkedInThreadOf(address)).toBe(thread);
    });
  });

  describe('a later notification about a followed LinkedIn conversation is their turn, whichever Gmail conversation it lands in', () => {
    it('reports it as their turn, from an unstarred notification in a conversation of its own', async () => {
      const { world, host } = await followed();
      world.receives(
        linkedInNotification('t-9', { id: 'n-9', sentAt: '2026-10-08T07:30:00Z', language: 'nl', link: 'comm', text: 'Vrijdag past ook.' }),
      );

      const next = await checked(world, host);

      expect(next.turns).toEqual([
        {
          conversationId: CONVERSATION,
          messageId: 'n-9',
          by: 'them',
          from: 'Steven Noels',
          at: '2026-10-08T07:30:00.000Z',
          excerpt: 'Vrijdag past ook.',
        },
      ]);
    });

    it('reports one for the same conversation whether it lands in another Gmail conversation or in the starred one', async () => {
      const { world, host } = await followed();
      world.receives(linkedInNotification('t-9', { id: 'n-9', sentAt: '2026-10-08T07:30:00Z' }));
      world.receives(linkedInNotification('t-1', { id: 'n-2', sentAt: '2026-10-08T08:30:00Z' }));

      const next = await checked(world, host);

      expect(next.turns.map((turn) => [turn.conversationId, turn.messageId])).toEqual([
        [CONVERSATION, 'n-9'],
        [CONVERSATION, 'n-2'],
      ]);
    });

    it('reports nothing for a notification of a conversation no Item follows', async () => {
      const { world, host } = await followed();
      world.receives(linkedInNotification('t-9', { id: 'n-9', sentAt: '2026-10-08T07:30:00Z', thread: '2-b3RoZXItY29udmVyc2F0aW9u' }));

      const next = await checked(world, host);

      expect(next.turns).toEqual([]);
    });

    it('reads in full only mail from the notification sender', async () => {
      const { world, host } = await followed();
      world.arrives('t-5', 'Invoice', 'Please pay.', []);
      world.receives(linkedInNotification('t-9', { id: 'n-9', sentAt: '2026-10-08T07:30:00Z' }));
      world.receives(linkedInConnectionRequest('t-8', { id: 'c-8', sentAt: '2026-10-08T07:40:00Z' }));

      await checked(world, host);

      expect(world.emailReads()).toEqual(['n-9']);
      expect(world.requests.filter((one) => one.includes('q=from'))).toHaveLength(1);
    });

    it('does not look for notifications while no Item follows a LinkedIn conversation', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      world.arrives('t-1', 'Dinner', 'Thursday?', ['star']);
      const second = await checked(world, first);
      world.forget();
      world.receives(linkedInNotification('t-9', { id: 'n-9', sentAt: '2026-10-08T07:30:00Z' }));

      const third = await checked(world, second);

      expect(third.turns).toEqual([]);
      expect(world.requests.filter((one) => one.includes('q=from') || /messages\/[^/?]+\?format/.test(one))).toEqual([]);
    });

    it('reports a notification once, however many runs read the page', async () => {
      const { world, host } = await followed();
      world.receives(linkedInNotification('t-9', { id: 'n-9', sentAt: '2026-10-08T07:30:00Z' }));

      const next = await checked(world, host);
      const again = await checked(world, next);

      expect(next.turns).toHaveLength(1);
      expect(again.turns).toEqual([]);
    });

    it('reports nothing for an Item that is done: the host no longer follows its conversation', async () => {
      const { world, host } = await followed();
      host.finished.add(CONVERSATION);
      world.receives(linkedInNotification('t-9', { id: 'n-9', sentAt: '2026-10-08T07:30:00Z' }));

      const next = await checked(world, host);

      expect(next.turns).toEqual([]);
      expect(world.emailReads()).toEqual([]);
    });
  });

  describe('a star on another notification of a conversation an open Item follows adds to that Item', () => {
    it('makes no second Item', async () => {
      const { world, host } = await followed();
      world.receives(linkedInNotification('t-9', { id: 'n-9', sentAt: '2026-10-08T07:30:00Z' }));
      world.star('n-9');

      const next = await checked(world, host);

      expect(next.emitted).toEqual([]);
      expect(next.turns.map((turn) => turn.messageId)).toEqual(['n-9']);
    });

    it('makes a new Item once the first is done', async () => {
      const { world, host } = await followed();
      host.finished.add(CONVERSATION);
      world.receives(linkedInNotification('t-9', { id: 'n-9', sentAt: '2026-10-08T07:30:00Z' }));
      world.star('n-9');

      const next = await checked(world, host);

      expect(next.emitted).toHaveLength(1);
      expect(next.emitted[0]).toMatchObject({ sourceId: 't-9', conversation: { id: CONVERSATION } });
    });
  });
});
