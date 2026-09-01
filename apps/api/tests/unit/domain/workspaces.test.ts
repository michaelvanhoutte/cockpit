import { describe, expect, it } from 'vitest';
import { themeOf } from '@cockpit/shared';
import type { Workspace } from '@cockpit/shared';
import {
  WORKSPACE_PALETTE,
  nextColor,
  workspaceFromCommand,
  workspaceNamed,
} from '../../../src/domain/workspaces.js';

const TENANT_ID = 'tenant-default';
const AT = '2026-08-12T10:00:00.000Z';

/** A workspace wearing the whole theme its tint belongs to. */
function colored(
  workspace: { id: string; tenantId: string; name: string },
  tint: string,
): Workspace {
  const theme = themeOf(tint);
  return { ...workspace, color: theme.tint, ground: theme.ground, header: theme.header };
}

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

  describe('a workspace looking for a free name finds the one already using it, except itself', () => {
    // L1: which of a list of workspaces is in the way is a pure decision over
    // a list and a name. That both the make and the rename path actually ask
    // it is proved against a real database in tests/integration.
    const live = [
      // The colors are not what this rule is about; they are here because a
      // workspace carries them, and `themeOf` is what fills them in everywhere
      // else, so the fixture is not a second opinion about what goes together.
      colored({ id: 'ws-work', tenantId: TENANT_ID, name: 'Work' }, '#6f62b5'),
      colored({ id: 'ws-personal', tenantId: TENANT_ID, name: 'Personal' }, '#c06a45'),
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
        // The whole theme its tint belongs to, not just the tint: a workspace
        // has all three of its colors from the moment it is made.
        color: '#3f8f78',
        ground: '#d9ece6',
        header: '#bcdcd2',
        createdAt: AT,
        deletedAt: null,
      });
    });
  });
});
