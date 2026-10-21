import { describe, expect, it } from 'vitest';
import { itemLabel, itemStatus, type Item, type WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from '../../src/api/queries';
import { drawnAhead, drawnOver } from '../../src/drawnAhead';

/**
 * F1: what the screen shows of a change before the server has answered it -
 * a copy and a change in, a copy out. That it is shown within 100 ms on each
 * surface is tests/unit/components/ChangesAtOnce.test.tsx.
 */

const AT = '2026-10-20T09:00:00.000Z';
const BART = '11111111-1111-7111-8111-000000000001';
const LISA = '11111111-1111-7111-8111-000000000002';

function anItem(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: `Item ${id.slice(-1)}`,
    description: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    dueDate: null,
    ...over,
  } as unknown as Item;
}

const workspace = (items: Item[]): WorkspaceSnapshot => ({ items, filings: [], panels: [] }) as unknown as WorkspaceSnapshot;

const envelope = (itemId: string) => ({ commandId: 'c1', issuedAt: AT, workspaceId: 'ws-work', itemId });

const read = (copy: WorkspaceSnapshot, id: string) => copy.items.find((item) => item.id === id);

describe('Item editing', () => {
  describe('a change to an Item shows the moment it is made, before the server has answered', () => {
    it.each([
      {
        situation: 'marking it done',
        change: { name: 'set_done', payload: { ...envelope(BART), done: true } } as CommandArgs,
        from: {},
        shown: (item: Item) => itemStatus(item),
        expected: 'done',
      },
      {
        situation: 'reopening what was done',
        change: { name: 'set_done', payload: { ...envelope(BART), done: false } } as CommandArgs,
        from: { completedAt: '2026-10-19T09:00:00.000Z' },
        shown: (item: Item) => itemStatus(item),
        expected: 'to_do',
      },
      {
        situation: 'starting it',
        change: { name: 'set_started', payload: { ...envelope(BART), started: true } } as CommandArgs,
        from: {},
        shown: (item: Item) => itemStatus(item),
        expected: 'in_progress',
      },
      {
        situation: 'taking it back to To do',
        change: { name: 'set_started', payload: { ...envelope(BART), started: false } } as CommandArgs,
        from: { startedAt: '2026-10-19T09:00:00.000Z' },
        shown: (item: Item) => itemStatus(item),
        expected: 'to_do',
      },
      {
        situation: 'a priority',
        change: { name: 'set_priority', payload: { ...envelope(BART), priority: 'high' } } as CommandArgs,
        from: {},
        shown: (item: Item) => item.priority,
        expected: 'high',
      },
      {
        situation: 'clearing a priority',
        change: { name: 'set_priority', payload: { ...envelope(BART), priority: null } } as CommandArgs,
        from: { priority: 'low' as const },
        shown: (item: Item) => item.priority,
        expected: null,
      },
      {
        situation: 'a due date',
        change: { name: 'set_due_date', payload: { ...envelope(BART), dueDate: '2026-10-21' } } as CommandArgs,
        from: {},
        shown: (item: Item) => item.dueDate,
        expected: '2026-10-21',
      },
      {
        situation: 'a title',
        change: { name: 'set_title', payload: { ...envelope(BART), title: 'Reply to Bart today' } } as CommandArgs,
        from: {},
        shown: (item: Item) => item.title,
        expected: 'Reply to Bart today',
      },
      {
        situation: 'a description',
        change: { name: 'set_description', payload: { ...envelope(BART), description: 'Ask about the tolerances' } } as CommandArgs,
        from: {},
        shown: (item: Item) => item.description,
        expected: 'Ask about the tolerances',
      },
      {
        situation: 'a next action, which is what the row reads',
        change: { name: 'set_next_action', payload: { ...envelope(BART), nextAction: 'Call Bart' } } as CommandArgs,
        from: {},
        shown: (item: Item) => itemLabel(item),
        expected: 'Call Bart',
      },
    ])('$situation', ({ change, from, shown, expected }) => {
      const copy = workspace([anItem(BART, from), anItem(LISA)]);

      const drawn = drawnAhead(copy, change);

      expect(shown(read(drawn, BART)!)).toEqual(expected);
      // The other Item and the copy the server sent are as they were.
      expect(read(drawn, LISA)).toEqual(read(copy, LISA));
      expect(shown(read(copy, BART)!)).not.toEqual(expected);
    });

    it('takes a dismissed Item out of the Workspace', () => {
      const copy = workspace([anItem(BART), anItem(LISA)]);

      const drawn = drawnAhead(copy, { name: 'set_dismissed', payload: { ...envelope(BART), dismissed: true } });

      expect(drawn.items.map((item) => item.id)).toEqual([LISA]);
      expect(copy.items).toHaveLength(2);
    });

    it.each([
      {
        situation: 'a change to an Item the copy does not hold',
        change: { name: 'set_priority', payload: { ...envelope('11111111-1111-7111-8111-000000000099'), priority: 'high' } } as CommandArgs,
      },
      {
        situation: 'a dismissal taken back, which has no copy of the Item to draw it from',
        change: { name: 'set_dismissed', payload: { ...envelope(BART), dismissed: false } } as CommandArgs,
      },
      {
        situation: 'a change the screen does not draw ahead',
        change: { name: 'rename_panel', payload: { ...envelope(BART), panelId: 'p-1', name: 'Today' } } as unknown as CommandArgs,
      },
    ])('leaves the copy as it is for $situation', ({ change }) => {
      const copy = workspace([anItem(BART)]);

      expect(drawnAhead(copy, change)).toBe(copy);
    });

    it('draws each of several changes over the one before, so the later one wins', () => {
      const copy = workspace([anItem(BART)]);

      const drawn = drawnOver(copy, [
        { name: 'set_priority', payload: { ...envelope(BART), priority: 'high' } },
        { name: 'set_title', payload: { ...envelope(BART), title: 'Reply to Bart' } },
        { name: 'set_priority', payload: { ...envelope(BART), priority: 'low' } },
      ]);

      expect(read(drawn, BART)).toMatchObject({ priority: 'low', title: 'Reply to Bart' });
    });
  });
});

