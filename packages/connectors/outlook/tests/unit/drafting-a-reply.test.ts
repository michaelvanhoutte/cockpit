import { describe, expect, it } from 'vitest';
import { SourceError, type OnDemandHost } from '@cockpit/connector-sdk';
import type { FakeHost } from './fake-host.js';
import { DELETED_ITEMS_ID, DRAFTS_ID, GraphWorld, SENT_ITEMS_ID, signedInHost } from './outlook-world.js';
import { wordsReplaced } from '../../src/drafts.js';

/**
 * L1, against a fake host and Microsoft Graph faked at the network, from the
 * shapes Graph documents: what the Outlook connector does for a draft Claude
 * writes ("Mail follow-up: Email… and Reply… in Outlook make an empty draft:
 * have Claude write it", issue 1731) - read a conversation for a reply, and make
 * a draft with a body it is handed. Never writing the body itself: the
 * recipient, subject and thread are the mailbox's (making-drafts.test.ts). What
 * the request does with them is the Worker's, proved at L2
 * (apps/api/tests/integration/connectors/outlook-drafts-on-the-host.test.ts).
 */

const LIMITS = { messages: 10, characters: 4000 };

function onDemand(host: FakeHost): OnDemandHost {
  return {
    getCredentials: () => host.getCredentials(),
    setCredentials: (credentials) => host.setCredentials(credentials),
    getState: async () => null,
    log: (level, message, data) => host.log(level, message, data),
  };
}

const ANNA = { name: 'Anna Peeters', address: 'anna@example.com' };
const STEVEN = { name: 'Steven Noels', address: 'steven@example.com' };

