import { describe, expect, it } from 'vitest';
import { pickFor, pickScreenSize } from '../../../src/panels/chosenLayout';

/**
 * F1: what the browser is holding is a string it parses, so every way that
 * string can be unusable is a branch rather than a browser question. The
 * storage is handed in, which is what lets a refusing one be one of the
 * cases.
 */

const KEY = 'cockpit.layoutPick';

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
      { situation: 'nothing held', held: undefined },
      // What a browser is holding from before this was made global and keyed
      // by screen size rather than by layout. Reading it forward would
      // misapply a pick made for one dashboard to whichever is open now, so
      // it is dropped.
      { situation: 'a pick made before it was keyed by screen size', held: '{"layoutId":"wide","whileNearestIs":"phone"}' },
      { situation: 'a pick made before picks expired at all', held: '0192-a-bare-layout-id' },
      { situation: 'a value that is not readable at all', held: '{oh no' },
      { situation: 'a pick that names no screen size', held: '{"whileNearestIs":"sz-wide"}' },
      { situation: 'a pick that says nothing about what it overrides', held: '{"screenSizeId":"sz-wide"}' },
      { situation: 'a pick whose parts are not names', held: '{"screenSizeId":3,"whileNearestIs":7}' },
      { situation: 'a pick that is not an object', held: '"sz-wide"' },
      { situation: 'a pick stored as nothing', held: 'null' },
    ])('$situation', ({ held }) => {
      const store = aStore(held === undefined ? {} : { [KEY]: held });

      expect(pickFor(store)).toBeNull();
    });

    it('reads back a pick that is whole', () => {
      const store = aStore();
      pickScreenSize(store, { screenSizeId: 'sz-wide', whileNearestIs: 'sz-phone' });

      expect(pickFor(store)).toEqual({ screenSizeId: 'sz-wide', whileNearestIs: 'sz-phone' });
    });

    it('holds nothing once the pick is cleared', () => {
      const store = aStore({ [KEY]: '{"screenSizeId":"sz-wide","whileNearestIs":"sz-phone"}' });
      pickScreenSize(store, null);

      expect(pickFor(store)).toBeNull();
    });

    it.each([
      { situation: 'no storage at all', store: undefined },
      { situation: 'storage that refuses', store: aRefusingStore() },
    ])('$situation is a dashboard drawn, not one that throws', ({ store }) => {
      // Both halves: neither reading nor writing may take the dashboard off the
      // screen, which is the whole reason the store is handed in.
      expect(() =>
        pickScreenSize(store, { screenSizeId: 'sz-wide', whileNearestIs: 'sz-phone' }),
      ).not.toThrow();
      expect(pickFor(store)).toBeNull();
    });
  });
});
