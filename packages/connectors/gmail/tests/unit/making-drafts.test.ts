import { describe, expect, it } from 'vitest';
import { SourceError, type OnDemandHost } from '@cockpit/connector-sdk';
import type { FakeHost } from './fake-host.js';
import { ADDRESS, GmailWorld, signedInHost } from './gmail-world.js';
import { rawDraft } from '../../src/drafts.js';

/**
 * L1, against a fake host and Gmail faked at the network: *Email…* and
 * *Reply…* make a draft in the mailbox, and a check tells a draft sent from one
 * deleted unsent ("Email… makes a Gmail draft the Item then follows", issue
 * 1708). What the draft does to the Item is the host's, proved at L2
 * (apps/api/tests/integration/connectors/drafts-on-the-host.test.ts).
 */

const DRAFTS = 'https://mail.google.com/mail/?authuser=anna%40example.com#drafts?compose=';

/** The host a draft is made through: the connection's credential, and the state its last check saved. */
function onDemand(host: FakeHost, state: unknown = { address: ADDRESS }): OnDemandHost {
  return {
    getCredentials: () => host.getCredentials(),
    setCredentials: (credentials) => host.setCredentials(credentials),
    getState: async () => state,
    log: (level, message, data) => host.log(level, message, data),
  };
}

/** A header of the draft Gmail was asked to make, as its raw text holds it. */
function headerOfDraft(text: string, name: string): string | undefined {
  return new RegExp(`^${name}: (.*)$`, 'mi').exec(text)?.[1]?.replace(/\r$/, '');
}

