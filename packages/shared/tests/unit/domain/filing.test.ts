import { describe, expect, it } from 'vitest';
import { itemsInTheInbox, itemsThatAreFiled, type Filing, type Item } from '../../../src/index.js';

/**
 * L1: what the Inbox holds and what is filed somewhere are views over a
 * Workspace's items and filings, so this is pure logic with no query to prove
 * against a database. Moved here with every assertion kept, now that the Worker
 * answers a connected app's ind_items from the same rule (issue 1240).
 * Which filings the server puts in the snapshot at all - deleted panels' are
 * left out - is proved against a real one in
 * apps/api/tests/integration/http/panel-items.test.ts.
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

