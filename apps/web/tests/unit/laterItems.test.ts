import { describe, expect, it } from 'vitest';
import { forgetEveryLaterShown, readLaterShown, writeLaterShown } from '../../src/laterItems';

/**
 * F1, and pure: what is remembered of whether a Panel shows its later Items is
 * read off and written to a store handed in, the split `allItemsTab.test.ts`
 * makes. That the board draws from it is tests/unit/components/PanelBoard.test.tsx.
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

describe('Panels', () => {
  describe('the choice to show a Panel’s later Items is remembered per Panel in this browser', () => {
    it('is hidden by default, shown once chosen, and per Panel', () => {
      const store = aStore();
      expect(readLaterShown(store, 'tasks')).toBe(false);
      writeLaterShown(store, 'tasks', true);
      expect(readLaterShown(store, 'tasks')).toBe(true);
      expect(readLaterShown(store, 'reading')).toBe(false);
      writeLaterShown(store, 'tasks', false);
      expect(readLaterShown(store, 'tasks')).toBe(false);
    });

    it('is still shown when read again from the same store, as after a reload', () => {
      const store = aStore();
      writeLaterShown(store, 'tasks', true);
      expect(readLaterShown(store, 'tasks')).toBe(true);
    });

    it('is forgotten for every Panel at sign-out, and nothing else is', () => {
      const store = aStore();
      writeLaterShown(store, 'tasks', true);
      writeLaterShown(store, 'reading', true);
      store.setItem('cockpit.agent-dock-hidden', '1');

      forgetEveryLaterShown(store);

      expect([readLaterShown(store, 'tasks'), readLaterShown(store, 'reading')]).toEqual([false, false]);
      expect(store.getItem('cockpit.agent-dock-hidden')).toBe('1');
    });

    it('is hidden, and throws nothing, where the browser refuses storage', () => {
      const refuse = () => {
        throw new Error('refused');
      };
      const refusing = { length: 1, key: refuse, getItem: refuse, setItem: refuse, removeItem: refuse } as unknown as Storage;
      expect(() => writeLaterShown(refusing, 'tasks', true)).not.toThrow();
      expect(() => forgetEveryLaterShown(refusing)).not.toThrow();
      expect(readLaterShown(refusing, 'tasks')).toBe(false);
    });
  });
});
