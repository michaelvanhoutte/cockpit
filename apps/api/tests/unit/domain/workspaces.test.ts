import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_PALETTE,
  foldName,
  nextColor,
  workspaceFromCommand,
  workspaceNamed,
} from '../../../src/domain/workspaces.js';

const TENANT_ID = 'tenant-default';
const AT = '2026-08-12T10:00:00.000Z';

/** Colors handed out to `taken` workspaces in a row, starting from none. */
function handOut(count: number): string[] {
  const given: string[] = [];
  for (let i = 0; i < count; i += 1) given.push(nextColor(given));
  return given;
}

describe('Workspace management', () => {
  describe('every workspace gets a color of its own without being asked for one', () => {
    it('takes a color no other workspace is using', () => {
      const taken = WORKSPACE_PALETTE.filter((c) => c !== WORKSPACE_PALETTE[2]);
      expect(nextColor(taken)).toBe(WORKSPACE_PALETTE[2]);
    });

    it('still gets one once every color is in use', () => {
      const everything = [...WORKSPACE_PALETTE];
      expect(WORKSPACE_PALETTE).toContain(nextColor(everything));
    });

    it('gives no two workspaces in a row the same color', () => {
      const given = handOut(WORKSPACE_PALETTE.length * 2 + 1);
      const repeats = given.filter((color, i) => i > 0 && color === given[i - 1]);
      expect(repeats).toEqual([]);
    });

    it('gives every workspace its own color while the palette lasts', () => {
      const given = handOut(WORKSPACE_PALETTE.length);
      expect(new Set(given).size).toBe(WORKSPACE_PALETTE.length);
    });
  });

  describe('two names are the same name when only their case differs, in any alphabet', () => {
    // L1: which names count as the same one is a pure decision over two
    // strings. That the second of them is then actually refused - by the
    // handler, and by the index behind it - is proved against a real database
    // in tests/integration.
    it.each([
      { situation: 'the same accented name in another case', one: 'ÉTÉ', other: 'été', same: true },
      { situation: 'the same plain name in another case', one: 'Personal', other: 'personal', same: true },
      // Lower case alone would leave these two apart: `STRASSE` lowercases to
      // `strasse` while `Straße` stays as it is. Upper case expands the sharp
      // s first, which is what makes them meet.
      { situation: 'a name whose sharp s is written out in the other case', one: 'STRASSE', other: 'Straße', same: true },
      { situation: 'a name that differs by an accent rather than by case', one: 'Reunions', other: 'Réunions', same: false },
      { situation: 'the same name with blanks around one of them', one: '  Réunions ', other: 'Réunions', same: true },
    ])('$situation', ({ one, other, same }) => {
      expect(foldName(one) === foldName(other)).toBe(same);
    });
  });

  describe('a workspace looking for a free name finds the one already using it, except itself', () => {
    // L1: which of a list of workspaces is in the way is a pure decision over
    // a list and a name. That both the make and the rename path actually ask
    // it is proved against a real database in tests/integration.
    const live = [
      { id: 'ws-work', tenantId: TENANT_ID, name: 'Work', color: '#6f62b5' },
      { id: 'ws-personal', tenantId: TENANT_ID, name: 'Personal', color: '#c06a45' },
    ];

    it.each([
      { situation: 'a name nobody is using', asked: 'Bookkeeping', by: undefined, inTheWay: undefined },
      { situation: 'a name another workspace has', asked: 'Personal', by: undefined, inTheWay: 'Personal' },
      {
        situation: 'a name another workspace has, in another case',
        asked: 'PERSONAL',
        by: undefined,
        inTheWay: 'Personal',
      },
      {
        // The case this exists for: renaming a workspace to what it is already
        // called finds only itself, and being in your own way is not a
        // collision. Without it, changing nothing but capitalization fails.
        situation: 'its own name, asked by the workspace that has it',
        asked: 'Personal',
        by: 'ws-personal',
        inTheWay: undefined,
      },
      {
        situation: 'its own name in another case, asked by the workspace that has it',
        asked: 'PERSONAL',
        by: 'ws-personal',
        inTheWay: undefined,
      },
      {
        situation: 'another workspace’s name, asked by a workspace being renamed',
        asked: 'Work',
        by: 'ws-personal',
        inTheWay: 'Work',
      },
    ])('$situation', ({ asked, by, inTheWay }) => {
      // The name as that workspace spells it, so a refusal can name what is
      // actually on screen rather than what was typed.
      expect(workspaceNamed(live, asked, by)?.name).toBe(inTheWay);
    });
  });

  describe('a new workspace starts out empty and belongs to the person who made it', () => {
    it('records the name, the color and who it belongs to', () => {
      const workspace = workspaceFromCommand(
        { commandId: 'c', issuedAt: AT, workspaceId: 'ws-new', name: 'Personal' },
        TENANT_ID,
        '#3f8f78',
      );
      expect(workspace).toEqual({
        id: 'ws-new',
        tenantId: TENANT_ID,
        name: 'Personal',
        // The copy the unique index holds, so that two names differing only in
        // case are one name whatever alphabet they are written in ("Workspace
        // names are only case-insensitive in ASCII", issue 91). Which names
        // that makes the same is proved through the interface, in
        // tests/integration/http/workspace-management.test.ts.
        foldedName: 'personal',
        // Written, read by nothing, and dropped by "Drop the unused workspace
        // slug column" (issue 78); the id is used because it is unique without
        // inventing a second naming rule.
        slug: 'ws-new',
        color: '#3f8f78',
        createdAt: AT,
        deletedAt: null,
      });
    });
  });
});
