import { describe, expect, it } from 'vitest';
import { WORKSPACE_THEMES, attachmentSchema, itemLabel, itemSchema, itemStatus, itemsInTheInbox, type Attachment, type Item, type Workspace, type WorkspaceList, type WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from '../../src/api/queries';
import { createChangeQueue } from '../../src/changeQueue';
import { drawnAhead, drawnOver, listDrawnOver, noSnapshotYet, type Drawn } from '../../src/drawnAhead';
import { itemsThatMayBeDuplicates } from '../../src/duplicates';

/**
 * F1: what the screen shows of a change before the server has answered it -
 * a copy and a change in, a copy out. That it is shown within 100 ms on each
 * surface is tests/unit/components/ChangesAtOnce.test.tsx.
 */

const AT = '2026-10-20T09:00:00.000Z';
const BART = '11111111-1111-7111-8111-000000000001';
const LISA = '11111111-1111-7111-8111-000000000002';

function anItem(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: `Item ${id.slice(-1)}`,
    description: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    dueDate: null,
    ...over,
  } as unknown as Item;
}

const workspace = (items: Item[]): WorkspaceSnapshot => ({ items, filings: [], panels: [] }) as unknown as WorkspaceSnapshot;

const envelope = (itemId: string) => ({ commandId: 'c1', issuedAt: AT, workspaceId: 'ws-work', itemId });

const read = (copy: WorkspaceSnapshot, id: string) => copy.items.find((item) => item.id === id);

describe('Item editing', () => {
  describe('a change to an Item shows the moment it is made, before the server has answered', () => {
    it.each([
      {
        situation: 'marking it done',
        change: { name: 'set_done', payload: { ...envelope(BART), done: true } } as CommandArgs,
        from: {},
        shown: (item: Item) => itemStatus(item),
        expected: 'done',
      },
      {
        situation: 'reopening what was done',
        change: { name: 'set_done', payload: { ...envelope(BART), done: false } } as CommandArgs,
        from: { completedAt: '2026-10-19T09:00:00.000Z' },
        shown: (item: Item) => itemStatus(item),
        expected: 'to_do',
      },
      {
        situation: 'starting it',
        change: { name: 'set_started', payload: { ...envelope(BART), started: true } } as CommandArgs,
        from: {},
        shown: (item: Item) => itemStatus(item),
        expected: 'in_progress',
      },
      {
        situation: 'taking it back to To do',
        change: { name: 'set_started', payload: { ...envelope(BART), started: false } } as CommandArgs,
        from: { startedAt: '2026-10-19T09:00:00.000Z' },
        shown: (item: Item) => itemStatus(item),
        expected: 'to_do',
      },
      {
        situation: 'waiting for a reply, due three days on',
        change: { name: 'wait_for_reply', payload: { ...envelope(BART), days: 3, timeZone: 'Europe/Brussels' } } as CommandArgs,
        from: { dueDate: '2026-12-01' },
        shown: (item: Item) => [itemStatus(item), item.waitingSince, item.dueDate],
        expected: ['waiting', AT, '2026-10-23'],
      },
      {
        situation: 'waiting again, since the day it first waited',
        change: { name: 'wait_for_reply', payload: { ...envelope(BART), days: 7, timeZone: 'Europe/Brussels' } } as CommandArgs,
        from: { waitingSince: '2026-10-13T09:00:00.000Z', dueDate: '2026-10-16' },
        shown: (item: Item) => [item.waitingSince, item.dueDate],
        expected: ['2026-10-13T09:00:00.000Z', '2026-10-27'],
      },
      {
        situation: 'taking a waiting Item back to To do',
        change: { name: 'set_started', payload: { ...envelope(BART), started: false } } as CommandArgs,
        from: { waitingSince: '2026-10-19T09:00:00.000Z' },
        shown: (item: Item) => itemStatus(item),
        expected: 'to_do',
      },
      {
        situation: 'starting a waiting Item',
        change: { name: 'set_started', payload: { ...envelope(BART), started: true } } as CommandArgs,
        from: { waitingSince: '2026-10-19T09:00:00.000Z' },
        shown: (item: Item) => itemStatus(item),
        expected: 'in_progress',
      },
      {
        situation: 'a priority',
        change: { name: 'set_priority', payload: { ...envelope(BART), priority: 'high' } } as CommandArgs,
        from: {},
        shown: (item: Item) => item.priority,
        expected: 'high',
      },
      {
        situation: 'clearing a priority',
        change: { name: 'set_priority', payload: { ...envelope(BART), priority: null } } as CommandArgs,
        from: { priority: 'low' as const },
        shown: (item: Item) => item.priority,
        expected: null,
      },
      {
        situation: 'a due date',
        change: { name: 'set_due_date', payload: { ...envelope(BART), dueDate: '2026-10-21' } } as CommandArgs,
        from: {},
        shown: (item: Item) => item.dueDate,
        expected: '2026-10-21',
      },
      {
        situation: 'a title',
        change: { name: 'set_title', payload: { ...envelope(BART), title: 'Reply to Bart today' } } as CommandArgs,
        from: {},
        shown: (item: Item) => item.title,
        expected: 'Reply to Bart today',
      },
      {
        situation: 'a description',
        change: { name: 'set_description', payload: { ...envelope(BART), description: 'Ask about the tolerances' } } as CommandArgs,
        from: {},
        shown: (item: Item) => item.description,
        expected: 'Ask about the tolerances',
      },
      {
        situation: 'a next action, which is what the row reads',
        change: { name: 'set_next_action', payload: { ...envelope(BART), nextAction: 'Call Bart' } } as CommandArgs,
        from: {},
        shown: (item: Item) => itemLabel(item),
        expected: 'Call Bart',
      },
    ])('$situation', ({ change, from, shown, expected }) => {
      const copy = workspace([anItem(BART, from), anItem(LISA)]);

      const drawn = drawnAhead(copy, change);

      expect(shown(read(drawn, BART)!)).toEqual(expected);
      // The other Item and the copy the server sent are as they were.
      expect(read(drawn, LISA)).toEqual(read(copy, LISA));
      expect(shown(read(copy, BART)!)).not.toEqual(expected);
    });

    it('takes a dismissed Item out of the Workspace', () => {
      const copy = workspace([anItem(BART), anItem(LISA)]);

      const drawn = drawnAhead(copy, { name: 'set_dismissed', payload: { ...envelope(BART), dismissed: true } });

      expect(drawn.items.map((item) => item.id)).toEqual([LISA]);
      expect(copy.items).toHaveLength(2);
    });

    it.each([
      {
        situation: 'a change to an Item the copy does not hold',
        change: { name: 'set_priority', payload: { ...envelope('11111111-1111-7111-8111-000000000099'), priority: 'high' } } as CommandArgs,
      },
      {
        situation: 'a dismissal taken back, which has no copy of the Item to draw it from',
        change: { name: 'set_dismissed', payload: { ...envelope(BART), dismissed: false } } as CommandArgs,
      },
      {
        situation: 'a change the screen does not draw ahead',
        change: { name: 'rename_panel', payload: { ...envelope(BART), panelId: 'p-1', name: 'Today' } } as unknown as CommandArgs,
      },
    ])('leaves the copy as it is for $situation', ({ change }) => {
      const copy = workspace([anItem(BART)]);

      expect(drawnAhead(copy, change)).toBe(copy);
    });

    it('draws each of several changes over the one before, so the later one wins', () => {
      const copy = workspace([anItem(BART)]);

      const drawn = drawnOver(copy, [
        { name: 'set_priority', payload: { ...envelope(BART), priority: 'high' } },
        { name: 'set_title', payload: { ...envelope(BART), title: 'Reply to Bart' } },
        { name: 'set_priority', payload: { ...envelope(BART), priority: 'low' } },
      ]);

      expect(read(drawn, BART)).toMatchObject({ priority: 'low', title: 'Reply to Bart' });
    });
  });
});

