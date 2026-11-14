import { describe, expect, it } from 'vitest';
import type { MirroredOpenStates } from '@cockpit/connector-sdk';
import { DELETED_ITEMS_ID, GraphWorld, NOW, SENT_ITEMS_ID, signedInHost } from './outlook-world.js';

/**
 * L1, against a fake host and Microsoft Graph faked at the network, from the
 * shapes Graph documents: an Outlook connection following the flag makes one
 * Item per conversation, reports every later message in it as a turn, and Done
 * completes the flag on each message of it ("Outlook follows the flagged
 * conversation as Gmail does", issue 1707). What a turn does to a status is the
 * core's (apps/api/tests/unit/domain/conversations.test.ts).
 */

function answered(answer: MirroredOpenStates): { confirmed: string[]; gaveUp: string[] } {
  if (Array.isArray(answer)) return { confirmed: answer, gaveUp: [] };
  return { confirmed: answer.confirmed ?? [], gaveUp: answer.gaveUp ?? [] };
}

/** A conversation of Pieter's whose first message is flagged, brought in and followed. */
async function aFollowedConversation() {
  const world = new GraphWorld();
  world.arrives('m-1', { flag: 'flagged', conversation: 'c-1', subject: 'Dinner?', receivedAt: '2026-10-09T08:00:00Z' });
  const host = signedInHost();
  await world.connector({ now: () => NOW }).sync(host);
  return { world, host };
}

const ANNA = { name: 'Anna', address: 'anna@example.com' };

describe('Capture', () => {
  describe('a flagged message makes one Item per conversation, which follows it', () => {
    it('files the conversation under its id, with where it stands and the flagged message as the Item', async () => {
      const world = new GraphWorld();
      world.arrives('m-0', { conversation: 'c-1', receivedAt: '2026-10-08T08:00:00Z', text: 'Shall we eat out?' });
      world.arrives('m-1', { conversation: 'c-1', from: ANNA, folder: SENT_ITEMS_ID, receivedAt: '2026-10-09T09:00:00Z', text: 'Thursday?' });
      world.arrives('m-2', { flag: 'flagged', conversation: 'c-1', subject: 'Dinner?', receivedAt: '2026-10-09T07:00:00Z' });
      const host = signedInHost();

      await world.connector().sync(host);

      expect([...host.filed.keys()]).toEqual(['conversation:c-1']);
      expect(host.filed.get('conversation:c-1')).toMatchObject({
        title: 'Dinner?',
        choice: 'flag',
        conversation: {
          id: 'c-1',
          latest: { by: 'you', at: '2026-10-09T09:00:00.000Z', excerpt: 'Thursday?' },
          messageCount: 3,
          startedAt: '2026-10-08T08:00:00.000Z',
          withWhom: 'Pieter Claes',
        },
      });
    });

    it.each([
      { situation: 'a mail to your alias alone', alias: 'cockpit@conselit.be', to: ['cockpit@conselit.be'], othersOnIt: false },
      { situation: 'a mail to a client with your alias in Cc', alias: 'cockpit@conselit.be', to: ['client@example.com'], othersOnIt: true },
      { situation: 'a mail to your alias alone, with no alias set', alias: null, to: ['cockpit@conselit.be'], othersOnIt: true },
    ])('brings in $situation as yours, saying whether anyone else is on it', async ({ alias, to, othersOnIt }) => {
      const world = new GraphWorld();
      const cc = to[0] === 'client@example.com' ? [{ address: 'cockpit@conselit.be' }] : [];
      world.arrives('m-sent', { conversation: 'c-1', folder: SENT_ITEMS_ID, from: ANNA, to: to.map((address) => ({ address })), cc, receivedAt: '2026-10-09T08:00:00Z' });
      // The alias's copy, delivered to the Inbox a moment later and flagged by the rule.
      world.arrives('m-copy', { flag: 'flagged', conversation: 'c-1', from: ANNA, to: to.map((address) => ({ address })), cc, receivedAt: '2026-10-09T08:00:05Z' });
      const host = signedInHost({ ownAlias: alias });

      await world.connector().sync(host);

      expect(host.filed.get('conversation:c-1')?.conversation).toMatchObject({ latest: { by: 'you' }, othersOnIt });
    });

    it('makes nothing new for a second message flagged in a conversation an Item follows, and reads nothing for it', async () => {
      const { world, host } = await aFollowedConversation();
      world.arrives('m-2', { flag: 'flagged', conversation: 'c-1', receivedAt: '2026-10-09T09:00:00Z' });
      world.forget();

      const next = host.next();
      await world.connector().sync(next);

      expect(next.filed.size).toBe(1);
      expect(world.readsInFull()).toEqual([]);
      expect(world.conversationsRead()).toEqual([]);
      expect(next.listings.at(-1)?.sourceIds).toEqual(['conversation:c-1']);
      expect(next.listings.at(-1)?.count).toBe(2);
    });

    it('still brings the conversation in from a second flagged message when the first was unflagged before it was read', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1', subject: 'Dinner?', receivedAt: '2026-10-09T08:00:00Z' });
      world.arrives('m-2', { flag: 'flagged', conversation: 'c-1', subject: 'Dinner?', receivedAt: '2026-10-09T09:00:00Z' });
      let first = true;
      world.beforeRead = (id) => {
        if (!first) return;
        first = false;
        world.unflag(id);
      };
      const host = signedInHost();

      await world.connector({ now: () => NOW }).sync(host);

      expect([...host.filed.keys()]).toEqual(['conversation:c-1']);
    });

    it('reports a flag put on again after Done as the same Item reopened, following', async () => {
      const { world, host } = await aFollowedConversation();
      world.complete('m-1');
      const closed = host.next();
      await world.connector().sync(closed);
      // Done, the Item no longer follows its conversation.
      closed.following.clear();
      world.flag('m-1');

      const again = closed.next();
      await world.connector().sync(again);

      expect(again.saidOf('conversation:c-1')).toEqual(['reopened']);
      expect(again.following.has('c-1')).toBe(true);
    });

    it('leaves a message with an Item of its own from before untouched, and lists it under its own id', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1' });
      const host = signedInHost();
      host.state = { choice: 'flag', seen: ['m-1'] };

      await world.connector().sync(host);

      expect(host.filed.size).toBe(0);
      expect(host.listings).toEqual([{ choice: 'flag', sourceIds: ['m-1'] }]);
    });

    it('lists a conversation with nothing flagged left as gone, so the host closes its Item', async () => {
      const { world, host } = await aFollowedConversation();
      world.unflag('m-1');

      const next = host.next();
      await world.connector().sync(next);

      expect(next.listings.at(-1)).toEqual({ choice: 'flag', sourceIds: [] });
    });
  });
});

