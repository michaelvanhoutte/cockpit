import { describe, expect, it } from 'vitest';
import type { MirroredOpenStates, SourceItem } from '@cockpit/connector-sdk';
import { CALLS_PER_RUN } from '../../src/index.js';
import { STARRED } from '../gmail-payloads.js';
import type { FakeHost } from './fake-host.js';
import { GmailWorld, signedInHost } from './gmail-world.js';

/**
 * L1, against a fake host and Gmail faked at the network: a connection
 * following the star brings in each email starred as an Item of its own, keeps
 * it in step with that email's star, and leaves an Item brought in before as a
 * conversation to close and nothing more ("Bring in each email you star in
 * Gmail as its own Item", issue 1398). What the host does with a source id it
 * never filed is the host's, and is proved there; the host is not run here.
 * The quirks each case rests on are in the package README.
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

/** An Item from before emails came in one by one: a conversation's, under the conversation's own id. */
function broughtInBefore(host: FakeHost, threadId: string): SourceItem {
  const item = { sourceId: threadId, title: 'Brought in as a conversation', choice: 'star' } as SourceItem;
  host.filed.set(threadId, item);
  return item;
}

/** A conversation of an email or two, none of them starred, ready to be starred one by one. */
function conversation(world: GmailWorld, ...subjects: string[]): void {
  world.arrives('t-1', subjects[0]!, `The text of ${subjects[0]}.`, []);
  subjects.slice(1).forEach((subject, at) => world.emailArrives('t-1', `m-${at + 2}`, subject, `The text of ${subject}.`));
}

function answered(answer: MirroredOpenStates): { confirmed: string[]; gaveUp: string[] } {
  if (Array.isArray(answer)) return { confirmed: answer, gaveUp: [] };
  return { confirmed: answer.confirmed ?? [], gaveUp: answer.gaveUp ?? [] };
}

