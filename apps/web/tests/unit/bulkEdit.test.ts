import { describe, expect, it } from 'vitest';
import type { Item, ItemType } from '@cockpit/shared';
import { CommandRefused } from '../../src/api/client';
import type { CommandArgs } from '../../src/api/queries';
import {
  editSeveral,
  putBack,
  saysWhatWasNotChanged,
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
    typeId: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    dueDate: null,
    ...over,
  } as unknown as Item;
}

const TYPES = [
  { id: 'task', name: 'Task' },
  { id: 'idea', name: 'Idea' },
] as unknown as ItemType[];

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
  field: 'typeId' | 'priority' | 'dueDate' | 'status',
  value: string | null,
  onProgress: (at: number, of: number) => void = () => {},
) => editSeveral(sending, { items, field, value, types: TYPES, runOf: () => undefined, onProgress });

const summary = (sent: CommandArgs[]) =>
  sent.map((c) => `${c.name}:${(c.payload as { itemId: string }).itemId}`);

describe('Selection', () => {
  describe('each field names the value every picked Item shares, or Mixed', () => {
    it.each([
      { situation: 'Priority all High', field: 'priority', items: [{ priority: 'high' }, { priority: 'high' }], mixed: false, value: 'high' },
      { situation: 'Priority High and none', field: 'priority', items: [{ priority: 'high' }, { priority: null }], mixed: true },
      { situation: 'Type on an Item with no type beside a typed one', field: 'typeId', items: [{ typeId: 'task' }, { typeId: null }], mixed: true },
      { situation: 'Type on Items that all have none', field: 'typeId', items: [{ typeId: null }, { typeId: null }], mixed: false, value: null },
      { situation: 'Status on Items to do and in progress', field: 'status', items: [{}, { startedAt: '2026-10-01T09:00:00.000Z' }], mixed: true },
      { situation: 'Status on Items all in progress', field: 'status', items: [{ startedAt: 'a' }, { startedAt: 'b' }], mixed: false, value: 'in_progress' },
    ] as {
      situation: string;
      field: 'typeId' | 'priority' | 'status';
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

    it('sends only a type that exists', async () => {
      const { sent, sending } = aSender();
      await edit(sending, [anItem('a')], 'typeId', 'gone');
      expect(sent).toEqual([]);
      await edit(sending, [anItem('a')], 'typeId', 'idea');
      expect(summary(sent)).toEqual(['set_item_type:a']);
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

    it('puts a finished Item back to what it was, naming the run Done ended', async () => {
      const { sent, sending } = aSender();
      const started = anItem('a', { startedAt: '2026-09-30T09:00:00.000Z' });
      const { changed } = await editSeveral(sending, {
        items: [started],
        field: 'status',
        value: 'done',
        types: TYPES,
        runOf: () => '0198a000-0000-7000-8000-000000000001',
        onProgress: () => {},
      });
      sent.length = 0;

      await putBack(sending, 'status', changed);

      expect(sent.map((c) => c.payload)).toMatchObject([
        { done: false, reopensRunId: '0198a000-0000-7000-8000-000000000001' },
      ]);
    });

    it('leaves an Item that had no type as it is, since no change sets a type to none, and says so', async () => {
      const { sent, sending } = aSender();
      const { changed } = await edit(sending, [anItem('a', { typeId: 'task' }), anItem('b')], 'typeId', 'idea');
      sent.length = 0;

      await putBack(sending, 'typeId', changed);

      expect(sent.map((c) => c.payload)).toMatchObject([{ itemId: 'a', typeId: 'task' }]);
      expect(whatWasChanged('typeId', 'Idea', changed)).toBe('Type set to Idea on 2 items (Undo leaves the 1 that had no type)');
    });

    it('names a single Item by its title and a cleared due date as cleared', async () => {
      const { sending } = aSender();
      const { changed } = await edit(sending, [anItem('a', { title: 'Reply to Bart', dueDate: '2026-12-24' })], 'dueDate', null);
      expect(whatWasChanged('dueDate', null, changed)).toBe('Due date cleared on “Reply to Bart”');
    });
  });
});