describe('Triage', () => {
  describe('a draft made with a body it is handed has that body, in the conversation the mailbox names', () => {
    it('writes the body into a new conversation’s draft as plain text, intact with its non-ASCII text and line breaks', async () => {
      const world = new GraphWorld();
      const body = 'Dag Steven,\n\nDonderdag past mij prima ✓. Om [hoe laat?] in Gent?\n\nGroet,\nAnna';

      await world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan a dinner', replyIn: null, body });

      expect(world.draftsAsked[0]!.body).toEqual({ subject: 'Plan a dinner', body: { contentType: 'text', content: body } });
      expect(world.bodyOf('draft-1')).toEqual({ contentType: 'text', content: body });
    });

    it('puts the body of a reply above the email Outlook quotes in it, intact with its non-ASCII text and line breaks', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { conversation: 'c-1', from: STEVEN, receivedAt: '2026-10-09T09:00:00Z', subject: 'Diner?', text: 'Shall we?' });
      const body = 'Dag Steven,\n\nDonderdag past <prima> & ✓.\n\nAnna';

      const made = await world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: 'c-1', body });

      expect(made.conversationId).toBe('c-1');
      expect(world.requests).toContain('POST /v1.0/me/messages/m-1/createReply');
      expect(world.requests).toContain('PATCH /v1.0/me/messages/draft-1');
      const stored = world.bodyOf('draft-1');
      expect(stored.contentType).toBe('html');
      expect(stored.content).toContain('<div>Dag Steven,</div><div><br></div><div>Donderdag past &lt;prima&gt; &amp; ✓.</div><div><br></div><div>Anna</div>');
      // Above the quoted email, which stays.
      expect(stored.content.indexOf('Dag Steven')).toBeLessThan(stored.content.indexOf('Shall we?'));
      expect(stored.content).toContain('Shall we?');
    });

    it('makes an empty draft where it is handed no body, as before, changing nothing after', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { conversation: 'c-1', receivedAt: '2026-10-09T09:00:00Z' });

      await world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: 'c-1' });

      expect(world.requests.filter((one) => one.startsWith('PATCH'))).toEqual([]);
    });

    it('says why, in words for the person, where Outlook refuses the body of a reply draft', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { conversation: 'c-1', receivedAt: '2026-10-09T09:00:00Z' });
      world.failures.push({ prefix: 'messages/draft-1', status: 403, body: { error: { code: 'ErrorAccessDenied' } } });

      const making = world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: 'c-1', body: 'Hi' });

      await expect(making).rejects.toBeInstanceOf(SourceError);
      await expect(making).rejects.toThrow('Outlook refused the draft (403)');
    });
  });

  describe('a conversation is read for a reply as its newest messages, each as its own words', () => {
    it('answers the messages oldest first, who sent each and when, without drafts, Deleted Items or the earlier emails a message quotes', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { conversation: 'c-1', from: STEVEN, receivedAt: '2026-10-01T09:00:00Z', text: 'Shall we have dinner?' });
      world.arrives('m-2', { conversation: 'c-1', from: ANNA, folder: SENT_ITEMS_ID, receivedAt: '2026-10-02T09:00:00Z', text: 'Yes! Thursday?' });
      world.arrives('m-3', {
        conversation: 'c-1',
        from: STEVEN,
        receivedAt: '2026-10-03T09:00:00Z',
        text: 'Thursday does not work.\n\nOn Fri, 2 Oct 2026 at 09:00, Anna Peeters <anna@example.com> wrote:\n> Yes! Thursday?',
      });
      world.arrives('m-4', { conversation: 'c-1', from: ANNA, draft: true, folder: DRAFTS_ID, receivedAt: '2026-10-04T09:00:00Z', text: 'half a draft' });
      world.arrives('m-5', { conversation: 'c-1', from: STEVEN, folder: DELETED_ITEMS_ID, receivedAt: '2026-10-05T09:00:00Z', text: 'binned' });
      world.arrives('m-6', { conversation: 'c-other', receivedAt: '2026-10-05T09:00:00Z', text: 'another conversation' });

      const read = await world.connector().readConversationForReply!(onDemand(signedInHost()), 'c-1', LIMITS);

      expect(read.map((one) => [one.by, one.from, one.text])).toEqual([
        ['them', 'Steven Noels', 'Shall we have dinner?'],
        ['you', 'Anna Peeters', 'Yes! Thursday?'],
        ['them', 'Steven Noels', 'Thursday does not work.'],
      ]);
      expect(read.map((one) => one.at)).toEqual(['2026-10-01T09:00:00.000Z', '2026-10-02T09:00:00.000Z', '2026-10-03T09:00:00.000Z']);
    });

    it('answers a message that has only an HTML body as its text, without markup or the email it quotes', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', {
        conversation: 'c-1',
        from: STEVEN,
        html: '<html><body><p>Thursday <b>evening</b>?</p><p>Dinner at 8 &amp; a walk.</p><div id="appendonsend"></div><hr><div><b>From:</b> Anna<br><b>Sent:</b> Friday</div><p>Shall we have dinner?</p></body></html>',
        unique: '<html><body><p>Thursday <b>evening</b>?</p><p>Dinner at 8 &amp; a walk.</p><hr><div><b>From:</b> Anna<br><b>Sent:</b> Friday</div><p>Shall we have dinner?</p></body></html>',
      });

      const [only] = await world.connector().readConversationForReply!(onDemand(signedInHost()), 'c-1', LIMITS);

      expect(only!.text).toBe('Thursday evening?\nDinner at 8 & a walk.');
    });

    it('answers only the newest messages of a long conversation, reading the bodies of those alone', async () => {
      const world = new GraphWorld();
      for (let n = 0; n < 30; n += 1) {
        world.arrives(`m-${n}`, { conversation: 'c-1', receivedAt: new Date(Date.UTC(2026, 9, 2, 8, n)).toISOString(), text: `Message ${n}` });
      }
      world.forget();

      const read = await world.connector().readConversationForReply!(onDemand(signedInHost()), 'c-1', LIMITS);

      expect(read.map((one) => one.text)).toEqual(Array.from({ length: 10 }, (_, n) => `Message ${n + 20}`));
      expect(world.readsInFull()).toHaveLength(10);
      expect(world.mostAtOnce).toBe(3);
    });

    it('tells a message whose own body holds no words by its preview', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { conversation: 'c-1', text: 'Dinner on Thursday?', unique: '' });

      const [only] = await world.connector().readConversationForReply!(onDemand(signedInHost()), 'c-1', LIMITS);

      expect(only!.text).toBe('Dinner on Thursday?');
    });

    it('cuts a message far over the limit to it', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { conversation: 'c-1', text: 'x'.repeat(50_000) });

      const [only] = await world.connector().readConversationForReply!(onDemand(signedInHost()), 'c-1', LIMITS);

      expect(only!.text).toHaveLength(4000);
    });

    it('changes nothing in the mailbox', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { conversation: 'c-1' });

      await world.connector().readConversationForReply!(onDemand(signedInHost()), 'c-1', LIMITS);

      expect(world.requests.filter((one) => !one.startsWith('GET') && !one.includes('/token'))).toEqual([]);
    });

    it('says why, in words for the person, where the conversation is no longer in Outlook', async () => {
      const world = new GraphWorld();

      const reading = world.connector().readConversationForReply!(onDemand(signedInHost()), 'gone', LIMITS);

      await expect(reading).rejects.toBeInstanceOf(SourceError);
      await expect(reading).rejects.toThrow('the conversation is no longer in Outlook');
    });
  });

  /**
   * Draft with Claude asked again ("Mail follow-up: a Claude draft looks like any
   * other and cannot be redone…", issue 1732): the look reads the draft's own
   * words back, and the rewrite replaces them in place above what Outlook quotes.
   * Whether the words still match Claude's, and what is recorded, is the
   * Worker's (L2, apps/api/tests/integration/connectors/outlook-drafts-on-the-host.test.ts).
   */
  describe('a draft is read back as its own words, and written again in place keeping what it quotes', () => {
    const WORDS = 'Dag Steven,\n\nDonderdag past <prima> & ✓.\n\nAnna';
    const spacingAside = (text: string | null | undefined) => text?.replace(/\s+/g, ' ').trim();

    /** A reply Claude's body was written into, and the draft as the store waits on it. */
    async function aReplyDrafted(world: GraphWorld) {
      world.arrives('m-1', { conversation: 'c-1', from: STEVEN, receivedAt: '2026-10-09T09:00:00Z', subject: 'Diner?', text: 'Shall we?' });
      const made = await world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: 'c-1', body: WORDS });
      world.forget();
      world.writes.length = 0;
      return { conversationId: made.conversationId, draftId: made.draftId, after: '2026-10-09T09:00:00.000Z' };
    }

    it('reads a reply draft’s words above what it quotes, as text, with the look', async () => {
      const world = new GraphWorld();
      const draft = await aReplyDrafted(world);

      const found = await world.connector().findDraft!(onDemand(signedInHost()), draft, { text: true });

      expect(found).toMatchObject({ draftLink: expect.stringContaining('draft-1') });
      expect(spacingAside((found as { text?: string | null }).text)).toBe(spacingAside(WORDS));
      expect(world.requests.filter((one) => one.includes('messages/draft-1'))).toEqual([
        'GET /v1.0/me/messages/draft-1?$select=id,isDraft,parentFolderId,webLink,uniqueBody,hasAttachments',
      ]);
      expect(world.prefer[0]).toContain('outlook.body-content-type="text"');
    });

    it('reads a draft a file was attached to as having no words it can tell, so it is the person’s', async () => {
      const world = new GraphWorld();
      const draft = await aReplyDrafted(world);
      world.editsTheDraft(draft.draftId, { attaches: true });

      const found = await world.connector().findDraft!(onDemand(signedInHost()), draft, { text: true });

      expect(found).toEqual({ draftLink: expect.any(String), text: null });
    });

    it('replaces the words of the same reply draft, keeping the email it quotes, conditional on the version read', async () => {
      const world = new GraphWorld();
      const draft = await aReplyDrafted(world);
      const quoted = world.bodyOf('draft-1').content.slice(world.bodyOf('draft-1').content.indexOf('<hr>'));

      const outcome = await world.connector().rewriteDraft!(onDemand(signedInHost()), draft, { was: WORDS, body: 'Dag Steven,\n\nVrijdag dan?\n\nAnna' });

      expect(outcome).toBe('rewritten');
      const stored = world.bodyOf('draft-1').content;
      expect(stored).toContain('<body><div>Dag Steven,</div><div><br></div><div>Vrijdag dan?</div><div><br></div><div>Anna</div><div><br></div><hr>');
      expect(stored).not.toContain('Donderdag');
      expect(stored.endsWith(quoted)).toBe(true);
      expect(world.draftsAsked).toHaveLength(1);
      expect(world.writes).toEqual([expect.objectContaining({ id: 'draft-1', ifMatch: expect.stringMatching(/^W\//) })]);
    });

    it('replaces the whole body of a new conversation’s draft, kept as text', async () => {
      const world = new GraphWorld();
      const made = await world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: null, body: 'Hi Steven,\n\n[which evening?]' });
      const draft = { conversationId: made.conversationId, draftId: made.draftId, after: null };

      const outcome = await world.connector().rewriteDraft!(onDemand(signedInHost()), draft, { was: 'Hi Steven,\n\n[which evening?]', body: 'Hi Steven, Friday?' });

      expect(outcome).toBe('rewritten');
      expect(world.bodyOf('draft-1')).toEqual({ contentType: 'text', content: 'Hi Steven, Friday?' });
    });

    it('writes nothing, and says it changed, where the draft no longer starts with Claude’s words', async () => {
      const world = new GraphWorld();
      const draft = await aReplyDrafted(world);
      world.editsTheDraft(draft.draftId, { types: 'Sorry, one more thing:' });

      const outcome = await world.connector().rewriteDraft!(onDemand(signedInHost()), draft, { was: WORDS, body: 'Hello' });

      expect(outcome).toBe('changed');
      expect(world.writes).toEqual([]);
    });

    it('writes nothing over a save Outlook made between the read and the write, and says it changed', async () => {
      const world = new GraphWorld();
      const draft = await aReplyDrafted(world);
      world.beforeWrite = (id) => world.editsTheDraft(id, { types: 'typed meanwhile' });

      const outcome = await world.connector().rewriteDraft!(onDemand(signedInHost()), draft, { was: WORDS, body: 'Hello' });

      expect(outcome).toBe('changed');
      expect(world.bodyOf('draft-1').content).toContain('typed meanwhile');
      expect(world.bodyOf('draft-1').content).not.toContain('Hello');
    });

    it('says why, in words for the person, where the draft was sent meanwhile', async () => {
      const world = new GraphWorld();
      const draft = await aReplyDrafted(world);
      world.sends(draft.draftId);

      const rewriting = world.connector().rewriteDraft!(onDemand(signedInHost()), draft, { was: WORDS, body: 'Hello' });

      await expect(rewriting).rejects.toBeInstanceOf(SourceError);
      await expect(rewriting).rejects.toThrow('the draft is no longer in Outlook');
    });
  });

  describe('the words at the top of a draft are found as Outlook stores them, spacing and markup aside', () => {
    it.each([
      {
        situation: 'as Cockpit wrote them',
        content: '<html><body><div>Hi Steven,</div><div><br></div><div>Thursday &amp; Friday.</div><div><br></div><hr><div>quoted</div></body></html>',
        kept: '<hr><div>quoted</div></body></html>',
      },
      {
        situation: 'rewrapped by Outlook into one block of its own',
        content: '<html><body dir="ltr"><div class="elementToProof" style="font-size:12pt">Hi Steven,<br><br>Thursday&nbsp;&amp; Friday.</div><div id="appendonsend"></div><hr style="display:inline-block"><div>quoted</div></body></html>',
        kept: '<div id="appendonsend"></div><hr style="display:inline-block"><div>quoted</div></body></html>',
      },
    ])('replaces them $situation, keeping what follows byte for byte', ({ content, kept }) => {
      const replaced = wordsReplaced({ contentType: 'html', content }, 'Hi Steven,\n\nThursday & Friday.', 'Hello');

      expect(replaced?.contentType).toBe('html');
      expect(replaced?.content).toMatch(/<body[^>]*><div>Hello<\/div><div><br><\/div>/);
      expect(replaced?.content.endsWith(kept)).toBe(true);
    });

    it.each([
      { situation: 'words added after them', content: '<html><body><div>Hi Steven, Thursday & Friday. Or Saturday</div><hr></body></html>' },
      { situation: 'other words first', content: '<html><body><div>PS</div><div>Hi Steven, Thursday & Friday.</div></body></html>' },
      { situation: 'some of them gone', content: '<html><body><div>Hi Steven,</div><hr></body></html>' },
      {
        situation: 'an image pasted among them, which Graph counts in no attachment',
        content: '<html><body><div>Hi Steven,</div><div><img src="cid:image001.png"></div><div>Thursday &amp; Friday.</div><hr></body></html>',
      },
    ])('finds none where the draft has $situation', ({ content }) => {
      expect(wordsReplaced({ contentType: 'html', content }, 'Hi Steven,\n\nThursday & Friday.', 'Hello')).toBeNull();
    });
  });
});
