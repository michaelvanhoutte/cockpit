import { describe, expect, it } from 'vitest';
import { INBOX, rememberView, rememberedIn, viewToOpen } from '../../src/lastVisited';

/**
 * F1, and pure: which view a workspace opens on is a decision over a remembered
 * string and a list. The storage is handed in rather than reached for, so this
 * asks nothing of the browser; that the router actually asks this, and that the
 * screen it lands on renders, is in tests/unit/router.test.tsx.
 */
describe('Dashboards', () => {
  const dashboards = [{ id: 'ws-work-dashboard-1' }, { id: 'ws-work-research' }];

  describe('a workspace opens on the view you were last on there', () => {
    it.each([
      {
        situation: 'a workspace never opened before',
        remembered: null,
        opens: { on: 'dashboard', dashboardId: 'ws-work-dashboard-1' },
      },
      {
        situation: 'a dashboard you were on, still there',
        remembered: 'ws-work-research',
        opens: { on: 'dashboard', dashboardId: 'ws-work-research' },
      },
      {
        situation: 'the Inbox, which you were last on',
        remembered: 'inbox',
        opens: INBOX,
      },
      {
        situation: 'a dashboard that is no longer there',
        remembered: 'ws-work-deleted',
        opens: { on: 'dashboard', dashboardId: 'ws-work-dashboard-1' },
      },
    ])('$situation', ({ remembered, opens }) => {
      expect(viewToOpen(remembered, dashboards)).toEqual(opens);
    });

    it('opens the Inbox for a workspace with no dashboards at all', () => {
      // Cannot happen - a workspace is created with one - so what is asked here
      // is that the app opens rather than throwing if the rule is ever broken.
      expect(viewToOpen(null, [])).toEqual(INBOX);
    });
  });

  describe('what each workspace was last on is remembered apart from the others', () => {
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

    it('gives each workspace back its own', () => {
      const store = aStore();

      rememberView(store, 'ws-work', { on: 'dashboard', dashboardId: 'ws-work-research' });
      rememberView(store, 'ws-personal', INBOX);

      expect(rememberedIn(store, 'ws-work')).toBe('ws-work-research');
      expect(rememberedIn(store, 'ws-personal')).toBe('inbox');
      expect(rememberedIn(store, 'ws-never-opened')).toBeNull();
    });

    it('remembers nothing, rather than failing, where there is nowhere to remember it', () => {
      // A private window, or a browser set to refuse storage. Not remembering
      // is a smaller thing than a workspace that will not open.
      const refuses: Storage = {
        ...aStore(),
        getItem: () => {
          throw new Error('storage is not available');
        },
        setItem: () => {
          throw new Error('storage is not available');
        },
      };

      expect(() => rememberView(refuses, 'ws-work', INBOX)).not.toThrow();
      expect(rememberedIn(refuses, 'ws-work')).toBeNull();
      expect(rememberedIn(undefined, 'ws-work')).toBeNull();
    });
  });
});
