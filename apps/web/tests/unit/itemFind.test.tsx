import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AgentRun, Item, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { FIND_LIMIT, findItems, indexForFind, useFindIndex } from '../../src/itemFind';

/**
 * F1: Find item matches in the browser over a snapshot the read model already
 * holds, so it is a view over a fixed snapshot. What the column draws from it
 * is tests/unit/components/PanelList.test.tsx.
 */
function anItem(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    description: null,
    nextAction: null,
    sender: null,
    completedAt: null,
    updatedAt: '2026-08-31T08:00:00.000Z',
    ...over,
  } as Item;
}

/** Dashboards `today` and `later`; Panels `inbox-ish` and `plan` on Today, `review` on Later; a Filter panel `gather`. */
function aSnapshot(items: Item[], filed: [string, string][] = []): WorkspaceSnapshot {
  return {
    items,
    dashboards: [
      { id: 'today', name: 'Today' },
      { id: 'later', name: 'Later' },
    ],
    panels: [
      { id: 'plan', dashboardId: 'today', name: 'Plan', kind: 'items' },
      { id: 'urgent', dashboardId: 'today', name: 'Urgent', kind: 'items' },
      { id: 'review', dashboardId: 'later', name: 'Review', kind: 'items' },
      { id: 'gather', dashboardId: 'today', name: 'Gathered', kind: 'filter', filter: { rows: [], groupBy: 'none' } },
    ],
    filings: filed.map(([itemId, panelId], position) => ({ itemId, panelId, position })),
    agentRuns: [],
  } as unknown as WorkspaceSnapshot;
}

const rowsFor = (snapshot: WorkspaceSnapshot, query: string, scope: 1 | 2 = 2) =>
  findItems(indexForFind(snapshot, '2026-09-01'), query, scope, 'today');

