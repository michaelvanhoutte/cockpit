import { describe, expect, it } from 'vitest';
import type { Filing, Item, PossibleDuplicate } from '@cockpit/shared';
import { itemsThatMayBeDuplicates, possibleDuplicatesOf } from '../../src/duplicates';

/**
 * F1: a drawing rule over the snapshot, so no database is needed to ask it.
 * Which pairs the snapshot carries at all is the server's answer, proved
 * against a real store in
 * apps/api/tests/integration/http/duplicate-notes.test.ts; what is decided here
 * is the one thing left - that filing an item takes the mark off both halves,
 * and putting it back brings it back.
 */

function anItem(id: string): Item {
  return {
    id,
    tenantId: 'tenant-default',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: `Note ${id}`,
    capturedMessage: null,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    sourceResolvedAt: null,
    typeId: null,
    nextAction: null,
    completedAt: null,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:00:00.000Z',
  };
}

const ONE = anItem('item-one');
const THE_OTHER = anItem('item-other');
const ITEMS = [ONE, THE_OTHER];
const PAIRED: PossibleDuplicate[] = [{ itemId: ONE.id, otherItemId: THE_OTHER.id }];

function filedOn(itemId: string, panelId = 'pn-1'): Filing {
  return { panelId, itemId, position: 0 };
}

describe('Triage', () => {
  describe('an item in the inbox is marked for a pair whatever the other half\'s own state is', () => {
    it.each([
      { situation: 'both are in the inbox', filings: [] },
      { situation: 'the other one is filed', filings: [filedOn(THE_OTHER.id)] },
    ])('marks $situation', ({ filings }) => {
      expect(itemsThatMayBeDuplicates(ITEMS, filings, PAIRED).has(ONE.id)).toBe(true);
    });

    it('names the other one, from either of the two', () => {
      expect(possibleDuplicatesOf(ONE.id, ITEMS, [], PAIRED)).toEqual([THE_OTHER]);
      expect(possibleDuplicatesOf(THE_OTHER.id, ITEMS, [], PAIRED)).toEqual([ONE]);
    });

    /**
     * An item finished with is out of the Inbox without being filed, and one
     * the snapshot no longer carries at all is gone - neither is something to
     * offer, and neither is a reason to stop drawing the other rows.
     */
    it.each([
      {
        situation: 'the other one is finished with',
        items: [ONE, { ...THE_OTHER, completedAt: '2026-08-12T12:00:00.000Z' }],
      },
      { situation: 'the other one is not in this snapshot at all', items: [ONE] },
    ])('offers nothing when $situation', ({ items }) => {
      expect(possibleDuplicatesOf(ONE.id, items, [], PAIRED)).toEqual([]);
      expect(itemsThatMayBeDuplicates(items, [], PAIRED).has(ONE.id)).toBe(false);
    });

    it('offers nothing where nothing was paired', () => {
      expect(possibleDuplicatesOf(ONE.id, ITEMS, [], [])).toEqual([]);
    });
  });

  describe('a filed item flags another filed item the same way an inbox item does', () => {
    it.each([
      {
        situation: 'both filed on different panels',
        filings: [filedOn(ONE.id, 'pn-1'), filedOn(THE_OTHER.id, 'pn-2')],
      },
      {
        situation: 'both filed on the same panel',
        filings: [filedOn(ONE.id, 'pn-1'), filedOn(THE_OTHER.id, 'pn-1')],
      },
    ])('marks both, $situation', ({ filings }) => {
      const flagged = itemsThatMayBeDuplicates(ITEMS, filings, PAIRED);
      expect(flagged.has(ONE.id)).toBe(true);
      expect(flagged.has(THE_OTHER.id)).toBe(true);
    });

    it('returns the filed duplicates from possibleDuplicatesOf', () => {
      const filings = [filedOn(ONE.id, 'pn-1'), filedOn(THE_OTHER.id, 'pn-2')];
      expect(possibleDuplicatesOf(ONE.id, ITEMS, filings, PAIRED)).toEqual([THE_OTHER]);
      expect(possibleDuplicatesOf(THE_OTHER.id, ITEMS, filings, PAIRED)).toEqual([ONE]);
    });

    /**
     * The rule is not symmetric ("Flag a duplicate between two cards on
     * dashboards", issue 410): the still-Inbox half is still waiting to be
     * triaged, so it goes on being told - it is only the *filed* card that
     * goes quiet, because it has settled onto a Panel and a still-untriaged
     * note is not the company its own screen means to show.
     */
    it('marks only the one still in the Inbox, where the other has been filed', () => {
      const filings = [filedOn(ONE.id, 'pn-1')];
      const flagged = itemsThatMayBeDuplicates(ITEMS, filings, PAIRED);
      expect(flagged.has(ONE.id)).toBe(false);
      expect(flagged.has(THE_OTHER.id)).toBe(true);

      expect(possibleDuplicatesOf(ONE.id, ITEMS, filings, PAIRED)).toEqual([]);
      expect(possibleDuplicatesOf(THE_OTHER.id, ITEMS, filings, PAIRED)).toEqual([ONE]);
    });

    it('drops the card\'s mark, and keeps the Inbox row\'s, the moment one of a filed pair moves back to the Inbox', () => {
      const filings = [filedOn(ONE.id, 'pn-1'), filedOn(THE_OTHER.id, 'pn-1')];
      expect(itemsThatMayBeDuplicates(ITEMS, filings, PAIRED).has(ONE.id)).toBe(true);

      // THE_OTHER moves back to the Inbox: ONE is now filed against an Inbox
      // Item, so its own card goes quiet - THE_OTHER's Inbox row does not.
      const afterMove = itemsThatMayBeDuplicates(ITEMS, [filedOn(ONE.id, 'pn-1')], PAIRED);
      expect(afterMove.has(ONE.id)).toBe(false);
      expect(afterMove.has(THE_OTHER.id)).toBe(true);
    });

    it('marks both again once both are back in the Inbox', () => {
      expect(itemsThatMayBeDuplicates(ITEMS, [], PAIRED).has(ONE.id)).toBe(true);
      expect(itemsThatMayBeDuplicates(ITEMS, [], PAIRED).has(THE_OTHER.id)).toBe(true);
    });
  });
});
