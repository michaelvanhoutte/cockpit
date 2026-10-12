import { describe, expect, it } from 'vitest';
import type { EmittedItem, SourceItem } from '@cockpit/connector-sdk';
import { ARCHIVE_ID, DELETED_ITEMS_ID, GraphWorld, signedInHost } from './outlook-world.js';
import { FakeHost } from './fake-host.js';

/**
 * L1, against a fake host and Microsoft Graph faked at the network: the messages
 * carrying the followed mark arrive once each as titled Tasks ("Build Outlook
 * as a connector package on the SDK, unregistered", issue 1046).
 */

describe('Capture', () => {
  describe('a message carrying the followed mark arrives once, as a titled Task tagged with the choice', () => {
    it('brings in a flagged message with its subject, sender, text, link in Outlook on the web and the choice it came in under', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', subject: 'Chase the invoice', text: 'Please pay by Friday.' });
      const host = signedInHost();

      await world.connector().sync(host);

      expect(host.filed.get('m-1')).toEqual({
        sourceId: 'm-1',
        sourceLink: expect.stringContaining('outlook.office365.com'),
        sender: 'Pieter Claes',
        sourceTimestamp: '2026-10-01T08:30:00.000Z',
        capturedMessage: 'Please pay by Friday.',
        title: 'Chase the invoice',
        choice: 'flag',
      });
    });

    it('brings in a message categorised Cockpit when following the category', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { categories: ['Cockpit'] });
      const host = signedInHost({ choice: 'category' });

      await world.connector().sync(host);

      expect([...host.filed.values()].map((one) => [one.sourceId, one.choice])).toEqual([['m-1', 'category']]);
    });

    it.each([
      {
        situation: 'a flagged message, following the category',
        choice: 'category',
        arrive: (world: GraphWorld) => world.arrives('m-1', { flag: 'flagged' }),
      },
      {
        situation: 'a categorised message, following the flag',
        choice: 'flag',
        arrive: (world: GraphWorld) => world.arrives('m-1', { categories: ['Cockpit'] }),
      },
      {
        situation: 'a message whose flag is complete',
        choice: 'flag',
        arrive: (world: GraphWorld) => world.arrives('m-1', { flag: 'complete' }),
      },
      {
        situation: 'a message in another category',
        choice: 'category',
        arrive: (world: GraphWorld) => world.arrives('m-1', { categories: ['Red category'] }),
      },
      {
        situation: 'a flagged message in Deleted Items',
        choice: 'flag',
        arrive: (world: GraphWorld) => world.arrives('m-1', { flag: 'flagged', folder: DELETED_ITEMS_ID }),
      },
      {
        situation: 'a categorised message in Deleted Items',
        choice: 'category',
        arrive: (world: GraphWorld) => world.arrives('m-1', { categories: ['Cockpit'], folder: DELETED_ITEMS_ID }),
      },
    ])('does not bring in $situation, whether or not Graph lists it', async ({ choice, arrive }) => {
      for (const listsEverything of [false, true]) {
        const world = new GraphWorld();
        world.listsEverything = listsEverything;
        arrive(world);
        const host = signedInHost({ choice });

        await world.connector().sync(host);

        expect(host.filed.size).toBe(0);
        expect(host.listings).toEqual([{ choice, sourceIds: [] }]);
      }
    });

    it('counts the category in any case, since Outlook compares category names without regard to it', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { categories: ['cockpit'] });
      world.listsEverything = true;
      const host = signedInHost({ choice: 'category' });

      await world.connector().sync(host);

      expect([...host.filed.keys()]).toEqual(['m-1']);
    });

    it.each([
      { situation: 'unmarked', change: (world: GraphWorld) => world.unflag('m-1') },
      { situation: 'moved to Deleted Items', change: (world: GraphWorld) => world.moveTo('m-1', DELETED_ITEMS_ID) },
      { situation: 'deleted for good', change: (world: GraphWorld) => world.deleteForGood('m-1') },
    ])('does not bring in a message  between the listing and the read', async ({ change }) => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      world.beforeRead = () => change(world);
      const host = signedInHost();

      await world.connector().sync(host);

      expect(host.filed.size).toBe(0);
    });

    it('titles a message with no subject “(no subject)”, and lets the title stand in for text it has none of', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', subject: null, text: '' });
      const host = signedInHost();

      await world.connector().sync(host);

      expect(host.filed.get('m-1')).toMatchObject({ title: '(no subject)', capturedMessage: '(no subject)' });
    });

    it('brings in the words of an HTML-only body, its tags taken out', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', html: '<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>Anna</b></p><p>Pay &amp; confirm</p></body></html>' });
      const host = signedInHost();

      await world.connector().sync(host);

      expect(host.filed.get('m-1')?.capturedMessage).toBe('Hello Anna\nPay & confirm');
    });

    it('cuts a title or sender past 200 characters and the text past 60,000', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', {
        flag: 'flagged',
        subject: 'S'.repeat(250),
        from: { name: 'N'.repeat(250), address: 'n@example.com' },
        text: 'T'.repeat(70_000),
      });
      const host = signedInHost();

      await world.connector().sync(host);

      const item = host.filed.get('m-1')!;
      expect([item.title?.length, item.sender?.length, item.capturedMessage?.length]).toEqual([200, 200, 60_000]);
    });

    it('names the sender by address where the name is empty, and brings a message with no sender in without one', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', from: { name: '', address: 'pieter@example.com' } });
      world.arrives('m-2', { flag: 'flagged', from: null });
      const host = signedInHost();

      await world.connector().sync(host);

      expect([host.filed.get('m-1')?.sender, host.filed.get('m-2')?.sender]).toEqual(['pieter@example.com', null]);
    });
  });

  describe('only messages the last listing did not see are read in full', () => {
    it('lists again on a second run over the same marks, and reads nothing and emits nothing', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      world.arrives('m-2', { flag: 'flagged' });
      const first = signedInHost();
      await world.connector().sync(first);
      world.forget();

      const second = first.next();
      await world.connector().sync(second);

      expect(world.listPages()).toBe(1);
      expect(world.readsInFull()).toEqual([]);
      expect(second.changes).toEqual([]);
      expect(second.filed.size).toBe(2);
    });

    it('reads and emits only the message newly marked', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      world.arrives('m-2');
      const first = signedInHost();
      await world.connector().sync(first);
      world.forget();
      world.flag('m-2');

      const second = first.next();
      await world.connector().sync(second);

      expect(world.readsInFull()).toEqual(['m-2']);
      expect([...second.filed.keys()].sort()).toEqual(['m-1', 'm-2']);
    });

    it('reports reopened a message marked again after its Item closed, which the host already knows', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      const first = signedInHost();
      await world.connector().sync(first);
      world.complete('m-1');
      const closed = first.next();
      await world.connector().sync(closed);
      expect(closed.listings.at(-1)?.sourceIds).toEqual([]);
      world.forget();
      world.flag('m-1');

      const again = closed.next();
      await world.connector().sync(again);

      expect(world.readsInFull()).toEqual(['m-1']);
      expect(again.saidOf('m-1')).toEqual(['reopened']);
    });

    it('keeps nothing of a run whose emit fails part-way, so the next run reads the same messages and finds them known', async () => {
      const world = new GraphWorld();
      for (const id of ['m-1', 'm-2', 'm-3']) world.arrives(id, { flag: 'flagged' });
      const failing = new FailingHost({ failAt: 2 });

      await expect(world.connector().sync(failing)).rejects.toThrow('the store is down');
      expect(failing.state).toBeNull();
      expect(failing.listings).toEqual([]);
      world.forget();

      const next = failing.next();
      await world.connector().sync(next);

      expect(world.readsInFull().sort()).toEqual(['m-1', 'm-2', 'm-3']);
      expect(next.filed.size).toBe(3);
      expect(next.saidOf('m-3')).toEqual(['reopened']);
    });
  });

  describe('a message keeps its Item when it moves folder', () => {
    it('asks Graph for immutable ids in every request', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });

      await world.connector().sync(signedInHost());

      expect(world.prefer.length).toBeGreaterThanOrEqual(3);
      for (const prefer of world.prefer) expect(prefer).toContain('IdType="ImmutableId"');
    });

    it('lists the same id after a move from Inbox to Archive, emitting nothing new and closing nothing', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      const first = signedInHost();
      await world.connector().sync(first);
      world.forget();
      world.moveTo('m-1', ARCHIVE_ID);

      const second = first.next();
      await world.connector().sync(second);

      expect(second.listings).toEqual([{ choice: 'flag', sourceIds: ['m-1'] }]);
      expect(world.readsInFull()).toEqual([]);
      expect(second.changes).toEqual([]);
      expect(second.filed.size).toBe(1);
    });
  });

  describe('a changed choice starts the diff over under the new mark', () => {
    it('lists under the new mark, reads every message carrying it and keeps the new choice', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', categories: ['Cockpit'] });
      world.arrives('m-2', { categories: ['Cockpit'] });
      const first = signedInHost({ choice: 'flag' });
      await world.connector().sync(first);
      world.forget();

      const second = first.next();
      second.choice = 'category';
      await world.connector().sync(second);

      expect(world.readsInFull().sort()).toEqual(['m-1', 'm-2']);
      expect(second.listings).toEqual([{ choice: 'category', sourceIds: expect.arrayContaining(['m-1', 'm-2']) }]);
      expect(second.state).toMatchObject({ choice: 'category' });
      expect(second.filed.get('m-2')?.choice).toBe('category');
    });

    it('carries on from the kept listing under the same choice', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      const first = signedInHost({ choice: 'flag' });
      await world.connector().sync(first);
      world.forget();

      await world.connector().sync(first.next());

      expect(world.readsInFull()).toEqual([]);
    });
  });

  describe('a run stops at its call budget and says there is more to do', () => {
    it('answers more to do, makes no more calls than the budget, counts the refresh, and a later run reads no message twice', async () => {
      const world = new GraphWorld();
      for (let n = 1; n <= 10; n++) world.arrives(`m-${n}`, { flag: 'flagged' });
      let host = signedInHost({ expiresAt: null });

      const first = await world.connector({ callsPerRun: 6 }).sync(host);

      expect(first).toEqual({ moreToDo: true });
      // The refresh, Deleted Items and the listing take three of the six.
      expect(world.requests).toHaveLength(6);
      expect(world.readsInFull()).toHaveLength(3);
      expect(host.filed.size).toBe(3);

      let runs = 1;
      let answer: unknown = first;
      while (answer && runs < 10) {
        host = host.next();
        answer = await world.connector({ callsPerRun: 6 }).sync(host);
        runs += 1;
      }

      expect(answer).toBeUndefined();
      expect(host.filed.size).toBe(10);
      const reads = world.readsInFull();
      expect(new Set(reads).size).toBe(reads.length);
    });

    it('says nothing more is to do once everything is read', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });

      await expect(world.connector({ callsPerRun: 4 }).sync(signedInHost())).resolves.toBeUndefined();
    });
  });
});

/** A host whose store gives out when asked to file its `failAt`th Item. */
class FailingHost extends FakeHost {
  #filings = 0;
  readonly #failAt: number;

  constructor(options: { failAt: number }) {
    super({ credential: signedInHost().credential });
    this.#failAt = options.failAt;
  }

  override async emitItem(item: SourceItem): Promise<EmittedItem> {
    this.#filings += 1;
    if (this.#filings === this.#failAt) throw new Error('the store is down');
    return super.emitItem(item);
  }
}
