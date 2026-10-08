import { describe, expect, it } from 'vitest';

import { layoutModules } from '../../src/layout.js';

const down = (from, to, files = 1) => ({ from, to, files, kind: 'downward' });
const rowsOf = (paths, cells) => Object.fromEntries(layoutModules({ paths, cells }).rows);
const drawn = (paths, cells) => layoutModules({ paths, cells }).down.map((each) => `${each.from}>${each.to}`).sort();

describe('Modules', () => {
  describe('an area sits on the row below everything that imports it', () => {
    it.each([
      { situation: 'a chain a, b, c takes rows 0, 1, 2', paths: ['a', 'b', 'c'], cells: [down('a', 'b'), down('b', 'c')], expected: { a: 0, b: 1, c: 2 } },
      { situation: 'the bottom of a diamond sits below both sides', paths: ['a', 'b', 'c', 'd'], cells: [down('a', 'b'), down('a', 'c'), down('b', 'd'), down('c', 'd')], expected: { a: 0, b: 1, c: 1, d: 2 } },
      { situation: 'an area importing a deep chain and a shallow one sits below the deepest importer', paths: ['a', 'b', 'c', 'd'], cells: [down('a', 'b'), down('b', 'c'), down('c', 'd'), down('a', 'd')], expected: { a: 0, b: 1, c: 2, d: 3 } },
      { situation: 'an import back up does not move either area', paths: ['a', 'b'], cells: [down('a', 'b'), { from: 'b', to: 'a', files: 4, kind: 'upward' }], expected: { a: 0, b: 1 } },
      { situation: 'the downward half of a cycle counts for rows', paths: ['a', 'b'], cells: [{ from: 'a', to: 'b', files: 2, kind: 'partner' }, { from: 'b', to: 'a', files: 2, kind: 'upward' }], expected: { a: 0, b: 1 } },
      { situation: 'what an area everyone reads imports, or is imported for, does not move anything', paths: ['a', 'env'], cells: [{ from: 'a', to: 'env', files: 5, kind: 'muted' }, { from: 'env', to: 'a', files: 1, kind: 'muted' }], expected: { a: 0, env: 0 } },
      { situation: 'an area with no imports either way is on the top row', paths: ['a', 'b', 'lone'], cells: [down('a', 'b')], expected: { a: 0, b: 1, lone: 0 } },
    ])('$situation', ({ paths, cells, expected }) => {
      expect(rowsOf(paths, cells)).toEqual(expected);
    });
  });

  describe('only the shortest chain of imports is drawn', () => {
    it.each([
      { situation: 'an import that a longer chain already covers is left out', paths: ['a', 'b', 'c'], cells: [down('a', 'b'), down('b', 'c'), down('a', 'c')], expected: ['a>b', 'b>c'] },
      { situation: 'an import covered through a longer chain of three is left out', paths: ['a', 'b', 'c', 'd'], cells: [down('a', 'b'), down('b', 'c'), down('c', 'd'), down('a', 'd')], expected: ['a>b', 'b>c', 'c>d'] },
      { situation: 'an import with no other path between its areas is drawn, with its files', paths: ['a', 'b', 'c'], cells: [down('a', 'b', 3), down('a', 'c', 7)], expected: ['a>b', 'a>c'] },
      { situation: 'both sides of a diamond stay, since neither covers the other', paths: ['a', 'b', 'c', 'd'], cells: [down('a', 'b'), down('a', 'c'), down('b', 'd'), down('c', 'd')], expected: ['a>b', 'a>c', 'b>d', 'c>d'] },
    ])('$situation', ({ paths, cells, expected }) => {
      expect(drawn(paths, cells)).toEqual(expected);
    });

    it('keeps the file count of a drawn import', () => {
      expect(layoutModules({ paths: ['a', 'c'], cells: [down('a', 'c', 7)] }).down).toEqual([{ from: 'a', to: 'c', files: 7 }]);
    });

    it('draws an import back up whatever else connects the two areas, and says whether it is a tie', () => {
      const cells = [{ from: 'a', to: 'b', files: 2, kind: 'partner' }, { from: 'b', to: 'a', files: 2, kind: 'upward' }];
      const { up } = layoutModules({ paths: ['a', 'b'], cells, undecidedPairs: [['a', 'b']] });
      expect(up).toEqual([{ from: 'b', to: 'a', files: 2, tie: true }]);
      expect(layoutModules({ paths: ['a', 'b'], cells }).up[0].tie).toBe(false);
    });
  });
});