describe('Triage', () => {
  describe('every later message in a followed conversation is reported as a turn', () => {
    it('reports a message in Sent Items as yours and one elsewhere as theirs, and none of a conversation not followed', async () => {
      const { world, host } = await aFollowedConversation();
      world.arrives('m-2', { conversation: 'c-1', receivedAt: '2026-10-09T12:10:00Z', text: 'Friday suits me.' });
      world.arrives('m-3', { conversation: 'c-1', folder: SENT_ITEMS_ID, from: ANNA, receivedAt: '2026-10-09T12:30:00Z', text: 'Great.' });
      world.arrives('m-4', { conversation: 'c-other', receivedAt: '2026-10-09T12:40:00Z' });
      world.forget();

      const next = host.next();
      await world.connector().sync(next);

      // Each with where Outlook shows it, which Open then goes to as the newest (issue 1720).
      const link = (id: string) => `https://outlook.office365.com/owa/?ItemID=${id}&exvsurl=1&viewmodel=ReadMessageItem`;
      expect(next.turns).toEqual([
        { conversationId: 'c-1', messageId: 'm-2', by: 'them', from: 'Pieter Claes', at: '2026-10-09T12:10:00.000Z', excerpt: 'Friday suits me.', link: link('m-2'), othersOnIt: true },
        { conversationId: 'c-1', messageId: 'm-3', by: 'you', from: 'Anna', at: '2026-10-09T12:30:00.000Z', excerpt: 'Great.', link: link('m-3'), othersOnIt: true },
      ]);
    });

    it('reports your alias’s copy of a later mail of yours as yours, with whoever else it names, learning your address from an earlier read', async () => {
      const ALIAS = { name: 'Cockpit', address: 'cockpit@conselit.be' };
      const { world, host } = await aFollowedConversation();
      world.arrives('m-2', { conversation: 'c-1', folder: SENT_ITEMS_ID, from: ANNA, to: [ALIAS], receivedAt: '2026-10-09T12:10:00Z' });
      const first = host.next();
      first.ownAlias = ALIAS.address;
      // Run at 12:20, so the next run reads from 12:15 and never sees m-2 again.
      await world.connector({ now: () => new Date('2026-10-09T12:20:00Z') }).sync(first);
      world.forget();
      // The alias's copy of a later mail, its Sent Items copy in no read this run sees.
      world.arrives('m-3', { conversation: 'c-1', from: ANNA, to: [{ name: 'Pieter Claes', address: 'pieter@example.com' }], cc: [ALIAS], receivedAt: '2026-10-09T12:20:00Z' });
      world.arrives('m-4', { conversation: 'c-1', from: ANNA, to: [ALIAS], receivedAt: '2026-10-09T12:30:00Z' });

      const next = first.next();
      await world.connector({ now: () => new Date('2026-10-09T12:31:00Z') }).sync(next);

      expect(first.turns.map((turn) => [turn.messageId, turn.by, turn.othersOnIt])).toEqual([['m-2', 'you', false]]);
      expect(next.turns.map((turn) => [turn.messageId, turn.by, turn.othersOnIt])).toEqual([
        ['m-3', 'you', true],
        ['m-4', 'you', false],
      ]);
    });

    it('previews what a reply adds, not the earlier email its preview runs on into', async () => {
      const { world, host } = await aFollowedConversation();
      // Graph's bodyPreview is already on one line, as the production reply's was (issue 1720).
      world.arrives('m-2', {
        conversation: 'c-1',
        receivedAt: '2026-10-09T12:10:00Z',
        text: 'Ja, ik ben thuis. ________________________________ Van: Michael Vanhoutte <michael@example.com> Verzonden: zondag 8 november 2026 17:53 Aan: Anna Onderwerp: Re: test2 ik kan morgen',
      });

      const next = host.next();
      await world.connector().sync(next);

      expect(next.turns.map((turn) => turn.excerpt)).toEqual(['Ja, ik ben thuis.']);
    });

    it('asks for the mail received since, ordered by it, across folders in one read', async () => {
      const { world, host } = await aFollowedConversation();
      world.forget();

      await world.connector().sync(host.next());

      expect(world.receivedReads()).toHaveLength(1);
      expect(world.receivedReads()[0]).toMatch(/^GET \/v1\.0\/me\/messages\?\$filter=receivedDateTime ge \S+&\$orderby=receivedDateTime&/);
      expect(world.receivedReads()[0]).not.toContain('mailFolders');
    });

    it('reports neither a draft nor a message in Deleted Items', async () => {
      const { world, host } = await aFollowedConversation();
      world.arrives('m-2', { conversation: 'c-1', draft: true, folder: SENT_ITEMS_ID, receivedAt: '2026-10-09T12:05:00Z' });
      world.arrives('m-3', { conversation: 'c-1', folder: DELETED_ITEMS_ID, receivedAt: '2026-10-09T12:10:00Z' });

      const next = host.next();
      await world.connector().sync(next);

      expect(next.turns).toEqual([]);
    });

    it('reads every page of the mail received since (more than one page)', async () => {
      const { world, host } = await aFollowedConversation();
      world.pageSize = 2;
      for (let n = 2; n <= 6; n++) world.arrives(`m-${n}`, { conversation: 'c-1', receivedAt: `2026-10-09T12:0${n}:00Z` });

      const next = host.next();
      await world.connector().sync(next);

      expect(next.turns.map((turn) => turn.messageId)).toEqual(['m-2', 'm-3', 'm-4', 'm-5', 'm-6']);
    });

    it('stops at the call budget saying there is more to do, and the next run carries on from the last message reported (more than one run)', async () => {
      const { world, host } = await aFollowedConversation();
      world.pageSize = 2;
      for (let n = 2; n <= 7; n++) world.arrives(`m-${n}`, { conversation: 'c-1', receivedAt: `2026-10-09T12:0${n}:00Z` });
      world.forget();

      // Deleted Items, the listing and Sent Items, then two pages of two.
      const first = host.next();
      const answer = await world.connector({ callsPerRun: 5 }).sync(first);
      expect(answer).toEqual({ moreToDo: true });
      expect(first.turns.map((turn) => turn.messageId)).toEqual(['m-2', 'm-3', 'm-4', 'm-5']);
      world.forget();

      const second = first.next();
      await world.connector({ callsPerRun: 40 }).sync(second);

      expect(world.receivedReads()[0]).toContain('receivedDateTime ge 2026-10-09T12:05:00.000Z');
      expect(second.turns.map((turn) => turn.messageId)).toEqual(['m-5', 'm-6', 'm-7']);
    });

    it('reads no mail at all while no Item follows a conversation', async () => {
      const world = new GraphWorld();
      world.arrives('m-1');
      const host = signedInHost();

      await world.connector().sync(host);

      expect(world.receivedReads()).toEqual([]);
    });
  });
});

