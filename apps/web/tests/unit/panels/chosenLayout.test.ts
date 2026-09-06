import { describe, expect, it } from 'vitest';
import { pickFor, pickLayout } from '../../../src/panels/chosenLayout';

/**
 * F1: what the browser is holding for a dashboard is a string it parses, so
 * every way that string can be unusable is a branch rather than a browser
 * question. The storage is handed in, which is what lets a refusing one be one
 * of the cases.
 */

const DASHBOARD = 'today';
const KEY = 'cockpit.layout.' + DASHBOARD;

/** A store backed by a plain object, standing in for the browser's. */
function aStore(held: Record<string, string> = {}): Storage {
  return {
    getItem: (key: string) => held[key] ?? null,
    setItem: (key: string, value: string) => {
      held[key] = value;
    },
    removeItem: (key: string) => {
      delete held[key];
    },
    clear: () => {},
    key: () => null,
    length: 0,
  };
}

/** A store that refuses, the way one does in a private window. */
function aRefusingStore(): Storage {
  return {
    ...aStore(),
    getItem: () => {
      throw new Error('refused');
    },
    setItem: () => {
      throw new Error('refused');
    },
  };
}

describe('Layouts', () => {
  describe('a pick the browser cannot use is no pick at all', () => {
    it.each([
      { situation: 'nothing held for this dashboard', held: undefined },
      // What browsers are holding from before a pick recorded the answer it
      // overrides. Reading it forward would keep every one of them pinned to
      // the layout it was stuck on, and being unstuck is the point.
      { situation: 'a pick made before picks expired', held: '0192-a-bare-layout-id' },
      { situation: 'a value that is not readable at all', held: '{oh no' },
      { situation: 'a pick that names no layout', held: '{"whileNearestIs":"wide"}' },
      { situation: 'a pick that says nothing about what it overrides', held: '{"layoutId":"wide"}' },
      { situation: 'a pick whose parts are not names', held: '{"layoutId":3,"whileNearestIs":7}' },
      { situation: 'a pick that is not an object', held: '"wide"' },
      { situation: 'a pick stored as nothing', held: 'null' },
    ])('$situation', ({ held }) => {
      const store = aStore(held === undefined ? {} : { [KEY]: held });

      expect(pickFor(store, DASHBOARD)).toBeNull();
    });

    it('reads back a pick that is whole', () => {
      const store = aStore();
      pickLayout(store, DASHBOARD, { layoutId: 'wide', whileNearestIs: 'phone' });

      expect(pickFor(store, DASHBOARD)).toEqual({ layoutId: 'wide', whileNearestIs: 'phone' });
    });

    it('holds nothing for a dashboard whose pick was cleared', () => {
      const store = aStore({ [KEY]: '{"layoutId":"wide","whileNearestIs":"phone"}' });
      pickLayout(store, DASHBOARD, null);

      expect(pickFor(store, DASHBOARD)).toBeNull();
    });

    it('keeps one dashboard’s pick off another’s', () => {
      const store = aStore();
      pickLayout(store, DASHBOARD, { layoutId: 'wide', whileNearestIs: 'phone' });

      expect(pickFor(store, 'research')).toBeNull();
    });

    it.each([
      { situation: 'no storage at all', store: undefined },
      { situation: 'storage that refuses', store: aRefusingStore() },
    ])('$situation is a dashboard drawn, not one that throws', ({ store }) => {
      // Both halves: neither reading nor writing may take the dashboard off the
      // screen, which is the whole reason the store is handed in.
      expect(() => pickLayout(store, DASHBOARD, { layoutId: 'wide', whileNearestIs: 'phone' })).not.toThrow();
      expect(pickFor(store, DASHBOARD)).toBeNull();
    });
  });
});
