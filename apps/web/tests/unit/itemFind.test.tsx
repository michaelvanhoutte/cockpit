import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { findItems, type Item, type WorkspaceSnapshot } from '@cockpit/shared';
import { useFindIndex } from '../../src/itemFind';

/**
 * F1: the index is built once per snapshot, not per keystroke. The matching
 * itself is packages/shared/tests/unit/domain/item-find.test.ts.
 */
function anItem(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    description: null,
    nextAction: null,
    sender: null,
    completedAt: null,
    updatedAt: '2026-08-31T08:00:00.000Z',
    ...over,
  } as Item;
}

function aSnapshot(items: Item[]): WorkspaceSnapshot {
  return { items, dashboards: [], panels: [], filings: [], agentRuns: [] } as unknown as WorkspaceSnapshot;
}

describe('Dashboards', () => {
  describe('each Item’s search text is built once per snapshot, not per keystroke', () => {
    it('derives it once for five letters, and again for a replaced snapshot where an edit now matches', () => {
      let reads = 0;
      const counted = anItem('a');
      Object.defineProperty(counted, 'description', {
        get: () => {
          reads += 1;
          return 'Pay the rent';
        },
      });
      const first = aSnapshot([counted]);
      const { result, rerender } = renderHook(({ snapshot }) => useFindIndex(snapshot, '2026-09-01'), {
        initialProps: { snapshot: first },
      });
      for (const typed of ['r', 're', 'ren', 'rent', 'rent ']) findItems(result.current, typed, 2, 'today');
      rerender({ snapshot: first });
      expect(reads).toBe(1);

      const edited = aSnapshot([anItem('a', { title: 'Pay the VAT' })]);
      rerender({ snapshot: edited });
      expect(findItems(result.current, 'vat', 2, 'today').rows).toHaveLength(1);
      expect(findItems(result.current, 'rent', 2, 'today').rows).toHaveLength(0);
    });
  });
});
