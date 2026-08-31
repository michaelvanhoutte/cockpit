import { describe, expect, it } from 'vitest';
import { WORKSPACE_PALETTE, nextColor, workspaceFromCommand } from '../../../src/domain/workspaces.js';

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
