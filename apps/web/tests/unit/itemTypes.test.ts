import { describe, expect, it } from 'vitest';
import type { Item, ItemType } from '@cockpit/shared';
import { typeOf, typesOffered, typeToOffer } from '../../src/itemTypes';

/**
 * F1: which types capture offers is a view over the snapshot evaluated in the
 * client, so this is the client's own logic and there is no query to prove
 * against a database.
 */

function aType(name: string, at: number): ItemType {
  return {
    id: `type-${at}`,
    tenantId: 'tenant',
    name,
    color: '#6f62b5',
    position: at,
    createdAt: '2026-08-31T08:00:00.000Z',
  };
}

const ACTION = aType('Action', 0);
const THOUGHT = aType('Thought', 1);
const QUESTION = aType('Question', 2);
const DECISION = aType('Decision', 3);
const EVERY = [ACTION, THOUGHT, QUESTION, DECISION];

/** An item of this type, made after every item before it in the list. */
function anItemOf(type: ItemType | null, at: number): Item {
  return {
    id: `item-${at}`,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: `item ${at}`,
    capturedMessage: null,
    description: null,
    sourceResolvedAt: null,
    typeId: type?.id ?? null,
    nextAction: null,
    completedAt: null,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: `2026-08-31T08:00:0${at}.000Z`,
    updatedAt: `2026-08-31T08:00:0${at}.000Z`,
  };
}

const used = (...types: (ItemType | null)[]) => types.map((type, at) => anItemOf(type, at));
const names = (types: readonly ItemType[]) => types.map((type) => type.name);

describe('Capture', () => {
  describe('capture offers the types you already have, the ones you used last first', () => {
    it.each([
      { situation: 'none used yet', items: used(), order: ['Action', 'Thought', 'Question', 'Decision'] },
      { situation: 'one used', items: used(QUESTION), order: ['Question', 'Action', 'Thought', 'Decision'] },
      {
        situation: 'three used',
        items: used(ACTION, THOUGHT, QUESTION),
        order: ['Question', 'Thought', 'Action', 'Decision'],
      },
      {
        // Four used and three kept, so the oldest of them drops back into the
        // list rather than being offered twice.
        situation: 'more than three used',
        items: used(DECISION, ACTION, THOUGHT, QUESTION),
        order: ['Question', 'Thought', 'Action', 'Decision'],
      },
      {
        situation: 'the same one used twice',
        items: used(THOUGHT, THOUGHT),
        order: ['Thought', 'Action', 'Question', 'Decision'],
      },
      {
        situation: 'items with no type at all',
        items: used(null, null),
        order: ['Action', 'Thought', 'Question', 'Decision'],
      },
      {
        // A type deleted in another tab is not a recent one, and skipping it
        // rather than leaving a hole is what keeps three entries three types.
        situation: 'an item of a type that has gone',
        items: [anItemOf(aType('Gone', 9), 0), anItemOf(THOUGHT, 1)],
        order: ['Thought', 'Action', 'Question', 'Decision'],
      },
    ])('$situation', ({ items, order }) => {
      expect(names(typesOffered(EVERY, items))).toEqual(order);
    });

    it('offers nothing when the account has no types', () => {
      expect(typesOffered([], used())).toEqual([]);
      expect(typeToOffer([], used())).toBeUndefined();
    });

    it('offers the rest in the order the types page put them in', () => {
      // The types arrive in that order and nothing here re-sorts them, which
      // is what makes moving one on the settings page change what capture
      // offers ("Manage the types, and put them in the order you want", issue
      // 156).
      const putInOrder = [DECISION, QUESTION, THOUGHT, ACTION];

      expect(names(typesOffered(putInOrder, used()))).toEqual([
        'Decision',
        'Question',
        'Thought',
        'Action',
      ]);
      // And the ones used last still come first, over the order set there.
      expect(names(typesOffered(putInOrder, used(ACTION)))).toEqual([
        'Action',
        'Decision',
        'Question',
        'Thought',
      ]);
    });

    it('opens on the one used last', () => {
      expect(typeToOffer(EVERY, used(ACTION, QUESTION))?.name).toBe('Question');
    });
  });

  describe('a row shows what type it is', () => {
    it.each([
      { situation: 'a type it has', item: anItemOf(THOUGHT, 0), shows: 'Thought' },
      { situation: 'no type at all', item: anItemOf(null, 0), shows: undefined },
      { situation: 'a type that has gone', item: anItemOf(aType('Gone', 9), 0), shows: undefined },
    ])('$situation', ({ item, shows }) => {
      expect(typeOf(EVERY, item)?.name).toBe(shows);
    });
  });
});
