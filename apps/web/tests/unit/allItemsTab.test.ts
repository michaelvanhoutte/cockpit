import { describe, expect, it } from 'vitest';
import { forgetEveryAllItemsTab, readAllItemsTab, writeAllItemsTab } from '../../src/allItemsTab';

/**
 * F1, and pure: what is remembered of whether a workspace shows its All items
 * tab is read off and written to a store handed in, the split
 * `agentDockHidden.test.ts` makes for the dock. That the bar draws the tab from
 * it is tests/unit/components/DashboardBar.test.tsx.
 */
function aStore(): Storage {
  const held = new Map<string, string>();
  return {
    get length() {
      return held.size;
    },
    key: (i: number) => [...held.keys()][i] ?? null,
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
  } as Storage;
}

describe('Dashboards', () => {
  describe('the choice to show All items is remembered per workspace in this browser', () => {
    it('reads back what was written, off where nothing was, and per workspace', () => {
      const store = aStore();
      expect(readAllItemsTab(store, 'ws-a')).toBe(false);
      writeAllItemsTab(store, 'ws-a', true);
      expect(readAllItemsTab(store, 'ws-a')).toBe(true);
      expect(readAllItemsTab(store, 'ws-b')).toBe(false);
      writeAllItemsTab(store, 'ws-a', false);
      expect(readAllItemsTab(store, 'ws-a')).toBe(false);
    });

    it('is forgotten for every workspace, and nothing else is', () => {
      const store = aStore();
      writeAllItemsTab(store, 'ws-a', true);
      writeAllItemsTab(store, 'ws-b', true);
      store.setItem('cockpit.agent-dock-hidden', '1');

      forgetEveryAllItemsTab(store);

      expect([readAllItemsTab(store, 'ws-a'), readAllItemsTab(store, 'ws-b')]).toEqual([false, false]);
      expect(store.getItem('cockpit.agent-dock-hidden')).toBe('1');
    });

    it('is off, and throws nothing, where the browser refuses storage', () => {
      const refuse = () => {
        throw new Error('refused');
      };
      const refusing = {
        length: 1,
        key: refuse,
        getItem: refuse,
        setItem: refuse,
        removeItem: refuse,
      } as unknown as Storage;
      expect(() => writeAllItemsTab(refusing, 'ws-a', true)).not.toThrow();
      expect(() => forgetEveryAllItemsTab(refusing)).not.toThrow();
      expect(readAllItemsTab(refusing, 'ws-a')).toBe(false);
      expect(readAllItemsTab(undefined, 'ws-a')).toBe(false);
    });
  });
});