const WORK = 'ws-work';
const FALCON = 'p-falcon';
const ANNA = 'p-anna';

/** A Workspace with these Items and filings, each filing as `[panel, item]` in the order the Panel holds them. */
const filedWorkspace = (items: Item[], filings: [string, string][], id = WORK): WorkspaceSnapshot =>
  ({
    workspace: { id },
    items,
    filings: filings.map(([panelId, itemId], position) => ({ panelId, itemId, position })),
    panels: [{ id: FALCON }, { id: ANNA }],
  }) as unknown as WorkspaceSnapshot;

const orderOn = (copy: WorkspaceSnapshot, panelId: string) =>
  copy.filings
    .filter((filing) => filing.panelId === panelId)
    .sort((a, b) => a.position - b.position)
    .map((filing) => filing.itemId);

const move = (panelId: string | null, order: string[], fromPanelIds?: string[]): CommandArgs => ({
  name: 'move_item_to_panel',
  payload: { ...envelope(BART), panelId, order, ...(fromPanelIds ? { fromPanelIds } : {}) },
});

describe('Panels', () => {
  describe('a filing shows the moment it is made, before the server has answered', () => {
    it.each([
      {
        situation: 'a move to a Panel takes the Item off the Panel it was on and puts it at the place in the order it carries',
        from: [[FALCON, BART], [ANNA, LISA]] as [string, string][],
        change: move(ANNA, [BART, LISA]),
        expected: { [FALCON]: [], [ANNA]: [BART, LISA] },
      },
      {
        situation: 'a move to the Inbox takes it off every Panel',
        from: [[FALCON, BART], [ANNA, BART]] as [string, string][],
        change: move(null, []),
        expected: { [FALCON]: [], [ANNA]: [] },
      },
      {
        situation: 'a move that names the Panel it leaves takes it off that one only',
        from: [[FALCON, BART], [ANNA, BART]] as [string, string][],
        change: move(FALCON, [BART], [ANNA]),
        expected: { [FALCON]: [BART], [ANNA]: [] },
      },
      {
        situation: 'an add leaves the Panels it is on alone',
        from: [[FALCON, BART]] as [string, string][],
        change: { name: 'add_item_to_panel', payload: { ...envelope(BART), panelId: ANNA, order: [BART] } } as CommandArgs,
        expected: { [FALCON]: [BART], [ANNA]: [BART] },
      },
      {
        situation: 'an add to a Panel it is on already is a reorder',
        from: [[FALCON, BART], [FALCON, LISA]] as [string, string][],
        change: { name: 'add_item_to_panel', payload: { ...envelope(BART), panelId: FALCON, order: [LISA, BART] } } as CommandArgs,
        expected: { [FALCON]: [LISA, BART], [ANNA]: [] },
      },
      {
        situation: 'a removal takes it off that Panel and no other',
        from: [[FALCON, BART], [ANNA, BART], [ANNA, LISA]] as [string, string][],
        change: { name: 'remove_item_from_panel', payload: { ...envelope(BART), panelId: ANNA } } as CommandArgs,
        expected: { [FALCON]: [BART], [ANNA]: [LISA] },
      },
    ])('$situation', ({ from, change, expected }) => {
      const copy = filedWorkspace([anItem(BART), anItem(LISA)], from);

      const drawn = drawnAhead(copy, change);

      for (const [panelId, order] of Object.entries(expected)) expect(orderOn(drawn, panelId)).toEqual(order);
      // The copy the server sent is as it was.
      expect(copy.filings).toHaveLength(from.length);
    });

    it('settles an Item that belonged to no Workspace in the Workspace it is filed in', () => {
      const copy = filedWorkspace([anItem(BART, { workspaceDecided: false })], []);

      const drawn = drawnAhead(copy, move(FALCON, [BART]));

      expect(read(drawn, BART)).toMatchObject({ workspaceDecided: true, workspaceId: WORK });
    });

    it.each([
      { situation: 'another Workspace’s copy', copy: filedWorkspace([anItem(BART)], [], 'ws-home') },
      { situation: 'a copy that does not hold the Item', copy: filedWorkspace([anItem(LISA)], []) },
    ])('leaves $situation as it is for a move', ({ copy }) => {
      expect(drawnAhead(copy, move(FALCON, [BART]))).toBe(copy);
    });

    it('draws a second filing over the first, so it is built on the Panel as the first left it', () => {
      const copy = filedWorkspace([anItem(BART), anItem(LISA)], []);

      const drawn = drawnOver(copy, [
        move(FALCON, [BART]),
        { name: 'move_item_to_panel', payload: { ...envelope(LISA), panelId: FALCON, order: [LISA, BART] } },
      ]);

      expect(orderOn(drawn, FALCON)).toEqual([LISA, BART]);
    });
  });
});

