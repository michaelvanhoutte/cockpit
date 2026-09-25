import { describe, expect, it } from 'vitest';
import type { Item, ItemType, PanelSort, Priority } from '@cockpit/shared';
import { inSortOrder, saysHowItIsSorted } from '../../src/sorting';

/**
 * F1: the order a sorted Panel draws its rows in is worked out in the client
 * from what it already holds, so it is the client's own logic with nothing to
 * prove against a store. That a sort is kept on the Panel is
 * apps/api/tests/integration/http/panels.test.ts; that the board draws its rows
 * through this is apps/web/tests/unit/components/PanelBoard.test.tsx.
 *
 * Every list below is handed over in the order you set, which is what a full
 * tie falls back to.
 */

function anItem(
  id: string,
  holding: {
    title?: string;
    dueDate?: string | null;
    priority?: Priority | null;
    typeId?: string | null;
    createdAt?: string;
  } = {},
): Item {
  return {
    id,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: holding.title ?? id,
    capturedMessage: null,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    sourceResolvedAt: null,
    typeId: holding.typeId ?? null,
    nextAction: null,
    completedAt: null,
    priority: holding.priority ?? null,
    dueDate: holding.dueDate ?? null,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: holding.createdAt ?? '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

function aType(id: string): ItemType {
  return { id, tenantId: 'tenant', name: id, color: '#000000', position: 0, createdAt: '2026-08-31T08:00:00.000Z' };
}

/** Your Types, in the order you put them: OKR before Task before Idea. */
const TYPES = [aType('okr'), aType('task'), aType('idea')];

const ids = (items: readonly Item[]) => items.map((item) => item.id);

describe('Panels', () => {
  describe('a sorted panel draws its rows by the first criterion, then the next wherever two tie, then the order you set', () => {
    it.each([
      {
        situation: 'Title, A to Z whatever the case',
        items: [anItem('b', { title: 'banana' }), anItem('c', { title: 'Cherry' }), anItem('a', { title: 'Apple' })],
        field: 'title' as const,
        ascending: ['a', 'b', 'c'],
      },
      {
        situation: 'Priority, Low to High',
        items: [anItem('high', { priority: 'high' }), anItem('low', { priority: 'low' }), anItem('normal', { priority: 'normal' })],
        field: 'priority' as const,
        ascending: ['low', 'normal', 'high'],
      },
      {
        situation: 'Created, oldest first',
        items: [
          anItem('new', { createdAt: '2026-09-03T08:00:00.000Z' }),
          anItem('old', { createdAt: '2026-09-01T08:00:00.000Z' }),
          anItem('mid', { createdAt: '2026-09-02T08:00:00.000Z' }),
        ],
        field: 'createdAt' as const,
        ascending: ['old', 'mid', 'new'],
      },
      {
        situation: 'Due date, soonest first',
        items: [anItem('later', { dueDate: '2026-10-01' }), anItem('soon', { dueDate: '2026-09-20' }), anItem('mid', { dueDate: '2026-09-25' })],
        field: 'dueDate' as const,
        ascending: ['soon', 'mid', 'later'],
      },
      {
        situation: 'Type, in the order of your Types',
        items: [anItem('an-idea', { typeId: 'idea' }), anItem('an-okr', { typeId: 'okr' }), anItem('a-task', { typeId: 'task' })],
        field: 'type' as const,
        ascending: ['an-okr', 'a-task', 'an-idea'],
      },
    ])('by $situation, and the reverse descending', ({ items, field, ascending }) => {
      expect(ids(inSortOrder(items, [{ field, direction: 'asc' }], TYPES))).toEqual(ascending);
      expect(ids(inSortOrder(items, [{ field, direction: 'desc' }], TYPES))).toEqual([...ascending].reverse());
    });

    it('breaks a tie on the first criterion by the second', () => {
      const items = [
        anItem('same-day-low', { dueDate: '2026-09-20', priority: 'low' }),
        anItem('later-high', { dueDate: '2026-09-25', priority: 'high' }),
        anItem('same-day-high', { dueDate: '2026-09-20', priority: 'high' }),
      ];
      const sort: PanelSort = [
        { field: 'dueDate', direction: 'asc' },
        { field: 'priority', direction: 'desc' },
      ];

      expect(ids(inSortOrder(items, sort, TYPES))).toEqual(['same-day-high', 'same-day-low', 'later-high']);
    });

    it('keeps the order you set where every criterion ties', () => {
      const items = [
        anItem('set-first', { priority: 'high' }),
        anItem('set-second', { priority: 'high' }),
        anItem('set-third', { priority: 'high' }),
      ];

      expect(ids(inSortOrder(items, [{ field: 'priority', direction: 'desc' }], TYPES))).toEqual([
        'set-first',
        'set-second',
        'set-third',
      ]);
    });
  });

  describe('an item with no value for a criterion goes after every item that has one, in either direction', () => {
    it.each([
      {
        situation: 'no due date',
        field: 'dueDate' as const,
        items: [anItem('none'), anItem('late', { dueDate: '2026-10-01' }), anItem('soon', { dueDate: '2026-09-20' })],
      },
      {
        situation: 'no priority',
        field: 'priority' as const,
        items: [anItem('none'), anItem('late', { priority: 'high' }), anItem('soon', { priority: 'low' })],
      },
      {
        situation: 'no Type',
        field: 'type' as const,
        items: [anItem('none'), anItem('late', { typeId: 'idea' }), anItem('soon', { typeId: 'okr' })],
      },
      {
        situation: 'a Type since deleted',
        field: 'type' as const,
        items: [anItem('none', { typeId: 'deleted' }), anItem('late', { typeId: 'idea' }), anItem('soon', { typeId: 'okr' })],
      },
      {
        situation: 'no title',
        field: 'title' as const,
        items: [anItem('none', { title: '  ' }), anItem('late', { title: 'Zebra' }), anItem('soon', { title: 'Apple' })],
      },
    ])('$situation', ({ field, items }) => {
      expect(ids(inSortOrder(items, [{ field, direction: 'asc' }], TYPES))).toEqual(['soon', 'late', 'none']);
      expect(ids(inSortOrder(items, [{ field, direction: 'desc' }], TYPES))).toEqual(['late', 'soon', 'none']);
    });
  });

  describe('the sort mark reads the sort back as a sentence', () => {
    it('names each criterion and its direction, in order', () => {
      expect(
        saysHowItIsSorted([
          { field: 'dueDate', direction: 'asc' },
          { field: 'priority', direction: 'desc' },
        ]),
      ).toBe('Sorted: Due date ascending, then Priority descending');
    });
  });
});
