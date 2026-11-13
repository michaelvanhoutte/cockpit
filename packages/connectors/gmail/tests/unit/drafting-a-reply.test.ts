import { describe, expect, it } from 'vitest';
import { SourceError, type OnDemandHost } from '@cockpit/connector-sdk';
import type { FakeHost } from './fake-host.js';
import { ADDRESS, GmailWorld, signedInHost } from './gmail-world.js';

/**
 * L1, against a fake host and Gmail faked at the network: what the Gmail
 * connector does for a draft Claude writes ("Mail follow-up: Reply… in Gmail
 * makes an empty draft: have Claude write it from the Item, your points and the
 * conversation", issue 1730) - read a conversation for a reply, and make a draft
 * with a body it is handed. Never writing the body itself, nor addressing the
 * draft from it: the recipient, subject and thread are the mailbox's
 * (making-drafts.test.ts). What the request does with them is the Worker's, proved
 * at L2 (apps/api/tests/integration/connectors/claude-drafts-on-the-host.test.ts).
 */

const LIMITS = { messages: 10, characters: 4000 };

function onDemand(host: FakeHost): OnDemandHost {
  return {
    getCredentials: () => host.getCredentials(),
    setCredentials: (credentials) => host.setCredentials(credentials),
    getState: async () => ({ address: ADDRESS }),
    log: (level, message, data) => host.log(level, message, data),
  };
}

/** A header of the draft Gmail was asked to make, as its raw text holds it. */
function headerOfDraft(text: string, name: string): string | undefined {
  return new RegExp(`^${name}: (.*)$`, 'mi').exec(text)?.[1]?.replace(/\r$/, '');
}

/** The body of the draft Gmail was asked to make: what follows its headers, decoded as its encoding says. */
function bodyOfDraft(text: string): string {
  const [headers, ...rest] = text.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  if (!/^Content-Transfer-Encoding: base64$/im.test(headers!)) return body;
  return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
}

