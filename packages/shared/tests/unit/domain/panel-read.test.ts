import { describe, expect, it } from 'vitest';
import type { Dashboard, Item, Priority, Workspace } from '../../../src/domain/item.js';
import type { Filing, Layout, Panel, PanelFilter } from '../../../src/domain/panel.js';
import { panelList, panelRead, panelsInBoardOrder, placesOf } from '../../../src/domain/panel-read.js';
import type { ReadableSnapshot } from '../../../src/domain/panel-read.js';

/**
 * L1: what a widget is told of a Panel is worked out from the Workspace's rows
 * by the rules the browser draws with, so the order of the list, what it
 * leaves out and the place line of a row are pure logic. That the answer is
 * reached, and reached only by an app allowed to read, is
 * apps/api/tests/integration/http/panel-reads.test.ts.
 */

function aWorkspace(id: string, color = '#6f62b5'): Workspace {
  return { id, tenantId: 'tenant', name: id, color, bar: '#fff', ground: '#fff', header: '#fff' };
}

function aDashboard(id: string, workspaceId = 'ws-work'): Dashboard {
  return { id, tenantId: 'tenant', workspaceId, name: id };
}

function aPanel(id: string, dashboardId: string, kind: Panel['kind'] = 'items', filter: PanelFilter | null = null): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId,
    name: id,
    kind,
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter,
    sort: null,
    columns: null,
  };
}

function aLayout(dashboardId: string, rows: string[][]): Layout {
  return {
    id: `layout-${dashboardId}`,
    tenantId: 'tenant',
    dashboardId,
    rows: rows.map((cells) => ({ height: null, cells: cells.map((panelId) => ({ panelId, span: 12 })) })),
  };
}

