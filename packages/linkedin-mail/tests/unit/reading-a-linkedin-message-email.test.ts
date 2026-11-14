import { describe, expect, it } from 'vitest';
import { linkedInMessageIn, linkedInThreadOf, type LinkedInMail } from '../../src/index.js';

/**
 * L1, on a mail as the reader takes it (sender, bodies, time), with no mail
 * provider in sight. The emails are reconstructed, not captured: no real
 * LinkedIn email was to hand, so the shapes follow what is publicly seen of
 * the direct notification and the digest's *View message* button. Replace
 * them with captured ones (names and addresses changed) when there are some.
 */

const THREAD = '2-ZmFrZS10aHJlYWQtMQ==';
const CLEAN = `https://www.linkedin.com/messaging/thread/${THREAD}/`;
const AT = Date.parse('2026-10-06T09:00:00Z');
const OTP = 'FAKEOTPTOKEN-do-not-keep';

/** The digest's button: no slash before the query, a page tag and a sign-in token. */
const DIGEST_ADDRESS = `https://www.linkedin.com/comm/messaging/thread/${THREAD}?lipi=urn%3Ali%3Apage%3Aemail_messaging_digest%3BfakeLipi&otpToken=${OTP}&midToken=AQEfake`;

function mail(over: Partial<LinkedInMail> & { address?: string }): LinkedInMail {
  const address = over.address ?? DIGEST_ADDRESS;
  return {
    from: 'Frederik Denkens via LinkedIn <messaging-digest-noreply@linkedin.com>',
    plain: [`Frederik Denkens\n\nCan you send me the deck?\n\nView message: ${address}\n\nYou are receiving LinkedIn notification emails.`],
    html: [`<p>Frederik Denkens</p><p>Can you send me the deck?</p><a href="${address.replace(/&/g, '&amp;')}">View message</a>`],
    at: AT,
    ...over,
  };
}

describe('Capture', () => {
  describe('a LinkedIn message email is read as a turn of the conversation it names, whichever mailbox it came from', () => {
    it.each([
      { situation: 'the digest sender, whose button has a query and a sign-in token', from: 'Frederik Denkens via LinkedIn <messaging-digest-noreply@linkedin.com>', address: DIGEST_ADDRESS },
      { situation: 'the direct sender, linking to the clean address', from: 'Frederik Denkens via LinkedIn <messages-noreply@linkedin.com>', address: CLEAN },
      { situation: 'the direct sender, through the comm tracking address', from: 'Frederik Denkens via LinkedIn <messages-noreply@linkedin.com>', address: `https://www.linkedin.com/comm/messaging/thread/${THREAD}/?trk=eml` },
    ])('reads the email from $situation as Frederik’s turn in the thread, with the clean link', ({ from, address }) => {
      const read = linkedInMessageIn(mail({ from, address }));

      expect(read).toEqual({
        conversationId: `linkedin:${THREAD}`,
        link: CLEAN,
        turn: { by: 'them', from: 'Frederik Denkens', at: '2026-10-06T09:00:00.000Z', excerpt: 'Can you send me the deck?' },
      });
    });

    it('keeps nothing of the email’s tracking or sign-in token', () => {
      const read = linkedInMessageIn(mail({}));

      expect(JSON.stringify(read)).not.toMatch(/otpToken|lipi|midToken|FAKEOTPTOKEN/);
    });

    it('reads an email with no text part from its HTML', () => {
      const read = linkedInMessageIn(mail({ plain: [] }));

      expect(read?.turn.excerpt).toBe('Can you send me the deck?');
    });
  });

  describe('anything that is not a LinkedIn message email is plain mail', () => {
    it.each([
      { situation: 'a link to a look-alike host', address: `https://linkedin.com.example.org/messaging/thread/${THREAD}/` },
      { situation: 'a link to another site’s messaging address', address: `https://evil.example/messaging/thread/${THREAD}/` },
      { situation: 'a connection request: a LinkedIn page that is no conversation', address: 'https://www.linkedin.com/comm/mynetwork/invitations/accept/?invitationId=1' },
      { situation: 'a plain-http link', address: `http://www.linkedin.com/messaging/thread/${THREAD}/` },
      { situation: 'a thread id that climbs out of the thread path', address: 'https://www.linkedin.com/messaging/thread/%2e%2e/' },
    ])('is not read: $situation', ({ address }) => {
      expect(linkedInMessageIn(mail({ address }))).toBeNull();
    });

    it.each([
      { situation: 'a sender that is not LinkedIn', from: 'Pieter Claes <pieter@example.com>' },
      { situation: 'a sender on a look-alike domain', from: 'Frederik <messaging-digest-noreply@linkedin.com.example.org>' },
      { situation: 'no sender', from: null },
    ])('is not read: $situation, whatever link the email carries', ({ from }) => {
      expect(linkedInMessageIn(mail({ from }))).toBeNull();
    });

    it('is not read when nobody knows when it was sent', () => {
      expect(linkedInMessageIn(mail({ at: 0 }))).toBeNull();
    });
  });

  describe('an address is read as the LinkedIn conversation it leads to', () => {
    it.each([
      { address: CLEAN, thread: THREAD },
      { address: DIGEST_ADDRESS, thread: THREAD },
      { address: `https://www.linkedin.com/e/v2?url=${encodeURIComponent(DIGEST_ADDRESS)}`, thread: THREAD },
      { address: `https://www.linkedin.com/e/v2?url=${encodeURIComponent(`https://evil.example/messaging/thread/${THREAD}/`)}`, thread: null },
      { address: `https://evil.example/r?url=${encodeURIComponent(CLEAN)}`, thread: null },
      { address: 'https://www.linkedin.com/messaging/', thread: null },
      { address: 'not an address', thread: null },
    ])('reads the thread of $address as $thread', ({ address, thread }) => {
      expect(linkedInThreadOf(address)).toBe(thread);
    });
  });
});
