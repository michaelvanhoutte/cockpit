import { describe, expect, it } from 'vitest';
import { NO_DASHBOARD_FILTER } from '../../../src/domain/dashboard-filter.js';
import type { Item } from '../../../src/domain/item.js';
import type { Filing, Panel, PanelFilter } from '../../../src/domain/panel.js';
import { isLater, panelRows } from '../../../src/domain/panel-contents.js';
import type { PanelContents } from '../../../src/domain/panel-contents.js';

/**
 * L1: which rows a Panel of Items sets aside as later is pure logic over the
 * Workspace's rows with today handed in. That the board draws the count and the
 * menu from it is tests/unit/components/PanelBoard.test.tsx.
 */

const TODAY = '2026-11-20';

function aPanel(id: string, kind: Panel['kind'] = 'items', filter: PanelFilter | null = null): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'today',
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

function anItem(id: string, dueDate: string | null): Item {
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
    seriesId: null,
    sourceResolvedAt: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    waitingSince: null,
    priority: null,
    prioritySetAt: null,
    dueDateChosenAt: null,
    capturedTimeZone: null,
    dueDate,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

const filedOn = (panelId: string, items: Item[]): Filing[] =>
  items.map((item, position) => ({ panelId, itemId: item.id, position }));

function contents(panel: Panel, items: Item[], extra: Partial<PanelContents> = {}): PanelContents {
  return {
    items,
    filings: filedOn(panel.id, items),
    panelsInWorkspace: [panel],
    dashboards: [{ id: 'today' }],
    filter: NO_DASHBOARD_FILTER,
    withAttachments: new Set(),
    withRun: new Set(),
    today: TODAY,
    ...extra,
  };
}

const ids = (items: readonly Item[]) => items.map((item) => item.id);

describe('Panels', () => {
  describe('a Panel of items leaves out an Item due more than 30 days after today while its later Items are hidden', () => {
    const tasks = aPanel('tasks');

    it.each([
      ['due in 30 days', '2026-12-20', true],
      ['due in 31 days', '2026-12-21', false],
      ['with no due date', null, true],
      ['overdue', '2026-01-02', true],
    ])('shows an Item %s: %s', (_what, dueDate, shown) => {
      const item = anItem('a', dueDate);
      const { rows } = panelRows(tasks, contents(tasks, [item], { hideLater: true }));
      expect(ids(rows)).toEqual(shown ? ['a'] : []);
    });

    it('shows an Item due in 60 days once the Panel shows its later Items, and still counts it', () => {
      const far = anItem('far', '2027-01-19');
      expect(panelRows(tasks, contents(tasks, [far], { hideLater: false }))).toMatchObject({ rows: [far], later: 1 });
      expect(panelRows(tasks, contents(tasks, [far], { hideLater: true }))).toMatchObject({ rows: [], later: 1 });
    });

    it('leaves a Filter panel and a Panel of text unnarrowed', () => {
      const far = anItem('far', '2026-12-31');
      const filter = aPanel('gather', 'filter', {
        sets: [[[{ field: 'dueDate', window: 'quarter', orOverdue: true }]]],
        groupBy: 'none',
      });
      const everything = { ...contents(filter, [far], { hideLater: true }), filings: filedOn('tasks', [far]) };
      const gathered = panelRows(filter, { ...everything, panelsInWorkspace: [tasks, filter] });
      expect(gathered.later).toBe(0);
      expect(ids(gathered.rows)).toEqual(['far']);
      const text = aPanel('notes', 'text');
      expect(panelRows(text, contents(text, [far], { hideLater: true }))).toMatchObject({ later: 0 });
    });

    it('hides a child due in 60 days under a parent due tomorrow, counting it, and hides a parent with its children', () => {
      const parent = anItem('parent', '2026-11-21');
      const farChild = anItem('far-child', '2027-01-19');
      const farParent = anItem('far-parent', '2027-01-19');
      const nearChild = anItem('near-child', '2026-11-21');
      const everything = [parent, farChild, farParent, nearChild];
      const filings = filedOn('tasks', [parent, farParent]);
      const children = [
        { parentId: 'parent', childId: 'far-child', position: 0 },
        { parentId: 'far-parent', childId: 'near-child', position: 0 },
      ];
      const found = panelRows(tasks, {
        ...contents(tasks, everything, { hideLater: true, children }),
        filings,
      });
      expect(ids(found.rows)).toEqual(['parent']);
      // The far child under the shown parent, and the far parent, which hides its child with it.
      expect(found.later).toBe(2);
    });
  });

  describe('an Item’s due date edited to six months out leaves the Panel at once', () => {
    it('is set aside by the next reading of the same rows', () => {
      const tasks = aPanel('tasks');
      const before = anItem('a', '2026-11-21');
      expect(ids(panelRows(tasks, contents(tasks, [before], { hideLater: true })).rows)).toEqual(['a']);
      const after = { ...before, dueDate: '2027-05-20' };
      expect(panelRows(tasks, contents(tasks, [after], { hideLater: true }))).toMatchObject({ rows: [], later: 1 });
    });
  });

  describe('isLater counts whole days from today', () => {
    it('is the 31st day on, and not for anything that is no date', () => {
      expect(isLater('2026-12-20', TODAY)).toBe(false);
      expect(isLater('2026-12-21', TODAY)).toBe(true);
      expect(isLater(null, TODAY)).toBe(false);
      expect(isLater('not a date', TODAY)).toBe(false);
    });
  });
});
