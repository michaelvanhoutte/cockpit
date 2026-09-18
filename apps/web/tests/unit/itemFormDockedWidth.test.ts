import { describe, expect, it } from 'vitest';
import {
  ITEM_FORM_DOCKED_WIDTH_FLOOR,
  clampItemFormDockedWidth,
  itemFormDockedWidthCeiling,
  readItemFormDockedWidth,
  writeItemFormDockedWidth,
} from '../../src/itemFormDockedWidth';

/**
 * F1, and pure: how wide the docked item's form may be dragged, and what is
 * remembered of it, are both decisions over numbers and a storage handed in
 * rather than reached for - the same shape `inboxWidth.test.ts` takes, and for
 * the same reason ("Let the item's form dock to the side of the screen
 * instead of opening as a dialog", issue 481).
 */
describe('Item editing', () => {
  describe('a dragged docked width is brought inside a floor and the window’s own ceiling', () => {
    it.each([
      { situation: 'within the range already', preferred: 500, windowWidth: 1280, clamped: 500 },
      { situation: 'below the floor', preferred: 40, windowWidth: 1280, clamped: ITEM_FORM_DOCKED_WIDTH_FLOOR },
      {
        situation: 'past half the window',
        preferred: 900,
        windowWidth: 1280,
        clamped: 640,
      },
      {
        situation: 'a window too narrow for the floor to be half of',
        preferred: 900,
        windowWidth: 400,
        clamped: ITEM_FORM_DOCKED_WIDTH_FLOOR,
      },
    ])('$situation', ({ preferred, windowWidth, clamped }) => {
      expect(clampItemFormDockedWidth(preferred, windowWidth)).toBe(clamped);
    });

    it('never answers a ceiling narrower than the floor, however narrow the window', () => {
      expect(itemFormDockedWidthCeiling(0)).toBe(ITEM_FORM_DOCKED_WIDTH_FLOOR);
    });

    it('answers the original preference again once the window is wide enough to hold it', () => {
      // A window narrowed after a wide choice must not overwrite the choice -
      // only clamp what is drawn from it (ItemForm.tsx). The same call, at the
      // window width the choice was made at, is what proves nothing was lost.
      const preferred = 900;
      expect(clampItemFormDockedWidth(preferred, 1600)).toBe(800);
      expect(clampItemFormDockedWidth(preferred, 2000)).toBe(900);
    });
  });

  describe('a chosen docked width is remembered across a reload, or falls back to the default width', () => {
    /** A browser's storage, without a browser. */
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

    it('gives back what was written', () => {
      const store = aStore();

      writeItemFormDockedWidth(store, 520);

      expect(readItemFormDockedWidth(store)).toBe(520);
    });

    it('answers nothing chosen for a value nothing here ever wrote', () => {
      const store = aStore();
      store.setItem('cockpit.item-form-docked-width', 'not-a-number');

      expect(readItemFormDockedWidth(store)).toBeNull();
    });

    it.each([undefined, ''])('answers nothing chosen for %j', (raw) => {
      expect(readItemFormDockedWidth(undefined)).toBeNull();
      const store = aStore();
      if (raw !== undefined) store.setItem('cockpit.item-form-docked-width', raw);
      expect(readItemFormDockedWidth(store)).toBeNull();
    });

    it('remembers nothing, rather than failing, where there is nowhere to remember it', () => {
      // A private window, or a browser set to refuse storage - the resize
      // still works for the session, per lastVisited.ts's own rule for the
      // same shape of failure.
      const refuses: Storage = {
        ...aStore(),
        getItem: () => {
          throw new Error('storage is not available');
        },
        setItem: () => {
          throw new Error('storage is not available');
        },
      };

      expect(() => writeItemFormDockedWidth(refuses, 520)).not.toThrow();
      expect(readItemFormDockedWidth(refuses)).toBeNull();
      expect(readItemFormDockedWidth(undefined)).toBeNull();
    });
  });
});
