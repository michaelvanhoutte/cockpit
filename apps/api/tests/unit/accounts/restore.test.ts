import { describe, expect, it } from 'vitest';
import { nowhereToPutThem, sameShapeThroughout } from '../../../src/accounts/restore.js';
import type { AccountBackup } from '../../../src/accounts/backup.js';

/**
 * Unit level, because both guards take plain data and either throw or do not -
 * a backup's tables against a list of names, and a table's rows against each
 * other. No store, no register, no request.
 *
 * They are the two ways a restore can look like it worked and not have, so
 * their branches are worth asking about one at a time rather than through a
 * real Durable Object. The integration suite keeps one example of each, which
 * is what proves a throw here becomes a 400 out there - the half this cannot
 * reach.
 */

function holding(tables: Record<string, Record<string, unknown>[]>): AccountBackup {
  return { changesApplied: [], tables } as AccountBackup;
}

describe('Backup', () => {
  describe('restoring refuses rows it has nowhere to put, rather than dropping them', () => {
    /**
     * The worst failure this command has: replaying the change list is what
     * creates the tables, so a backup whose rows outlive their schema - a
     * `changesApplied` trimmed by hand, a file merged from two others - has
     * rows with no table to go in. Walking the schema and reading the file
     * through it drops them without a word and answers as though it worked.
     */
    it.each([
      {
        situation: 'a table the changes do not create',
        tables: { items: [{ id: 'i1' }] },
        order: ['workspaces'],
        says: /items \(1\)/,
      },
      {
        situation: 'several such tables',
        tables: { items: [{ id: 'i1' }, { id: 'i2' }], panels: [{ id: 'p1' }] },
        order: [],
        says: /items \(2\), panels \(1\)/,
      },
      {
        situation: 'one among tables that are fine',
        tables: { workspaces: [{ id: 'w1' }], items: [{ id: 'i1' }] },
        order: ['workspaces'],
        says: /items \(1\)/,
      },
    ])('refuses $situation', ({ tables, order, says }) => {
      expect(() => nowhereToPutThem(holding(tables), order)).toThrow(says);
    });

    it.each([
      { situation: 'every table it holds rows for exists', tables: { items: [{ id: 'i1' }] }, order: ['items'] },
      // An empty table names nothing that has to be put anywhere, so it is not
      // a table with nowhere to go - a backup routinely carries several.
      { situation: 'a table it has no rows for is missing', tables: { items: [] }, order: [] },
      { situation: 'it holds nothing at all', tables: {}, order: [] },
    ])('allows a backup where $situation', ({ tables, order }) => {
      expect(() => nowhereToPutThem(holding(tables), order)).not.toThrow();
    });
  });

  describe('restoring refuses a table whose rows do not agree about their columns', () => {
    /**
     * A backup is a file on somebody's disk and may have been edited or merged
     * by hand - that is what the format is for. Taking the first row's columns
     * and reading the rest through them writes NULL for one a later row lacks
     * and drops one it has gained, both landing as a restore reporting success
     * having lost data.
     */
    it.each([
      {
        situation: 'a later row carrying one the first does not',
        rows: [{ id: 'a' }, { id: 'b', extra: 'x' }],
        says: /row 2 has extra,id where the first has id/,
      },
      {
        situation: 'a later row missing one the first has',
        rows: [{ id: 'a', name: 'n' }, { id: 'b' }],
        says: /row 2 has id where the first has id,name/,
      },
      {
        situation: 'rows carrying no columns at all',
        rows: [{}, {}],
        says: /carry no columns at all/,
      },
      // The disagreement is found wherever it is, not only in the second row.
      {
        situation: 'a disagreement further down',
        rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', extra: 'x' }],
        says: /row 4/,
      },
    ])('refuses $situation', ({ rows, says }) => {
      expect(() => sameShapeThroughout('workspaces', rows, Object.keys(rows[0]!))).toThrow(says);
    });

    it.each([
      { situation: 'every row carries the same columns', rows: [{ id: 'a', name: 'n' }, { id: 'b', name: 'm' }] },
      // Order is not shape: `SELECT *` gives one order and a hand-edited file
      // may give another, and both say the same thing about the row.
      { situation: 'the columns are in a different order', rows: [{ id: 'a', name: 'n' }, { name: 'm', id: 'b' }] },
      { situation: 'there is one row', rows: [{ id: 'a' }] },
      // A column that is there and null is carried; it is a value, not an
      // absence, and every store has plenty of them.
      { situation: 'a column is there but empty', rows: [{ id: 'a', name: null }, { id: 'b', name: 'm' }] },
    ])('allows a table where $situation', ({ rows }) => {
      expect(() => sameShapeThroughout('workspaces', rows, Object.keys(rows[0]!))).not.toThrow();
    });

    it('names the table it is talking about', () => {
      expect(() => sameShapeThroughout('panel_placements', [{ a: 1 }, { b: 2 }], ['a'])).toThrow(
        /panel_placements/,
      );
    });
  });
});
