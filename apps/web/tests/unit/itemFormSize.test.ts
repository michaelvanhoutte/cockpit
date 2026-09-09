import { describe, expect, it } from 'vitest';
import {
  forgetItemFormSize,
  rememberItemFormSize,
  rememberedItemFormSize,
} from '../../src/itemFormSize';

/**
 * F1: the storage is handed in, so none of this needs a browser, and a
 * browser that refuses storage or holds something unusable reads as nothing
 * remembered rather than a crash.
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

describe('The item form’s remembered size', () => {
  it('reads back a size that was remembered', () => {
    const store = aStore();
    rememberItemFormSize(store, { width: 900, height: 700 });

    expect(rememberedItemFormSize(store)).toEqual({ width: 900, height: 700 });
  });

  it('remembers the last size dragged to, not every one along the way', () => {
    const store = aStore();
    rememberItemFormSize(store, { width: 900, height: 700 });
    rememberItemFormSize(store, { width: 500, height: 400 });

    expect(rememberedItemFormSize(store)).toEqual({ width: 500, height: 400 });
  });

  describe('a value that is not a usable size reads as nothing remembered', () => {
    it.each([
      { situation: 'nothing stored at all', stored: undefined },
      { situation: 'something that is not JSON', stored: 'not json at all {' },
      { situation: 'JSON that is not an object', stored: '"a size"' },
      { situation: 'an object missing a dimension', stored: '{"width":900}' },
      { situation: 'a dimension that is not a number', stored: '{"width":"wide","height":700}' },
      { situation: 'a dimension that is zero', stored: '{"width":0,"height":700}' },
      { situation: 'a dimension that is negative', stored: '{"width":-100,"height":700}' },
      { situation: 'a dimension that is not finite', stored: '{"width":null,"height":700}' },
    ])('$situation', ({ stored }) => {
      const store = aStore(stored === undefined ? {} : { 'cockpit.item-form-size': stored });

      expect(rememberedItemFormSize(store)).toBeNull();
    });
  });

  describe('a browser that refuses storage remembers nothing, rather than throwing', () => {
    it.each([
      { situation: 'no storage at all', store: undefined },
      { situation: 'storage that refuses', store: aStoreThatRefuses() },
    ])('$situation', ({ store }) => {
      expect(rememberedItemFormSize(store)).toBeNull();
      expect(() => rememberItemFormSize(store, { width: 900, height: 700 })).not.toThrow();
    });
  });

  describe('signing out leaves nothing of the person behind', () => {
    it('forgets the size dragged to, and leaves what is not ours alone', () => {
      const store = aStore({ 'somebody else': 'theirs' });
      rememberItemFormSize(store, { width: 900, height: 700 });

      forgetItemFormSize(store);

      expect(rememberedItemFormSize(store)).toBeNull();
      expect(store.getItem('somebody else')).toBe('theirs');
    });

    it('does not throw where there is nothing to forget', () => {
      expect(() => forgetItemFormSize(undefined)).not.toThrow();
      expect(() => forgetItemFormSize(aStoreThatRefuses())).not.toThrow();
    });
  });
});
