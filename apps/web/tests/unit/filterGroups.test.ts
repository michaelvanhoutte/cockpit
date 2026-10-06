import { describe, expect, it } from 'vitest';
import type { Dashboard, Filing, FilterGrouping, Item, Layout, Panel } from '@cockpit/shared';
import { groupFilterRows } from '../../src/filterGroups';

/**
 * F1: which heading a Filter's row goes under is a calculation over rows,
 * Panels, Dashboards and Layouts the Workspace read already holds ("Group a
 * Filter panel's items by the Dashboard or Panel they are filed on", issue 805).
 * What a heading says and what a row under it says is
 * apps/web/tests/unit/components/ItemList.test.tsx, and that the choice is saved
 * and drawn again is tests/e2e/panels.test.ts.
 */

function anItem(id: string): Item {
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
    title: id,
    capturedMessage: null,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    sourceResolvedAt: null,
    typeId: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    dueDate: null,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

function aDashboard(id: string): Dashboard {
  return { id, tenantId: 'tenant', workspaceId: 'ws-work', name: id };
}

function aPanel(id: string, dashboardId: string, kind: Panel['kind'] = 'items'): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId,
    name: id,
    kind,
    format: 'plain',
    body: '',
    readOnly: false,
    filter: null,
    sort: null,
  };
}

function filed(panelId: string, itemId: string): Filing {
  return { panelId, itemId, position: 0 };
}

/** A Layout of these rows, each a list of the Panels across it. */
function aLayout(dashboardId: string, rows: string[][]): Layout {
  return {
    id: `layout-${dashboardId}`,
    tenantId: 'tenant',
    dashboardId,
    rows: rows.map((cells) => ({ height: null, cells: cells.map((panelId) => ({ panelId, span: 12 })) })),
  };
}

/** The headings a Filter would draw, each as its name and the ids of the rows under it. */
function drawn(
  grouping: FilterGrouping,
  items: Item[],
  filings: Filing[],
  panels: Panel[],
  dashboards: Dashboard[],
  layouts: Layout[] = [],
): [string, string[]][] {
  return groupFilterRows(items, grouping, filings, panels, dashboards, layouts).map((group) => [
    group.key,
    group.items.map((item) => item.id),
  ]);
}

const A = anItem('a');
const B = anItem('b');
const C = anItem('c');

