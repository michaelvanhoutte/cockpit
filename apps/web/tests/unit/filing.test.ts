import { describe, expect, it } from 'vitest';
import type { Filing, Item } from '@cockpit/shared';
import {
  filedOrderOnPanel,
  itemsInTheInbox,
  itemsOnPanel,
  orderWithItemAt,
} from '../../src/filing';

/**
 * F1: what a panel holds and what the Inbox holds are views over the snapshot
 * evaluated in the client, so this is the client's own logic and there is no
 * query to prove against a database. Which filings the server puts in the
 * snapshot at all - deleted panels' are left out - is proved against a real one
 * in apps/api/tests/integration/http/panel-items.test.ts.
 */

function anItem(id: string, completedAt: string | null = null): Item {
  return {
    id,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: id,
    capturedMessage: null,
    description: null,
    sourceResolvedAt: null,
    typeId: null,
    nextAction: null,
    completedAt,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

/**
 * A dismissed item is not here at all: the workspace leaves it out before the
 * browser sees it, so being finished with one is the only thing these two
 * derivations have to decide about ("An item is either yours to deal with or
 * finished with", issue 154).
 */
const FINISHED = '2026-08-31T09:00:00.000Z';

function filed(panelId: string, itemId: string, position: number): Filing {
  return { panelId, itemId, position };
}

describe('Panels', () => {
  describe('a panel draws exactly the items filed on it, in the order they were filed into', () => {
    it('draws them by position, not by the order the filings arrived in', () => {
      const items = [anItem('a'), anItem('b'), anItem('c')];
      const filings = [filed('falcon', 'c', 2), filed('falcon', 'a', 0), filed('falcon', 'b', 1)];

      expect(itemsOnPanel(items, filings, 'falcon').map((item) => item.id)).toEqual(['a', 'b', 'c']);
    });

    it('draws an item filed on two panels on both of them', () => {
      const items = [anItem('a')];
      const filings = [filed('falcon', 'a', 0), filed('anna', 'a', 0)];

      expect(itemsOnPanel(items, filings, 'falcon').map((i) => i.id)).toEqual(['a']);
      expect(itemsOnPanel(items, filings, 'anna').map((i) => i.id)).toEqual(['a']);
    });

    it('leaves an item that has been finished with off the panel it was filed on', () => {
      const filings = [filed('falcon', 'a', 0), filed('falcon', 'b', 1)];

      expect(
        itemsOnPanel([anItem('a', FINISHED), anItem('b')], filings, 'falcon').map((i) => i.id),
      ).toEqual(['b']);
    });

    it('closes the gap rather than drawing a hole when a filing names an item that has gone', () => {
      // An item dismissed in another tab leaves the snapshot while its filing
      // is still on the panel.
      const filings = [filed('falcon', 'a', 0), filed('falcon', 'gone', 1), filed('falcon', 'b', 2)];

      expect(itemsOnPanel([anItem('a'), anItem('b')], filings, 'falcon').map((i) => i.id)).toEqual([
        'a',
        'b',
      ]);
    });

    it('draws an empty panel as empty', () => {
      expect(itemsOnPanel([anItem('a')], [filed('anna', 'a', 0)], 'falcon')).toEqual([]);
    });
  });

  describe('the Inbox holds every item you still have to deal with that is filed nowhere', () => {
    it.each([
      { situation: 'filed on a panel', filings: [filed('falcon', 'a', 0)], inTheInbox: false },
      { situation: 'filed nowhere', filings: [], inTheInbox: true },
      {
        situation: 'filed only on a panel that is no longer in the snapshot',
        filings: [filed('anna', 'somebody else', 0)],
        inTheInbox: true,
      },
    ])('$situation', ({ filings, inTheInbox }) => {
      const inbox = itemsInTheInbox([anItem('a')], filings).map((item) => item.id);

      expect(inbox.includes('a')).toBe(inTheInbox);
    });

    it('leaves out an item that has been finished with', () => {
      expect(itemsInTheInbox([anItem('a', FINISHED), anItem('b')], []).map((i) => i.id)).toEqual([
        'b',
      ]);
    });
  });

  describe('a move carries the panel’s whole order, with the item in the place it was put', () => {
    it.each([
      { situation: 'at the top', held: ['a', 'b'], at: 0, order: ['moved', 'a', 'b'] },
      { situation: 'between two', held: ['a', 'b'], at: 1, order: ['a', 'moved', 'b'] },
      { situation: 'at the end', held: ['a', 'b'], at: 2, order: ['a', 'b', 'moved'] },
      { situation: 'onto an empty panel', held: [], at: 0, order: ['moved'] },
      {
        situation: 'past the end of a list that has since shrunk',
        held: ['a'],
        at: 9,
        order: ['a', 'moved'],
      },
      { situation: 'before the start', held: ['a'], at: -3, order: ['moved', 'a'] },
    ])('$situation', ({ held: heldIds, at, order }) => {
      expect(orderWithItemAt(heldIds, 'moved', at)).toEqual(order);
    });

    it('names an item once when it is moved within the panel it is already on', () => {
      expect(orderWithItemAt(['a', 'moved', 'b'], 'moved', 2)).toEqual(['a', 'b', 'moved']);
    });

    it('names the items the panel holds but does not draw, so the move is not refused', () => {
      // A filing outlives its item being finished or dismissed, and the panel
      // is still holding it. An order built from what is drawn would leave it
      // out, and every move onto that panel would be refused from then on.
      const filings = [filed('falcon', 'finished', 0), filed('falcon', 'b', 1)];

      expect(filedOrderOnPanel(filings, 'falcon')).toEqual(['finished', 'b']);
      expect(orderWithItemAt(filedOrderOnPanel(filings, 'falcon'), 'moved', 0)).toEqual([
        'moved',
        'finished',
        'b',
      ]);
    });

    it('reads only the panel being moved to', () => {
      const filings = [filed('falcon', 'a', 0), filed('anna', 'b', 0)];

      expect(filedOrderOnPanel(filings, 'falcon')).toEqual(['a']);
    });
  });
});
