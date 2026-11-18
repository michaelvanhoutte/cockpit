import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import { CommandRefused } from '../../src/api/client';
import type { CommandArgs } from '../../src/api/queries';
import {
  dismissSeveral,
  editSeveral,
  putBack,
  saysWhatWasNotChanged,
  saysWhatWasNotDismissed,
  undismissSeveral,
  whatWasDismissed,
  sharedValue,
  whatWasChanged,
  type Sending,
} from '../../src/bulkEdit';
import { dueTomorrow } from '../../src/dueDateShortcuts';

/**
 * F1: what changing one field of everything picked sends, in which order, and
 * what putting it back sends - decided in the client, with the send replaced by
 * a fake that records what went and can refuse a chosen Item.
 */

function anItem(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: `Item ${id}`,
    completedAt: null,
    startedAt: null,
    priority: null,
    dueDate: null,
    ...over,
  } as unknown as Item;
}

/** A send that records what it was given and refuses what it is told to, by Item. */
function aSender(refusing: Record<string, 'refused' | 'offline' | 'stale'> = {}) {
  const sent: CommandArgs[] = [];
  const sending: Sending = {
    send: async (args) => {
      sent.push(args);
      const how = refusing[(args.payload as { itemId: string }).itemId];
      if (how === 'refused') throw new CommandRefused(409, 'That item is locked.');
      if (how === 'offline') throw new TypeError('Failed to fetch');
      return { applied: how !== 'stale' };
    },
    envelope: (itemId) => () => ({
      commandId: `command-${sent.length}`,
      issuedAt: '2026-10-08T09:00:00.000Z',
      workspaceId: 'ws',
      itemId,
    }),
  };
  return { sent, sending };
}

const edit = (
  sending: Sending,
  items: Item[],
  field: 'priority' | 'dueDate' | 'status',
  value: string | null,
  onProgress: (at: number, of: number) => void = () => {},
) => editSeveral(sending, { items, field, value, runOf: () => undefined, onProgress });

const summary = (sent: CommandArgs[]) =>
  sent.map((c) => `${c.name}:${(c.payload as { itemId: string }).itemId}`);