describe('Connector management', () => {
  describe('Done completes the flag on every message of the conversation', () => {
    it('completes each flagged message of the conversation, wherever it is, and confirms only then', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1' });
      world.arrives('m-2', { flag: 'flagged', conversation: 'c-1', folder: SENT_ITEMS_ID });
      world.arrives('m-3', { conversation: 'c-1' });
      world.arrives('m-4', { flag: 'flagged', conversation: 'c-1', folder: DELETED_ITEMS_ID });
      world.arrives('m-5', { flag: 'flagged', conversation: 'c-other' });

      const answer = await world.connector().mirrorOpenState!(signedInHost(), [{ sourceId: 'conversation:c-1', open: false }]);

      expect(answered(answer)).toEqual({ confirmed: ['conversation:c-1'], gaveUp: [] });
      expect(['m-1', 'm-2', 'm-3', 'm-4', 'm-5'].map((id) => world.flagOf(id))).toEqual(['complete', 'complete', 'notFlagged', 'complete', 'flagged']);
    });

    it('leaves the rest for the next run when the budget runs out, keeping the Item wanted until none is left (more than one run)', async () => {
      const world = new GraphWorld();
      for (let n = 1; n <= 5; n++) world.arrives(`m-${n}`, { flag: 'flagged', conversation: 'c-1' });
      const wanted = [{ sourceId: 'conversation:c-1', open: false }];

      // The read of the conversation and two changes a run.
      const first = await world.connector({ callsPerRun: 3 }).mirrorOpenState!(signedInHost(), wanted);
      expect(answered(first)).toEqual({ confirmed: [], gaveUp: [] });
      expect(world.writes).toHaveLength(2);

      const second = await world.connector({ callsPerRun: 3 }).mirrorOpenState!(signedInHost(), wanted);
      expect(answered(second)).toEqual({ confirmed: [], gaveUp: [] });

      const third = await world.connector({ callsPerRun: 3 }).mirrorOpenState!(signedInHost(), wanted);
      expect(answered(third)).toEqual({ confirmed: ['conversation:c-1'], gaveUp: [] });
      expect(['m-1', 'm-2', 'm-3', 'm-4', 'm-5'].map((id) => world.flagOf(id))).toEqual(Array(5).fill('complete'));
    });

    it('confirms a conversation that is gone', async () => {
      const world = new GraphWorld();

      const answer = await world.connector().mirrorOpenState!(signedInHost(), [{ sourceId: 'conversation:vanished', open: false }]);

      expect(answered(answer)).toEqual({ confirmed: ['conversation:vanished'], gaveUp: [] });
    });

    it('confirms a reopened conversation while a message in it is still flagged, and gives it up when none is', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1' });
      world.arrives('m-2', { conversation: 'c-2' });

      const answer = await world.connector().mirrorOpenState!(signedInHost(), [
        { sourceId: 'conversation:c-1', open: true },
        { sourceId: 'conversation:c-2', open: true },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['conversation:c-1'], gaveUp: ['conversation:c-2'] });
      expect(world.writes).toEqual([]);
    });

    it('gives up a conversation whose flag Microsoft refuses to change', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1' });
      world.failures.push({ prefix: 'v1.0/me/messages/', status: 403 });

      const answer = await world.connector().mirrorOpenState!(signedInHost(), [{ sourceId: 'conversation:c-1', open: false }]);

      expect(answered(answer)).toEqual({ confirmed: [], gaveUp: ['conversation:c-1'] });
    });

    it('still pushes a message-keyed Item from before as it did', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1' });

      const answer = await world.connector().mirrorOpenState!(signedInHost(), [{ sourceId: 'm-1', open: false }]);

      expect(answered(answer).confirmed).toEqual(['m-1']);
      expect(world.flagOf('m-1')).toBe('complete');
    });
  });
});
