import { describe, expect, it } from 'vitest';
import { itemLabel, itemStatus, type Item, type WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from '../../src/api/queries';
import { createChangeQueue } from '../../src/changeQueue';
import { drawnAhead, drawnOver } from '../../src/drawnAhead';

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