describe('Capture', () => {
  describe('by star, each email starred after connecting arrives once as an Item of its own, with that email’s subject, text, sender, time, link and labels', () => {
    const arrived = (id: string, title: string, sourceTimestamp: string, link = id) => ({
      sourceId: `message:${id}`,
      title,
      capturedMessage: `The text of ${title}.`,
      sender: 'Pieter Claes',
      sourceTimestamp,
      sourceLink: `${LINK}${link}`,
      choice: 'star',
    });
    it.each([
      {
        situation: 'two emails in one conversation, both starred',
        happens: (world: GmailWorld) => {
          conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
          world.star('t-1');
          world.star('m-2');
        },
        brings: [
          arrived('t-1', 'Invoice for contract 1', '2026-10-01T08:30:00.000Z'),
          arrived('m-2', 'Invoice for contract 2', '2026-10-02T08:30:00.000Z'),
        ],
      },
      {
        situation: 'one email starred in a conversation of three, not the latest',
        happens: (world: GmailWorld) => {
          conversation(world, 'Contract', 'Re: Contract', 'Re: Re: Contract');
          world.star('m-2');
        },
        brings: [arrived('m-2', 'Re: Contract', '2026-10-02T08:30:00.000Z')],
      },
      {
        situation: 'an email arriving already starred, as a filter or Outlook’s flag does it',
        happens: (world: GmailWorld) => {
          conversation(world, 'Contract');
          world.emailArrives('t-1', 'm-2', 'Flagged on arrival', 'The text of Flagged on arrival.', { marks: ['star'] });
        },
        brings: [arrived('m-2', 'Flagged on arrival', '2026-10-02T08:30:00.000Z')],
      },
      {
        situation: 'a conversation arriving starred',
        happens: (world: GmailWorld) => world.arrives('t-1', 'Quarterly figures', 'The text of Quarterly figures.', ['star']),
        brings: [arrived('t-1', 'Quarterly figures', '2026-10-01T08:30:00.000Z')],
      },
      {
        situation: 'a user label on another email of the conversation only',
        happens: (world: GmailWorld) => {
          conversation(world, 'Contract', 'Re: Contract');
          world.label('t-1', 'Admin', 1);
          world.star('t-1');
        },
        brings: [{ ...arrived('t-1', 'Contract', '2026-10-01T08:30:00.000Z'), names: [] }],
      },
      {
        situation: 'a user label on the starred email',
        happens: (world: GmailWorld) => {
          conversation(world, 'Contract', 'Re: Contract');
          world.label('t-1', 'Admin', 1);
          world.star('m-2');
        },
        brings: [{ ...arrived('m-2', 'Re: Contract', '2026-10-02T08:30:00.000Z'), names: ['Admin'] }],
      },
    ])('$situation: files $brings.length', async ({ happens, brings }) => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      happens(world);

      const second = await checked(world, first);

      expect([...second.filed.values()]).toEqual(brings.map((one) => expect.objectContaining(one)));
    });

    it('files nothing for an email starred before connecting', async () => {
      const world = new GmailWorld();
      conversation(world, 'Starred long ago');
      world.star('t-1');
      const first = await connectedByStar(world);

      const second = await checked(world, first);

      expect(first.filed.size + second.filed.size).toBe(0);
    });

    it('files each email once when the same history is read twice', async () => {
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

      expect([...third.filed.keys()]).toEqual(['message:t-1', 'message:m-2']);
      expect(third.saidOf('message:t-1')).toEqual(['reopened']);
    });

    it('files the first email of a conversation beside the conversation’s Item from before, which it leaves as it is', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      const before = broughtInBefore(first, 't-1');
      conversation(world, 'Quarterly figures');
      world.star('t-1');

      const second = await checked(world, first);

      expect([...second.filed.keys()]).toEqual(['t-1', 'message:t-1']);
      expect(second.filed.get('t-1')).toBe(before);
      expect(second.saidOf('t-1')).toEqual([]);
    });
  });

  describe('an Item brought in by star follows its own email’s star from Gmail', () => {
    async function twoStarred() {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      world.star('t-1');
      world.star('m-2');
      return { world, host: await checked(world, first) };
    }

    it.each([
      { situation: 'that email unstarred', happens: (world: GmailWorld) => world.unstar('m-2') },
      { situation: 'that email moved to the bin', happens: (world: GmailWorld) => world.binEmail('m-2') },
      { situation: 'that email deleted for good', happens: (world: GmailWorld) => world.deleteEmail('m-2') },
    ])('marks it done when $situation, and leaves the other email’s Item alone', async ({ happens }) => {
      const { world, host } = await twoStarred();
      happens(world);

      const next = await checked(world, host);

      expect(next.saidOf('message:m-2')).toEqual(['resolved']);
      expect(next.saidOf('message:t-1')).toEqual([]);
    });

    it('reopens the same Item when that email is starred again', async () => {
      const { world, host } = await twoStarred();
      world.unstar('m-2');
      const closed = await checked(world, host);
      world.star('m-2');

      const reopened = await checked(world, closed);

      expect(reopened.saidOf('message:m-2')).toEqual(['reopened']);
      expect([...reopened.filed.keys()]).toEqual(['message:t-1', 'message:m-2']);
    });
  });

  describe('an Item brought in as a conversation before emails came in one by one only ever closes', () => {
    /** A conversation of two emails, both starred before connecting, whose Item an earlier release made. */
    async function oldConversation() {
      const world = new GmailWorld();
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      world.star('t-1');
      world.star('m-2');
      const first = await connectedByStar(world);
      broughtInBefore(first, 't-1');
      return { world, host: first };
    }

    it('is marked done once no email in its conversation is starred', async () => {
      const { world, host } = await oldConversation();
      world.unstar('t-1');
      world.unstar('m-2');

      const next = await checked(world, host);

      expect(next.saidOf('t-1')).toEqual(['resolved']);
    });

    it('stays open while one email in its conversation is starred', async () => {
      const { world, host } = await oldConversation();
      world.unstar('t-1');

      const next = await checked(world, host);

      expect(next.saidOf('t-1')).toEqual([]);
      expect(next.saidOf('message:t-1')).toEqual(['resolved']);
    });

    it('stays done when an email in its conversation is starred again, which arrives as an Item of its own', async () => {
      const { world, host } = await oldConversation();
      world.unstar('t-1');
      world.unstar('m-2');
      const closed = await checked(world, host);
      world.star('m-2');

      const next = await checked(world, closed);

      expect(next.saidOf('t-1')).toEqual([]);
      expect(closed.saidOf('t-1')).toEqual(['resolved']);
      expect([...next.filed.keys()]).toEqual(['t-1', 'message:m-2']);
    });

    it('keeps the names a label put on one of its emails gives it', async () => {
      const { world, host } = await oldConversation();
      world.label('t-1', 'Admin', 1);

      const next = await checked(world, host);

      expect(next.namesReported).toContainEqual({ sourceId: 't-1', names: ['Admin'] });
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

  describe('a run spends its call budget per conversation changed, and resumes without losing or repeating an email', () => {
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
      expect([...second.filed.keys()]).toEqual(['message:t-1', 'message:m-2', 'message:m-3']);
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
      expect(host.filed.size).toBe((CALLS_PER_RUN + 10) * 2);
      const reads = world.threadReads();
      expect(new Set(reads).size).toBe(reads.length);
    });
  });

  describe('a history page part-read when emails came to be read one by one is read again from its start', () => {
    it('files every email, none skipped, from a place saved inside a page by the release before', async () => {
      const world = new GmailWorld();
      const first = await connectedByStar(world);
      for (const id of ['a', 'b', 'c']) {
        world.arrives(`c-${id}`, `Contract ${id}`, 'x', []);
        world.star(`c-${id}`);
      }
      const second = first.next();
      // As the release before saved it: no version, and two of the page's three conversations counted done.
      const { version: _, ...before } = first.state as Record<string, unknown> & { version: number };
      second.state = { ...before, history: { pageToken: null, done: 2 } };

      await world.connector().sync(second);

      expect([...second.filed.keys()]).toEqual(['message:c-a', 'message:c-b', 'message:c-c']);
    });

    it('lists again from the first page a listing by star that the release before had under way', async () => {
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

  describe('a connection following the label stays one Item per conversation', () => {
    it('files two labelled emails in one conversation once', async () => {
      const world = new GmailWorld();
      const first = signedInHost({ choice: 'label' });
      await world.connector().sync(first);
      world.arrives('t-1', 'Contract', 'The text of Contract.', ['label']);
      world.emailArrives('t-1', 'm-2', 'Re: Contract', 'The text of Re: Contract.', { marks: ['label'] });

      const second = await checked(world, first);

      expect([...second.filed.keys()]).toEqual(['t-1']);
    });
  });

  describe('the same mailbox followed by star in two Workspaces shares each email’s star', () => {
    it('marks an email’s Item done in the other Workspace at its next check once it is done in the first', async () => {
      const world = new GmailWorld();
      const mine = await connectedByStar(world);
      const theirs = await connectedByStar(world);
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      world.star('t-1');
      world.star('m-2');
      const mineNow = await checked(world, mine);
      const theirsNow = await checked(world, theirs);

      await world.connector().mirrorOpenState!(mineNow, [{ sourceId: 'message:m-2', open: false }]);
      const theirsLater = await checked(world, theirsNow);

      expect(theirsLater.saidOf('message:m-2')).toEqual(['resolved']);
      expect(theirsLater.saidOf('message:t-1')).toEqual([]);
    });
  });
});

describe('Connector management', () => {
  describe('a Task done, dismissed, reopened or undone in Cockpit changes that email’s star alone', () => {
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
      expect(world.requests.filter((one) => one.startsWith('POST'))).toEqual([
        'POST /gmail/v1/users/me/messages/m-2/modify',
      ]);
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

  describe('a Task brought in as a conversation before emails came in one by one can be done in Cockpit but not reopened', () => {
    it('takes the star off the whole conversation when done', async () => {
      const world = new GmailWorld();
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');
      world.star('t-1');
      world.star('m-2');

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'star' }), [
        { sourceId: 't-1', open: false },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['t-1'], gaveUp: [] });
      expect(world.labelsOfEmail('t-1')).not.toContain(STARRED);
      expect(world.labelsOfEmail('m-2')).not.toContain(STARRED);
    });

    it('is given up on when reopened, and nothing is sent to Gmail', async () => {
      const world = new GmailWorld();
      conversation(world, 'Invoice for contract 1', 'Invoice for contract 2');

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'star' }), [
        { sourceId: 't-1', open: true },
        { sourceId: 'message:m-2', open: true },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['message:m-2'], gaveUp: ['t-1'] });
      expect(world.requests.filter((one) => one.startsWith('POST'))).toEqual([
        'POST /gmail/v1/users/me/messages/m-2/modify',
      ]);
      expect(world.labelsOfEmail('t-1')).not.toContain(STARRED);
    });
  });
});