describe('Selection', () => {
  describe('each field names the value every picked Item shares, or Mixed', () => {
    it.each([
      { situation: 'Priority all High', field: 'priority', items: [{ priority: 'high' }, { priority: 'high' }], mixed: false, value: 'high' },
      { situation: 'Priority High and none', field: 'priority', items: [{ priority: 'high' }, { priority: null }], mixed: true },
      { situation: 'Status on Items to do and in progress', field: 'status', items: [{}, { startedAt: '2026-10-01T09:00:00.000Z' }], mixed: true },
      { situation: 'Status on Items all in progress', field: 'status', items: [{ startedAt: 'a' }, { startedAt: 'b' }], mixed: false, value: 'in_progress' },
    ] as {
      situation: string;
      field: 'priority' | 'status';
      items: Partial<Item>[];
      mixed: boolean;
      value?: string | null;
    }[])('reads $situation', ({ field, items, mixed, value }) => {
      const read = sharedValue(
        items.map((over, at) => anItem(String(at), over)),
        field,
      );
      expect(read.mixed).toBe(mixed);
      if (!read.mixed) expect(read.value).toBe(value);
    });
  });

  describe('a choice changes that field on every picked Item that does not already hold it, one after another', () => {
    it('sends one change per Item not already High, in the order picked, and none for those that are', async () => {
      const { sent, sending } = aSender();
      const items = [anItem('a', { priority: 'low' }), anItem('b', { priority: 'high' }), anItem('c')];

      const { changed } = await edit(sending, items, 'priority', 'high');

      expect(summary(sent)).toEqual(['set_priority:a', 'set_priority:c']);
      expect(changed.map((c) => c.item.id)).toEqual(['a', 'c']);
    });

    it('clears the priority with none', async () => {
      const { sent, sending } = aSender();
      await edit(sending, [anItem('a', { priority: 'low' })], 'priority', null);
      expect(sent[0]!.payload).toMatchObject({ priority: null });
    });

    it.each([
      { situation: 'Tomorrow sends the day the form’s own Tomorrow gives', value: dueTomorrow(new Date()), expected: dueTomorrow(new Date()) },
      { situation: 'No due date clears it', value: null, expected: null },
      { situation: 'Pick a date… sends the chosen day', value: '2027-01-31', expected: '2027-01-31' },
    ])('due date: $situation', async ({ value, expected }) => {
      const { sent, sending } = aSender();
      await edit(sending, [anItem('a', { dueDate: '2026-12-24' })], 'dueDate', value);
      expect(sent.map((c) => c.payload)).toMatchObject([{ dueDate: expected }]);
    });

    it.each([
      {
        situation: 'In progress on a finished Item reopens it first, as a row’s own Status does',
        item: { completedAt: '2026-10-01T09:00:00.000Z' },
        to: 'in_progress',
        sends: ['set_done:false', 'set_started:true'],
      },
      {
        situation: 'In progress on one with a start time kept keeps it',
        item: { completedAt: '2026-10-01T09:00:00.000Z', startedAt: '2026-09-30T09:00:00.000Z' },
        to: 'in_progress',
        sends: ['set_done:false'],
      },
      { situation: 'Done from To do', item: {}, to: 'done', sends: ['set_done:true'] },
      { situation: 'To do on one in progress', item: { startedAt: '2026-09-30T09:00:00.000Z' }, to: 'to_do', sends: ['set_started:false'] },
    ])('status: $situation', async ({ item, to, sends }) => {
      const { sent, sending } = aSender();
      await edit(sending, [anItem('a', item)], 'status', to);
      expect(
        sent.map((c) => {
          const payload = c.payload as { done?: boolean; started?: boolean };
          return `${c.name}:${payload.done ?? payload.started}`;
        }),
      ).toEqual(sends);
    });

    it('counts the Items it is sending to, not the ones already holding the value', async () => {
      const { sending } = aSender();
      const progress: string[] = [];
      await edit(sending, [anItem('a'), anItem('b', { priority: 'high' }), anItem('c')], 'priority', 'high', (at, of) =>
        progress.push(`${at} of ${of}`),
      );
      expect(progress).toEqual(['1 of 2', '2 of 2']);
    });
  });

  describe('an Item refused does not stop the rest', () => {
    it('changes the first and third when the second is refused, and says one was not changed and why', async () => {
      const { sent, sending } = aSender({ b: 'refused' });
      const items = [anItem('a'), anItem('b'), anItem('c')];

      const { changed, refused } = await edit(sending, items, 'priority', 'high');

      expect(summary(sent)).toEqual(['set_priority:a', 'set_priority:b', 'set_priority:c']);
      expect(changed.map((c) => c.item.id)).toEqual(['a', 'c']);
      expect(refused.map((r) => r.item.id)).toEqual(['b']);
      expect(saysWhatWasNotChanged(refused)).toBe('1 not changed. That item is locked.');
    });

    it('changes nothing when every Item is refused, so there is nothing to undo', async () => {
      const { sending } = aSender({ a: 'refused', b: 'refused' });

      const { changed, refused } = await edit(sending, [anItem('a'), anItem('b')], 'priority', 'high');

      expect(changed).toEqual([]);
      expect(saysWhatWasNotChanged(refused)).toBe('2 not changed. That item is locked.');
    });

    it.each([
      { situation: 'the network failing', how: 'offline' as const, why: 'Failed to fetch' },
      { situation: 'an Item changed elsewhere', how: 'stale' as const, why: 'That item changed somewhere else.' },
    ])('treats $situation on one Item as a refusal of that Item', async ({ how, why }) => {
      const { sending } = aSender({ a: how });

      const { changed, refused } = await edit(sending, [anItem('a'), anItem('b')], 'priority', 'high');

      expect(changed.map((c) => c.item.id)).toEqual(['b']);
      expect(refused).toMatchObject([{ why }]);
    });
  });

  describe('Undo puts back each changed Item’s own previous value, and only those', () => {
    it('returns Items at Low, Normal and none each to its own', async () => {
      const { sent, sending } = aSender();
      const { changed } = await edit(
        sending,
        [anItem('a', { priority: 'low' }), anItem('b', { priority: 'normal' }), anItem('c')],
        'priority',
        'high',
      );
      sent.length = 0;

      await putBack(sending, 'priority', changed);

      expect(sent.map((c) => (c.payload as { priority: string | null }).priority)).toEqual(['low', 'normal', null]);
    });

    it('leaves a refused Item out of the Undo, which counts only the changed ones', async () => {
      const { sent, sending } = aSender({ b: 'refused' });
      const { changed } = await edit(sending, [anItem('a'), anItem('b'), anItem('c')], 'priority', 'high');
      sent.length = 0;

      await putBack(sending, 'priority', changed);

      expect(summary(sent)).toEqual(['set_priority:a', 'set_priority:c']);
      expect(whatWasChanged('priority', 'High', changed)).toBe('Priority set to High on 2 items');
    });

    it('says how far it got when refused part way, and leaves the rest undone', async () => {
      const { sent, sending } = aSender();
      const { changed } = await edit(sending, [anItem('a'), anItem('b'), anItem('c')], 'priority', 'high');
      sent.length = 0;
      const refusing = aSender({ b: 'refused' });

      await expect(putBack(refusing.sending, 'priority', changed)).rejects.toThrow(
        '1 of 3 put back, the rest still changed. That item is locked.',
      );
      expect(summary(refusing.sent)).toEqual(['set_priority:a', 'set_priority:b']);
    });

    it('says how far it got when an Item it reaches was waiting for a reply, which cannot be put back', async () => {
      const { sent, sending } = aSender();
      const waiting = anItem('b', { waitingSince: '2026-10-01T09:00:00.000Z' });
      const { changed } = await edit(sending, [anItem('a'), waiting, anItem('c')], 'status', 'in_progress');
      sent.length = 0;

      await expect(putBack(sending, 'status', changed)).rejects.toThrow(
        '1 of 3 put back, the rest still changed. A wait for a reply cannot be put back.',
      );
      expect(summary(sent)).toEqual(['set_started:a']);
    });

    it('puts a finished Item back to what it was, naming the run Done ended', async () => {
      const { sent, sending } = aSender();
      const started = anItem('a', { startedAt: '2026-09-30T09:00:00.000Z' });
      const { changed } = await editSeveral(sending, {
        items: [started],
        field: 'status',
        value: 'done',
        runOf: () => '0198a000-0000-7000-8000-000000000001',
        onProgress: () => {},
      });
      sent.length = 0;

      await putBack(sending, 'status', changed);

      expect(sent.map((c) => c.payload)).toMatchObject([
        { done: false, reopensRunId: '0198a000-0000-7000-8000-000000000001' },
      ]);
    });

    it('names a single Item by its title and a cleared due date as cleared', async () => {
      const { sending } = aSender();
      const { changed } = await edit(sending, [anItem('a', { title: 'Reply to Bart', dueDate: '2026-12-24' })], 'dueDate', null);
      expect(whatWasChanged('dueDate', null, changed)).toBe('Due date cleared on “Reply to Bart”');
    });
  });
  describe('Dismiss on the bar sends one set_dismissed per picked Item, in list order, and its one Undo undismisses exactly those that were', () => {
    const dismiss = (sending: Sending, items: Item[], onProgress: (at: number, of: number) => void = () => {}) =>
      dismissSeveral(sending, { items, runOf: () => undefined, onProgress });

    it('sends A, B, C in the order given, every one before any is answered', async () => {
      const sent: string[] = [];
      let answering = 0;
      const sending: Sending = {
        send: (args) => {
          sent.push((args.payload as { itemId: string }).itemId);
          return new Promise((resolve) => setTimeout(() => resolve({ applied: true }), 0)).then(() => {
            answering += 1;
            return { applied: true };
          });
        },
        envelope: (itemId) => () => ({ commandId: 'c', issuedAt: '2026-10-08T09:00:00.000Z', workspaceId: 'ws', itemId }),
      };

      const run = dismiss(sending, [anItem('a'), anItem('b'), anItem('c')]);

      expect(sent).toEqual(['a', 'b', 'c']);
      expect(answering).toBe(0);
      await run;
    });

    it('sends the command one row’s Dismiss sends, and counts the answers from one', async () => {
      const { sent, sending } = aSender();
      const progress: [number, number][] = [];

      await dismiss(sending, [anItem('a'), anItem('b'), anItem('c')], (at, of) => progress.push([at, of]));

      expect(sent.map((c) => [c.name, c.payload])).toMatchObject([
        ['set_dismissed', { itemId: 'a', dismissed: true }],
        ['set_dismissed', { itemId: 'b', dismissed: true }],
        ['set_dismissed', { itemId: 'c', dismissed: true }],
      ]);
      expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
    });

    it('says how many were dismissed, and Undo sends three undismissals', async () => {
      const { sent, sending } = aSender();
      const { changed } = await dismiss(sending, [anItem('a'), anItem('b'), anItem('c')]);
      expect(whatWasDismissed(changed)).toBe('3 items dismissed');
      sent.length = 0;

      await undismissSeveral(sending, changed);

      expect(sent.map((c) => [c.name, (c.payload as { itemId: string }).itemId, (c.payload as { dismissed: boolean }).dismissed])).toEqual([
        ['set_dismissed', 'a', false],
        ['set_dismissed', 'b', false],
        ['set_dismissed', 'c', false],
      ]);
    });

    it('names a single Item by its title, as a row’s Dismiss does', async () => {
      const { sending } = aSender();
      const { changed } = await dismiss(sending, [anItem('a', { title: 'Reply to Bart' })]);
      expect(whatWasDismissed(changed)).toBe('“Reply to Bart” dismissed');
    });

    it('names the run each dismissal ended in its Undo, so the server reopens exactly that one', async () => {
      const { sent, sending } = aSender();
      const { changed } = await dismissSeveral(sending, {
        items: [anItem('a'), anItem('b')],
        runOf: (itemId) => (itemId === 'a' ? 'run-a' : undefined),
        onProgress: () => {},
      });
      sent.length = 0;

      await undismissSeveral(sending, changed);

      expect(sent.map((c) => c.payload)).toMatchObject([
        { itemId: 'a', dismissed: false, reopensRunId: 'run-a' },
        { itemId: 'b', dismissed: false },
      ]);
      expect(sent[1]!.payload).not.toHaveProperty('reopensRunId');
    });

    it('carries on past a refused Item, which is the one left out of the changed, and its Undo brings back the other two alone', async () => {
      const { sent, sending } = aSender({ b: 'refused' });

      const { changed, refused } = await dismiss(sending, [anItem('a'), anItem('b'), anItem('c')]);

      expect(changed.map(({ item }) => item.id)).toEqual(['a', 'c']);
      expect(refused.map(({ item }) => item.id)).toEqual(['b']);
      expect(saysWhatWasNotDismissed(refused)).toBe('1 not dismissed. That item is locked.');
      sent.length = 0;
      await undismissSeveral(sending, changed);
      expect(sent.map((c) => (c.payload as { itemId: string }).itemId)).toEqual(['a', 'c']);
    });

    it('says a stale write, and offline, as the Item not dismissed, with the reason', async () => {
      const { sending } = aSender({ a: 'stale', b: 'offline' });

      const { changed, refused } = await dismiss(sending, [anItem('a'), anItem('b')]);

      expect(changed).toEqual([]);
      expect(saysWhatWasNotDismissed(refused)).toBe('2 not dismissed. That item changed somewhere else. Failed to fetch');
    });

    it('says nothing when none was refused', () => {
      expect(saysWhatWasNotDismissed([])).toBeNull();
    });

    it('stops an Undo refused part way and says how far it got', async () => {
      const { sending } = aSender();
      const { changed } = await dismiss(sending, [anItem('a'), anItem('b'), anItem('c')]);
      const { sending: refusing } = aSender({ b: 'refused' });

      await expect(undismissSeveral(refusing, changed)).rejects.toThrow(
        '1 of 3 put back, the rest still dismissed. That item is locked.',
      );
    });
  });

});