describe('Panels', () => {
  describe('a grouped filter draws its rows under one heading per Dashboard or per Panel, in board order', () => {
    const dashboards = [aDashboard('today'), aDashboard('research')];
    const panels = [
      aPanel('falcon', 'today'),
      aPanel('anna', 'today'),
      aPanel('reading', 'research'),
      aPanel('empty', 'research'),
    ];

    it.each([
      {
        situation: 'grouped by nothing, which is one flat list the caller draws as it always did',
        grouping: 'none' as const,
        filings: [filed('falcon', 'a')],
        groups: [],
      },
      {
        situation: 'by Panel, items on three Panels',
        grouping: 'panel' as const,
        filings: [filed('falcon', 'a'), filed('anna', 'b'), filed('reading', 'c')],
        groups: [
          ['falcon', ['a']],
          ['anna', ['b']],
          ['reading', ['c']],
        ],
      },
      {
        situation: 'by Panel, an item filed on two Panels, which is under both',
        grouping: 'panel' as const,
        filings: [filed('falcon', 'a'), filed('reading', 'a')],
        groups: [
          ['falcon', ['a']],
          ['reading', ['a']],
        ],
      },
      {
        situation: 'by Dashboard, an item on two Panels of one Dashboard, which is under it once',
        grouping: 'dashboard' as const,
        filings: [filed('falcon', 'a'), filed('anna', 'a')],
        groups: [['today', ['a']]],
      },
      {
        situation: 'by Dashboard, an item on Panels of two Dashboards, which is under both',
        grouping: 'dashboard' as const,
        filings: [filed('falcon', 'a'), filed('reading', 'a')],
        groups: [
          ['today', ['a']],
          ['research', ['a']],
        ],
      },
      {
        situation: 'by Panel, Panels holding no match',
        grouping: 'panel' as const,
        filings: [filed('anna', 'a')],
        groups: [['anna', ['a']]],
      },
      {
        situation: 'by Dashboard, a Dashboard holding no match',
        grouping: 'dashboard' as const,
        filings: [filed('reading', 'a')],
        groups: [['research', ['a']]],
      },
      {
        situation: 'by Panel, an item filed nowhere, which has no Panel to be under',
        grouping: 'panel' as const,
        filings: [filed('falcon', 'a')],
        items: [A, B],
        groups: [['falcon', ['a']]],
      },
      {
        situation: 'the Filter matching nothing, which leaves no heading for the empty message to sit under',
        grouping: 'panel' as const,
        filings: [filed('falcon', 'a')],
        items: [],
        groups: [],
      },
    ])('$situation', ({ grouping, filings, items = [A, B, C], groups }) => {
      expect(drawn(grouping, items, filings, panels, dashboards)).toEqual(groups);
    });

    it('keeps the order the Filter sorted the rows in, inside every group', () => {
      const sorted = [C, A, B];
      const filings = [filed('falcon', 'a'), filed('falcon', 'b'), filed('falcon', 'c')];

      expect(drawn('panel', sorted, filings, panels, dashboards)).toEqual([['falcon', ['c', 'a', 'b']]]);
    });

    it('counts a filing onto a Filter or a Panel since deleted for nothing', () => {
      const gathers = aPanel('gather', 'today', 'filter');
      const filings = [filed('gather', 'a'), filed('gone', 'a'), filed('anna', 'a')];

      expect(drawn('panel', [A], filings, [...panels, gathers], dashboards)).toEqual([['anna', ['a']]]);
    });
  });

  describe('a grouped filter goes in board order, whatever order things were made in', () => {
    const everywhere = [filed('p1', 'a'), filed('p2', 'a'), filed('p3', 'a'), filed('p4', 'a')];

    it('puts Dashboards in tab order, which is not the order their Panels were made in', () => {
      const dashboards = [aDashboard('second-tab'), aDashboard('first-tab')];
      const panels = [aPanel('p1', 'first-tab'), aPanel('p2', 'second-tab')];

      expect(drawn('dashboard', [A], everywhere, panels, dashboards).map(([key]) => key)).toEqual([
        'second-tab',
        'first-tab',
      ]);
      expect(drawn('panel', [A], everywhere, panels, dashboards).map(([key]) => key)).toEqual(['p2', 'p1']);
    });

    it('puts a Dashboard’s Panels row by row and left to right, as its Layout draws them', () => {
      const dashboards = [aDashboard('today')];
      // Made in the order p1..p4, arranged with p3 and p1 across the top.
      const panels = [aPanel('p1', 'today'), aPanel('p2', 'today'), aPanel('p3', 'today'), aPanel('p4', 'today')];
      const layouts = [aLayout('today', [['p3', 'p1'], ['p4', 'p2']])];

      expect(drawn('panel', [A], everywhere, panels, dashboards, layouts).map(([key]) => key)).toEqual([
        'p3',
        'p1',
        'p4',
        'p2',
      ]);
    });

    it('puts the Panels of a Dashboard never arranged in the order they come in', () => {
      const dashboards = [aDashboard('today')];
      const panels = [aPanel('p2', 'today'), aPanel('p1', 'today'), aPanel('p3', 'today')];

      expect(drawn('panel', [A], everywhere, panels, dashboards).map(([key]) => key)).toEqual(['p2', 'p1', 'p3']);
    });

    it('draws a Panel the Layout has never heard of after the ones it has, and leaves out one it names that is gone', () => {
      const dashboards = [aDashboard('today')];
      const panels = [aPanel('p1', 'today'), aPanel('p2', 'today')];
      const layouts = [aLayout('today', [['p2', 'deleted']])];

      expect(drawn('panel', [A], everywhere, panels, dashboards, layouts).map(([key]) => key)).toEqual(['p2', 'p1']);
    });
  });
});