const TODAY = 'd-today';
const READING = 'd-reading';
const ADMIN = 'd-admin';

/** A Workspace with three Dashboards, a Panel and a Layout on each, and an Item filed on Reading's Panel. */
const withDashboards = (id = WORK): WorkspaceSnapshot =>
  ({
    workspace: { id, tenantId: 'tenant' },
    items: [anItem(BART)],
    dashboards: [TODAY, READING, ADMIN].map((dashboardId) => ({
      id: dashboardId,
      tenantId: 'tenant',
      workspaceId: id,
      name: dashboardId.slice(2),
    })),
    panels: [TODAY, READING, ADMIN].map((dashboardId) => ({ id: `p-${dashboardId}`, dashboardId, name: 'Panel 1' })),
    layouts: [TODAY, READING, ADMIN].map((dashboardId) => ({ id: `l-${dashboardId}`, dashboardId, rows: [] })),
    filings: [{ panelId: `p-${READING}`, itemId: BART, position: 0 }],
  }) as unknown as WorkspaceSnapshot;

const dashboardEnvelope = (workspaceId = WORK) => ({ commandId: 'c1', issuedAt: AT, workspaceId });
const names = (copy: WorkspaceSnapshot) => copy.dashboards.map((one) => one.name);
const added = (name: string, workspaceId = WORK): CommandArgs => ({
  name: 'add_dashboard',
  payload: { ...dashboardEnvelope(workspaceId), dashboardId: 'd-new', panelId: 'p-new', name },
});
const deleted = (dashboardId: string, workspaceId = WORK): CommandArgs => ({
  name: 'delete_dashboard',
  payload: { ...dashboardEnvelope(workspaceId), dashboardId },
});
const reordered = (dashboardId: string, dashboardIds: string[]): CommandArgs => ({
  name: 'reorder_dashboards',
  payload: { ...dashboardEnvelope(), dashboardId, dashboardIds },
});

describe('Dashboards', () => {
  describe('a Dashboard change shows the moment it is made, before the server has answered', () => {
    it('puts an added Dashboard at the end of the bar with the Panel it arrives with', () => {
      const copy = withDashboards();

      const drawn = drawnAhead(copy, added('Research'));

      expect(names(drawn)).toEqual(['today', 'reading', 'admin', 'Research']);
      expect(drawn.panels.filter((panel) => panel.dashboardId === 'd-new')).toEqual([
        expect.objectContaining({ id: 'p-new', name: 'Panel 1', kind: 'items', tenantId: 'tenant' }),
      ]);
      expect(drawn.dashboards[3]).toEqual({ id: 'd-new', tenantId: 'tenant', workspaceId: WORK, name: 'Research' });
      // The copy the server sent is as it was.
      expect(copy.dashboards).toHaveLength(3);
    });

    it('draws a Dashboard added twice once, as the server makes it once', () => {
      const drawn = drawnOver(withDashboards(), [added('Research'), added('Research')]);

      expect(names(drawn)).toEqual(['today', 'reading', 'admin', 'Research']);
      expect(drawn.panels.filter((panel) => panel.dashboardId === 'd-new')).toHaveLength(1);
    });

    it('shows the new name on a renamed Dashboard and no other', () => {
      const drawn = drawnAhead(withDashboards(), {
        name: 'rename_dashboard',
        payload: { ...dashboardEnvelope(), dashboardId: READING, name: 'Library' },
      });

      expect(names(drawn)).toEqual(['today', 'Library', 'admin']);
    });

    it('takes a deleted Dashboard off the bar with its Panels, its Layout and what was filed on them', () => {
      const drawn = drawnAhead(withDashboards(), deleted(READING));

      expect(names(drawn)).toEqual(['today', 'admin']);
      expect(drawn.panels.map((panel) => panel.dashboardId)).toEqual([TODAY, ADMIN]);
      expect(drawn.layouts.map((layout) => layout.dashboardId)).toEqual([TODAY, ADMIN]);
      expect(drawn.filings).toEqual([]);
    });

    it('leaves the other Dashboards’ boards as they were when one is deleted', () => {
      const copy = withDashboards();

      const drawn = drawnAhead(copy, deleted(READING));

      expect(drawn.panels.filter((panel) => panel.dashboardId === TODAY)).toEqual(
        copy.panels.filter((panel) => panel.dashboardId === TODAY),
      );
    });

    it('does not draw the last Dashboard deleted, which the server refuses', () => {
      const one = { ...withDashboards(), dashboards: [withDashboards().dashboards[0]!] } as WorkspaceSnapshot;

      expect(drawnAhead(one, deleted(TODAY))).toBe(one);
    });

    it('shows the order a reorder carries, and keeps a Dashboard it never named on the end', () => {
      const copy = withDashboards();

      expect(names(drawnAhead(copy, reordered(TODAY, [READING, TODAY, ADMIN])))).toEqual(['reading', 'today', 'admin']);
      // Added on another device since the order was drawn: kept, not taken off the bar.
      expect(names(drawnAhead(copy, reordered(ADMIN, [ADMIN, TODAY])))).toEqual(['admin', 'today', 'reading']);
    });

    it.each([
      { situation: 'an add', change: added('Research', 'ws-home') },
      { situation: 'a delete', change: deleted(READING, 'ws-home') },
    ])('leaves another Workspace’s copy as it is for $situation', ({ change }) => {
      const copy = withDashboards();

      expect(drawnAhead(copy, change)).toBe(copy);
    });
  });
});

