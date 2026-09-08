import { describe, expect, it } from 'vitest';
import type { ScreenSize } from '@cockpit/shared';
import { screenSizeNamed } from '../../../src/domain/screen-sizes.js';

const TENANT_ID = 'tenant-default';
const AT = '2026-09-08T10:00:00.000Z';

function size(id: string, name: string, width: number): ScreenSize {
  return { id, tenantId: TENANT_ID, name, width, createdAt: AT };
}

describe('Layouts', () => {
  describe('a screen size looking for a free name finds the one already using it, except itself', () => {
    // L1: which of the account's sizes is in the way is a pure decision over a
    // list and a name, folded exactly as every other name in the app is
    // (`namedTheSame`, domain/names.ts, which carries its own case-folding
    // table). That the create and rename commands actually ask it is proved
    // against a real database in tests/integration.
    const live = [size('sz-wide', 'Wide', 1280), size('sz-phone', 'Phone', 430)];

    it.each([
      { situation: 'a name nobody is using', asked: 'Tablet', by: undefined, inTheWay: undefined },
      { situation: 'a name another size has', asked: 'Wide', by: undefined, inTheWay: 'Wide' },
      {
        situation: 'that name in another capitalisation',
        asked: 'WIDE',
        by: undefined,
        inTheWay: 'Wide',
      },
      {
        // Renaming a size to what it is already called finds only itself, and
        // being in your own way is not a collision - without this, changing
        // nothing but capitalization would be refused.
        situation: 'its own name, asked by the size that has it',
        asked: 'Wide',
        by: 'sz-wide',
        inTheWay: undefined,
      },
      {
        situation: 'another size’s name, asked by a size being renamed',
        asked: 'Phone',
        by: 'sz-wide',
        inTheWay: 'Phone',
      },
    ])('$situation', ({ asked, by, inTheWay }) => {
      expect(screenSizeNamed(live, asked, by)?.name).toBe(inTheWay);
    });
  });
});
