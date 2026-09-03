import { describe, expect, it } from 'vitest';
import type { Filing, MoveItemToPanelCommand } from '@cockpit/shared';
import { filingRows, orderIsNotOfThePanel } from '../../../src/domain/filings.js';

/**
 * Unit level: both are pure decisions about a list, with no store in them. What
 * scope they are applied in, and what ends up written, is
 * apps/api/tests/integration/http/panel-items.test.ts.
 */

const AT = '2026-09-01T10:00:00.000Z';

function moving(
  itemId: string,
  panelId: string | null,
  order: string[],
): MoveItemToPanelCommand {
  return {
    commandId: '018f0000-0000-7000-8000-000000000001',
    issuedAt: AT,
    workspaceId: 'ws-work',
    itemId,
    panelId,
    order,
  };
}

function held(panelId: string, itemIds: string[]): Filing[] {
  return itemIds.map((itemId, position) => ({ panelId, itemId, position }));
}

describe('Panels', () => {
  describe('a panel keeps its items in the order the last move put them in', () => {
    it('numbers them from the front, in the order the move named them', () => {
      expect(filingRows('tenant-default', moving('b', 'falcon', ['a', 'b', 'c']))).toEqual([
        { tenantId: 'tenant-default', panelId: 'falcon', itemId: 'a', position: 0, createdAt: AT },
        { tenantId: 'tenant-default', panelId: 'falcon', itemId: 'b', position: 1, createdAt: AT },
        { tenantId: 'tenant-default', panelId: 'falcon', itemId: 'c', position: 2, createdAt: AT },
      ]);
    });

    it('files nothing when the item is going back to the Inbox, which has no order', () => {
      expect(filingRows('tenant-default', moving('b', null, []))).toEqual([]);
    });
  });

  describe('an order that is not the panel’s arrangement is refused', () => {
    it.each([
      {
        situation: 'the panel’s items with the arriving one among them',
        onThePanel: ['a', 'c'],
        order: ['a', 'b', 'c'],
        refused: false,
      },
      {
        situation: 'an empty panel taking its first item',
        onThePanel: [],
        order: ['b'],
        refused: false,
      },
      {
        situation: 'a reorder of a panel the item is already on',
        onThePanel: ['a', 'b', 'c'],
        order: ['b', 'a', 'c'],
        refused: false,
      },
      {
        situation: 'an order leaving out an item the panel holds',
        onThePanel: ['a', 'c'],
        order: ['a', 'b'],
        refused: true,
      },
      {
        situation: 'an order naming an item that is not on the panel',
        onThePanel: ['a'],
        order: ['a', 'b', 'somebody else’s'],
        refused: true,
      },
      {
        situation: 'an order of a panel the item has just been moved off',
        onThePanel: ['a', 'b'],
        order: ['a'],
        refused: true,
      },
    ])('$situation', ({ onThePanel, order, refused }) => {
      const why = orderIsNotOfThePanel(held('falcon', onThePanel), moving('b', 'falcon', order));

      expect(why === null).toBe(!refused);
    });

    it('asks nothing of a move to the Inbox, which is not a panel and has no order', () => {
      expect(orderIsNotOfThePanel(held('falcon', ['a', 'b']), moving('b', null, []))).toBeNull();
    });
  });
});
