import { describe, expect, it } from 'vitest';
import { uuidv7, uuidv7Timestamp } from '../../src/ids.js';

/**
 * Why this exists at all: the app is local-first, so an item captured with no
 * connection has to be given its identifier there and then, before any server
 * has seen it - and those identifiers still have to fall into the order the
 * items were captured in.
 */
describe('Offline', () => {
  describe('an item captured without a connection gets its identifier on the spot', () => {
    it('needs nothing from the server to produce one', () => {
      const id = uuidv7();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('items fall into the order they were captured in', () => {
    it('sorts an earlier capture before a later one', () => {
      const earlier = uuidv7(1_000_000_000_000);
      const later = uuidv7(1_000_000_000_001);
      expect(earlier < later).toBe(true);
    });
  });

  describe('the time an item was captured can be read back off its identifier', () => {
    const moments = [
      { name: 'the epoch', now: 0 },
      { name: 'a recent capture', now: 1_756_000_000_000 },
      { name: 'the largest 48-bit millisecond', now: 2 ** 48 - 1 },
    ];

    it.each(moments)('$name survives the round trip', ({ now }) => {
      expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
    });

    const notOurs = [
      { name: 'an empty string', id: '' },
      { name: 'a UUIDv4', id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
      { name: 'a v7 layout with the wrong variant', id: '018f0000-0000-7000-0000-000000000000' },
      { name: 'a UUID with a character too many', id: `${uuidv7()}0` },
      { name: 'prose', id: 'not an id' },
    ];

    it.each(notOurs)('$name carries no capture time', ({ id }) => {
      expect(uuidv7Timestamp(id)).toBeNull();
    });
  });
});