const PANEL_A = 'p-a';
const PANEL_B = 'p-b';

/** Today holds Falcon (items) and Notes (text), arranged in one row each; Reading holds a Panel also called Falcon. */
const withPanels = (id = WORK): WorkspaceSnapshot => {
  const panel = (panelId: string, dashboardId: string, name: string, over: object = {}) => ({
    id: panelId,
    tenantId: 'tenant',
    dashboardId,
    name,
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter: null,
    sort: null,
    columns: null,
    ...over,
  });
  return {
    workspace: { id, tenantId: 'tenant' },
    items: [anItem(BART)],
    dashboards: [TODAY, READING].map((dashboardId) => ({ id: dashboardId, tenantId: 'tenant', workspaceId: id, name: dashboardId.slice(2) })),
    panels: [
      panel(PANEL_A, TODAY, 'Falcon'),
      panel(PANEL_B, TODAY, 'Notes', { kind: 'text' }),
      panel('p-reading-falcon', READING, 'Falcon'),
    ],
    layouts: [
      {
        id: 'l-today',
        tenantId: 'tenant',
        dashboardId: TODAY,
        rows: [
          { height: null, cells: [{ panelId: PANEL_A, span: 12 }] },
          { height: null, cells: [{ panelId: PANEL_B, span: 12 }] },
        ],
      },
    ],
    filings: [{ panelId: PANEL_A, itemId: BART, position: 0 }],
  } as unknown as WorkspaceSnapshot;
};

const panelEnvelope = (workspaceId = WORK) => ({ commandId: 'c1', issuedAt: AT, workspaceId });
const panelOf = (copy: WorkspaceSnapshot, id: string) => copy.panels.find((one) => one.id === id);
const panelNames = (copy: WorkspaceSnapshot, dashboardId: string) =>
  copy.panels.filter((one) => one.dashboardId === dashboardId).map((one) => one.name);
const panelAdded = (name: string, kind: 'items' | 'text' | 'filter' = 'items', workspaceId = WORK): CommandArgs => ({
  name: 'add_panel',
  payload: { ...panelEnvelope(workspaceId), dashboardId: TODAY, panelId: 'p-new', name, kind },
});