describe('Dashboards', () => {
  describe('Find lists the open Items in scope that match what is typed, in any of four fields', () => {
    it('lists nothing until something is typed', () => {
      expect(rowsFor(aSnapshot([anItem('a')]), '  ')).toEqual({ rows: [], more: 0 });
    });

    it.each([
      { situation: 'the title', over: { title: 'Pay conselit.be' } },
      { situation: 'the description', over: { description: 'invoice from conselit.be' } },
      { situation: 'the next action', over: { nextAction: 'Call conselit.be' } },
      { situation: 'the sender', over: { sender: 'billing@conselit.be' } },
    ])('matches in $situation only', ({ over }) => {
      const snapshot = aSnapshot([anItem('a', over), anItem('b')]);
      expect(rowsFor(snapshot, 'CONSELIT.BE').rows.map((row) => row.itemId)).toEqual(['a']);
    });

    it('keeps this Dashboard’s Items in Dashboard, every open one in Workspace, and no finished one', () => {
      const snapshot = aSnapshot(
        [anItem('here-o'), anItem('away-o'), anItem('inbox-o'), anItem('done-o', { completedAt: '2026-08-31T09:00:00.000Z' })],
        [['here-o', 'plan'], ['away-o', 'review'], ['done-o', 'plan']],
      );
      expect(rowsFor(snapshot, 'o', 1).rows.map((row) => row.itemId)).toEqual(['here-o']);
      expect(rowsFor(snapshot, 'o', 2).rows.map((row) => row.itemId).toSorted()).toEqual(['away-o', 'here-o', 'inbox-o']);
    });

    it('treats an Item filed on a Filter panel only as the Inbox’s', () => {
      const snapshot = aSnapshot([anItem('a')], [['a', 'gather']]);
      expect(rowsFor(snapshot, 'a', 2).rows[0]?.where).toBe('Inbox');
      expect(rowsFor(snapshot, 'a', 1).rows).toEqual([]);
    });
  });

  describe('a row says what the Item is and where, most recently changed first', () => {
    it('names the Panel in Dashboard, and Dashboard ▸ Panel with +n in Workspace, once for an Item on two Panels', () => {
      const snapshot = aSnapshot([anItem('a'), anItem('b')], [['a', 'plan'], ['a', 'review']]);
      expect(rowsFor(snapshot, 'a', 1).rows[0]?.where).toBe('Plan');
      expect(rowsFor(snapshot, 'a', 2).rows).toHaveLength(1);
      expect(rowsFor(snapshot, 'a', 2).rows[0]?.where).toBe('Today ▸ Plan +1');
      expect(rowsFor(snapshot, 'b', 2).rows[0]?.where).toBe('Inbox');
    });

    it('puts the Dashboard on screen’s Panel first for an Item on another Dashboard too', () => {
      const snapshot = aSnapshot([anItem('a')], [['a', 'review'], ['a', 'urgent']]);
      expect(rowsFor(snapshot, 'a', 2).rows[0]?.panel?.panelId).toBe('urgent');
    });

    it('lists the one changed last first', () => {
      const snapshot = aSnapshot([
        anItem('old', { title: 'rent old', updatedAt: '2026-08-01T00:00:00.000Z' }),
        anItem('new', { title: 'rent new', updatedAt: '2026-08-30T00:00:00.000Z' }),
      ]);
      expect(rowsFor(snapshot, 'rent').rows.map((row) => row.itemId)).toEqual(['new', 'old']);
    });
  });

  describe('Include done adds the finished Items, in Workspace only, after the open ones', () => {
    const snapshot = () =>
      aSnapshot(
        [
          anItem('open-old', { title: 'rent open', updatedAt: '2026-08-01T00:00:00.000Z' }),
          anItem('done-new', {
            title: 'rent done',
            completedAt: '2026-08-31T09:00:00.000Z',
            updatedAt: '2026-08-30T00:00:00.000Z',
          }),
        ],
        [['open-old', 'plan'], ['done-new', 'plan']],
      );
    const listed = (scope: 1 | 2, withDone: boolean) =>
      findItems(indexForFind(snapshot(), '2026-09-01'), 'rent', scope, 'today', FIND_LIMIT, withDone).rows;

    it('lists no finished Item unless asked', () => {
      expect(listed(2, false).map((row) => row.itemId)).toEqual(['open-old']);
    });

    it('lists the finished Item after the open one, saying done and going to no Panel', () => {
      const rows = listed(2, true);
      expect(rows.map((row) => row.itemId)).toEqual(['open-old', 'done-new']);
      expect(rows[1]).toMatchObject({ where: 'done', panel: null, done: true });
    });

    it('lists no finished Item in Dashboard, ticked or not', () => {
      expect(listed(1, true).map((row) => row.itemId)).toEqual(['open-old']);
    });
  });

  describe('at most 50 rows are drawn', () => {
    const many = (n: number) => aSnapshot(Array.from({ length: n }, (_, at) => anItem(`item-${at}`)));

    it('draws 50 matches with no tail, and 51 with one more counted', () => {
      expect(rowsFor(many(FIND_LIMIT), 'item')).toMatchObject({ more: 0 });
      expect(rowsFor(many(FIND_LIMIT), 'item').rows).toHaveLength(50);
      expect(rowsFor(many(FIND_LIMIT + 1), 'item')).toMatchObject({ more: 1 });
      expect(rowsFor(many(FIND_LIMIT + 1), 'item').rows).toHaveLength(50);
    });
  });

  describe('each Item’s search text is built once per snapshot, not per keystroke', () => {
    it('derives it once for five letters, and again for a replaced snapshot where an edit now matches', () => {
      let reads = 0;
      const counted = anItem('a');
      Object.defineProperty(counted, 'description', {
        get: () => {
          reads += 1;
          return 'Pay the rent';
        },
      });
      const first = aSnapshot([counted]);
      const { result, rerender } = renderHook(({ snapshot }) => useFindIndex(snapshot, '2026-09-01'), {
        initialProps: { snapshot: first },
      });
      for (const typed of ['r', 're', 'ren', 'rent', 'rent ']) findItems(result.current, typed, 2, 'today');
      rerender({ snapshot: first });
      expect(reads).toBe(1);

      const edited = aSnapshot([anItem('a', { title: 'Pay the VAT' })]);
      rerender({ snapshot: edited });
      expect(findItems(result.current, 'vat', 2, 'today').rows).toHaveLength(1);
      expect(findItems(result.current, 'rent', 2, 'today').rows).toHaveLength(0);
    });
  });

  describe('Find on Dashboard matches every open Item drawn on this Dashboard, filed on a Panel here or gathered by a Filter panel here', () => {
    const dueToday = { rows: [[{ field: 'dueDate', window: 'today', orOverdue: false }]], groupBy: 'none' };
    const running = { rows: [[{ field: 'agent' }]], groupBy: 'none' };
    const filterPanel = (id: string, dashboardId: string, name: string, filter: object): Panel =>
      ({ id, dashboardId, name, kind: 'filter', filter }) as unknown as Panel;
    /** `invoice` is filed on Review (Later), with these Filter panels in place of the base one. */
    const snapshotWith = (panels: Panel[], item: Partial<Item> = {}, extra: Partial<WorkspaceSnapshot> = {}) => {
      const base = aSnapshot([anItem('invoice', item)], [['invoice', 'review']]);
      return { ...base, panels: [...(base.panels ?? []).filter((panel) => panel.id !== 'gather'), ...panels], ...extra } as WorkspaceSnapshot;
    };
    const found = (snapshot: WorkspaceSnapshot, day = '2026-09-01') =>
      findItems(indexForFind(snapshot, day), 'invoice', 1, 'today').rows;

    it.each([
      {
        situation: 'filed on another Dashboard, gathered by a Filter panel here',
        panels: [filterPanel('gather', 'today', 'Due today', dueToday)],
        item: { dueDate: '2026-09-01' },
        expected: ['Due today'],
      },
      {
        situation: 'filed on another Dashboard, gathered only by a Filter panel on that Dashboard',
        panels: [filterPanel('gather', 'later', 'Due later', dueToday)],
        item: { dueDate: '2026-09-01' },
        expected: [],
      },
      {
        situation: 'filed elsewhere, failing the condition of the Filter panel here',
        panels: [filterPanel('gather', 'today', 'Due today', dueToday)],
        item: { dueDate: '2026-09-30' },
        expected: [],
      },
    ])('$situation', ({ panels, item, expected }) => {
      const rows = found(snapshotWith(panels, item as Partial<Item>));
      expect(rows.map((row) => row.where)).toEqual(expected);
      if (expected.length > 0) expect(rows[0]?.panel?.panelId).toBe('gather');
    });

    it('follows the day: found on the day its Due date window holds, then not the day after', () => {
      const snapshot = snapshotWith([filterPanel('gather', 'today', 'Due today', dueToday)], { dueDate: '2026-09-01' } as Partial<Item>);
      expect(found(snapshot, '2026-09-01')).toHaveLength(1);
      expect(found(snapshot, '2026-09-02')).toHaveLength(0);
    });

    it('follows the open runs: found while the Item has an open run, then not after the run closes', () => {
      const panels = [filterPanel('gather', 'today', 'Busy', running)];
      const open = [{ itemId: 'invoice', status: 'running' }] as unknown as AgentRun[];
      const closed: AgentRun[] = [];
      expect(found(snapshotWith(panels, {}, { agentRuns: open })).map((row) => row.where)).toEqual(['Busy']);
      expect(found(snapshotWith(panels, {}, { agentRuns: closed }))).toEqual([]);
    });

    it('is still found when this Dashboard’s own filter would hide it, since the index never reads that filter', () => {
      const snapshot = snapshotWith([filterPanel('gather', 'today', 'Due today', dueToday)], { dueDate: '2026-09-01' } as Partial<Item>);
      expect(found(snapshot)).toHaveLength(1);
    });
  });

  describe('an Item drawn on this Dashboard in several places is one row: the Panel it is filed on first, then the Filter panels in Panel order, the rest counted', () => {
    const dueToday = { rows: [[{ field: 'dueDate', window: 'today', orOverdue: false }]], groupBy: 'none' };
    const filterPanel = (id: string, name: string): Panel =>
      ({ id, dashboardId: 'today', name, kind: 'filter', filter: dueToday }) as unknown as Panel;
    const rowsFor2 = (filedOn: string, filters: Panel[], scope: 1 | 2) => {
      const base = aSnapshot([anItem('invoice', { dueDate: '2026-09-01' } as Partial<Item>)], [['invoice', filedOn]]);
      const snapshot = { ...base, panels: [...(base.panels ?? []).filter((panel) => panel.id !== 'gather'), ...filters] } as WorkspaceSnapshot;
      return findItems(indexForFind(snapshot, '2026-09-01'), 'invoice', scope, 'today').rows;
    };

    it('names the Panel it is filed on here with +1, and goes to it', () => {
      const rows = rowsFor2('urgent', [filterPanel('f1', 'Due today')], 1);
      expect(rows.map((row) => [row.where, row.panel?.panelId])).toEqual([['Urgent +1', 'urgent']]);
    });

    it('names the first Filter panel with +1 for an Item filed elsewhere and gathered by two here', () => {
      const rows = rowsFor2('review', [filterPanel('f1', 'First'), filterPanel('f2', 'Second')], 1);
      expect(rows.map((row) => [row.where, row.panel?.panelId])).toEqual([['First +1', 'f1']]);
    });
  });

  describe('Find on Workspace still names where an Item is filed, never a Filter panel that gathers it', () => {
    it('reads Dashboard ▸ Panel of the Panel it is filed on, though a Filter panel on the Dashboard on screen gathers it', () => {
      const base = aSnapshot([anItem('invoice', { dueDate: '2026-09-01' } as Partial<Item>)], [['invoice', 'review']]);
      const gathering = { id: 'f1', dashboardId: 'today', name: 'Due today', kind: 'filter', filter: { rows: [[{ field: 'dueDate', window: 'today', orOverdue: false }]], groupBy: 'none' } };
      const snapshot = { ...base, panels: [...(base.panels ?? []).filter((panel) => panel.id !== 'gather'), gathering] } as unknown as WorkspaceSnapshot;
      const rows = findItems(indexForFind(snapshot, '2026-09-01'), 'invoice', 2, 'today').rows;
      expect(rows.map((row) => [row.where, row.panel?.panelId])).toEqual([['Later ▸ Review', 'review']]);
    });
  });
});