describe('Triage', () => {
  describe('Email… makes one draft in the mailbox, titled with the Item, or a reply in the conversation it follows', () => {
    it('makes a new conversation’s draft with the title as subject and nobody to send it to, and answers where it opens', async () => {
      const world = new GmailWorld();
      const host = signedInHost({ choice: 'star' });

      const made = await world.connector().makeDraft!(onDemand(host), { subject: 'Plan a dinner with Steven Noels', replyIn: null });

      expect(world.draftsAsked).toHaveLength(1);
      const [asked] = world.draftsAsked;
      expect(asked!.threadId).toBeNull();
      expect(headerOfDraft(asked!.text, 'Subject')).toBe('Plan a dinner with Steven Noels');
      expect(headerOfDraft(asked!.text, 'To')).toBeUndefined();
      expect(made).toEqual({
        draftId: 'r-1',
        conversationId: 'draft-message-1',
        draftLink: `${DRAFTS}draft-message-1`,
        conversationLink: 'https://mail.google.com/mail/?authuser=anna%40example.com#all/draft-message-1',
      });
    });

    it('encodes a subject outside ASCII so Gmail reads it back whole', async () => {
      const world = new GmailWorld();

      await world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), { subject: 'Diner met Stéven ✓', replyIn: null });

      const subject = headerOfDraft(world.draftsAsked[0]!.text, 'Subject')!;
      const [, encoded] = /^=\?UTF-8\?B\?(.+)\?=$/.exec(subject)!;
      expect(new TextDecoder().decode(Uint8Array.from(atob(encoded!), (c) => c.charCodeAt(0)))).toBe('Diner met Stéven ✓');
    });

    it('makes a reply in the followed conversation, answering its latest message and addressed to whom it came from', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'Dinner one of these weeks?', 'Shall we?', ['star']);
      world.replies('t-1', [], { from: 'Steven Noels <steven@example.com>', text: 'Thursday?' });

      const made = await world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), { subject: 'Plan a dinner', replyIn: 't-1' });

      const [asked] = world.draftsAsked;
      expect(asked!.threadId).toBe('t-1');
      expect(headerOfDraft(asked!.text, 'Subject')).toBe('Re: Dinner one of these weeks?');
      expect(headerOfDraft(asked!.text, 'To')).toBe('Steven Noels <steven@example.com>');
      expect(headerOfDraft(asked!.text, 'In-Reply-To')).toBe('<t-1-r1@mail.example.com>');
      expect(headerOfDraft(asked!.text, 'References')).toBe('<t-1-r1@mail.example.com>');
      expect(made.conversationId).toBe('t-1');
    });

    it('folds a long conversation’s References one message id a line, inside the line length mail allows', () => {
      const ids = Array.from({ length: 40 }, (_, n) => `<message-${n}-of-a-long-conversation@mail.example.com>`);

      const raw = rawDraft({ subject: 'Re: Dinner', to: null, inReplyTo: ids.at(-1)!, references: ids.join(' ') });

      const text = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
      expect(text).toContain(`References: ${ids.join('\r\n ')}\r\n`);
      expect(Math.max(...text.split('\r\n').map((line) => line.length))).toBeLessThanOrEqual(998);
    });

    it('addresses a reply to whom your own latest message went', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'Dinner one of these weeks?', 'Shall we?', ['star']);
      world.replies('t-1', [], { sent: true, text: 'Thursday?' });

      await world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), { subject: 'Plan a dinner', replyIn: 't-1' });

      // The fixtures send every message to this mailbox unless told otherwise.
      expect(headerOfDraft(world.draftsAsked[0]!.text, 'To')).toBe('anna@example.com');
    });

    it('asks Gmail for the mailbox’s address where no check has saved it, to name it in the link', async () => {
      const world = new GmailWorld();

      const made = await world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' }), null), { subject: 'Plan', replyIn: null });

      expect(world.requests.some((one) => one.endsWith('/profile'))).toBe(true);
      expect(made.draftLink.startsWith(DRAFTS)).toBe(true);
    });

    it.each([
      {
        situation: 'Google no longer accepts the sign-in',
        happens: (world: GmailWorld) => {
          world.acceptedToken = 'another-token';
          world.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } };
        },
        says: 'Google no longer accepts the sign-in. Connect again.',
      },
      {
        situation: 'Gmail is not answering',
        happens: (world: GmailWorld) => world.failures.push({ prefix: 'drafts', status: 503 }),
        says: 'Gmail did not answer. Try again in a moment.',
      },
      {
        situation: 'Gmail refuses the draft',
        happens: (world: GmailWorld) => world.failures.push({ prefix: 'drafts', status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT' } } }),
        says: 'Gmail refused the draft (400)',
      },
    ])('says why, in words for the person, where $situation', async ({ happens, says }) => {
      const world = new GmailWorld();
      happens(world);

      const making = world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), { subject: 'Plan', replyIn: null });

      await expect(making).rejects.toBeInstanceOf(SourceError);
      await expect(making).rejects.toThrow(says);
      expect(world.draftsAsked).toEqual([]);
    });

    it('makes nothing where the followed conversation is gone from Gmail', async () => {
      const world = new GmailWorld();

      const making = world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), { subject: 'Plan', replyIn: 't-gone' });

      await expect(making).rejects.toThrow('the conversation is no longer in Gmail');
      expect(world.draftsAsked).toEqual([]);
    });
  });

  describe('a check tells a draft sent, which is your turn, from one deleted unsent', () => {
    /** A connection following the star, a new conversation's draft made, and the host waiting on it. */
    async function aDraftWaitedOn(): Promise<{ world: GmailWorld; host: FakeHost; draftId: string; conversationId: string }> {
      const world = new GmailWorld();
      const host = signedInHost({ choice: 'star' });
      await world.connector().sync(host);
      const made = await world.connector().makeDraft!(onDemand(host), { subject: 'Plan a dinner', replyIn: null });
      host.following.add(made.conversationId);
      host.draftsMade.push({ conversationId: made.conversationId, draftId: made.draftId, after: null });
      return { world, host, draftId: made.draftId, conversationId: made.conversationId };
    }

    it.each([
      {
        situation: 'the draft still unsent',
        happens: () => {},
        turns: [],
        gone: [],
      },
      {
        situation: 'the draft sent',
        happens: (world: GmailWorld, draftId: string) => world.sendsTheDraft(draftId),
        turns: [{ by: 'you' }],
        gone: [],
      },
      {
        situation: 'the draft deleted unsent',
        happens: (world: GmailWorld, draftId: string) => world.deletesTheDraft(draftId),
        turns: [],
        gone: ['r-1'],
      },
    ])('with $situation', async ({ happens, turns, gone }) => {
      const { world, host, draftId, conversationId } = await aDraftWaitedOn();
      happens(world, draftId);

      const next = host.next();
      await world.connector().sync(next);

      expect(next.turns).toEqual(turns.map((turn) => expect.objectContaining({ ...turn, conversationId })));
      expect(next.draftsGone).toEqual(gone.map((id) => ({ conversationId, draftId: id })));
    });

    it('reports nothing gone for a draft whose conversation holds a message you sent, though the host still waits on it', async () => {
      const { world, host, draftId } = await aDraftWaitedOn();
      world.sendsTheDraft(draftId);
      const next = host.next();
      // As a draft sent after the history was read: the host has not heard of the turn yet.
      next.draftsWaiting = async () => [...host.draftsMade];

      await world.connector().sync(next);

      expect(next.draftsGone).toEqual([]);
    });
  });
});
