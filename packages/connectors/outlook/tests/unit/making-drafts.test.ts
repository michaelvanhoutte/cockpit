import { describe, expect, it } from 'vitest';
import { SourceError, type OnDemandHost } from '@cockpit/connector-sdk';
import type { FakeHost } from './fake-host.js';
import { DELETED_ITEMS_ID, DRAFTS_ID, GraphWorld, NOW, SENT_ITEMS_ID, signedInHost } from './outlook-world.js';

/**
 * L1, against a fake host and Microsoft Graph faked at the network, from the
 * shapes Graph documents: *Email…* and *Reply…* make a draft in the mailbox,
 * and a check tells a draft sent, which is your turn, from one deleted unsent
 * ("Email… makes an Outlook draft the Item then follows", issue 1709). What the
 * draft does to the Item is the host's, proved at L2
 * (apps/api/tests/integration/connectors/outlook-drafts-on-the-host.test.ts).
 */

/** The host a draft is made through: the connection's credential, and the state its last check saved. */
function onDemand(host: FakeHost): OnDemandHost {
  return {
    getCredentials: () => host.getCredentials(),
    setCredentials: (credentials) => host.setCredentials(credentials),
    getState: async () => null,
    log: (level, message, data) => host.log(level, message, data),
  };
}

const ANNA = { name: 'Anna', address: 'anna@example.com' };
const LINK = 'https://outlook.office365.com/owa/?ItemID=draft-1&exvsurl=1&viewmodel=ReadMessageItem';

