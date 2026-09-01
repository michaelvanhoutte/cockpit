import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomForTheInbox } from '../../src/roomForTheInbox';

/**
 * F1, and pure: whether there is room for the Inbox beside the dashboards is a
 * question put to the browser and nothing more. That the app then *does* the
 * right thing with the answer is in tests/unit/router.test.tsx; that the two
 * shapes actually fit their screens is the browser walk in
 * tests/e2e/inbox.test.ts.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Triage', () => {
  describe('a browser that cannot answer how wide it is gets the shape that works everywhere', () => {
    it.each([
      {
        situation: 'a browser with no media queries at all',
        matchMedia: undefined,
      },
      {
        situation: 'a browser that refuses to answer',
        matchMedia: () => {
          throw new Error('not implemented');
        },
      },
      {
        situation: 'a screen too narrow to hold the Inbox beside the dashboards',
        matchMedia: () => ({ matches: false }),
      },
    ])('$situation', ({ matchMedia }) => {
      vi.stubGlobal('matchMedia', matchMedia);

      // No room, which is the phone shape: a tab in the bar rather than a
      // column. Guessing the other way would put a 90px Inbox on a phone.
      expect(roomForTheInbox()).toBe(false);
    });

    it('says there is room when the screen says so', () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));

      expect(roomForTheInbox()).toBe(true);
    });
  });
});
