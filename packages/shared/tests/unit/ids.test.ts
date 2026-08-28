import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/ids.js';

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
});
