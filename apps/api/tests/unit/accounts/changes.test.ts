import { describe, expect, it } from 'vitest';
import { WORKSPACE_THEMES } from '@cockpit/shared';
import { accountChanges } from '../../../src/accounts/changes.js';

/**
 * The shape of the change list itself, rather than what any change does.
 *
 * **One rule, because only one of them guards anything.** A store decides what
 * to apply by comparing full names (up-to-date.ts), so two changes with the
 * *same* name are a real fault: whichever is recorded first makes the other
 * look applied, and the second's statements never run on any account that got
 * there first - silently, and forever.
 *
 * **A shared ordinal is not that fault**, which is worth writing down because
 * this file was first drafted as though it were. `0004-workspace-order` and
 * `0004-workspace-bar` are different names, so both apply, in list order, and
 * nothing is skipped: the duplicated number is untidy and nothing more. A test
 * for it would go red on a harmless condition, and the obvious way to green it
 * is to renumber one - which is the one genuinely dangerous edit here, because
 * a renamed change looks unapplied to every store that already ran it and
 * fails on the second attempt (`duplicate column name`). That is not a
 * hypothetical: it is what renumbering this branch's change did to the machine
 * it was written on. A check that pushes towards it is worse than no check.
 *
 * So the rename rule lives where it can be read before the edit is made - in
 * changes.ts's own header, and in the readme's "Resetting local data" for
 * whoever meets the failure - and CI holds only the fault it can actually
 * catch.
 */
describe('Accounts', () => {
  describe('no two schema changes an account applies share a name', () => {
    // L1: the list is a value. Whether each change *works* is proved against a
    // real store in tests/integration/accounts.
    it('gives every change a name of its own, so none can be mistaken for another', () => {
      const names = accountChanges('any-account-would-do').map((change) => change.name);

      expect(new Set(names).size, names.join(', ')).toBe(names.length);
    });
  });

  describe('a workspace ends up wearing the whole of its own theme', () => {
    /*
     * L1, and it is a duplication guard rather than a behaviour: the change
     * that repaints a workspace's surfaces writes the palette's colours out as
     * SQL, so the palette and the SQL are the same eight sets of numbers said
     * twice. Three of the eight are proved end to end against a real store in
     * tests/integration/accounts/workspace-reads.test.ts - the seeded
     * workspaces - and the other five have nothing else holding them to the
     * palette at all. A theme retuned by hand and half-copied here is a
     * workspace painted in two palettes at once, and nothing would fail.
     */
    it.each(WORKSPACE_THEMES.map((theme) => ({ situation: theme.name, theme })))(
      'repaints $situation in the surfaces the palette gives it',
      ({ theme }) => {
        const ink = accountChanges('any-account-would-do').find(
          (change) => change.name === '0010-workspace-ink',
        );
        const sql = ink!.statements.map((statement) => statement.sql).join(' ');

        for (const surface of [theme.header, theme.bar, theme.ground]) {
          expect(sql, `${theme.name} is missing ${surface}`).toContain(
            `WHEN '${theme.tint}' THEN '${surface}'`,
          );
        }
      },
    );
  });
});
