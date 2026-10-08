import { describe, expect, it } from 'vitest';

import { greedyOrder, orderAreas, upwardFiles } from '../../src/order.js';

/** A weight function from `from>to: files` entries. */
const weights = (table) => (from, to) => table[`${from}>${to}`] ?? 0;

describe('Dependencies', () => {
  describe('areas are ordered so the fewest import files point up', () => {
    it.each([
      { situation: 'a chain, listed in order', paths: ['a', 'b', 'c'], table: { 'a>b': 1, 'b>c': 1 }, expected: ['a', 'b', 'c'] },
      { situation: 'a chain, listed backwards', paths: ['c', 'b', 'a'], table: { 'a>b': 1, 'b>c': 1 }, expected: ['a', 'b', 'c'] },
      { situation: 'a chain, listed scrambled', paths: ['b', 'c', 'a'], table: { 'a>b': 1, 'b>c': 1 }, expected: ['a', 'b', 'c'] },
      { situation: 'a cycle of 5 files one way and 2 the other', paths: ['b', 'a'], table: { 'a>b': 5, 'b>a': 2 }, expected: ['a', 'b'] },
      { situation: 'areas that import nothing of each other', paths: ['x', 'y', 'z'], table: {}, expected: ['x', 'y', 'z'] },
    ])('$situation', ({ paths, table, expected }) => {
      expect(orderAreas({ paths, weight: weights(table) })).toEqual({ order: expected, method: 'exact' });
    });

    it('puts a pinned area above another even where that points an import up', () => {
      const weight = weights({ 'a>b': 5, 'b>a': 2 });
      const { order } = orderAreas({ paths: ['a', 'b'], weight, pins: [['b', 'a']] });
      expect(order).toEqual(['b', 'a']);
      expect(upwardFiles(order, weight)).toBe(5);
    });

    it('keeps every pin when it orders by approximation too', () => {
      const weight = weights({ 'a>b': 5, 'b>c': 5, 'c>a': 1 });
      const { order, method } = orderAreas({ paths: ['a', 'b', 'c'], weight, pins: [['c', 'a']], limit: 2 });
      expect(method).toBe('approximate');
      expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'));
    });

    it('says an order is approximate when there are more areas than the exact search allows, and then leaves no more files up than the greedy order', () => {
      const paths = Array.from({ length: 9 }, (_, at) => `a${at}`);
      // Every area imports the next and, less, the one two before it: a greedy pass is led astray by the back edges.
      const table = Object.fromEntries(paths.flatMap((path, at) => [[`${path}>${paths[(at + 1) % 9]}`, 3 + (at % 3)], [`${path}>${paths[(at + 7) % 9]}`, 2]]));
      const weight = weights(table);
      const exact = orderAreas({ paths, weight, limit: 9 });
      const approximate = orderAreas({ paths, weight, limit: 8 });
      expect([exact.method, approximate.method]).toEqual(['exact', 'approximate']);
      expect([...approximate.order].sort()).toEqual([...paths].sort());
      expect(upwardFiles(approximate.order, weight)).toBeLessThanOrEqual(upwardFiles(greedyOrder({ paths, weight }), weight));
      expect(upwardFiles(approximate.order, weight)).toBeGreaterThanOrEqual(upwardFiles(exact.order, weight));
    });
  });
});