describe('Panels', () => {
  describe('a Panel change shows the moment it is made, before the server has answered', () => {
    it('puts an added Panel on its Dashboard, not yet placed in the Layout', () => {
      const copy = withPanels();

      const drawn = drawnAhead(copy, panelAdded('Waiting on'));

      expect(panelNames(drawn, TODAY)).toEqual(['Falcon', 'Notes', 'Waiting on']);
      expect(panelOf(drawn, 'p-new')).toMatchObject({ kind: 'items', filter: null, readOnly: false, format: 'plain' });
      // The Layout is as the server sent it: the board draws a Panel it has never heard of at the foot.
      expect(drawn.layouts).toBe(copy.layouts);
      expect(copy.panels).toHaveLength(3);
    });

    it.each([
      { situation: 'text', kind: 'text' as const, filter: null },
      { situation: 'a Filter that has nothing chosen yet', kind: 'filter' as const, filter: { rows: [], groupBy: 'none' } },
    ])('draws an added Panel of $situation as the kind it was made as', ({ kind, filter }) => {
      const drawn = drawnAhead(withPanels(), panelAdded('Kept', kind));

      expect(panelOf(drawn, 'p-new')).toMatchObject({ kind, filter });
    });

    it('draws a Panel added twice once', () => {
      const drawn = drawnOver(withPanels(), [panelAdded('Waiting on'), panelAdded('Waiting on')]);

      expect(panelNames(drawn, TODAY)).toEqual(['Falcon', 'Notes', 'Waiting on']);
    });

    it('puts a Section at the foot of the Layout the Dashboard has', () => {
      const rows = [
        { height: null, cells: [{ panelId: PANEL_A, span: 12 }] },
        { height: null, cells: [{ panelId: PANEL_B, span: 12 }] },
        { height: null, title: 'This week', cells: [] },
      ];

      const drawn = drawnAhead(withPanels(), {
        name: 'save_layout',
        payload: { ...panelEnvelope(), dashboardId: TODAY, layoutId: 'l-other', carriesSections: true, rows },
      });

      expect(drawn.layouts).toEqual([expect.objectContaining({ id: 'l-today', dashboardId: TODAY, rows })]);
    });

    it('makes the Layout of a Dashboard that had none, under the id the save names', () => {
      const rows = [{ height: null, cells: [{ panelId: 'p-reading-falcon', span: 12 }] }];

      const drawn = drawnAhead(withPanels(), {
        name: 'save_layout',
        payload: { ...panelEnvelope(), dashboardId: READING, layoutId: 'l-new', carriesSections: true, rows },
      });

      expect(drawn.layouts.map((layout) => layout.id)).toEqual(['l-today', 'l-new']);
      expect(drawn.layouts[1]).toMatchObject({ dashboardId: READING, tenantId: 'tenant', rows });
    });

    it('shows the settings the form changed and no others', () => {
      const drawn = drawnAhead(withPanels(), {
        name: 'set_panel_settings',
        payload: { ...panelEnvelope(), panelId: PANEL_B, name: 'Waiting on', readOnly: true, format: 'rich' },
      });

      expect(panelOf(drawn, PANEL_B)).toMatchObject({ name: 'Waiting on', readOnly: true, format: 'rich', neverPropose: false, columns: null });
      expect(panelOf(drawn, PANEL_A)).toMatchObject({ name: 'Falcon', readOnly: false });
    });

    it('shows Never propose and the columns a Panel of items was given, and one set back to a single list', () => {
      const set = drawnAhead(withPanels(), {
        name: 'set_panel_settings',
        payload: { ...panelEnvelope(), panelId: PANEL_A, neverPropose: true, columns: 'wide' },
      });
      const back = drawnAhead(set, {
        name: 'set_panel_settings',
        payload: { ...panelEnvelope(), panelId: PANEL_A, columns: null },
      });

      expect(panelOf(set, PANEL_A)).toMatchObject({ neverPropose: true, columns: 'wide' });
      expect(panelOf(back, PANEL_A)).toMatchObject({ neverPropose: true, columns: null });
    });

    it('shows the conditions and the grouping a Filter was given', () => {
      const rows = [[{ field: 'priority', values: ['high'] }]];

      const drawn = drawnAhead(withPanels(), {
        name: 'set_panel_filter',
        payload: { ...panelEnvelope(), panelId: PANEL_A, rows, groupBy: 'dashboard' },
      } as CommandArgs);

      expect(panelOf(drawn, PANEL_A)?.filter).toEqual({ rows, groupBy: 'dashboard' });
    });

    it('shows the sort a Panel was given, and Manual when it is set back', () => {
      const sort = [{ field: 'title' as const, direction: 'asc' as const }];
      const sorted = drawnAhead(withPanels(), { name: 'set_panel_sort', payload: { ...panelEnvelope(), panelId: PANEL_A, sort } });
      const manual = drawnAhead(sorted, { name: 'set_panel_sort', payload: { ...panelEnvelope(), panelId: PANEL_A, sort: null } });

      expect(panelOf(sorted, PANEL_A)?.sort).toEqual(sort);
      expect(panelOf(manual, PANEL_A)?.sort).toBeNull();
    });

    it('takes a deleted Panel off the board with what was filed on it', () => {
      const copy = withPanels();

      const drawn = drawnAhead(copy, { name: 'delete_panel', payload: { ...panelEnvelope(), panelId: PANEL_A } });

      expect(panelNames(drawn, TODAY)).toEqual(['Notes']);
      expect(drawn.filings).toEqual([]);
      expect(copy.panels).toHaveLength(3);
    });

    it('moves a Panel off its Dashboard and onto the other', () => {
      const drawn = drawnAhead(withPanels(), {
        name: 'move_panel_to_dashboard',
        payload: { ...panelEnvelope(), panelId: PANEL_B, dashboardId: READING },
      });

      expect(panelNames(drawn, TODAY)).toEqual(['Falcon']);
      expect(panelNames(drawn, READING).sort()).toEqual(['Falcon', 'Notes']);
    });

    it.each([
      { situation: 'an add', change: panelAdded('Waiting on', 'items', 'ws-home') },
      { situation: 'a delete', change: { name: 'delete_panel', payload: { ...panelEnvelope('ws-home'), panelId: PANEL_A } } as CommandArgs },
      {
        situation: 'a setting',
        change: { name: 'set_panel_settings', payload: { ...panelEnvelope('ws-home'), panelId: PANEL_A, name: 'X' } } as CommandArgs,
      },
    ])('leaves another Workspace’s copy as it is for $situation', ({ change }) => {
      const copy = withPanels();

      expect(drawnAhead(copy, change)).toBe(copy);
    });
  });

  describe('what the server decides is drawn as predicted, then as the server says', () => {
    it('keeps a moved Panel’s own name where the other Dashboard holds one of that name, until the read brings the server’s rename', async () => {
      const queue = createChangeQueue({ send: async () => ({ ok: true, applied: true }) });
      const move: CommandArgs = {
        name: 'move_panel_to_dashboard',
        payload: { ...panelEnvelope(), panelId: PANEL_A, dashboardId: READING },
      };

      const answered = queue.enqueue(move);
      await answered;
      expect(panelNames(queue.drawnOver(withPanels()), READING)).toEqual(['Falcon', 'Falcon']);

      // The read after the answer, in which the server has renamed it.
      const read = withPanels();
      read.panels = read.panels.map((one) => (one.id === PANEL_A ? { ...one, dashboardId: READING, name: 'Falcon (2)' } : one));
      queue.readLanded(WORK, queue.readStarted());

      expect(panelNames(queue.drawnOver(read), READING)).toEqual(['Falcon (2)', 'Falcon']);
    });
  });
});

