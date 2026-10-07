import { describe, expect, it } from 'vitest';
import { forgetPanelListWidth } from '../../src/panelList';
import {
  PANEL_LIST_WIDTH_FLOOR,
  clampPanelListWidth,
  readPanelListWidth,
  writePanelListWidth,
} from '../../src/panelListWidth';

/**
 * F1, and pure: how wide Go to panel may be dragged and what is remembered of
 * it are decisions over numbers and a storage handed in. That the edge, the
 * drag and the double-click land on these numbers is
 * tests/unit/components/PanelList.test.tsx.
 */
function aStore(): Storage {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
    clear: () => held.clear(),
    key: () => null,
    get length() {
      return held.size;
    },
  };
}

describe('Dashboards', () => {
  describe('the Go to panel width stays between 224px and a third of the row', () => {
    it.each([
      { situation: 'a width inside the bounds', preferred: 300, rowWidth: 1200, clamped: 300 },
      { situation: 'narrower than 224', preferred: 100, rowWidth: 1200, clamped: PANEL_LIST_WIDTH_FLOOR },
      { situation: 'wider than a third of the row', preferred: 900, rowWidth: 1200, clamped: 400 },
      { situation: 'a row so narrow a third is under 224', preferred: 500, rowWidth: 600, clamped: PANEL_LIST_WIDTH_FLOOR },
    ])('$situation', ({ preferred, rowWidth, clamped }) => {
      expect(clampPanelListWidth(preferred, rowWidth)).toBe(clamped);
    });
  });

  describe('the Go to panel width is remembered in this browser and forgotten at sign-out', () => {
    it('is read back after being written, and cleared by sign-out', () => {
      const store = aStore();
      expect(readPanelListWidth(store)).toBeNull();
      writePanelListWidth(store, 360);
      expect(readPanelListWidth(store)).toBe(360);

      forgetPanelListWidth(store);

      expect(readPanelListWidth(store)).toBeNull();
    });

    it.each([
      { situation: 'not a number', raw: 'wide' },
      { situation: 'zero', raw: '0' },
      { situation: 'negative', raw: '-40' },
    ])('ignores a stored width that is $situation', ({ raw }) => {
      const store = aStore();
      store.setItem('cockpit.panel-list-width', raw);
      expect(readPanelListWidth(store)).toBeNull();
    });

    it('throws nothing where the browser refuses storage', () => {
      const refuse = () => {
        throw new Error('refused');
      };
      const refusing = { getItem: refuse, setItem: refuse, removeItem: refuse } as unknown as Storage;
      expect(() => writePanelListWidth(refusing, 300)).not.toThrow();
      expect(() => forgetPanelListWidth(refusing)).not.toThrow();
      expect(readPanelListWidth(refusing)).toBeNull();
      expect(readPanelListWidth(undefined)).toBeNull();
    });
  });
});
