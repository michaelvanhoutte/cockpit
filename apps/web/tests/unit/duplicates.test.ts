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
  describe('until an item is filed its duplicates are everything else in the workspace, and a filed item is nothing\'s duplicate yet', () => {
    it.each([
      { situation: 'both are in the inbox', filings: [], marked: true },
      { situation: 'one of them is filed', filings: [filedOn(THE_OTHER.id)], marked: false },
    ])('$situation', ({ filings, marked }) => {
      const flagged = itemsThatMayBeDuplicates(ITEMS, filings, PAIRED);
      for (const item of ITEMS) {
        expect(flagged.has(item.id)).toBe(marked);
      }
    });

    it('marks them again once the filed one is back in the inbox', () => {
      expect(itemsThatMayBeDuplicates(ITEMS, [filedOn(THE_OTHER.id)], PAIRED).has(ONE.id)).toBe(
        false,
      );

      expect(itemsThatMayBeDuplicates(ITEMS, [], PAIRED).has(ONE.id)).toBe(true);
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
        marked: true,
      },
      {
        situation: 'both filed on the same panel',
        filings: [filedOn(ONE.id, 'pn-1'), filedOn(THE_OTHER.id, 'pn-1')],
        marked: true,
      },
      {
        situation: 'one filed one in inbox',
        filings: [filedOn(ONE.id)],
        marked: false,
      },
    ])('$situation: pair marked $marked', ({ filings, marked }) => {
      const flagged = itemsThatMayBeDuplicates(ITEMS, filings, PAIRED);
      for (const item of ITEMS) {
        expect(flagged.has(item.id)).toBe(marked);
      }
    });

    it('returns the filed duplicates from possibleDuplicatesOf', () => {
      const filings = [filedOn(ONE.id, 'pn-1'), filedOn(THE_OTHER.id, 'pn-2')];
      expect(possibleDuplicatesOf(ONE.id, ITEMS, filings, PAIRED)).toEqual([THE_OTHER]);
      expect(possibleDuplicatesOf(THE_OTHER.id, ITEMS, filings, PAIRED)).toEqual([ONE]);
    });

    it('names nothing when one filed item is paired with an inbox item', () => {
      const filings = [filedOn(ONE.id, 'pn-1')];
      expect(possibleDuplicatesOf(ONE.id, ITEMS, filings, PAIRED)).toEqual([]);
      expect(possibleDuplicatesOf(THE_OTHER.id, ITEMS, filings, PAIRED)).toEqual([]);
    });

    it('brings back the mark when a filed item is moved back to the inbox', () => {
      const filings = [filedOn(ONE.id, 'pn-1'), filedOn(THE_OTHER.id, 'pn-1')];
      expect(itemsThatMayBeDuplicates(ITEMS, filings, PAIRED).has(ONE.id)).toBe(true);

      // Move THE_OTHER back to inbox
      expect(itemsThatMayBeDuplicates(ITEMS, [filedOn(ONE.id, 'pn-1')], PAIRED).has(ONE.id)).toBe(
        false,
      );

      // Move ONE back to inbox
      expect(itemsThatMayBeDuplicates(ITEMS, [], PAIRED).has(ONE.id)).toBe(true);
    });
  });
});