const WORK = 'ws-work';
const FALCON = 'p-falcon';
const ANNA = 'p-anna';

/** A Workspace with these Items and filings, each filing as `[panel, item]` in the order the Panel holds them. */
const filedWorkspace = (items: Item[], filings: [string, string][], id = WORK): WorkspaceSnapshot =>
  ({
    workspace: { id },
    items,
    filings: filings.map(([panelId, itemId], position) => ({ panelId, itemId, position })),
    panels: [{ id: FALCON }, { id: ANNA }],
  }) as unknown as WorkspaceSnapshot;

const orderOn = (copy: WorkspaceSnapshot, panelId: string) =>
  copy.filings
    .filter((filing) => filing.panelId === panelId)
    .sort((a, b) => a.position - b.position)
    .map((filing) => filing.itemId);

const move = (panelId: string | null, order: string[], fromPanelIds?: string[]): CommandArgs => ({
  name: 'move_item_to_panel',
  payload: { ...envelope(BART), panelId, order, ...(fromPanelIds ? { fromPanelIds } : {}) },
});

describe('Panels', () => {
  describe('a filing shows the moment it is made, before the server has answered', () => {
    it.each([
      {
        situation: 'a move to a Panel takes the Item off the Panel it was on and puts it at the place in the order it carries',
        from: [[FALCON, BART], [ANNA, LISA]] as [string, string][],
        change: move(ANNA, [BART, LISA]),
        expected: { [FALCON]: [], [ANNA]: [BART, LISA] },
      },
      {
        situation: 'a move to the Inbox takes it off every Panel',
        from: [[FALCON, BART], [ANNA, BART]] as [string, string][],
        change: move(null, []),
        expected: { [FALCON]: [], [ANNA]: [] },
      },
      {
        situation: 'a move that names the Panel it leaves takes it off that one only',
        from: [[FALCON, BART], [ANNA, BART]] as [string, string][],
        change: move(FALCON, [BART], [ANNA]),
        expected: { [FALCON]: [BART], [ANNA]: [] },
      },
      {
        situation: 'an add leaves the Panels it is on alone',
        from: [[FALCON, BART]] as [string, string][],
        change: { name: 'add_item_to_panel', payload: { ...envelope(BART), panelId: ANNA, order: [BART] } } as CommandArgs,
        expected: { [FALCON]: [BART], [ANNA]: [BART] },
      },
      {
        situation: 'an add to a Panel it is on already is a reorder',
        from: [[FALCON, BART], [FALCON, LISA]] as [string, string][],
        change: { name: 'add_item_to_panel', payload: { ...envelope(BART), panelId: FALCON, order: [LISA, BART] } } as CommandArgs,
        expected: { [FALCON]: [LISA, BART], [ANNA]: [] },
      },
      {
        situation: 'a removal takes it off that Panel and no other',
        from: [[FALCON, BART], [ANNA, BART], [ANNA, LISA]] as [string, string][],
        change: { name: 'remove_item_from_panel', payload: { ...envelope(BART), panelId: ANNA } } as CommandArgs,
        expected: { [FALCON]: [BART], [ANNA]: [LISA] },
      },
    ])('$situation', ({ from, change, expected }) => {
      const copy = filedWorkspace([anItem(BART), anItem(LISA)], from);

      const drawn = drawnAhead(copy, change);

      for (const [panelId, order] of Object.entries(expected)) expect(orderOn(drawn, panelId)).toEqual(order);
      // The copy the server sent is as it was.
      expect(copy.filings).toHaveLength(from.length);
    });

    it('settles an Item that belonged to no Workspace in the Workspace it is filed in', () => {
      const copy = filedWorkspace([anItem(BART, { workspaceDecided: false })], []);

      const drawn = drawnAhead(copy, move(FALCON, [BART]));

      expect(read(drawn, BART)).toMatchObject({ workspaceDecided: true, workspaceId: WORK });
    });

    it.each([
      { situation: 'another Workspace’s copy', copy: filedWorkspace([anItem(BART)], [], 'ws-home') },
      { situation: 'a copy that does not hold the Item', copy: filedWorkspace([anItem(LISA)], []) },
    ])('leaves $situation as it is for a move', ({ copy }) => {
      expect(drawnAhead(copy, move(FALCON, [BART]))).toBe(copy);
    });

    it('draws a second filing over the first, so it is built on the Panel as the first left it', () => {
      const copy = filedWorkspace([anItem(BART), anItem(LISA)], []);

      const drawn = drawnOver(copy, [
        move(FALCON, [BART]),
        { name: 'move_item_to_panel', payload: { ...envelope(LISA), panelId: FALCON, order: [LISA, BART] } },
      ]);

      expect(orderOn(drawn, FALCON)).toEqual([LISA, BART]);
    });
  });
});