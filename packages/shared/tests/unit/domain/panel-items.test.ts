import { describe, expect, it } from 'vitest';
import type { Filing, Item, Panel } from '../../../src/index.js';
import { itemsOfPanel } from '../../../src/domain/panel-items.js';

/**
 * F1: what a Panel holds is worked out from the snapshot, by the board and by
 * `find_items` alike, so this is the one rule they share.
 */

function anItem(id: string, over: Partial<Item> = {}): Item {
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
    proposedPanelFit: null,
    claudeProposals: null,
    sourceResolvedAt: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    prioritySetAt: null,
    dueDateChosenAt: null,
    capturedTimeZone: null,
    dueDate: null,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
    ...over,
  };
}

function aPanel(id: string, over: Partial<Panel> = {}): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'dash-1',
    name: id,
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter: null,
    sort: null,
    columns: null,
    ...over,
  };
}

const filed = (panelId: string, itemId: string, position: number): Filing => ({ panelId, itemId, position });

const input = (items: Item[], filings: Filing[], panels: Panel[]) => ({
  items,
  filings,
  panelsInWorkspace: panels,
  dashboards: [{ id: 'dash-1' }],
  withRun: new Set<string>(),
  today: '2026-10-15',
});

const idsOf = (items: Item[]) => items.map((item) => item.id);

describe('Panels', () => {
  describe('a panel holds the items filed on it, or what its filter gathers', () => {
    it('holds the open items filed on an items panel, by position, and none that are finished', () => {
      const panel = aPanel('p1');
      const items = [anItem('a'), anItem('b'), anItem('c', { completedAt: '2026-09-01T00:00:00.000Z' })];
      const filings = [filed('p1', 'b', 0), filed('p1', 'a', 1), filed('p1', 'c', 2)];

      expect(idsOf(itemsOfPanel(panel, input(items, filings, [panel])))).toEqual(['b', 'a']);
    });

    it('gathers what a filter panel says from items filed on other panels, not only on itself', () => {
      const other = aPanel('p1');
      const gathers = aPanel('f1', {
        kind: 'filter',
        filter: { rows: [[{ field: 'priority', values: ['high'] }]], groupBy: 'none' },
      });
      const items = [anItem('a', { priority: 'high' }), anItem('b', { priority: 'low' })];
      const filings = [filed('p1', 'a', 0), filed('p1', 'b', 1)];

      expect(idsOf(itemsOfPanel(gathers, input(items, filings, [other, gathers])))).toEqual(['a']);
    });

    it('gathers nothing for a filter with no conditions, and holds nothing for a panel of text', () => {
      const empty = aPanel('f1', { kind: 'filter', filter: { rows: [], groupBy: 'none' } });
      const text = aPanel('t1', { kind: 'text' });
      const items = [anItem('a')];
      const filings = [filed('p1', 'a', 0)];

      expect(itemsOfPanel(empty, input(items, filings, [empty, text]))).toEqual([]);
      expect(itemsOfPanel(text, input(items, [], [empty, text]))).toEqual([]);
    });
  });
});
