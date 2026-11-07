import { describe, expect, it } from 'vitest';
import type { MirroredOpenStates, SourceItem } from '@cockpit/connector-sdk';
import { CALLS_PER_RUN } from '../../src/index.js';
import { STARRED } from '../gmail-payloads.js';
import type { FakeHost } from './fake-host.js';
import { GmailWorld, signedInHost } from './gmail-world.js';

/**
 * L1, against a fake host and Gmail faked at the network: a connection
 * following the star brings in the conversation of an email starred as one
 * Item that follows it, reports every later message in it as a turn, and keeps
 * the Item in step with the conversation's stars ("A Gmail starred conversation
 * is one Item whose status follows who wrote last", issue 1705). What a turn
 * does to the Item is the host's, and is proved there
 * (apps/api/tests/unit/domain/conversations.test.ts, and
 * conversations-on-the-host.test.ts at L2); the host is not run here. The
 * quirks each case rests on are in the package README.
 */

const LINK = 'https://mail.google.com/mail/?authuser=anna%40example.com#all/';

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

/** A conversation of an email or two, none of them starred, ready to be starred one by one. */
function conversation(world: GmailWorld, ...subjects: string[]): void {
  world.arrives('t-1', subjects[0]!, `The text of ${subjects[0]}.`, []);
  subjects.slice(1).forEach((subject, at) => world.emailArrives('t-1', `m-${at + 2}`, subject, `The text of ${subject}.`));
}

/** A conversation starred and brought in, which the host now says an open Item follows. */
async function followed(): Promise<{ world: GmailWorld; host: FakeHost }> {
  const world = new GmailWorld();
  const first = await connectedByStar(world);
  conversation(world, 'Dinner');
  world.star('t-1');
  const host = await checked(world, first);
  expect(await host.followedConversations()).toEqual(['t-1']);
  world.forget();
  return { world, host };
}

/** An Item a release before made of one starred email, under that email's own source id. */
function madeOfOneEmail(host: FakeHost, emailId: string): SourceItem {
  const item = { sourceId: `message:${emailId}`, title: 'Brought in as one email', choice: 'star' } as SourceItem;
  host.filed.set(item.sourceId!, item);
  return item;
}

function answered(answer: MirroredOpenStates): { confirmed: string[]; gaveUp: string[] } {
  if (Array.isArray(answer)) return { confirmed: answer, gaveUp: [] };
  return { confirmed: answer.confirmed ?? [], gaveUp: answer.gaveUp ?? [] };
}