describe('Triage', () => {
  describe('Email… makes one draft in the mailbox, titled with the Item, or a reply in the conversation it follows', () => {
    it('makes a new conversation’s draft with the title as subject, and answers where it opens', async () => {
      const world = new GraphWorld();

      const made = await world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan a dinner with Steven Noels', replyIn: null });

      expect(world.draftsAsked).toEqual([
        {
          subject: 'Plan a dinner with Steven Noels',
          replyTo: null,
          body: { subject: 'Plan a dinner with Steven Noels', body: { contentType: 'text', content: '' } },
        },
      ]);
      expect(world.requests).toContain('POST /v1.0/me/messages');
      expect(made).toEqual({
        draftId: 'draft-1',
        conversationId: 'conversation-of-draft-1',
        draftLink: LINK,
        conversationLink: LINK,
      });
    });

    it('puts a title on one line, and no longer than an Item’s title may be', async () => {
      const world = new GraphWorld();

      await world.connector().makeDraft!(onDemand(signedInHost()), { subject: `Plan\r\na dinner ${'x'.repeat(300)}`, replyIn: null });

      expect(world.draftsAsked[0]!.subject).toHaveLength(200);
      expect(world.draftsAsked[0]!.subject).toMatch(/^Plan a dinner x+$/);
    });

    it('makes a reply draft on the latest message of the conversation, in that conversation', async () => {
      const world = new GraphWorld();
      world.arrives('m-0', { conversation: 'c-1', receivedAt: '2026-10-08T08:00:00Z', subject: 'Dinner one of these weeks?' });
      world.arrives('m-1', {
        conversation: 'c-1',
        from: ANNA,
        folder: SENT_ITEMS_ID,
        receivedAt: '2026-10-09T09:00:00Z',
        subject: 'Re: Dinner one of these weeks?',
      });
      world.arrives('m-2', { conversation: 'c-other', receivedAt: '2026-10-09T10:00:00Z' });

      const made = await world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan a dinner', replyIn: 'c-1' });

      expect(world.requests).toContain('POST /v1.0/me/messages/m-1/createReply');
      expect(world.draftsAsked.map((one) => one.replyTo)).toEqual(['m-1']);
      expect(made.conversationId).toBe('c-1');
      expect(made.draftId).toBe('draft-1');
    });

    it('replies to the latest message that is neither a draft nor in Deleted Items', async () => {
      const world = new GraphWorld();
      world.arrives('m-0', { conversation: 'c-1', receivedAt: '2026-10-08T08:00:00Z' });
      world.arrives('m-1', { conversation: 'c-1', draft: true, folder: DRAFTS_ID, receivedAt: '2026-10-09T09:00:00Z' });
      world.arrives('m-2', { conversation: 'c-1', folder: DELETED_ITEMS_ID, receivedAt: '2026-10-09T10:00:00Z' });

      await world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: 'c-1' });

      expect(world.draftsAsked.map((one) => one.replyTo)).toEqual(['m-0']);
    });

    it('asks for immutable ids, so the draft keeps its id while it is edited and sent', async () => {
      const world = new GraphWorld();

      await world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: null });

      expect(world.prefer.at(-1)).toContain('IdType="ImmutableId"');
    });

    it.each([
      {
        situation: 'Microsoft no longer accepts the sign-in',
        happens: (world: GraphWorld) => {
          world.acceptedToken = 'another-token';
          world.refresh = { status: 400, body: { error: 'invalid_grant' } };
        },
        says: 'Microsoft no longer accepts the sign-in. Connect again.',
      },
      {
        situation: 'Outlook is not answering',
        happens: (world: GraphWorld) => world.failures.push({ prefix: '/messages', status: 503 }),
        says: 'Outlook did not answer. Try again in a moment.',
      },
      {
        situation: 'Outlook refuses the draft',
        happens: (world: GraphWorld) => world.failures.push({ prefix: '/messages', status: 403, body: { error: { code: 'ErrorAccessDenied' } } }),
        says: 'Outlook refused the draft (403)',
      },
    ])('says why, in words for the person, where $situation', async ({ happens, says }) => {
      const world = new GraphWorld();
      happens(world);

      const making = world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: null });

      await expect(making).rejects.toBeInstanceOf(SourceError);
      await expect(making).rejects.toThrow(says);
      expect(world.draftsAsked).toEqual([]);
    });

    it('makes nothing where the followed conversation is gone from Outlook', async () => {
      const world = new GraphWorld();

      const making = world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: 'c-gone' });

      await expect(making).rejects.toThrow('the conversation is no longer in Outlook');
      expect(world.draftsAsked).toEqual([]);
    });

    it('never asks twice for a draft, whatever Graph answers', async () => {
      const world = new GraphWorld();
      world.failures.push({ prefix: '/messages', status: 503 });

      await expect(world.connector().makeDraft!(onDemand(signedInHost()), { subject: 'Plan', replyIn: null })).rejects.toThrow();

      expect(world.requests.filter((one) => one.startsWith('POST'))).toHaveLength(1);
    });

    it('is offered only to a connection following the flag', () => {
      expect(new GraphWorld().connector().manifest.startsConversations).toEqual({ underChoices: ['flag'] });
    });
  });

  describe('a check tells a draft sent, which is your turn, from one deleted unsent', () => {
    /** A connection following the flag, a new conversation's draft made, and the host waiting on it. */
    async function aDraftWaitedOn() {
      const world = new GraphWorld();
      const host = signedInHost();
      await world.connector({ now: () => NOW }).sync(host);
      const made = await world.connector().makeDraft!(onDemand(host), { subject: 'Plan a dinner', replyIn: null });
      host.following.add(made.conversationId);
      host.draftsMade.push({ conversationId: made.conversationId, draftId: made.draftId, after: null });
      return { world, host, draftId: made.draftId, conversationId: made.conversationId };
    }

    it.each([
      { situation: 'the draft still unsent', happens: () => {}, turns: [], gone: [] },
      {
        situation: 'the draft sent',
        happens: (world: GraphWorld, draftId: string) => world.sends(draftId),
        turns: [{ by: 'you' }],
        gone: [],
      },
      {
        situation: 'the draft deleted unsent',
        happens: (world: GraphWorld, draftId: string) => world.deletes(draftId),
        turns: [],
        gone: ['draft-1'],
      },
    ])('with $situation', async ({ happens, turns, gone }) => {
      const { world, host, draftId, conversationId } = await aDraftWaitedOn();
      happens(world, draftId);

      const next = host.next();
      await world.connector({ now: () => NOW }).sync(next);

      expect(next.turns).toEqual(turns.map((turn) => expect.objectContaining({ ...turn, conversationId })));
      expect(next.draftsGone).toEqual(gone.map((id) => ({ conversationId, draftId: id })));
    });

    it('reads an unsent draft once a run, and nothing else of it', async () => {
      const { world, host, draftId } = await aDraftWaitedOn();
      const next = host.next();
      world.forget();

      await world.connector({ now: () => NOW }).sync(next);

      expect(world.requests.filter((one) => one.includes(`messages/${draftId}`))).toHaveLength(1);
      expect(world.conversationsRead()).toEqual([]);
    });

    it('reports the sent message as your turn, and nothing gone, where the read of received mail never showed it', async () => {
      const { world, host, draftId, conversationId } = await aDraftWaitedOn();
      // Sent before the time the read of received mail starts from.
      world.sends(draftId, '2026-10-09T11:00:00Z');
      const next = host.next();
      next.state = { ...(next.state as object), turnsSince: '2026-10-09T11:59:00.000Z' };

      await world.connector({ now: () => NOW }).sync(next);

      expect(next.draftsGone).toEqual([]);
      expect(next.turns).toEqual([expect.objectContaining({ by: 'you', conversationId })]);
    });

    it('ignores a message sent before a reply draft was started', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { conversation: 'c-1', from: ANNA, folder: SENT_ITEMS_ID, receivedAt: '2026-10-09T09:00:00Z' });
      const host = signedInHost();
      await world.connector({ now: () => NOW }).sync(host);
      const made = await world.connector().makeDraft!(onDemand(host), { subject: 'Plan', replyIn: 'c-1' });
      host.following.add('c-1');
      host.draftsMade.push({ conversationId: 'c-1', draftId: made.draftId, after: '2026-10-09T09:00:00.000Z' });
      world.deletes(made.draftId);

      const next = host.next();
      await world.connector({ now: () => NOW }).sync(next);

      expect(next.turns).toEqual([]);
      expect(next.draftsGone).toEqual([{ conversationId: 'c-1', draftId: made.draftId }]);
    });
  });
});