describe('Workspace management', () => {
  describe('a Workspace change shows the moment it is made, before the server has answered', () => {
    const THEMES = WORKSPACE_THEMES;
    const aWorkspace = (id: string, name: string, color: string): Workspace =>
      ({ id, tenantId: 'tenant', name, color, bar: '#000001', ground: '#000002', header: '#000003' }) as Workspace;
    const listed = (): WorkspaceList => ({
      workspaces: [aWorkspace('ws-work', 'Work', THEMES[0].tint), aWorkspace('ws-home', 'Home', THEMES[1].tint), aWorkspace('ws-acme', 'Acme', THEMES[2].tint)],
    });
    const envelope = (workspaceId: string) => ({ commandId: 'c1', issuedAt: AT, workspaceId });
    const shown = (list: WorkspaceList) => list.workspaces.map((one) => one.name);

    it('shows the new name on a renamed Workspace and no other', () => {
      const copy = listed();

      const drawn = listDrawnOver(copy, [{ name: 'rename_workspace', payload: { ...envelope('ws-home'), name: 'Family' } }]);

      expect(shown(drawn)).toEqual(['Work', 'Family', 'Acme']);
      // The list the server sent is as it was.
      expect(shown(copy)).toEqual(['Work', 'Home', 'Acme']);
    });

    it('shows the palette’s colours on a recoloured Workspace', () => {
      const drawn = listDrawnOver(listed(), [
        { name: 'set_workspace_theme', payload: { ...envelope('ws-home'), color: THEMES[3].tint, bar: '#111111', ground: '#222222', header: '#333333' } },
      ]);

      // The tint alone is what the server stores; the other three are the palette's.
      expect(drawn.workspaces[1]).toMatchObject({ color: THEMES[3].tint, bar: THEMES[3].bar, ground: THEMES[3].ground, header: THEMES[3].header });
      expect(drawn.workspaces[0]!.color).toBe(THEMES[0].tint);
    });

    it('draws no colour the palette does not have, since the server refuses it', () => {
      const copy = listed();

      const drawn = listDrawnOver(copy, [
        { name: 'set_workspace_theme', payload: { ...envelope('ws-home'), color: '#123456', bar: '#111111', ground: '#222222', header: '#333333' } },
      ]);

      expect(drawn).toEqual(copy);
    });

    it('takes a deleted Workspace out of the list', () => {
      const drawn = listDrawnOver(listed(), [{ name: 'delete_workspace', payload: envelope('ws-home') }]);

      expect(shown(drawn)).toEqual(['Work', 'Acme']);
    });

    it('shows the order a reorder carries, with one it never named kept on the end', () => {
      const drawn = listDrawnOver(listed(), [
        { name: 'reorder_workspaces', payload: { ...envelope('ws-acme'), workspaceIds: ['ws-acme', 'ws-work'] } },
      ]);

      expect(shown(drawn)).toEqual(['Acme', 'Work', 'Home']);
    });

    it('builds each change on the one before it', () => {
      const drawn = listDrawnOver(listed(), [
        { name: 'rename_workspace', payload: { ...envelope('ws-home'), name: 'Family' } },
        { name: 'reorder_workspaces', payload: { ...envelope('ws-home'), workspaceIds: ['ws-home', 'ws-work', 'ws-acme'] } },
        { name: 'delete_workspace', payload: envelope('ws-acme') },
      ]);

      expect(shown(drawn)).toEqual(['Family', 'Work']);
    });

    describe('a new Workspace is drawn whole from what the tab made', () => {
      const made = (workspaceId: string, name = 'Bookkeeping'): CommandArgs => ({
        name: 'create_workspace',
        payload: { ...envelope(workspaceId), name, panelId: 'p-first' },
      });

      it('puts it at the end of the list in the first colour no other wears, with the palette’s other three', () => {
        const copy = listed();

        const drawn = listDrawnOver(copy, [made('ws-new')]);

        expect(shown(drawn)).toEqual(['Work', 'Home', 'Acme', 'Bookkeeping']);
        expect(drawn.workspaces[3]).toMatchObject({
          id: 'ws-new',
          color: THEMES[3].tint,
          bar: THEMES[3].bar,
          ground: THEMES[3].ground,
          header: THEMES[3].header,
        });
        expect(copy.workspaces).toHaveLength(3);
      });

      it('gives two Workspaces added in a row a colour each', () => {
        const drawn = listDrawnOver(listed(), [made('ws-new'), made('ws-newer', 'Reading')]);

        expect(drawn.workspaces.slice(3).map((one) => one.color)).toEqual([THEMES[3].tint, THEMES[4].tint]);
      });

      it('draws the first Workspace of an account on an empty list', () => {
        const drawn = listDrawnOver({ workspaces: [] }, [made('ws-new')]);

        expect(drawn.workspaces).toEqual([expect.objectContaining({ id: 'ws-new', name: 'Bookkeeping', color: THEMES[0].tint })]);
      });

      it('draws a Workspace the list holds already once, as it is held', () => {
        const copy = listed();

        expect(listDrawnOver(copy, [made('ws-home', 'Elsewhere')])).toEqual(copy);
      });

      it('holds its first Dashboard, named as the server names it, and that Dashboard’s Panel', () => {
        const drawn = noSnapshotYet(made('ws-new'));

        expect(drawn.dashboards).toEqual([expect.objectContaining({ id: 'ws-new-dashboard-1', workspaceId: 'ws-new', name: 'Dashboard 1' })]);
        expect(drawn.panels).toEqual([
          expect.objectContaining({ id: 'p-first', dashboardId: 'ws-new-dashboard-1', name: 'Panel 1', kind: 'items' }),
        ]);
      });

      it('leaves a Workspace the server has sent alone, so a Dashboard deleted since does not come back', () => {
        const copy = withDashboards('ws-new');

        expect(drawnAhead(copy, made('ws-new'))).toBe(copy);
      });

      it('leaves another Workspace’s copy alone', () => {
        const copy = { ...noSnapshotYet(made('ws-other')), dashboards: [], panels: [] };

        expect(drawnAhead(copy, made('ws-new'))).toBe(copy);
      });
    });
    it('draws nothing over a Workspace’s own copy', () => {
      const copy = withDashboards();

      expect(drawnAhead(copy, { name: 'rename_workspace', payload: { ...envelope('ws-work'), name: 'Family' } })).toBe(copy);
    });
  });
});