describe('Triage', () => {
  describe('a draft made with a body it is handed has that body, in the conversation the mailbox names', () => {
    it('writes the body into a reply, intact with its non-ASCII text and line breaks, addressed as the mailbox addresses it', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'Diner volgende week?', 'Zullen we?', ['star']);
      world.replies('t-1', [], { from: 'Steven Noels <steven@example.com>', text: 'Donderdag?', sentAt: '2026-10-03T09:00:00Z' });
      const body = 'Dag Steven,\n\nDonderdag past mij prima ✓. Om [hoe laat?] in Gent?\n\nGroet,\nAnna';

      await world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), { subject: 'Plan', replyIn: 't-1', body });

      const [asked] = world.draftsAsked;
      expect(bodyOfDraft(asked!.text)).toBe(body.replace(/\n/g, '\r\n'));
      expect(asked!.threadId).toBe('t-1');
      expect(headerOfDraft(asked!.text, 'To')).toBe('Steven Noels <steven@example.com>');
      expect(headerOfDraft(asked!.text, 'Subject')).toBe('Re: Diner volgende week?');
    });

    it('writes the body into a new conversation’s draft, with the title as subject and nobody to send it to', async () => {
      const world = new GmailWorld();

      await world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), {
        subject: 'Plan a dinner',
        replyIn: null,
        body: 'Hi Steven, [which evening?]',
      });

      const [asked] = world.draftsAsked;
      expect(bodyOfDraft(asked!.text)).toBe('Hi Steven, [which evening?]');
      expect(headerOfDraft(asked!.text, 'Subject')).toBe('Plan a dinner');
      expect(headerOfDraft(asked!.text, 'To')).toBeUndefined();
    });

    it('keeps every line of a long body inside the line length mail allows', async () => {
      const world = new GmailWorld();
      const body = 'word '.repeat(2000).trim();

      await world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), { subject: 'Plan', replyIn: null, body });

      const text = world.draftsAsked[0]!.text;
      expect(Math.max(...text.split('\r\n').map((line) => line.length))).toBeLessThanOrEqual(998);
      expect(bodyOfDraft(text)).toBe(body);
    });

    it('makes an empty draft where it is handed no body, as before', async () => {
      const world = new GmailWorld();

      await world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), { subject: 'Plan', replyIn: null });

      expect(bodyOfDraft(world.draftsAsked[0]!.text)).toBe('');
      expect(world.draftsAsked[0]!.text).not.toMatch(/Content-Transfer-Encoding/i);
    });
  });

  describe('a conversation is read for a reply as its newest messages, each as its own words', () => {
    it('answers the messages oldest first, who sent each and when, without drafts or the earlier emails a message quotes', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'Dinner one of these weeks?', 'Shall we have dinner?', ['star']);
      world.replies('t-1', [], { sent: true, text: 'Yes! Thursday?', sentAt: '2026-10-02T09:00:00Z' });
      world.replies('t-1', [], {
        from: 'Steven Noels <steven@example.com>',
        text: 'Thursday does not work.\n\nOn Fri, 2 Oct 2026 at 09:00, Anna Peeters <anna@example.com> wrote:\n> Yes! Thursday?',
        sentAt: '2026-10-03T09:00:00Z',
      });
      world.drafts('t-1');

      const read = await world.connector().readConversationForReply!(onDemand(signedInHost({ choice: 'star' })), 't-1', LIMITS);

      expect(read.map((one) => [one.by, one.from, one.text])).toEqual([
        ['them', 'Pieter Claes', 'Shall we have dinner?'],
        ['you', 'Anna Peeters', 'Yes! Thursday?'],
        ['them', 'Steven Noels', 'Thursday does not work.'],
      ]);
      expect(read.map((one) => one.at)).toEqual([...read.map((one) => one.at)].sort());
    });

    it('answers only the newest messages of a long conversation', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'A long one', 'Message 0', ['star']);
      for (let n = 1; n < 30; n += 1) {
        world.replies('t-1', [], { text: `Message ${n}`, sentAt: new Date(Date.UTC(2026, 9, 2, 8, n)).toISOString() });
      }

      const read = await world.connector().readConversationForReply!(onDemand(signedInHost({ choice: 'star' })), 't-1', LIMITS);

      expect(read.map((one) => one.text)).toEqual(Array.from({ length: 10 }, (_, n) => `Message ${n + 20}`));
    });

    it('cuts a message far over the limit to it', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'A long one', 'x'.repeat(50_000), ['star']);

      const [only] = await world.connector().readConversationForReply!(onDemand(signedInHost({ choice: 'star' })), 't-1', LIMITS);

      expect(only!.text).toHaveLength(4000);
    });

    it('says why, in words for the person, where the conversation is no longer in Gmail', async () => {
      const world = new GmailWorld();

      const reading = world.connector().readConversationForReply!(onDemand(signedInHost({ choice: 'star' })), 'gone', LIMITS);

      await expect(reading).rejects.toBeInstanceOf(SourceError);
      await expect(reading).rejects.toThrow('the conversation is no longer in Gmail');
    });
  });

  /**
   * Draft with Claude asked again ("Mail follow-up: a Claude draft looks like any
   * other and cannot be redone…", issue 1732): the look reads the draft's words
   * back, and the rewrite replaces its body in place. Whether the words still
   * match Claude's, and what is recorded, is the Worker's (L2,
   * apps/api/tests/integration/connectors/drafts-on-the-host.test.ts).
   */
  describe('a draft is read back as its words, and written again in place keeping everything else', () => {
    /** A reply Claude's body was written into, and the draft as the store waits on it. */
    async function aReplyDrafted(world: GmailWorld, body = 'Hi Steven,\n\nThursday works.\n\nAnna') {
      world.arrives('t-1', 'Dinner one of these weeks?', 'Shall we?', ['star']);
      world.replies('t-1', [], { from: 'Steven Noels <steven@example.com>', text: 'Thursday?', sentAt: '2026-10-03T09:00:00Z' });
      const made = await world.connector().makeDraft!(onDemand(signedInHost({ choice: 'star' })), { subject: 'Plan', replyIn: 't-1', body });
      return { conversationId: made.conversationId, draftId: made.draftId, after: '2026-10-03T09:00:00.000Z' };
    }

    it('reads a draft’s words with the look, in the one read of the draft', async () => {
      const world = new GmailWorld();
      const draft = await aReplyDrafted(world);

      const found = await world.connector().findDraft!(onDemand(signedInHost({ choice: 'star' })), draft, { text: true });

      expect(found).toEqual({ draftLink: expect.any(String), text: 'Hi Steven,\n\nThursday works.\n\nAnna' });
      expect(world.requests.filter((one) => one.includes('/drafts/'))).toEqual(['GET /gmail/v1/users/me/drafts/r-1?format=full']);
    });

    it('reads no words where none are asked for, as before', async () => {
      const world = new GmailWorld();
      const draft = await aReplyDrafted(world);

      const found = await world.connector().findDraft!(onDemand(signedInHost({ choice: 'star' })), draft);

      expect(found).toEqual({ draftLink: expect.any(String) });
      expect(world.requests.filter((one) => one.includes('/drafts/'))).toEqual(['GET /gmail/v1/users/me/drafts/r-1?format=minimal']);
    });

    it('reads a draft a file was added to as having no words it can tell, so it is the person’s', async () => {
      const world = new GmailWorld();
      const draft = await aReplyDrafted(world);
      world.editsTheDraft(draft.draftId, 'Hi Steven,\n\nThursday works.\n\nAnna', { attaching: true });

      const found = await world.connector().findDraft!(onDemand(signedInHost({ choice: 'star' })), draft, { text: true });

      expect(found).toEqual({ draftLink: expect.any(String), text: null });
    });

    it('replaces the body of the same draft, in its conversation, keeping who it goes to, its subject and what it answers', async () => {
      const world = new GmailWorld();
      const draft = await aReplyDrafted(world);
      const made = world.draftsAsked[0]!.text;

      const outcome = await world.connector().rewriteDraft!(onDemand(signedInHost({ choice: 'star' })), draft, {
        was: 'Hi Steven,\n\nThursday works.\n\nAnna',
        body: 'Hi Steven,\n\nFriday ✓ instead.\n\nAnna',
      });

      expect(outcome).toBe('rewritten');
      expect(world.draftsAsked).toHaveLength(1);
      const [updated] = world.draftsUpdated;
      expect(updated).toMatchObject({ id: 'r-1', threadId: 't-1' });
      expect(bodyOfDraft(updated!.text)).toBe('Hi Steven,\r\n\r\nFriday ✓ instead.\r\n\r\nAnna');
      for (const name of ['To', 'Subject', 'In-Reply-To', 'References']) expect(headerOfDraft(updated!.text, name)).toBe(headerOfDraft(made, name));
      expect(updated!.text.match(/^Content-Type: /gim)).toHaveLength(1);
      expect(world.requests.filter((one) => one.includes('/drafts/'))).toEqual([
        'GET /gmail/v1/users/me/drafts/r-1?format=raw',
        'PUT /gmail/v1/users/me/drafts/r-1',
      ]);
    });

    it('writes nothing, and says it changed, where a file was added to the draft', async () => {
      const world = new GmailWorld();
      const draft = await aReplyDrafted(world);
      const raw = world.draftsAsked[0]!.text.replace('Content-Type: text/plain; charset="UTF-8"', 'Content-Type: multipart/mixed; boundary="b"');
      world.replacesTheDraftRaw(draft.draftId, raw);

      const outcome = await world.connector().rewriteDraft!(onDemand(signedInHost({ choice: 'star' })), draft, { was: 'Hi', body: 'Hello' });

      expect(outcome).toBe('changed');
      expect(world.draftsUpdated).toEqual([]);
    });

    it('says why, in words for the person, where the draft is no longer in Gmail', async () => {
      const world = new GmailWorld();
      const draft = await aReplyDrafted(world);
      world.deletesTheDraft(draft.draftId);

      const rewriting = world.connector().rewriteDraft!(onDemand(signedInHost({ choice: 'star' })), draft, { was: 'Hi', body: 'Hello' });

      await expect(rewriting).rejects.toBeInstanceOf(SourceError);
      await expect(rewriting).rejects.toThrow('the draft is no longer in Gmail');
      expect(world.draftsUpdated).toEqual([]);
    });
  });
});
