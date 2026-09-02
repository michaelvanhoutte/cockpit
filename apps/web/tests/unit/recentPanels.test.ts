import { describe, expect, it } from 'vitest';
import {
  RECENT_PANELS_KEPT,
  forgetEveryRecentPanel,
  recentPanelsIn,
  rememberRecentPanel,
  withMostRecent,
} from '../../src/recentPanels';

/**
 * F1: the deciding is pure, and the storage is handed in - so none of this
 * needs a browser, and a browser that refuses storage is a case rather than a
 * crash.
 */

/** A `Storage` that is only a map, and one that refuses everything. */
function aStore(seed: Record<string, string> = {}): Storage {
  const held = new Map(Object.entries(seed));
  return {
    get length() {
      return held.size;
    },
    key: (i: number) => [...held.keys()][i] ?? null,
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
    clear: () => held.clear(),
  } as Storage;
}

function aStoreThatRefuses(): Storage {
  const refuse = () => {
    throw new Error('storage is not available');
  };
  return {
    get length(): number {
      return refuse();
    },
    key: refuse,
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
    clear: refuse,
  } as unknown as Storage;
}

describe('Panels', () => {
  describe('the panels most recently filed into are offered first, newest first and without repeats', () => {
    it.each([
      { situation: 'nothing filed yet', remembered: [], filed: 'a', offered: ['a'] },
      { situation: 'a second panel', remembered: ['a'], filed: 'b', offered: ['b', 'a'] },
      {
        situation: 'a panel already in the list',
        remembered: ['a', 'b'],
        filed: 'b',
        offered: ['b', 'a'],
      },
      {
        situation: 'a fourth panel, which drops the oldest',
        remembered: ['c', 'b', 'a'],
        filed: 'd',
        offered: ['d', 'c', 'b'],
      },
    ])('$situation', ({ remembered, filed, offered }) => {
      expect(withMostRecent(remembered, filed)).toEqual(offered);
    });

    it('keeps no more than the three the picker shows', () => {
      let held: string[] = [];
      for (const panelId of ['a', 'b', 'c', 'd', 'e']) held = withMostRecent(held, panelId);

      expect(held).toHaveLength(RECENT_PANELS_KEPT);
    });

    it('remembers them per workspace, so one workspace’s do not surface in another', () => {
      const store = aStore();
      rememberRecentPanel(store, 'ws-work', 'falcon');
      rememberRecentPanel(store, 'ws-personal', 'shopping');

      expect(recentPanelsIn(store, 'ws-work')).toEqual(['falcon']);
      expect(recentPanelsIn(store, 'ws-personal')).toEqual(['shopping']);
    });
  });

  describe('a browser that remembers nothing usable is a picker with no recent list', () => {
    it.each([
      { situation: 'nothing stored at all', stored: undefined },
      { situation: 'something that is not JSON', stored: 'falcon' },
      { situation: 'JSON that is not a list', stored: '{"panelId":"falcon"}' },
      { situation: 'a list holding things that are not panel ids', stored: '[1,null,{}]' },
    ])('$situation', ({ stored }) => {
      const store = aStore(stored === undefined ? {} : { 'cockpit.recent-panels.ws-work': stored });

      expect(recentPanelsIn(store, 'ws-work')).toEqual([]);
    });

    it.each([
      { situation: 'no storage at all', store: undefined },
      { situation: 'storage that refuses', store: aStoreThatRefuses() },
    ])('$situation', ({ store }) => {
      expect(recentPanelsIn(store, 'ws-work')).toEqual([]);
      expect(() => rememberRecentPanel(store, 'ws-work', 'falcon')).not.toThrow();
      expect(() => forgetEveryRecentPanel(store)).not.toThrow();
    });
  });

  describe('signing out leaves nothing of the person behind', () => {
    it('forgets where they filed things, and leaves what is not ours alone', () => {
      const store = aStore({ 'somebody else': 'theirs' });
      rememberRecentPanel(store, 'ws-work', 'falcon');
      rememberRecentPanel(store, 'ws-personal', 'shopping');

      forgetEveryRecentPanel(store);

      expect(recentPanelsIn(store, 'ws-work')).toEqual([]);
      expect(recentPanelsIn(store, 'ws-personal')).toEqual([]);
      expect(store.getItem('somebody else')).toBe('theirs');
    });
  });
});