describe('Capture', () => {
  describe('a capture shows in the Inbox the moment it is made, before the server has it', () => {
    const captured = (over: Record<string, unknown> = {}): CommandArgs =>
      ({
        name: 'capture_item',
        payload: { ...envelope(BART), commandId: 'c-capture', message: 'call bart', ...over },
      }) as CommandArgs;
    const inWork = (items: Item[] = []) =>
      ({ workspace: { id: 'ws-work', tenantId: 'tenant' }, items, filings: [], panels: [] }) as unknown as WorkspaceSnapshot;
    const inTheInbox = (copy: WorkspaceSnapshot) => itemsInTheInbox(copy.items, []).map((item) => item.id);

    it.each([
      { situation: 'captured to this Workspace', over: {}, shown: [BART] },
      { situation: 'captured to Any workspace, from another Workspace', over: { workspaceId: 'ws-home', workspaceDecided: false }, shown: [BART] },
      { situation: 'captured to another Workspace', over: { workspaceId: 'ws-home' }, shown: [] },
    ])('$situation', ({ over, shown }) => {
      expect(inTheInbox(drawnAhead(inWork(), captured(over)))).toEqual(shown);
    });

    it('draws it once when the read already holds the row, as the server has it', () => {
      const held = anItem(BART, { title: 'Call Bart.' });

      const drawn = drawnAhead(inWork([held]), captured());

      expect(drawn.items).toEqual([held]);
    });

    it('draws it after the Items the Workspace already holds, as the server orders them', () => {
      expect(drawnAhead(inWork([anItem(LISA)]), captured()).items.map((item) => item.id)).toEqual([LISA, BART]);
    });

    it('names it as the server does, with the priority and due date the strip chose, and what the server decides left for the next read', () => {
      const copy = inWork();

      const drawn = read(drawnAhead(copy, captured({ message: '**call bart**\nabout the quote', priority: 'high', dueDate: '2026-10-23' })), BART)!;

      expect(drawn).toMatchObject({
        // Its words on one line for the title, and the note itself as the description.
        title: 'call bart about the quote',
        description: '**call bart**\nabout the quote',
        priority: 'high',
        dueDate: '2026-10-23',
        createdAt: AT,
        completedAt: null,
        readings: null,
        proposedPanelId: null,
      });
      expect(copy.items).toEqual([]);
    });

    it('takes the title a front door gave the note, with the note as the description', () => {
      const drawn = read(drawnAhead(inWork(), captured({ title: 'Quote for Bart' })), BART)!;

      expect(drawn).toMatchObject({ title: 'Quote for Bart', description: 'call bart' });
    });

    it('draws a whole Item, one the Inbox and the form can read like any other', () => {
      const drawn = read(drawnAhead(inWork(), captured()), BART);

      expect(itemSchema.safeParse(drawn).success).toBe(true);
    });
  });
});

describe('Triage', () => {
  describe('a pair said not to be a duplicate shows as settled the moment it is said, before the server has answered', () => {
    const MAGGIE = '11111111-1111-7111-8111-000000000003';
    const settled = (itemId: string, otherItemId: string, settledOrNot = true): CommandArgs =>
      ({ name: 'set_duplicate_settled', payload: { ...envelope(itemId), otherItemId, settled: settledOrNot } }) as CommandArgs;
    const flaggedPairs = (pairs: { itemId: string; otherItemId: string }[], items = [BART, LISA, MAGGIE]) =>
      ({
        workspace: { id: 'ws-work' },
        items: items.map((id) => anItem(id)),
        filings: [],
        panels: [],
        duplicates: pairs,
      }) as unknown as WorkspaceSnapshot;
    const marked = (copy: WorkspaceSnapshot) => [...itemsThatMayBeDuplicates(copy.items, [], copy.duplicates)].sort();

    it.each([
      { situation: 'said from the first note of the pair', change: settled(BART, LISA) },
      { situation: 'said from the second note of the pair', change: settled(LISA, BART) },
    ])('clears both notes’ marks when $situation', ({ change }) => {
      const copy = flaggedPairs([{ itemId: BART, otherItemId: LISA }]);

      const drawn = drawnAhead(copy, change);

      expect(marked(drawn)).toEqual([]);
      // The copy the server sent is as it was.
      expect(marked(copy)).toEqual([BART, LISA]);
    });

    it('clears both pairs of a note flagged against two others, and no pair it was not said of', () => {
      const copy = flaggedPairs([
        { itemId: BART, otherItemId: LISA },
        { itemId: BART, otherItemId: MAGGIE },
      ]);

      expect(marked(drawnAhead(copy, settled(BART, LISA)))).toEqual([BART, MAGGIE]);
      expect(marked(drawnOver(copy, [settled(BART, LISA), settled(BART, MAGGIE)]))).toEqual([]);
    });

    it('brings the pair back when the settling is taken back', () => {
      const drawn = drawnAhead(flaggedPairs([]), settled(LISA, BART, false));

      expect(marked(drawn)).toEqual([BART, LISA]);
    });

    it('draws a pair taken back once when the read already holds it, whichever way round', () => {
      const copy = flaggedPairs([{ itemId: BART, otherItemId: LISA }]);

      expect(drawnAhead(copy, settled(LISA, BART, false)).duplicates).toHaveLength(1);
    });

    it('does not bring a pair back whose other note has left the Workspace since', () => {
      const copy = flaggedPairs([], [BART]);

      expect(drawnAhead(copy, settled(BART, LISA, false)).duplicates).toEqual([]);
    });

    it('draws nothing in another Workspace', () => {
      const copy = flaggedPairs([{ itemId: BART, otherItemId: LISA }]);
      const change = { name: 'set_duplicate_settled', payload: { ...envelope(BART), workspaceId: 'ws-home', otherItemId: LISA, settled: true } } as CommandArgs;

      expect(drawnAhead(copy, change)).toBe(copy);
    });
  });
});