function anItem(id: string, holding: { priority?: Priority | null; dueDate?: string | null; title?: string } = {}): Item {
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
    proposedPanelFit: null,
    claudeProposals: null,
    seriesId: null,
    sourceResolvedAt: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    waitingSince: null,
    priority: holding.priority ?? null,
    prioritySetAt: null,
    dueDateChosenAt: null,
    capturedTimeZone: null,
    dueDate: holding.dueDate ?? null,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

function filed(panelId: string, itemId: string, position = 0): Filing {
  return { panelId, itemId, position };
}

describe('Panels', () => {
  describe('the Panel list holds every Workspace’s Dashboards and Panels in the order Cockpit shows them, with no Items', () => {
    const work = {
      workspace: aWorkspace('ws-work', '#2f6f9f'),
      dashboards: [aDashboard('tab-two'), aDashboard('tab-one')],
      panels: [
        aPanel('made-first', 'tab-one'),
        aPanel('made-second', 'tab-one', 'filter'),
        aPanel('made-third', 'tab-one'),
        aPanel('on-two', 'tab-two'),
      ],
      layouts: [aLayout('tab-one', [['made-third', 'made-first'], ['made-second']])],
    };
    const home = {
      workspace: aWorkspace('ws-home', '#9f4a2f'),
      dashboards: [aDashboard('only', 'ws-home')],
      panels: [aPanel('chores', 'only')],
      layouts: [],
    };

    it('lists Workspaces in tab order, each with its colour', () => {
      const { workspaces } = panelList([work, home]);

      expect(workspaces.map(({ id, color }) => [id, color])).toEqual([
        ['ws-work', '#2f6f9f'],
        ['ws-home', '#9f4a2f'],
      ]);
    });

    it('lists a Workspace’s Dashboards in tab order', () => {
      const [first] = panelList([work]).workspaces;

      expect(first!.dashboards.map((dashboard) => dashboard.id)).toEqual(['tab-two', 'tab-one']);
    });

    it('lists a Dashboard’s Panels in board order, each named with its kind', () => {
      const [first] = panelList([work]).workspaces;
      const [, tabOne] = first!.dashboards;

      // As its Layout draws them - row by row, left to right - not as they were made.
      expect(tabOne!.panels).toEqual([
        { id: 'made-third', name: 'made-third', kind: 'items' },
        { id: 'made-first', name: 'made-first', kind: 'items' },
        { id: 'made-second', name: 'made-second', kind: 'filter' },
      ]);
    });

    it('leaves out a Panel of text, which holds no Items to read', () => {
      const withText = { ...work, panels: [...work.panels, aPanel('notes', 'tab-one', 'text')] };

      const ids = panelList([withText]).workspaces.flatMap((w) => w.dashboards.flatMap((d) => d.panels.map((p) => p.id)));

      expect(ids).not.toContain('notes');
      expect(ids).toHaveLength(4);
    });

    it('carries no Item at all', () => {
      expect(JSON.stringify(panelList([work, home]))).not.toMatch(/itemId|label|dueDate|priority/);
    });
  });

  describe('each row carries what the widget draws: its label, priority, due date and every other Panel it is filed on, or Inbox', () => {
    const dashboards = [aDashboard('work'), aDashboard('home')];
    const panels = [
      aPanel('finance', 'work'),
      aPanel('proposals', 'work'),
      aPanel('hasselt', 'work'),
      aPanel('admin', 'home'),
      aPanel('this-week', 'work', 'filter', {
        groupBy: 'none',
        rows: [[{ field: 'dueDate', window: 'week', orOverdue: true }]],
      }),
    ];
    const read = (items: Item[], filings: Filing[], panelId: string, layouts: Layout[] = []) =>
      panelRead(
        { workspace: aWorkspace('ws-work'), dashboards, panels, layouts, items, filings, agentRuns: [] } satisfies ReadableSnapshot,
        panelId,
        '2026-10-23',
      )!;
    /** The place line of an Item read under `notAgainst`, with every Panel in board order. */
    const placeLine = (filings: Filing[], notAgainst: string, layouts: Layout[] = []) =>
      placesOf(
        anItem('a'),
        filings,
        panelsInBoardOrder({ dashboards, panels, layouts }),
        dashboards,
        notAgainst,
      );

    it.each([
      { situation: 'filed on this Panel only', read: 'finance', filings: [filed('finance', 'a')], places: [] },
      {
        situation: 'filed on this Panel and one other',
        read: 'finance',
        filings: [filed('finance', 'a'), filed('admin', 'a')],
        places: ['home ▸ admin'],
      },
      {
        situation: 'filed on two others, read through a Filter panel, in board order - not the order the Panels were made or filed in',
        read: 'this-week',
        filings: [filed('finance', 'a'), filed('hasselt', 'a')],
        places: ['work ▸ hasselt', 'work ▸ finance'],
      },
      { situation: 'on no Panel, read through a Filter panel', read: 'this-week', filings: [], places: ['Inbox'] },
    ])('$situation', ({ read: panelId, filings, places }) => {
      expect(placeLine(filings, panelId, [aLayout('work', [['hasselt'], ['finance']])])).toEqual(places);
    });

    it('sorts titles in English, whatever the runtime it is worked out in would sort them by', () => {
      const items = [anItem('z', { title: 'Zebra' }), anItem('a-umlaut', { title: 'Ärlig' }), anItem('a', { title: 'Apa' })];
      const sortedByTitle = panels.map((panel) =>
        panel.id === 'finance' ? { ...panel, sort: [{ field: 'title' as const, direction: 'asc' as const }] } : panel,
      );

      const read = panelRead(
        {
          workspace: aWorkspace('ws-work'),
          dashboards,
          panels: sortedByTitle,
          layouts: [],
          items,
          filings: items.map((item) => filed('finance', item.id)),
          agentRuns: [],
        },
        'finance',
        '2026-10-23',
      )!;

      expect(read.groups[0]!.rows.map((row) => row.label)).toEqual(['Apa', 'Ärlig', 'Zebra']);
    });

    it('says a row’s label, priority and due date as they are on the Item', () => {
      const items = [anItem('a', { priority: 'high', dueDate: '2026-10-21', title: 'Send the forecast' })];

      const [row] = read(items, [filed('finance', 'a')], 'finance').groups[0]!.rows;

      expect(row).toEqual({
        itemId: 'a',
        label: 'Send the forecast',
        priority: 'high',
        dueDate: '2026-10-21',
        places: [],
      });
    });
  });
});
