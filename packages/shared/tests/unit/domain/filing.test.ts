import { describe, expect, it } from 'vitest';
import type { Filing, Item } from '../../../src/index.js';
import { itemsInTheInbox, itemsOnPanel, itemsThatAreFiled } from '../../../src/index.js';

/**
 * L1: what a panel holds and what the Inbox holds are views over the snapshot,
 * shared by the browser and the MCP find_items tool, so this is pure logic with
 * no query to prove against a database. Which filings the server puts in the
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
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    proposedPanelFit: null,
    claudeProposals: null,
    sourceResolvedAt: null,
    nextAction: null,
    completedAt,
    startedAt: null,
    priority: null,
    prioritySetAt: null,
    dueDateChosenAt: null,
    capturedTimeZone: null,
    dueDate: null,
    dueDateSetAt: null,
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

  /**
   * The complement of `itemsInTheInbox`, built the same direct way rather than
   * by inverting that function's own result ("Flag a duplicate between two
   * cards on dashboards", issue 410) - so it is proved the same way, at the
   * same level, with the same cases turned around.
   */
  describe('everything still to deal with that is filed somewhere', () => {
    it.each([
      { situation: 'filed on a panel', filings: [filed('falcon', 'a', 0)], filed: true },
      { situation: 'filed nowhere', filings: [], filed: false },
      {
        situation: 'filed only on a panel that is no longer in the snapshot',
        filings: [filed('anna', 'somebody else', 0)],
        filed: false,
      },
    ])('$situation', ({ filings, filed: isFiled }) => {
      expect(itemsThatAreFiled([anItem('a')], filings).map((item) => item.id).includes('a')).toBe(
        isFiled,
      );
    });

    it('leaves out an item that has been finished with, even though it is still filed', () => {
      const filings = [filed('falcon', 'a', 0), filed('falcon', 'b', 1)];

      expect(
        itemsThatAreFiled([anItem('a', FINISHED), anItem('b')], filings).map((i) => i.id),
      ).toEqual(['b']);
    });
  });
});
