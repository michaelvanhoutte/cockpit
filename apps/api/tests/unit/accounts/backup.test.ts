import { describe, expect, it } from 'vitest';
import { describeForeignRows, foreignRows, type AccountBackup } from '../../../src/accounts/backup.js';

/**
 * Unit level, because deciding which rows in a backup belong somewhere else -
 * and saying so - is a decision about plain data. Rows in, a list and a
 * sentence out: no store, no register, no request.
 *
 * The integration suite drives one foreign row in one table, which is all it
 * needs to prove the refusal is wired to a real store. Everything below is the
 * branching underneath that: grouping by table, counting, and naming each
 * account once however many rows carry it. Proving that against a real Durable
 * Object would be re-proving lower-level coverage higher up the pyramid, and
 * arranging a store holding three accounts' rows across two tables to do it.
 */

const MINE = 'tenant-default';

/** A backup holding exactly the rows given, in the tables named. */
function holding(tables: Record<string, { tenant_id?: string; id?: string }[]>): AccountBackup {
  return { changesApplied: [], tables } as AccountBackup;
}

describe('Backup', () => {
  describe('a backup says whose every row is', () => {
    it('finds nothing to report in an account holding only its own rows', () => {
      const backup = holding({
        workspaces: [{ id: 'w1', tenant_id: MINE }, { id: 'w2', tenant_id: MINE }],
        items: [{ id: 'i1', tenant_id: MINE }],
      });

      expect(foreignRows(backup, MINE)).toEqual([]);
    });

    it('finds nothing to report in an account holding nothing at all', () => {
      expect(foreignRows(holding({}), MINE)).toEqual([]);
    });

    it.each([
      {
        situation: 'one row belonging to somebody else',
        tables: { workspaces: [{ tenant_id: MINE }, { tenant_id: 'tenant-ada' }] },
        found: [{ table: 'workspaces', tenantId: 'tenant-ada' }],
      },
      {
        situation: 'several rows belonging to somebody else',
        tables: { items: [{ tenant_id: 'tenant-ada' }, { tenant_id: 'tenant-ada' }] },
        found: [
          { table: 'items', tenantId: 'tenant-ada' },
          { table: 'items', tenantId: 'tenant-ada' },
        ],
      },
      {
        situation: 'rows belonging to two different accounts',
        tables: { items: [{ tenant_id: 'tenant-ada' }, { tenant_id: 'tenant-bob' }] },
        found: [
          { table: 'items', tenantId: 'tenant-ada' },
          { table: 'items', tenantId: 'tenant-bob' },
        ],
      },
      {
        situation: 'foreign rows in more than one table',
        tables: {
          workspaces: [{ tenant_id: 'tenant-ada' }],
          items: [{ tenant_id: 'tenant-ada' }],
        },
        found: [
          { table: 'workspaces', tenantId: 'tenant-ada' },
          { table: 'items', tenantId: 'tenant-ada' },
        ],
      },
    ])('finds $situation', ({ tables, found }) => {
      expect(foreignRows(holding(tables), MINE)).toEqual(found);
    });

    /**
     * A table carrying no such column makes no claim about whose its rows are,
     * so there is nothing to disagree with. The store's own ledger of applied
     * changes is the one that looks like this, and it is kept out of the tables
     * anyway - this is what holds if a second such table ever arrives.
     */
    it('claims nothing about a table whose rows do not say whose they are', () => {
      const backup = holding({ account_notes: [{ id: 'n1' }, { id: 'n2' }] });

      expect(foreignRows(backup, MINE)).toEqual([]);
    });
  });

  describe('a backup that was refused says which tables held what', () => {
    it.each([
      {
        situation: 'one row in one table',
        found: [{ table: 'workspaces', tenantId: 'tenant-ada' }],
        says: 'workspaces holds 1 row belonging to "tenant-ada"',
      },
      // Counted rather than listed one by one: a store that has accumulated
      // foreign rows has no upper bound on how many, and this becomes a
      // response body built in the Worker's memory.
      {
        situation: 'many rows in one table',
        found: Array.from({ length: 300 }, () => ({ table: 'items', tenantId: 'tenant-ada' })),
        says: 'items holds 300 rows belonging to "tenant-ada"',
      },
      {
        situation: 'rows from two accounts in one table',
        found: [
          { table: 'items', tenantId: 'tenant-ada' },
          { table: 'items', tenantId: 'tenant-bob' },
          { table: 'items', tenantId: 'tenant-ada' },
        ],
        says: 'items holds 3 rows belonging to "tenant-ada", "tenant-bob"',
      },
      {
        situation: 'rows in two tables',
        found: [
          { table: 'workspaces', tenantId: 'tenant-ada' },
          { table: 'items', tenantId: 'tenant-ada' },
        ],
        says:
          'workspaces holds 1 row belonging to "tenant-ada"; ' +
          'items holds 1 row belonging to "tenant-ada"',
      },
    ])('says so for $situation', ({ found, says }) => {
      expect(describeForeignRows(found, MINE)).toBe(
        `account ${MINE} was not backed up: ${says}`,
      );
    });

    /**
     * The property that made this counted rather than listed: however many rows
     * there are, what it says stays short. Three hundred rows across three
     * tables would be three hundred clauses the other way round.
     */
    it('stays short however many rows there are', () => {
      const many = Array.from({ length: 5_000 }, (_, at) => ({
        table: `table${at % 3}`,
        tenantId: 'tenant-ada',
      }));

      expect(describeForeignRows(many, MINE).length).toBeLessThan(300);
    });

    it('names the account that was not backed up', () => {
      expect(describeForeignRows([{ table: 'items', tenantId: 'x' }], MINE)).toContain(MINE);
    });
  });
});
