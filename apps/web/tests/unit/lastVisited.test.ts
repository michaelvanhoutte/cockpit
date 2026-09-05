import { describe, expect, it } from 'vitest';
import {
  INBOX,
  rememberView,
  rememberWorkspace,
  rememberedIn,
  viewToOpen,
  workspaceToCaptureFrom,
} from '../../src/lastVisited';

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
        situation: 'the Inbox, which you were last on, on a screen too narrow to hold it beside',
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

    it.each([
      {
        situation: 'the Inbox, which is on the screen already',
        remembered: 'inbox',
        opens: { on: 'dashboard', dashboardId: 'ws-work-dashboard-1' },
      },
      {
        situation: 'a dashboard you were on, which is still a view to return to',
        remembered: 'ws-work-research',
        opens: { on: 'dashboard', dashboardId: 'ws-work-research' },
      },
    ])('where the Inbox has a column of its own: $situation', ({ remembered, opens }) => {
      // Returning to the Inbox where it is already beside you would land you on
      // a workspace showing the same thing twice.
      expect(viewToOpen(remembered, dashboards, true)).toEqual(opens);
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

/**
 * F1, and pure for the same reason as the rest of this file: which workspace a
 * capture is recorded against is a decision over a remembered string and a
 * list. That the Capture page actually asks it is
 * tests/unit/pages/CapturePage.test.tsx.
 */
describe('Capture', () => {
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

  describe('a note captured outside every workspace still records the one you came from', () => {
    const workspaces = [{ id: 'ws-work' }, { id: 'ws-personal' }];

    it.each([
      { situation: 'the workspace you were last in', last: 'ws-personal', from: 'ws-personal' },
      { situation: 'nowhere yet - a browser that lands straight on the page', last: null, from: 'ws-work' },
      { situation: 'a workspace deleted since, whose note would be refused', last: 'ws-gone', from: 'ws-work' },
    ])('$situation', ({ last, from }) => {
      const store = aStore();
      if (last) rememberWorkspace(store, last);

      expect(workspaceToCaptureFrom(store, workspaces)).toBe(from);
    });

    it('falls back to the first workspace where there is nowhere to remember one', () => {
      const refuses: Storage = {
        ...aStore(),
        getItem: () => {
          throw new Error('storage is not available');
        },
        setItem: () => {
          throw new Error('storage is not available');
        },
      };

      expect(() => rememberWorkspace(refuses, 'ws-work')).not.toThrow();
      expect(workspaceToCaptureFrom(refuses, workspaces)).toBe('ws-work');
      expect(workspaceToCaptureFrom(undefined, workspaces)).toBe('ws-work');
    });

    it('has nowhere to capture from with no workspaces at all', () => {
      // The address answers that by sending you to the page that makes one
      // (router.tsx); what matters here is that it says so rather than naming
      // a workspace nobody has.
      expect(workspaceToCaptureFrom(aStore(), [])).toBeUndefined();
    });
  });
});
