import { describe, expect, it } from 'vitest';
import type { Dashboard, Filing, Item, Panel, PanelFilter } from '@cockpit/shared';
import {
  distinctPanelNames,
  itemsOnPanelsNamed,
  panelsNamed,
  type WorkspaceBoard,
} from '../../../src/domain/panel-search.js';

/**
 * L1: which Items a connected app gets when it names a Panel: those filed on a
 * Panel of that name or gathered by a Filter panel of that name, the way Find
 * item's Dashboard mode counts them. That the Panels and filings come from the
 * account's own store, one Workspace at a time, and that an app is told the
 * names there are, is tests/integration/http/find-items.test.ts and
 * tests/unit/mcp/find-items.test.ts.
 */

const anItem = (id: string, over: Partial<Item> = {}): Item =>
  ({ id, title: id, description: null, nextAction: null, sender: null, startedAt: null, completedAt: null, priority: null, dueDate: null, createdAt: '2026-10-01T00:00:00.000Z', ...over }) as Item;

const aDashboard = (id: string): Dashboard => ({ id, name: id }) as Dashboard;

const aPanel = (id: string, name: string, dashboardId = 'd1', over: Partial<Panel> = {}): Panel =>
  ({ id, name, dashboardId, kind: 'items', filter: null, ...over }) as Panel;

const aFilter = (id: string, name: string, rows: PanelFilter['rows'], dashboardId = 'd1'): Panel =>
  aPanel(id, name, dashboardId, { kind: 'filter', filter: { rows, groupBy: 'none' } });

const filed = (panelId: string, itemId: string): Filing => ({ panelId, itemId, position: 0 });

const board = (over: Partial<WorkspaceBoard>): WorkspaceBoard => ({
  items: [],
  filings: [],
  panels: [],
  dashboards: [aDashboard('d1'), aDashboard('d2')],
  withRun: new Set(),
  ...over,
});

const TODAY = '2026-10-19';
const idsOn = (b: WorkspaceBoard, name: string, today = TODAY) =>
  itemsOnPanelsNamed(b, name, today).map((item) => item.id).toSorted();

describe('MCP connections', () => {
  describe('an app finds the items on a panel by its name', () => {
    it('finds the items filed on a panel of that name, and not those filed elsewhere or nowhere', () => {
      const b = board({
        items: [anItem('one'), anItem('two'), anItem('elsewhere'), anItem('in-the-inbox')],
        panels: [aPanel('admin', 'Admin'), aPanel('waiting', 'Waiting')],
        filings: [filed('admin', 'one'), filed('admin', 'two'), filed('waiting', 'elsewhere')],
      });

      expect(idsOn(b, 'Admin')).toEqual(['one', 'two']);
    });

    it('finds the items a Filter panel of that name gathers, as the screen draws them', () => {
      const b = board({
        items: [anItem('urgent', { priority: 'high' }), anItem('calm', { priority: 'low' }), anItem('urgent-but-unfiled', { priority: 'high' })],
        panels: [aPanel('admin', 'Admin'), aFilter('hot', 'Hot', [[{ field: 'priority', values: ['high'] }]])],
        filings: [filed('admin', 'urgent'), filed('admin', 'calm')],
      });

      expect(idsOn(b, 'Hot')).toEqual(['urgent']);
    });

    it('finds the items of two panels going by the name on different dashboards', () => {
      const b = board({
        items: [anItem('on-first'), anItem('on-second'), anItem('on-neither')],
        panels: [aPanel('p1', 'Admin', 'd1'), aPanel('p2', 'Admin', 'd2'), aPanel('p3', 'Other', 'd2')],
        filings: [filed('p1', 'on-first'), filed('p2', 'on-second'), filed('p3', 'on-neither')],
      });

      expect(idsOn(b, 'Admin')).toEqual(['on-first', 'on-second']);
    });

    it('finds an item once though it is filed on a panel and gathered by a Filter panel of the name', () => {
      const b = board({
        items: [anItem('both', { priority: 'high' })],
        panels: [aPanel('p1', 'Admin'), aFilter('f1', 'Admin', [[{ field: 'priority', values: ['high'] }]], 'd2')],
        filings: [filed('p1', 'both')],
      });

      expect(idsOn(b, 'Admin')).toEqual(['both']);
    });

    it('takes the name in any case, around spaces', () => {
      const b = board({ items: [anItem('one')], panels: [aPanel('p1', 'Admin & money')], filings: [filed('p1', 'one')] });

      expect(idsOn(b, '  ADMIN & Money ')).toEqual(['one']);
    });

    it('finds nothing on a panel no one has, and nothing on a panel of text, which files nothing', () => {
      const b = board({
        items: [anItem('one')],
        panels: [aPanel('p1', 'Admin'), aPanel('notes', 'Notes', 'd1', { kind: 'text' })],
        filings: [filed('p1', 'one')],
      });

      expect(idsOn(b, 'Garden')).toEqual([]);
      expect(idsOn(b, 'Notes')).toEqual([]);
    });

    it('does not find an item filed only on a Filter panel, which is the Inbox as the screen reads it', () => {
      const b = board({
        items: [anItem('strange')],
        panels: [aFilter('f1', 'Hot', [[{ field: 'priority', values: ['high'] }]])],
        filings: [filed('f1', 'strange')],
      });

      expect(idsOn(b, 'Hot')).toEqual([]);
    });

    it('does not find a finished item, which is on no dashboard', () => {
      const b = board({
        items: [anItem('open'), anItem('finished', { completedAt: '2026-10-18T00:00:00.000Z' })],
        panels: [aPanel('p1', 'Admin')],
        filings: [filed('p1', 'open'), filed('p1', 'finished')],
      });

      expect(idsOn(b, 'Admin')).toEqual(['open']);
    });
  });

  describe('an app finds what a Filter panel gathers counted from the day it gives', () => {
    const b = board({
      items: [anItem('this-week', { dueDate: '2026-10-21' }), anItem('next-week', { dueDate: '2026-10-28' })],
      panels: [aPanel('p1', 'Admin'), aFilter('f1', 'Due this week', [[{ field: 'dueDate', window: 'week', orOverdue: false }]])],
      filings: [filed('p1', 'this-week'), filed('p1', 'next-week')],
    });

    it.each([
      { situation: 'in the week of the 19th', today: '2026-10-19', found: ['this-week'] },
      { situation: 'in the week of the 26th', today: '2026-10-26', found: ['next-week'] },
    ])('$situation', ({ today, found }) => {
      expect(idsOn(b, 'Due this week', today)).toEqual(found);
    });
  });

  describe('an app is told the panel names there are', () => {
    it('lists each name once, ignoring case, in the order the panels come', () => {
      const panels = [aPanel('1', 'Admin'), aPanel('2', 'Waiting'), aPanel('3', 'ADMIN', 'd2'), aPanel('4', 'Later')];

      expect(distinctPanelNames(panels)).toEqual(['Admin', 'Waiting', 'Later']);
    });

    it('picks out the panels of a name, in any case', () => {
      const panels = [aPanel('1', 'Admin'), aPanel('2', 'Waiting'), aPanel('3', 'admin', 'd2')];

      expect(panelsNamed(panels, ' ADMIN ').map((panel) => panel.id)).toEqual(['1', '3']);
    });
  });
});
