import { describe, expect, it } from 'vitest';
import type { SyncAnswer } from '@cockpit/connector-sdk';
import { CALLS_PER_RUN } from '../../src/index.js';
import type { FakeHost } from './fake-host.js';
import { GmailWorld, signedInHost } from './gmail-world.js';

/**
 * L1, against a fake host and Gmail faked at the network: what a run of the
 * Gmail connector brings in, closes and reopens ("Build Gmail as a connector
 * package on the SDK, unregistered", issue 943). The quirks each case rests on
 * are in the package README.
 */

/** One run of the connection, handed back with what the host was told. */
async function run(world: GmailWorld, host: FakeHost): Promise<SyncAnswer | void> {
  return world.connector().sync(host);
}

describe('Capture', () => {
  describe('a run brings in each conversation the connection follows, once, as a titled Task tagged with the choice', () => {
    it.each([
      { situation: 'labelled Cockpit, by label', choice: 'label', marks: ['label'] as const },
      { situation: 'starred, by star', choice: 'star', marks: ['star'] as const },
    ])('files a conversation $situation under its subject, sender, link and the choice', async ({ choice, marks }) => {
      const world = new GmailWorld();
      const first = signedInHost({ choice });
      await run(world, first);

      world.arrives('t-1', 'Quarterly figures', 'Send the Q3 figures.', marks);
      const second = first.next();
      await run(world, second);

      expect([...second.filed.values()]).toEqual([
        expect.objectContaining({
          source: 'mail',
          sourceId: 't-1',
          title: 'Quarterly figures',
          capturedMessage: 'Send the Q3 figures.',
          sender: 'Pieter Claes',
          choice,
          sourceLink: 'https://mail.google.com/mail/?authuser=anna%40example.com#all/t-1',
        }),
      ]);
    });

    it('does not file a conversation again once the host knows it', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'Quarterly figures');
      const first = signedInHost();
      await run(world, first);
      expect(first.filed.size).toBe(1);

      world.arrives('t-2', 'Lunch');
      world.mark('t-1', 'label');
      const second = first.next();
      await run(world, second);

      // t-1 was read again for its label put back, and the host answered that it knew it.
      expect([...second.filed.keys()]).toEqual(['t-1', 't-2']);
      expect(second.changes.filter((one) => one.change === 'reopened').map((one) => one.sourceId)).toContain('t-1');
    });

    it('leaves out a conversation starred before the connection started following the star', async () => {
      const world = new GmailWorld();
      world.arrives('t-before', 'Starred long ago', 'x', ['star']);
      const first = signedInHost({ choice: 'star' });
      await run(world, first);

      world.arrives('t-after', 'Starred today', 'y', ['star']);
      const second = first.next();
      await run(world, second);

      expect([...second.filed.keys()]).toEqual(['t-after']);
    });
  });

  describe('a run reads the history since its saved position, and lists in full where the history has lapsed or the choice changed', () => {
    it('reads only the history while the position is still kept', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One');
      const first = signedInHost();
      await run(world, first);
      world.arrives('t-2', 'Two');
      world.forget();

      const second = first.next();
      await run(world, second);

      expect(world.requests.some((one) => one.includes('/history'))).toBe(true);
      expect(world.requests.some((one) => /GET \/gmail\/v1\/users\/me\/threads\?/.test(one))).toBe(false);
      expect(second.listings).toEqual([]);
      expect([...second.filed.keys()]).toEqual(['t-1', 't-2']);
    });

    it.each([{ saved: 'unreadable' }, { saved: 42 }, { saved: { choice: 'label', historyId: 7, listing: 'x' } }])(
      'starts with a complete listing when what it saved cannot be read: $saved',
      async ({ saved }) => {
        const world = new GmailWorld();
        world.arrives('t-1', 'One');
        const host = signedInHost();
        host.state = saved;

        await run(world, host);

        expect(host.listings).toHaveLength(1);
        expect(host.filed.size).toBe(1);
      },
    );

    it('lists in full, and reports the listing, when the first run has no position', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One');
      world.arrives('t-2', 'Two');

      const host = signedInHost();
      await run(world, host);

      expect(host.listings).toEqual([{ choice: 'label', sourceIds: expect.arrayContaining(['t-1', 't-2']) }]);
      expect(host.listings[0]!.sourceIds).toHaveLength(2);
    });

    it('lists in full again, and brings in what is marked and missing, where Gmail no longer keeps the position', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One');
      const first = signedInHost();
      await run(world, first);

      world.arrives('t-2', 'Two');
      world.forgetHistory();
      const second = first.next();
      await run(world, second);

      expect(second.listings).toEqual([{ choice: 'label', sourceIds: expect.arrayContaining(['t-1', 't-2']) }]);
      expect([...second.filed.keys()]).toEqual(['t-1', 't-2']);
    });

    it('starts over, with a complete listing under the new choice, when the connection now follows another', async () => {
      const world = new GmailWorld();
      world.arrives('t-label', 'Labelled');
      world.arrives('t-star', 'Starred', 'x', ['star']);
      const byLabel = signedInHost({ choice: 'label' });
      await run(world, byLabel);
      expect(byLabel.listings.map((one) => one.choice)).toEqual(['label']);

      const byStar = byLabel.next();
      byStar.choice = 'star';
      await run(world, byStar);

      expect(byStar.listings).toEqual([{ choice: 'star', sourceIds: ['t-star'] }]);
      // A star listing only closes: what was starred before it counts is not brought in.
      expect([...byStar.filed.keys()]).toEqual(['t-label']);
    });

    it('resumes a listing that spans runs from where it stopped, reading no conversation twice', async () => {
      const world = new GmailWorld();
      for (let at = 0; at < 120; at += 1) world.arrives(`t-${at}`, `Subject ${at}`);

      let host = signedInHost();
      let runs = 0;
      for (;;) {
        runs += 1;
        const answer = await run(world, host);
        if (!answer?.moreToDo) break;
        host = host.next();
        expect(runs).toBeLessThan(20);
      }

      expect(runs).toBeGreaterThan(1);
      expect(host.filed.size).toBe(120);
      const reads = world.readsInFull();
      expect(new Set(reads).size).toBe(reads.length);
      expect(host.listings).toHaveLength(1);
      expect(host.listings[0]!.sourceIds).toHaveLength(120);
    });
  });

  describe('a run stops at its call budget and says there is more to do', () => {
    it('answers moreToDo, having called Google no more than the budget allows', async () => {
      const world = new GmailWorld();
      for (let at = 0; at < 80; at += 1) world.arrives(`t-${at}`, `Subject ${at}`);

      const answer = await run(world, signedInHost());

      expect(answer).toEqual({ moreToDo: true });
      expect(world.gmailCalls()).toBeLessThanOrEqual(CALLS_PER_RUN);
    });

    it('says nothing when it read everything the mailbox held', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One');

      expect(await run(world, signedInHost())).toBeUndefined();
    });
  });

  describe('a label or star coming off, or going back on, is a change the Task follows', () => {
    it.each([
      { situation: 'the label taken off', choice: 'label', mark: 'label', change: (w: GmailWorld) => w.unmark('t-1', 'label'), says: ['resolved'] },
      { situation: 'the star taken off', choice: 'star', mark: 'star', change: (w: GmailWorld) => w.unmark('t-1', 'star'), says: ['resolved'] },
      { situation: 'the conversation moved to the bin', choice: 'label', mark: 'label', change: (w: GmailWorld) => w.bin('t-1'), says: ['resolved'] },
    ] as const)('says resolved for $situation', async ({ choice, mark, change, says }) => {
      const world = new GmailWorld();
      const first = signedInHost({ choice });
      await run(world, first);
      world.arrives('t-1', 'One', 'x', [mark]);
      const second = first.next();
      await run(world, second);

      change(world);
      const third = second.next();
      await run(world, third);

      expect(third.saidOf('t-1')).toEqual(says);
    });

    it.each([
      { situation: 'the label put back', choice: 'label', mark: 'label' },
      { situation: 'the star put back', choice: 'star', mark: 'star' },
    ] as const)('says reopened for $situation', async ({ choice, mark }) => {
      const world = new GmailWorld();
      const first = signedInHost({ choice });
      await run(world, first);
      world.arrives('t-1', 'One', 'x', [mark]);
      const second = first.next();
      await run(world, second);
      world.unmark('t-1', mark);
      const third = second.next();
      await run(world, third);

      world.mark('t-1', mark);
      const fourth = third.next();
      await run(world, fourth);

      expect(fourth.saidOf('t-1')).toEqual(['reopened']);
    });

    it('closes what a complete listing no longer sees, where the history missed it', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One');
      world.arrives('t-2', 'Two');
      const first = signedInHost();
      await run(world, first);

      world.unmark('t-1', 'label');
      world.forgetHistory();
      const second = first.next();
      await run(world, second);

      // The listing is the backstop: what it did not list, the host closes.
      expect(second.listings.at(-1)!.sourceIds).toEqual(['t-2']);
    });

    it('works through a history page naming more conversations than one run can read, over successive runs', async () => {
      const world = new GmailWorld();
      const first = signedInHost();
      await run(world, first);
      for (let at = 0; at < 60; at += 1) world.arrives(`t-${at}`, `Subject ${at}`);

      let host = first.next();
      let runs = 0;
      for (;;) {
        runs += 1;
        const answer = await run(world, host);
        if (!answer?.moreToDo) break;
        host = host.next();
        expect(runs).toBeLessThan(20);
      }

      expect(runs).toBeGreaterThan(1);
      expect(host.filed.size).toBe(60);
    });
  });
});