describe('Item editing', () => {
  describe('an attachment shows the moment it is uploaded or removed, before a read holds it', () => {
    const SCAN = '11111111-1111-7111-8111-0000000000a1';
    const NOTE = '11111111-1111-7111-8111-0000000000a2';
    const uploaded = (over: Record<string, unknown> = {}): Drawn => ({
      name: 'add_attachment',
      payload: { ...envelope(BART), attachmentId: SCAN, filename: 'scan.pdf', size: 5, contentType: 'application/pdf', ...over },
    });
    const removed = (attachmentId: string, over: Record<string, unknown> = {}): CommandArgs =>
      ({ name: 'remove_attachment', payload: { ...envelope(BART), attachmentId, ...over } }) as CommandArgs;
    const held = (id: string, filename: string): Attachment => ({
      id,
      tenantId: 'tenant',
      itemId: BART,
      filename,
      size: 5,
      contentType: 'application/pdf',
      createdAt: AT,
    });
    const inWork = (attachments: Attachment[] = [], items = [anItem(BART)]) =>
      ({ workspace: { id: 'ws-work', tenantId: 'tenant' }, items, filings: [], panels: [], attachments }) as unknown as WorkspaceSnapshot;

    it('draws an uploaded file as the chip the server reads back: its id, its Item, its name, size and type', () => {
      const drawn = drawnAhead(inWork(), uploaded());

      expect(drawn.attachments).toEqual([held(SCAN, 'scan.pdf')]);
      expect(attachmentSchema.safeParse(drawn.attachments[0]).success).toBe(true);
    });

    it('draws it after the files the Item already holds, and once when the read already holds it', () => {
      const earlier = held(NOTE, 'note.pdf');

      expect(drawnAhead(inWork([earlier]), uploaded()).attachments.map((one) => one.id)).toEqual([NOTE, SCAN]);
      const holding = inWork([held(SCAN, 'scan.pdf')]);
      expect(drawnAhead(holding, uploaded())).toBe(holding);
    });

    it.each([
      { situation: 'another Workspace', copy: { ...inWork(), workspace: { id: 'ws-home', tenantId: 'tenant' } } as unknown as WorkspaceSnapshot },
      { situation: 'a Workspace that no longer holds the Item', copy: inWork([], []) },
    ])('draws nothing in $situation', ({ copy }) => {
      expect(drawnAhead(copy, uploaded())).toBe(copy);
    });

    it('takes a removed file away and no other, and leaves the copy the server sent as it was', () => {
      const copy = inWork([held(SCAN, 'scan.pdf'), held(NOTE, 'note.pdf')]);

      const drawn = drawnAhead(copy, removed(SCAN));

      expect(drawn.attachments.map((one) => one.id)).toEqual([NOTE]);
      expect(copy.attachments).toHaveLength(2);
    });

    it('draws nothing of a removal in another Workspace', () => {
      const copy = inWork([held(SCAN, 'scan.pdf')]);

      expect(drawnAhead(copy, removed(SCAN, { workspaceId: 'ws-home' })).attachments).toEqual(copy.attachments);
    });

    it('draws a removal over an upload made before it, so a file added and taken away is not there', () => {
      expect(drawnOver(inWork(), [uploaded(), removed(SCAN)]).attachments).toEqual([]);
    });
  });
});

/**
 * "Set an Item to repeat from its form, and see the rule on its row" (issue
 * 1406): a repeat is the Item's series as the server will hold it, drawn from the
 * rule the change carries. That it is shown at once on the form and the row is
 * tests/unit/components/RepeatsAtOnce.test.tsx.
 */
describe('Item editing', () => {
  describe('a repeat shows the moment it is set, before the server has answered', () => {
    const SERIES = '11111111-1111-7111-8111-0000000000aa';
    const rule: { frequency: 'daily' | 'weekly' | 'monthly'; nextOn: string; dueAfterDays: number; timeZone: string } = { frequency: 'weekly', nextOn: '2026-11-02', dueAfterDays: 5, timeZone: 'Europe/Brussels' };
    const set = (repeat: typeof rule | null, seriesId = SERIES): CommandArgs => ({
      name: 'set_repeat',
      payload: { ...envelope(BART), seriesId, repeat },
    });
    const held = (items: Item[], series: WorkspaceSnapshot['series'] = []) =>
      ({ ...workspace(items), workspace: { tenantId: 'tenant' }, series }) as unknown as WorkspaceSnapshot;

    it('makes the series from the rule and has the Item name it', () => {
      const copy = held([anItem(BART, { seriesId: null }), anItem(LISA, { seriesId: null })]);

      const drawn = drawnAhead(copy, set(rule));

      expect(drawn.series).toEqual([{ id: SERIES, tenantId: 'tenant', ...rule, stoppedAt: null }]);
      expect(read(drawn, BART)?.seriesId).toBe(SERIES);
      expect(read(drawn, LISA)?.seriesId).toBeNull();
      expect(copy.series).toEqual([]);
    });

    it('changes the series the Item already names rather than making another', () => {
      const own = { id: 'series-own', tenantId: 'tenant', ...rule, stoppedAt: null };
      const copy = held([anItem(BART, { seriesId: 'series-own' })], [own]);

      const drawn = drawnAhead(copy, set({ ...rule, frequency: 'monthly' }));

      expect(drawn.series).toEqual([{ ...own, frequency: 'monthly' }]);
      expect(read(drawn, BART)?.seriesId).toBe('series-own');
    });

    it('stops the series on Never and leaves the Item naming it', () => {
      const own = { id: 'series-own', tenantId: 'tenant', ...rule, stoppedAt: null };
      const copy = held([anItem(BART, { seriesId: 'series-own' })], [own]);

      const drawn = drawnAhead(copy, set(null));

      expect(drawn.series).toEqual([{ ...own, stoppedAt: AT }]);
      expect(read(drawn, BART)?.seriesId).toBe('series-own');
    });

    it.each([
      { situation: 'Never on an Item that repeats nothing', change: set(null), items: [anItem(BART, { seriesId: null })] },
      { situation: 'a repeat on an Item the copy does not hold', change: set(rule), items: [anItem(LISA, { seriesId: null })] },
    ])('leaves the copy as it is for $situation', ({ change, items }) => {
      const copy = held(items);

      expect(drawnAhead(copy, change)).toBe(copy);
    });
  });
});
