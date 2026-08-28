import { describe, expect, it } from 'vitest';
import { uuidv7, uuidv7Timestamp } from '../../src/ids.js';

describe('id.created-at', () => {
  describe('an ID carries the time it was created', () => {
    const moments = [
      { name: 'the epoch', now: 0 },
      { name: 'a recent moment', now: 1_756_000_000_000 },
      { name: 'the largest 48-bit millisecond', now: 2 ** 48 - 1 },
    ];

    it.each(moments)('$name is readable back off the ID', ({ now }) => {
      expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
    });
  });

  describe('an ID that is not a UUIDv7 has no creation time', () => {
    const rejected = [
      { name: 'an empty string', id: '' },
      { name: 'a UUIDv4', id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
      { name: 'a v7 layout with the wrong variant', id: '018f0000-0000-7000-0000-000000000000' },
      { name: 'a UUID with a character too many', id: `${uuidv7()}0` },
      { name: 'prose', id: 'not an id' },
    ];

    it.each(rejected)('$name is rejected', ({ id }) => {
      expect(uuidv7Timestamp(id)).toBeNull();
    });
  });
});
