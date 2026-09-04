import { describe, expect, it } from 'vitest';
import type { ItemType } from '@cockpit/shared';
import { ITEM_TYPE_COLORS } from '@cockpit/shared';
import { itemTypeFromCommand, itemTypeNamed } from '../../../src/domain/item-types.js';

const AT = '2026-09-04T10:00:00.000Z';

const request = {
  commandId: '018f0000-0000-7000-8000-000000000001',
  workspaceId: 'ws-work',
  issuedAt: AT,
};

function aType(name: string, color: string, at = 0): ItemType {
  return {
    id: `11111111-1111-7111-8111-${String(at).padStart(12, '0')}`,
    tenantId: 'tenant-default',
    name,
    color,
    position: at,
    createdAt: AT,
  };
}

const made = (name: string, taken: ItemType[] = []) =>
  itemTypeFromCommand(
    { ...request, typeId: '018f0000-0000-7000-8000-000000000009', name },
    'tenant-default',
    taken,
  );

describe('Capture', () => {
  describe('naming a type already there reuses it; naming a new one creates it', () => {
    const taken = [aType('Action', ITEM_TYPE_COLORS[0]!, 0), aType('Thought', ITEM_TYPE_COLORS[1]!, 1)];

    it.each([
      { situation: 'the exact name', name: 'Thought', reuses: true },
      { situation: 'a different capitalisation', name: 'THOUGHT', reuses: true },
      { situation: 'the name with blanks round it', name: '  thought  ', reuses: true },
      // Case folding rather than lowercasing, which is what makes these one
      // name: `STRASSE` lowercases to `strasse` while `Straße` stays `straße`.
      { situation: 'a name that only folds together', name: 'STRASSE', reuses: false },
      { situation: 'a name never used', name: 'Question', reuses: false },
    ])('$situation', ({ name, reuses }) => {
      expect(itemTypeNamed(taken, name) !== undefined).toBe(reuses);
    });

    it('folds the pair that lowercasing alone would leave apart', () => {
      expect(itemTypeNamed([aType('Straße', ITEM_TYPE_COLORS[0]!)], 'STRASSE')).toBeDefined();
    });
  });

  describe('a type never exists without a colour, and gets one no other type is using', () => {
    it('takes the first colour nothing is wearing', () => {
      const taken = [aType('Action', ITEM_TYPE_COLORS[0]!, 0)];

      expect(made('Thought', taken).color).toBe(ITEM_TYPE_COLORS[1]);
    });

    it('gives the first type the first colour', () => {
      expect(made('Action').color).toBe(ITEM_TYPE_COLORS[0]);
    });

    it('repeats a colour rather than refusing once the palette is spent', () => {
      const taken = ITEM_TYPE_COLORS.map((color, at) => aType(`Type ${at}`, color, at));

      // The name is what carries the meaning; a shared dot is a pair you read
      // the word to tell apart, and that is better than not being able to say
      // what a thing is.
      expect(ITEM_TYPE_COLORS).toContain(made('One more', taken).color);
    });
  });
});
