import { describe, expect, it } from 'vitest';
import { forgetEveryScheduledTab, readScheduledTab, writeScheduledTab } from '../../src/scheduledTab';

/**
 * F1, and pure: what is remembered of whether a workspace shows its Scheduled
 * tab is read off and written to a store handed in, the split
 * `allItemsTab.test.ts` makes for All items. That the bar draws the tab from it
 * is tests/unit/components/DashboardBar.test.tsx.
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
  describe('the choice to show Scheduled is remembered per workspace in this browser', () => {
    it('reads back what was written, off where nothing was, and per workspace', () => {
      const store = aStore();
      expect(readScheduledTab(store, 'ws-a')).toBe(false);
      writeScheduledTab(store, 'ws-a', true);
      expect(readScheduledTab(store, 'ws-a')).toBe(true);
      expect(readScheduledTab(store, 'ws-b')).toBe(false);
      writeScheduledTab(store, 'ws-a', false);
      expect(readScheduledTab(store, 'ws-a')).toBe(false);
    });

    it('is forgotten for every workspace, and nothing else is', () => {
      const store = aStore();
      writeScheduledTab(store, 'ws-a', true);
      writeScheduledTab(store, 'ws-b', true);
      store.setItem('cockpit.all-items-tab.ws-a', '1');

      forgetEveryScheduledTab(store);

      expect([readScheduledTab(store, 'ws-a'), readScheduledTab(store, 'ws-b')]).toEqual([false, false]);
      expect(store.getItem('cockpit.all-items-tab.ws-a')).toBe('1');
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
      expect(() => writeScheduledTab(refusing, 'ws-a', true)).not.toThrow();
      expect(() => forgetEveryScheduledTab(refusing)).not.toThrow();
      expect(readScheduledTab(refusing, 'ws-a')).toBe(false);
      expect(readScheduledTab(undefined, 'ws-a')).toBe(false);
    });
  });
});