describe('Capture', () => {
  describe('by star, an email starred after connecting brings its conversation in once, as one Item following it, titled with that email’s subject', () => {
    it.each([
      {
        situation: 'two emails in one conversation, both starred',
        happens: (world: GmailWorld) => {
          conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
          world.star('t-1');
          world.star('m-2');
        },
        title: 'Invoice for contract 2',
        sourceTimestamp: '2026-10-02T08:30:00.000Z',
        messages: 2,
      },
      {
        situation: 'one email starred in a conversation of three, not the latest',
        happens: (world: GmailWorld) => {
          conversation(world, 'Contract', 'Re: Contract', 'Re: Re: Contract');
          world.star('m-2');
        },
        title: 'Re: Contract',
        sourceTimestamp: '2026-10-02T08:30:00.000Z',
        messages: 3,
      },
      {
        situation: 'an email arriving already starred, as a filter or Outlook’s flag does it',
        happens: (world: GmailWorld) => {
          conversation(world, 'Contract');
          world.emailArrives('t-1', 'm-2', 'Flagged on arrival', 'The text of Flagged on arrival.', { marks: ['star'] });
        },
        title: 'Flagged on arrival',
        sourceTimestamp: '2026-10-02T08:30:00.000Z',
        messages: 2,
      },
      {
        situation: 'a conversation arriving starred',
        happens: (world: GmailWorld) => world.arrives('t-1', 'Quarterly figures', 'The text of Quarterly figures.', ['star']),
        title: 'Quarterly figures',
        sourceTimestamp: '2026-10-01T08:30:00.000Z',
        messages: 1,
      },
    ])('$situation', async ({ happens, title, sourceTimestamp, messages }) => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      happens(world);

      const second = await checked(world, first);

      expect([...second.filed.values()]).toEqual([
        expect.objectContaining({
          sourceId: 't-1',
          title,
          capturedMessage: `The text of ${title}.`,
          sender: 'Pieter Claes',
          sourceTimestamp,
          sourceLink: `${LINK}t-1`,
          choice: 'star',
          conversation: expect.objectContaining({
            id: 't-1',
            link: `${LINK}t-1`,
            messageCount: messages,
            startedAt: '2026-10-01T08:30:00.000Z',
            withWhom: 'Pieter Claes',
          }),
        }),
      ]);
    });

    it('says where the conversation stands: its latest message, who sent it, and its first lines', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      conversation(world, 'Dinner');
      world.replies('t-1', [], { sent: true, text: 'Sure!\nDoes Thursday the 19th work for you?', sentAt: '2026-10-03T09:00:00Z' });
      world.star('t-1');

      const second = await checked(world, first);

      expect(second.filed.get('t-1')?.conversation).toEqual({
        id: 't-1',
        link: `${LINK}t-1`,
        latest: { by: 'you', from: 'Anna Peeters', at: '2026-10-03T09:00:00.000Z', excerpt: 'Sure! Does Thursday the 19th work for you?' },
        messageCount: 2,
        startedAt: '2026-10-01T08:30:00.000Z',
        withWhom: 'Pieter Claes',
      });
    });

    it('adds nothing new for a second email starred in a conversation it already brought in', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      conversation(world, 'Contract', 'Re: Contract');
      world.star('t-1');
      const second = await checked(world, first);

      world.star('m-2');
      const third = await checked(world, second);

      expect([...third.filed.keys()]).toEqual(['t-1']);
    });

    it('files nothing for an email starred before connecting', async () => {
      const world = new GmailWorld();
      conversation(world, 'Starred long ago');
      world.star('t-1');
      const first = await connectedByStar(world);

      const second = await checked(world, first);

      expect(first.filed.size + second.filed.size).toBe(0);
    });

    it('files the conversation once when the same history is read twice', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      conversation(world, 'One', 'Two');
      world.star('t-1');
      world.star('m-2');
      const second = await checked(world, first);

      // The saved position taken back to where it was: the same page again.
      const third = second.next();
      third.state = first.state;
      await world.connector().sync(third);

      expect([...third.filed.keys()]).toEqual(['t-1']);
      expect(third.saidOf('t-1')).toEqual(['reopened']);
    });

    it('is the same Item a label, or a release before, brought in for the conversation', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      const before = { sourceId: 't-1', title: 'Brought in as a conversation', choice: 'label' } as SourceItem;
      first.filed.set('t-1', before);
      conversation(world, 'Quarterly figures');
      world.star('t-1');

      const second = await checked(world, first);

      expect([...second.filed.keys()]).toEqual(['t-1']);
      expect(second.filed.get('t-1')).toBe(before);
      expect(second.saidOf('t-1')).toEqual(['reopened']);
    });

    it('leaves an Item made of one email before untouched, and brings the conversation in beside it', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      const old = madeOfOneEmail(first, 't-1');
      conversation(world, 'Quarterly figures');
      world.star('t-1');

      const second = await checked(world, first);

      expect([...second.filed.keys()]).toEqual(['message:t-1', 't-1']);
      expect(second.filed.get('message:t-1')).toBe(old);
      expect(second.saidOf('message:t-1')).toEqual([]);
    });
  });

  describe('every message added to a followed conversation is reported as a turn, starred or not, each once', () => {
    it('reports the turns of followed conversations only, and reads no other message', async () => {
      const { world, host } = await followed();
      world.arrives('t-2', 'Unrelated', 'Not followed.', []);
      world.replies('t-2');
      const reply = world.replies('t-1', [], { from: 'Steven Noels <steven@example.com>', text: 'Thursday is tricky, how about Friday?' });

      const next = await checked(world, host);

      expect(next.turns).toEqual([
        {
          conversationId: 't-1',
          messageId: reply,
          by: 'them',
          from: 'Steven Noels',
          at: '2026-10-02T08:30:00.000Z',
          excerpt: 'Thursday is tricky, how about Friday?',
        },
      ]);
      expect(world.emailReads()).toEqual([reply]);
    });

    it.each([
      { situation: 'sent from this mailbox, which Gmail labels Sent', sent: true, by: 'you', from: 'Anna Peeters' },
      { situation: 'arriving from somebody else', sent: false, by: 'them', from: 'Pieter Claes' },
    ])('counts a message $situation as $by', async ({ sent, by, from }) => {
      const { world, host } = await followed();
      world.replies('t-1', [], { sent });

      const next = await checked(world, host);

      expect(next.turns).toEqual([expect.objectContaining({ by, from })]);
    });

    it('reports no turn for a draft being written in the conversation', async () => {
      const { world, host } = await followed();
      world.drafts('t-1');

      const next = await checked(world, host);

      expect(next.turns).toEqual([]);
      expect(world.emailReads()).toEqual([]);
    });

    it('reports a draft sent where it stands, keeping its id, as your turn, once', async () => {
      const { world, host } = await followed();
      const draft = world.drafts('t-1');
      world.sendsDraft(draft);

      const next = await checked(world, host);

      expect(next.turns).toEqual([expect.objectContaining({ messageId: draft, by: 'you' })]);
    });

    it('reports a message added on a later page of the run that brought its conversation in', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      world.historyPageSize = 1;
      conversation(world, 'Dinner');
      world.star('t-1');
      const reply = world.replies('t-1');

      const next = await checked(world, first);

      expect([...next.filed.keys()]).toEqual(['t-1']);
      expect(next.turns.map((turn) => turn.messageId)).toEqual([reply]);
    });

    it('reads every page of the history, saving the position after each', async () => {
      const { world, host } = await followed();
      world.historyPageSize = 1;
      const replies = [world.replies('t-1'), world.replies('t-1', [], { sent: true }), world.replies('t-1')];

      const next = await checked(world, host);

      expect(next.turns.map((turn) => turn.messageId)).toEqual(replies);
      const pages = next.statesSaved.map((saved) => (saved as { history: { pageToken: string | null } }).history.pageToken);
      expect(pages).toEqual(['1', '2', null]);
    });

    it('stops when the run’s calls are spent, says there is more to do, and resumes at the saved page, reporting each turn once', async () => {
      const { world, host } = await followed();
      world.historyPageSize = 10;
      const replies = Array.from({ length: CALLS_PER_RUN + 5 }, () => world.replies('t-1'));

      let run = host.next();
      const answer = await world.connector().sync(run);
      expect(answer).toEqual({ moreToDo: true });
      const reported = [...run.turns];
      for (let runs = 1; runs < 5; runs += 1) {
        run = run.next();
        const more = await world.connector().sync(run);
        reported.push(...run.turns);
        if (!more?.moreToDo) break;
      }

      expect(reported.map((turn) => turn.messageId)).toEqual(replies);
      expect(new Set(world.emailReads()).size).toBe(world.emailReads().length);
    });

    it('resumes a page past the conversations it already read, by id, though the page now names another before them', async () => {
      const { world, host } = await followed();
      // A deletion in the followed conversation, then another conversation starred:
      // a run following nothing yet would have named only the second.
      world.deleteEmail(world.replies('t-1'));
      world.arrives('t-2', 'Other', 'Another.', []);
      world.star('t-2');
      const resumed = host.next();
      const saved = host.state as { history: Record<string, unknown> };
      resumed.state = { ...saved, history: { ...saved.history, pageToken: null, done: 0, turns: [], read: ['t-2'] } };

      await world.connector().sync(resumed);

      expect(world.threadReads()).toEqual(['t-1']);
    });

    it('lists in full where Gmail no longer keeps the position, then reads the history again', async () => {
      const { world, host } = await followed();
      // A reply Gmail has since forgotten the history of, as it does after about a week.
      world.replies('t-1');
      world.forgetHistory();
      const lapsed = await checked(world, host);
      expect(lapsed.listings).toHaveLength(1);

      const reply = world.replies('t-1', [], { sent: true });
      const next = await checked(world, lapsed);

      expect(next.turns.map((turn) => turn.messageId)).toEqual([reply]);
    });
  });

  describe('an Item following a conversation follows its stars from Gmail', () => {
    it.each([
      { situation: 'every star in it taken off', happens: (world: GmailWorld) => world.unstar('t-1') },
      { situation: 'its starred email moved to the bin', happens: (world: GmailWorld) => world.binEmail('t-1') },
      { situation: 'its starred email deleted for good', happens: (world: GmailWorld) => world.deleteEmail('t-1') },
    ])('marks it done when $situation', async ({ happens }) => {
      const { world, host } = await followed();
      happens(world);

      const next = await checked(world, host);

      expect(next.saidOf('t-1')).toEqual(['resolved']);
    });

    it('stays open while one email in it is still starred', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      world.star('t-1');
      world.star('m-2');
      const host = await checked(world, first);
      world.unstar('t-1');

      const next = await checked(world, host);

      expect(next.saidOf('t-1')).toEqual([]);
    });

    it('reopens the same Item when an email in it is starred again', async () => {
      const { world, host } = await followed();
      world.unstar('t-1');
      const closed = await checked(world, host);
      closed.finished.add('t-1');
      world.star('t-1');

      const reopened = await checked(world, closed);

      expect(reopened.saidOf('t-1')).toEqual(['reopened']);
      expect([...reopened.filed.keys()]).toEqual(['t-1']);
    });

    it('reopens the same Item when its starred email is taken back out of the bin', async () => {
      const { world, host } = await followed();
      world.binEmail('t-1');
      const closed = await checked(world, host);
      expect(closed.saidOf('t-1')).toEqual(['resolved']);
      closed.finished.add('t-1');
      world.unbinEmail('t-1');

      const restored = await checked(world, closed);

      expect(restored.saidOf('t-1')).toEqual(['reopened']);
    });

    it('leaves an Item reopened in Cockpit, its star not put back, open when another of its messages is labelled', async () => {
      const { world, host } = await followed();
      world.unstar('t-1');
      // Closed by the unstar, then reopened in Cockpit: open, and still following.
      const reopenedInCockpit = await checked(world, host);
      world.replies('t-1', ['Admin']);
      world.label('t-1', 'Waiting', 1);

      const next = await checked(world, reopenedInCockpit);

      expect(next.saidOf('t-1')).toEqual([]);
      expect(next.turns).toHaveLength(1);
    });

    it('keeps the names a label put on one of its emails gives it', async () => {
      const { world, host } = await followed();
      world.label('t-1', 'Admin');

      const next = await checked(world, host);

      expect(next.namesReported).toContainEqual({ sourceId: 't-1', names: ['Admin'] });
    });
  });

  describe('an Item made of one starred email before is left as it was, closing when that email’s star comes off', () => {
    it.each([
      { situation: 'that email unstarred', happens: (world: GmailWorld) => world.unstar('m-2') },
      { situation: 'that email moved to the bin', happens: (world: GmailWorld) => world.binEmail('m-2') },
    ])('marks it done when $situation, and leaves the other email’s Item alone', async ({ happens }) => {
      const world = new GmailWorld();
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      world.star('t-1');
      world.star('m-2');
      const host = await connectedByStar(world);
      madeOfOneEmail(host, 't-1');
      madeOfOneEmail(host, 'm-2');
      happens(world);

      const next = await checked(world, host);

      expect(next.saidOf('message:m-2')).toEqual(['resolved']);
      expect(next.saidOf('message:t-1')).toEqual([]);
    });
  });

  describe('a complete listing of what is starred brings nothing in and keeps open each Item whose email, or whose conversation, still is', () => {
    async function listed(happens: (world: GmailWorld) => void) {
      const world = new GmailWorld();
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      world.arrives('t-3', 'Lunch', 'Lunch on Thursday?', []);
      happens(world);
      const host = await connectedByStar(world);
      return { world, host, ids: host.listings.at(-1)!.sourceIds };
    }

    it.each([
      {
        situation: 'an email still starred',
        happens: (world: GmailWorld) => world.star('m-2'),
        open: ['message:m-2'],
        closed: ['message:t-1', 'message:t-3'],
      },
      {
        situation: 'an email in a conversation with another one starred, which keeps the conversation’s Item open',
        happens: (world: GmailWorld) => world.star('m-2'),
        open: ['t-1'],
        closed: ['t-3'],
      },
      {
        situation: 'a starred email in the bin',
        happens: (world: GmailWorld) => {
          world.star('m-2');
          world.binEmail('m-2');
        },
        open: [],
        closed: ['message:m-2', 't-1'],
      },
      {
        situation: 'nothing starred at all',
        happens: () => {},
        open: [],
        closed: ['message:t-1', 'message:m-2', 't-1', 't-3'],
      },
    ])('lists $open and not $closed for $situation', async ({ happens, open, closed }) => {
      const { ids, host } = await listed(happens);

      for (const id of open) expect(ids).toContain(id);
      for (const id of closed) expect(ids).not.toContain(id);
      expect(host.filed.size).toBe(0);
    });

    it('names both the Item of an email and of its conversation, for each email starred', async () => {
      const { ids } = await listed((world) => {
        world.star('t-1');
        world.star('t-3');
      });

      expect([...ids].sort()).toEqual(['message:t-1', 'message:t-3', 't-1', 't-3']);
    });

    it('says how many emails are starred, not how many ids it names', async () => {
      const { host } = await listed((world) => {
        world.star('t-1');
        world.star('m-2');
        world.star('t-3');
      });

      expect(host.listings.at(-1)!.sourceIds).toHaveLength(5);
      expect(host.listings.at(-1)!.count).toBe(3);
    });

    it('resumes at the next page when a run stops between pages, closing nothing it had not yet listed', async () => {
      const world = new GmailWorld();
      world.emailPageSize = 1;
      const wanted = [];
      for (let at = 0; at < CALLS_PER_RUN + 5; at += 1) {
        world.arrives(`t-${at}`, `Subject ${at}`, 'x', ['star']);
        wanted.push(`message:t-${at}`, `t-${at}`);
      }
      let host = signedInHost({ choice: 'star' });
      const first = await world.connector().sync(host);
      expect(first).toEqual({ moreToDo: true });
      expect(host.listings).toEqual([]);

      host = host.next();
      await world.connector().sync(host);

      expect(host.listings).toHaveLength(1);
      expect([...host.listings[0]!.sourceIds].sort()).toEqual([...wanted].sort());
    });
  });

  describe('a run spends its call budget per conversation changed, and resumes without losing or repeating a conversation', () => {
    it('reads a conversation once for all the emails of it starred', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      conversation(world, 'One', 'Two', 'Three');
      world.star('t-1');
      world.star('m-2');
      world.star('m-3');
      world.forget();

      const second = await checked(world, first);

      expect(world.threadReads()).toEqual(['t-1']);
      expect([...second.filed.keys()]).toEqual(['t-1']);
    });

    it('files the rest, each once, in the run after the budget ran out part-way down a page', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      for (let at = 0; at < CALLS_PER_RUN + 10; at += 1) {
        world.arrives(`c-${at}`, `Contract ${at}`, 'x', []);
        world.emailArrives(`c-${at}`, `d-${at}`, `Contract ${at}, the second`);
        world.star(`c-${at}`);
        world.star(`d-${at}`);
      }
      world.forget();

      let host = first.next();
      let runs = 0;
      for (;;) {
        runs += 1;
        const answer = await world.connector().sync(host);
        if (!answer?.moreToDo) break;
        host = host.next();
        expect(runs).toBeLessThan(20);
      }

      expect(runs).toBeGreaterThan(1);
      expect(host.filed.size).toBe(CALLS_PER_RUN + 10);
      const reads = world.threadReads();
      expect(new Set(reads).size).toBe(reads.length);
    });
  });

  describe('a history page part-read before replies were read is read again from the position', () => {
    it('files every conversation, none skipped, from a place saved inside a page by a release before', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      for (const id of ['a', 'b', 'c']) {
        world.arrives(`c-${id}`, `Contract ${id}`, 'x', []);
        world.star(`c-${id}`);
      }
      const second = first.next();
      // As a release before saved it: an older version, and two of the page's three conversations counted done.
      second.state = { ...(first.state as Record<string, unknown>), version: 2, history: { pageToken: 'an-older-token', done: 2 } };
      world.forget();

      await world.connector().sync(second);

      expect([...second.filed.keys()]).toEqual(['c-a', 'c-b', 'c-c']);
      expect(world.requests.some((one) => one.includes('an-older-token'))).toBe(false);
    });

    it('lists again from the first page a listing by star that a release before had under way', async () => {
      const world = new GmailWorld();
      for (const id of ['a', 'b']) world.arrives(`c-${id}`, `Contract ${id}`, 'x', ['star']);
      const first = await connectedByStar(world);
      const second = first.next();
      second.state = {
        choice: 'star',
        address: 'anna@example.com',
        historyId: '4001',
        history: { pageToken: null, done: 0 },
        listing: { pageToken: 'a-token-for-conversations', done: 0, seen: ['c-a'], listed: false },
      };
      world.forget();

      await world.connector().sync(second);

      expect(world.requests.some((one) => one.includes('a-token-for-conversations'))).toBe(false);
      expect([...second.listings.at(-1)!.sourceIds].sort()).toEqual(['c-a', 'c-b', 'message:c-a', 'message:c-b']);
    });
  });

  describe('a connection following the label stays one Item per conversation, and follows no turns', () => {
    it('files two labelled emails in one conversation once, following nothing', async () => {
      const world = new GmailWorld();
      const first = signedInHost({ choice: 'label' });
      await world.connector().sync(first);
      world.arrives('t-1', 'Contract', 'The text of Contract.', ['label']);
      world.emailArrives('t-1', 'm-2', 'Re: Contract', 'The text of Re: Contract.', { marks: ['label'] });

      const second = await checked(world, first);

      expect([...second.filed.keys()]).toEqual(['t-1']);
      expect(second.filed.get('t-1')?.conversation).toBeUndefined();
    });
  });

  describe('the same mailbox followed by star in two Workspaces shares each conversation’s stars', () => {
    it('marks its Item done in the other Workspace at its next check once it is done in the first', async () => {
      const world = new GmailWorld();
      const mine = await connectedByStar(world);
      const theirs = await connectedByStar(world);
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      world.star('t-1');
      world.star('m-2');
      const mineNow = await checked(world, mine);
      const theirsNow = await checked(world, theirs);

      await world.connector().mirrorOpenState!(mineNow, [{ sourceId: 't-1', open: false }]);
      const theirsLater = await checked(world, theirsNow);

      expect(theirsLater.saidOf('t-1')).toEqual(['resolved']);
    });
  });
});

