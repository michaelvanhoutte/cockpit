import { describe, expect, it } from 'vitest';
import {
  INBOX_WIDTH_FLOOR,
  clampInboxWidth,
  inboxWidthCeiling,
  readInboxWidth,
  writeInboxWidth,
} from '../../src/inboxWidth';

/**
 * F1, and pure: how wide the Inbox column may be dragged, and what is
 * remembered of it, are both decisions over numbers and a storage handed in
 * rather than reached for - exactly the shape `lastVisited.ts`'s own tests
 * take, and for the same reason. That a real drag lands on these numbers is
 * not walked in a browser any more - the walk that did failed at random under
 * CI load and was deleted; that the column and the automatic sizing it falls
 * back to actually render is tests/unit/router.test.tsx.
 */
describe('Triage', () => {
  describe('a dragged width is brought inside a floor and the row’s own ceiling', () => {
    it.each([
      { situation: 'within the range already', preferred: 320, rowWidth: 1280, clamped: 320 },
      { situation: 'below the floor', preferred: 40, rowWidth: 1280, clamped: INBOX_WIDTH_FLOOR },
      {
        situation: 'past half the row - the ceiling this issue raises the fixed 420px cap to',
        preferred: 900,
        rowWidth: 1280,
        clamped: 632,
      },
      {
        situation: 'a row too narrow for the floor to be half of',
        preferred: 900,
        rowWidth: 400,
        clamped: INBOX_WIDTH_FLOOR,
      },
    ])('$situation', ({ preferred, rowWidth, clamped }) => {
      expect(clampInboxWidth(preferred, rowWidth)).toBe(clamped);
    });

    it('never answers a ceiling narrower than the floor, however narrow the row', () => {
      expect(inboxWidthCeiling(0)).toBe(INBOX_WIDTH_FLOOR);
    });

    it.each([768, 1280, 3000])(
      'leaves the dashboard at least as much of a %ipx row as the Inbox just took',
      (rowWidth) => {
        // The ceiling is half of what is left once the handle and the two
        // seams either side of it (Layout.tsx's own `<main>`) have their
        // share - not half of the row itself, which would hand the Inbox the
        // exact middle and leave the dashboard those pixels short. Checked
        // only where the row is wide enough that the floor isn't what is
        // actually deciding the ceiling - below that the floor wins on
        // purpose, an unreadable Inbox being the worse of the two failures.
        const HANDLE_AND_SEAMS = 16;
        const ceiling = inboxWidthCeiling(rowWidth);
        expect(ceiling * 2 + HANDLE_AND_SEAMS).toBeLessThanOrEqual(rowWidth);
      },
    );

    it('answers the original preference again once the row is wide enough to hold it', () => {
      // A window narrowed after a wide choice must not overwrite the choice -
      // only clamp what is drawn from it (Layout.tsx). The same call, at the
      // row width the choice was made at, is what proves nothing was lost.
      const preferred = 900;
      expect(clampInboxWidth(preferred, 1200)).toBe(592);
      expect(clampInboxWidth(preferred, 2000)).toBe(900);
    });
  });

  describe('a chosen width is remembered across a reload, or falls back to the automatic sizing', () => {
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

      writeInboxWidth(store, 360);

      expect(readInboxWidth(store)).toBe(360);
    });

    it('clears back to automatic sizing when written null', () => {
      const store = aStore();
      writeInboxWidth(store, 360);

      writeInboxWidth(store, null);

      expect(readInboxWidth(store)).toBeNull();
    });

    it('answers automatic sizing rather than throwing for a value nothing here ever wrote', () => {
      const store = aStore();
      store.setItem('cockpit.inbox-width', 'not-a-number');

      expect(readInboxWidth(store)).toBeNull();
    });

    it.each([undefined, ''])('answers automatic sizing for %j', (raw) => {
      expect(readInboxWidth(undefined)).toBeNull();
      const store = aStore();
      if (raw !== undefined) store.setItem('cockpit.inbox-width', raw);
      expect(readInboxWidth(store)).toBeNull();
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

      expect(() => writeInboxWidth(refuses, 360)).not.toThrow();
      expect(readInboxWidth(refuses)).toBeNull();
      expect(readInboxWidth(undefined)).toBeNull();
    });
  });
});