describe('Connector management', () => {
  describe('a conversation Item done in Cockpit takes the star off every email of it, and is not starred again when reopened', () => {
    it('takes the star off the whole conversation when done, and no other label', async () => {
      const world = new GmailWorld();
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      world.star('t-1');
      world.star('m-2');
      const labels = world.labelsOfEmail('m-2');

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'star' }), [{ sourceId: 't-1', open: false }]);

      expect(answered(answer)).toEqual({ confirmed: ['t-1'], gaveUp: [] });
      expect(world.labelsOfEmail('t-1')).not.toContain(STARRED);
      expect(world.labelsOfEmail('m-2')).toEqual(labels.filter((one) => one !== STARRED));
    });

    it('is given up on when reopened, and nothing is sent to Gmail', async () => {
      const world = new GmailWorld();
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'star' }), [{ sourceId: 't-1', open: true }]);

      expect(answered(answer)).toEqual({ confirmed: [], gaveUp: ['t-1'] });
      expect(world.requests.filter((one) => one.startsWith('POST'))).toEqual([]);
      expect(world.labelsOfEmail('t-1')).not.toContain(STARRED);
    });
  });

  describe('a Task made of one email before changes that email’s star alone', () => {
    async function twoEmails(starred: boolean) {
      const world = new GmailWorld();
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      if (starred) {
        world.star('t-1');
        world.star('m-2');
      }
      return world;
    }

    it('takes the star off that email when done, and no other email and no other label of it changes', async () => {
      const world = await twoEmails(true);
      const labels = world.labelsOfEmail('m-2');

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'star' }), [
        { sourceId: 'message:m-2', open: false },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['message:m-2'], gaveUp: [] });
      expect(world.labelsOfEmail('m-2')).toEqual(labels.filter((one) => one !== STARRED));
      expect(world.labelsOfEmail('t-1')).toContain(STARRED);
      expect(world.requests.filter((one) => one.startsWith('POST'))).toEqual(['POST /gmail/v1/users/me/messages/m-2/modify']);
    });

    it('puts the star back on that email alone when reopened', async () => {
      const world = await twoEmails(false);

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'star' }), [
        { sourceId: 'message:m-2', open: true },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['message:m-2'], gaveUp: [] });
      expect(world.labelsOfEmail('m-2')).toContain(STARRED);
      expect(world.labelsOfEmail('t-1')).not.toContain(STARRED);
    });

    it.each([
      { situation: 'a rate limit', status: 429 },
      { situation: 'Gmail failing', status: 503 },
    ])('asks for it again next run, neither confirmed nor given up, on $situation', async ({ status }) => {
      const world = await twoEmails(true);
      world.modifyStatus = () => status;

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'star' }), [
        { sourceId: 'message:t-1', open: false },
        { sourceId: 'message:m-2', open: false },
      ]);

      expect(answered(answer)).toEqual({ confirmed: [], gaveUp: [] });
      expect(world.labelsOfEmail('m-2')).toContain(STARRED);
    });

    it('gives up on an email Gmail refuses for good, and sends the rest', async () => {
      const world = await twoEmails(true);
      world.modifyStatus = (id) => (id === 't-1' ? 400 : 200);
      const host = signedInHost({ choice: 'star' });

      const answer = await world.connector().mirrorOpenState!(host, [
        { sourceId: 'message:t-1', open: false },
        { sourceId: 'message:m-2', open: false },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['message:m-2'], gaveUp: ['message:t-1'] });
      expect(host.logged.some((one) => one.level === 'warn')).toBe(true);
    });

    it('confirms an email that is gone, which has nothing left to unstar', async () => {
      const world = await twoEmails(true);
      world.deleteEmail('m-2');

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'star' }), [
        { sourceId: 'message:m-2', open: false },
      ]);

      expect(answered(answer).confirmed).toEqual(['message:m-2']);
    });
  });
});
