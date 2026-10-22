import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, Filing, Item, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { PanelBoard } from '../../../src/components/PanelBoard';
import { ItemList } from '../../../src/components/ItemList';
import { UndoWhatJustHappened } from '../../../src/undo';
import { NO_DASHBOARD_FILTER, useDashboardFilter } from '../../../src/dashboardFilter';
import { useCommand } from '../../../src/api/queries';
import { carryAcrossSwitch, landItem, liftItem } from '../../../src/itemInTheAir';
import { ITEM_BEING_DRAGGED } from '../../../src/dropAt';
import { dashboardScope, endSelection, pickedNow } from '../../../src/selection';

/**
 * F1: one selection across a Dashboard's Panels, as the person sees it - the
 * ticks, the one bar and the Panels' own menus. What the selection is made of
 * (a pick, a prune, a hand-over between the Inbox and a Dashboard) is decided
 * in tests/unit/selection.test.ts; this holds that the board is wired to it.
 * Where the bar sits and sticks needs a layout engine, and filing from it is
 * proved in the browser (tests/e2e/selecting.test.ts).
 */

/** What filing a selection sends, answered as the server would answer a change that is accepted. */
const held = vi.hoisted(() => ({
  send: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')),
  useNavigate: () => vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/api/queries', async () => {
  const actual = await vi.importActual<typeof import('../../../src/api/queries')>(
    '../../../src/api/queries',
  );
  return { ...actual, useCommand: vi.fn(), useSendCommand: () => held.send };
});

const DASHBOARD: Dashboard = { id: 'today', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Today' };
const OTHER: Dashboard = { id: 'later', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Later' };

function aPanel(id: string, name: string, over: Partial<Panel> = {}, dashboardId = DASHBOARD.id): Panel {
  return {
    id,
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
  };
}

function anItem(id: string, title: string): Item {
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
    title,
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
  };
}

const filedOn = (panelId: string, itemId: string, position = 0): Filing =>
  ({ id: `${panelId}-${itemId}`, tenantId: 'tenant', panelId, itemId, position }) as Filing;

const BART = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
const RENEW = anItem('11111111-1111-7111-8111-000000000002', 'Renew the licence');
const CHASE = anItem('11111111-1111-7111-8111-000000000003', 'Chase the invoice');
const FILED_AWAY = anItem('11111111-1111-7111-8111-000000000004', 'File the receipts');

const FALCON = aPanel('falcon', 'Project Falcon');
const READING = aPanel('reading', 'To read');
const EMPTY = aPanel('empty', 'Nothing yet');
const NOTES = aPanel('notes', 'Notes', { kind: 'text' });

/** What the next snapshot holds: the Items, where they are filed, and the Panels. */
interface World {
  items: Item[];
  filings: Filing[];
  panels: Panel[];
  /** What the Inbox shows beside the Dashboard. */
  inbox?: Item[];
  dashboard?: Dashboard;
}

let client: QueryClient;
let world: World;
let view: ReturnType<typeof render>;

function snapshotOf(now: World): WorkspaceSnapshot {
  return {
    workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: now.items,
    dashboards: [DASHBOARD, OTHER],
    panels: now.panels,
    layouts: [],
    associations: [],
    attachments: [],
    itemFormPresentation: 'centered',
    duplicates: [],
    filings: now.filings,
    agentRuns: [],
    generatedAt: '2026-08-31T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

/** The Panels' rows on the Dashboard, and beside it the Inbox, as the page draws them. */
function screenFor(now: World) {
  const dashboard = now.dashboard ?? DASHBOARD;
  return (
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <PanelBoard
          workspaceId="ws-work"
          dashboard={dashboard}
          dashboards={[DASHBOARD, OTHER]}
          panels={now.panels.filter((panel) => panel.dashboardId === dashboard.id)}
          panelsInWorkspace={now.panels}
          layouts={[]}
          items={now.items}
          attachments={[]}
          agentRuns={[]}
          filings={now.filings}
        />
        {now.inbox && (
          <ItemList
            workspaceId="ws-work"
            items={now.inbox}
            openDashboardId={dashboard.id}
            emptyMessage="Nothing to deal with."
          />
        )}
      </UndoWhatJustHappened>
    </QueryClientProvider>
  );
}

/** Draws the Dashboard, and answers the user to drive it with. */
function showDashboard(now: World) {
  world = now;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['snapshot', 'ws-work'], snapshotOf(now));
  vi.mocked(useCommand).mockReturnValue({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
    variables: undefined,
  } as never);
  view = render(screenFor(now));
  return userEvent.setup();
}

/** The next snapshot arriving, drawn under the board already on screen. */
function nextSnapshot(changes: Partial<World>) {
  world = { ...world, ...changes };
  act(() => {
    client.setQueryData(['snapshot', 'ws-work'], snapshotOf(world));
  });
  view.rerender(screenFor(world));
}

const rowOf = (panel: string, item: Item) =>
  within(screen.getByRole('region', { name: panel })).getByText(item.title).closest('li')!;

const isPicked = (li: HTMLElement) => li.classList.contains('row-picked');

async function tick(user: ReturnType<typeof userEvent.setup>, panel: string, item: Item, withShift = false) {
  const key = withShift ? 'Shift' : 'Control';
  await user.keyboard(`{${key}>}`);
  await user.click(within(screen.getByRole('region', { name: panel })).getByText(item.title));
  await user.keyboard(`{/${key}}`);
}

async function chooseFromMenu(user: ReturnType<typeof userEvent.setup>, panel: string, entry: string) {
  await user.click(screen.getByRole('button', { name: `Actions for ${panel}` }));
  await user.click(await screen.findByRole('menuitem', { name: new RegExp(`^${entry}`) }));
}

const TWO_PANELS: World = {
  items: [BART, RENEW, CHASE],
  filings: [filedOn('falcon', BART.id), filedOn('reading', RENEW.id), filedOn('reading', CHASE.id, 1)],
  panels: [FALCON, READING],
};

beforeEach(() => {
  localStorage.clear();
  held.send = vi.fn(() => Promise.resolve());
});

describe('Selection', () => {
  describe('a Dashboard holds one selection across all its Panels, counting each Item once', () => {
    it('adds a pick on a second Panel to the first, under one bar', async () => {
      const user = await showDashboard(TWO_PANELS);

      await tick(user, 'Project Falcon', BART);
      await tick(user, 'To read', RENEW);

      expect(screen.getAllByText('2 selected')).toHaveLength(1);
      expect(isPicked(rowOf('Project Falcon', BART))).toBe(true);
      expect(isPicked(rowOf('To read', RENEW))).toBe(true);
      expect(isPicked(rowOf('To read', CHASE))).toBe(false);
    });

    it('ticks an Item shown on two Panels on both, and counts it once', async () => {
      const user = await showDashboard({
        ...TWO_PANELS,
        filings: [...TWO_PANELS.filings, filedOn('reading', BART.id, 2)],
      });

      await tick(user, 'Project Falcon', BART);
      await tick(user, 'To read', RENEW);

      expect(screen.getByText('2 selected')).toBeVisible();
      expect(isPicked(rowOf('To read', BART))).toBe(true);
    });

    it('draws no bar of its own on a Panel', async () => {
      const user = await showDashboard(TWO_PANELS);

      await tick(user, 'To read', RENEW);
      await tick(user, 'To read', CHASE);

      expect(within(screen.getByRole('region', { name: 'To read' })).queryByText('2 selected')).toBeNull();
      expect(within(screen.getByRole('region', { name: 'Project Falcon' })).queryByText('2 selected')).toBeNull();
      expect(screen.getByText('2 selected')).toBeVisible();
    });
  });

  describe('one scope holds a selection at a time, and leaving it ends it', () => {
    it('ends a Dashboard’s selection when another Dashboard is opened, and finds nothing picked on coming back', async () => {
      const later = aPanel('later-panel', 'Later panel', {}, OTHER.id);
      const user = await showDashboard({ ...TWO_PANELS, panels: [FALCON, READING, later] });
      await tick(user, 'Project Falcon', BART);
      expect(isPicked(rowOf('Project Falcon', BART))).toBe(true);

      nextSnapshot({ dashboard: OTHER });
      nextSnapshot({ dashboard: DASHBOARD });

      expect(isPicked(rowOf('Project Falcon', BART))).toBe(false);
    });

    it('ends the Inbox’s selection when one is started on a Panel', async () => {
      const user = await showDashboard({ ...TWO_PANELS, inbox: [FILED_AWAY] });
      await user.keyboard('{Control>}');
      await user.click(screen.getByText(FILED_AWAY.title));
      await user.keyboard('{/Control}');
      expect(isPicked(screen.getByText(FILED_AWAY.title).closest('li')!)).toBe(true);

      await tick(user, 'Project Falcon', BART);
      await tick(user, 'To read', RENEW);

      // One bar, and it is the Dashboard's: the Inbox's own is gone.
      expect(screen.getAllByText('2 selected')).toHaveLength(1);
      expect(isPicked(screen.getByText(FILED_AWAY.title).closest('li')!)).toBe(false);
      expect(isPicked(rowOf('Project Falcon', BART))).toBe(true);
    });
  });

  describe('a picked Item no shown Panel holds leaves the selection; nothing else empties it', () => {
    it('drops an Item a Dashboard filter hides, and does not bring it back picked when the filter clears', async () => {
      const user = await showDashboard(TWO_PANELS);
      await tick(user, 'Project Falcon', BART);
      await tick(user, 'To read', RENEW);
      expect(screen.getByText('2 selected')).toBeVisible();

      const filter = renderHook(() => useDashboardFilter(localStorage, DASHBOARD.id));
      act(() => filter.result.current[1]({ ...NO_DASHBOARD_FILTER, text: 'bart' }));
      await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
      expect(isPicked(rowOf('Project Falcon', BART))).toBe(true);

      act(() => filter.result.current[1](NO_DASHBOARD_FILTER));
      await waitFor(() => expect(isPicked(rowOf('To read', RENEW))).toBe(false));
      expect(isPicked(rowOf('Project Falcon', BART))).toBe(true);
    });

    it('keeps an Item picked when it is moved to another Panel of the Dashboard', async () => {
      const user = await showDashboard(TWO_PANELS);
      await tick(user, 'Project Falcon', BART);

      nextSnapshot({
        filings: [filedOn('reading', BART.id, 2), filedOn('reading', RENEW.id), filedOn('reading', CHASE.id, 1)],
      });

      await waitFor(() => expect(isPicked(rowOf('To read', BART))).toBe(true));
    });

    it.each([
      { situation: 'moved off the Dashboard', filings: [filedOn('reading', RENEW.id), filedOn('reading', CHASE.id, 1)], items: TWO_PANELS.items },
      { situation: 'finished elsewhere', filings: TWO_PANELS.filings, items: [{ ...BART, completedAt: '2026-08-31T09:00:00.000Z' }, RENEW, CHASE] },
    ])('drops an Item $situation', async ({ filings, items }) => {
      const user = await showDashboard(TWO_PANELS);
      await tick(user, 'Project Falcon', BART);
      await tick(user, 'To read', RENEW);

      nextSnapshot({ filings, items });

      await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
      expect(isPicked(rowOf('To read', RENEW))).toBe(true);
    });

    it('is not emptied by the Inbox refreshing its list', async () => {
      // The prototype's bug: the Inbox's own housekeeping, run after every edit,
      // claimed the one held selection with nothing in it.
      const user = await showDashboard({ ...TWO_PANELS, inbox: [FILED_AWAY] });
      await tick(user, 'Project Falcon', BART);
      expect(isPicked(rowOf('Project Falcon', BART))).toBe(true);

      nextSnapshot({ inbox: [FILED_AWAY, anItem('11111111-1111-7111-8111-000000000005', 'Newly captured')] });
      nextSnapshot({ inbox: [] });

      expect(isPicked(rowOf('Project Falcon', BART))).toBe(true);
    });

    it('leaves what is picked on the other Panels alone when a Panel is removed', async () => {
      const user = await showDashboard(TWO_PANELS);
      await tick(user, 'Project Falcon', BART);
      await tick(user, 'To read', RENEW);

      nextSnapshot({ panels: [FALCON], filings: [filedOn('falcon', BART.id)] });

      await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
      expect(isPicked(rowOf('Project Falcon', BART))).toBe(true);
    });
  });

  describe('Select all adds what a Panel shows to what is already picked', () => {
    it('picks every row of the Panel, on top of a pick made on another', async () => {
      const user = await showDashboard(TWO_PANELS);
      await tick(user, 'Project Falcon', BART);

      await chooseFromMenu(user, 'To read', 'Select all');

      expect(screen.getByText('3 selected')).toBeVisible();
      expect(isPicked(rowOf('To read', RENEW))).toBe(true);
      expect(isPicked(rowOf('To read', CHASE))).toBe(true);
    });

    it('picks what a Filter panel gathers', async () => {
      const urgent = { ...BART, priority: 'high' as const };
      const gathering = aPanel('gathering', 'Urgent', {
        kind: 'filter',
        filter: { rows: [[{ field: 'priority', values: ['high'] }]], groupBy: 'none' },
      });
      const user = await showDashboard({
        ...TWO_PANELS,
        items: [urgent, RENEW, CHASE],
        panels: [FALCON, READING, gathering],
      });
      await tick(user, 'To read', RENEW);

      await chooseFromMenu(user, 'Urgent', 'Select all');

      expect(screen.getByText('2 selected')).toBeVisible();
      expect(isPicked(rowOf('Project Falcon', urgent))).toBe(true);
    });

    it('is offered, saying why it cannot be chosen, on a Panel with no items', async () => {
      const user = await showDashboard({ ...TWO_PANELS, panels: [FALCON, READING, EMPTY] });

      await user.click(screen.getByRole('button', { name: 'Actions for Nothing yet' }));

      const entry = await screen.findByRole('menuitem', { name: /^Select all/ });
      expect(entry).toHaveAttribute('aria-disabled', 'true');
      expect(entry).toHaveTextContent('This panel has no items');
    });

    it('is not offered on a Panel of text', async () => {
      const user = await showDashboard({ ...TWO_PANELS, panels: [FALCON, READING, NOTES] });

      await user.click(screen.getByRole('button', { name: 'Actions for Notes' }));

      await screen.findByRole('menuitem', { name: 'Settings…' });
      expect(screen.queryByRole('menuitem', { name: /^Select all/ })).toBeNull();
    });

    it('sits in a group of its own above Settings…', async () => {
      const user = await showDashboard(TWO_PANELS);

      await user.click(screen.getByRole('button', { name: 'Actions for To read' }));

      const entries = (await screen.findAllByRole('menuitem')).map((entry) => entry.textContent);
      expect(entries.slice(0, 2)).toEqual(['Select all', 'Settings…']);
    });
  });

  describe('a selection moved from a Dashboard takes each Item off that Dashboard’s Panels only', () => {
    const ELSEWHERE = aPanel('elsewhere', 'Elsewhere', {}, OTHER.id);
    const TARGET = aPanel('target', 'Target panel', {}, OTHER.id);

    /** What each filing named: the change, the Item, and the Panels a move takes it off. */
    function sent() {
      return (held.send.mock.calls as unknown as [{ name: string; payload: Record<string, unknown> }][])
        .filter(([{ payload }]) => payload.itemId !== CHASE.id)
        .map(
        ([{ name, payload }]) => ({
          name,
          itemId: payload.itemId,
          panelId: payload.panelId,
          from: payload.fromPanelIds as string[] | undefined,
          order: payload.order as string[] | undefined,
        }),
      );
    }

    async function moveSelectionTo(
      user: ReturnType<typeof userEvent.setup>,
      picks: [string, Item][],
      target: string | RegExp,
    ) {
      // One picked row has no bar, so a lone pick is joined by a decoy that `sent` leaves out.
      for (const [panel, item] of picks.length === 1 ? [...picks, ['Project Falcon', CHASE] as [string, Item]] : picks)
        await tick(user, panel, item);
      await user.click(screen.getByRole('button', { name: 'Move to…' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: target }));
    }

    const on = (...filings: Filing[]): World => ({
      items: [BART, RENEW, CHASE],
      filings: [...filings, filedOn('falcon', CHASE.id, 9)],
      panels: [FALCON, READING, ELSEWHERE, TARGET],
    });

    it('names the Panel here an Item is on, and not the one on another Dashboard', async () => {
      const user = await showDashboard(on(filedOn('falcon', BART.id), filedOn('elsewhere', BART.id, 1)));

      await moveSelectionTo(user, [['Project Falcon', BART]], 'Target panel');

      await waitFor(() => expect(sent()).toHaveLength(1));
      expect(sent()[0]).toMatchObject({ name: 'move_item_to_panel', panelId: 'target', from: ['falcon'] });
    });

    it('names every Panel of the Dashboard an Item is on', async () => {
      const user = await showDashboard(on(filedOn('falcon', BART.id), filedOn('reading', BART.id, 1)));

      await moveSelectionTo(user, [['Project Falcon', BART]], 'Target panel');

      await waitFor(() => expect(sent()).toHaveLength(1));
      expect([...sent()[0]!.from!].sort()).toEqual(['falcon', 'reading']);
    });

    it('names, for each Item of a selection, its own Panels here', async () => {
      const user = await showDashboard(
        on(
          filedOn('falcon', BART.id),
          filedOn('elsewhere', BART.id, 1),
          filedOn('reading', RENEW.id),
          filedOn('elsewhere', RENEW.id, 2),
        ),
      );

      await moveSelectionTo(
        user,
        [
          ['Project Falcon', BART],
          ['To read', RENEW],
        ],
        'Target panel',
      );

      await waitFor(() => expect(sent()).toHaveLength(2));
      expect(sent().map((s) => [s.itemId, s.from])).toEqual([
        [BART.id, ['falcon']],
        [RENEW.id, ['reading']],
      ]);
    });

    it('adds an Item this Dashboard shows only through a Filter, instead of a move naming no Panel', async () => {
      const gathering = aPanel('gathering', 'Urgent', {
        kind: 'filter',
        filter: { rows: [[{ field: 'priority', values: ['high'] }]], groupBy: 'none' },
      });
      const urgent = { ...BART, priority: 'high' as const };
      const user = await showDashboard({
        items: [urgent, CHASE],
        filings: [filedOn('elsewhere', urgent.id), filedOn('falcon', CHASE.id)],
        panels: [gathering, FALCON, ELSEWHERE, TARGET],
      });

      await moveSelectionTo(user, [['Urgent', urgent]], 'Target panel');

      await waitFor(() => expect(sent()).toHaveLength(1));
      expect(sent()[0]).toMatchObject({ name: 'add_item_to_panel', panelId: 'target' });
      expect(sent()[0]!.from).toBeUndefined();
    });

    it('chains the orders when a move and an add are mixed in one selection', async () => {
      const gathering = aPanel('gathering', 'Urgent', {
        kind: 'filter',
        filter: { rows: [[{ field: 'priority', values: ['high'] }]], groupBy: 'none' },
      });
      const urgent = { ...RENEW, priority: 'high' as const };
      const user = await showDashboard({
        items: [BART, urgent, CHASE],
        filings: [filedOn('falcon', BART.id), filedOn('elsewhere', urgent.id), filedOn('target', CHASE.id)],
        panels: [FALCON, gathering, ELSEWHERE, TARGET],
      });

      await moveSelectionTo(
        user,
        [
          ['Project Falcon', BART],
          ['Urgent', urgent],
        ],
        'Target panel',
      );

      await waitFor(() => expect(sent()).toHaveLength(2));
      const [first, second] = sent();
      // The second is an add, and its order still names the first as well as the panel's own.
      expect([first!.name, first!.from]).toEqual(['move_item_to_panel', ['falcon']]);
      expect(second!.name).toBe('add_item_to_panel');
      expect(first!.order).toEqual([BART.id, CHASE.id]);
      expect(second!.order).toEqual([BART.id, urgent.id, CHASE.id]);
    });

    it('names only the Panel it leaves for an Item already on the target', async () => {
      const user = await showDashboard(on(filedOn('falcon', BART.id), filedOn('target', BART.id, 1)));

      await moveSelectionTo(user, [['Project Falcon', BART]], 'Target panel');

      await waitFor(() => expect(sent()).toHaveLength(1));
      expect(sent()[0]).toMatchObject({ name: 'move_item_to_panel', panelId: 'target', from: ['falcon'] });
    });

    it('names no Panel when it is moved to the Inbox, which takes it off every one', async () => {
      const user = await showDashboard(on(filedOn('falcon', BART.id), filedOn('elsewhere', BART.id, 1)));

      await moveSelectionTo(user, [['Project Falcon', BART]], /^Inbox/);

      await waitFor(() => expect(sent()).toHaveLength(1));
      expect(sent()[0]).toMatchObject({ name: 'move_item_to_panel', panelId: null });
      expect(sent()[0]!.from).toBeUndefined();
    });
  });
});
describe('Selection', () => {
  describe('a selection survives the Dashboard switch its own drag made, and only that one', () => {
    const TARGET = aPanel('target', 'Target panel', {}, OTHER.id);
    const ALREADY_THERE = anItem('11111111-1111-7111-8111-000000000005', 'Already on Target');
    const here = dashboardScope(DASHBOARD.id);
    const ON_TWO_PANELS: World = {
      items: [BART, RENEW, CHASE, ALREADY_THERE],
      filings: [
        filedOn('falcon', BART.id),
        filedOn('reading', RENEW.id),
        // On a Panel of the Dashboard it is dropped on already: a move from here leaves it be.
        filedOn('target', ALREADY_THERE.id),
        filedOn('reading', CHASE.id, 1),
      ],
      panels: [FALCON, READING, TARGET],
    };

    beforeEach(() => {
      landItem();
      endSelection();
    });

    /** Two rows picked on this Dashboard, one from each Panel. */
    async function pickedOnTwoPanels() {
      const user = await showDashboard(ON_TWO_PANELS);
      await tick(user, 'Project Falcon', BART);
      await tick(user, 'To read', RENEW);
      return user;
    }

    /** The drag of the picked rows, in the air, as a row's own drag start leaves it. */
    const lifted = () => liftItem(BART.id, 'falcon', { ids: [BART.id, RENEW.id], scope: here });

    /** What a tab does when the drag has rested on it long enough. */
    const restedOnTheTab = () =>
      act(() => {
        lifted();
        carryAcrossSwitch(here);
      });

    /** The filing server: a move leaves only the Panels it names, or every one; the board is redrawn from what is left. */
    function filesAsTheServerDoes() {
      held.send = vi.fn((args: unknown) => {
        const { name, payload } = args as {
          name: string;
          payload: { itemId: string; panelId: string | null; order: string[]; fromPanelIds?: string[] };
        };
        const left = (filing: Filing) =>
          name === 'move_item_to_panel' &&
          filing.itemId === payload.itemId &&
          (!payload.fromPanelIds || payload.fromPanelIds.includes(filing.panelId));
        const arriving = payload.panelId
          ? payload.order.map((itemId, position) => filedOn(payload.panelId!, itemId, position))
          : [];
        nextSnapshot({
          filings: [
            ...world.filings.filter((filing) => !left(filing) && filing.panelId !== payload.panelId),
            ...arriving,
          ],
        });
        return Promise.resolve();
      });
    }

    const targetBox = () => within(screen.getByRole('region', { name: 'Target panel' })).getByRole('list').parentElement!;
    async function dropOnTarget(grabbed: Item) {
      await act(async () => {});
      const dataTransfer = {
        types: [ITEM_BEING_DRAGGED],
        getData: (type: string) => (type === ITEM_BEING_DRAGGED ? grabbed.id : ''),
        setData: vi.fn(),
        dropEffect: '',
      };
      fireEvent.dragOver(targetBox(), { dataTransfer });
      fireEvent.drop(targetBox(), { dataTransfer });
    }
    const filedOnPanels = (item: Item) => world.filings.filter((f) => f.itemId === item.id).map((f) => f.panelId);

    it('is still held on the Dashboard the drag rested on, where it was picked on another', async () => {
      await pickedOnTwoPanels();

      restedOnTheTab();
      nextSnapshot({ dashboard: OTHER });

      expect([...pickedNow(here)]).toEqual([BART.id, RENEW.id]);
    });

    it('ends at once on a switch the drag did not make, even with a drag in the air', async () => {
      await pickedOnTwoPanels();

      act(lifted);
      nextSnapshot({ dashboard: OTHER });

      expect(pickedNow(here).size).toBe(0);
    });

    it('ends when the drag is cancelled after the switch, there being no row left to say so', async () => {
      await pickedOnTwoPanels();
      restedOnTheTab();
      nextSnapshot({ dashboard: OTHER });

      act(() => {
        document.dispatchEvent(new Event('dragend', { bubbles: true }));
      });

      expect(pickedNow(here).size).toBe(0);
    });

    it('ends when the pointer comes back after a drag that let go over nothing', async () => {
      await pickedOnTwoPanels();
      restedOnTheTab();
      nextSnapshot({ dashboard: OTHER });

      act(() => {
        document.dispatchEvent(new Event('pointermove', { bubbles: true }));
      });

      expect(pickedNow(here).size).toBe(0);
    });

    it('files every picked Item on a Panel there, taking each off the Panels of the Dashboard it was picked on', async () => {
      filesAsTheServerDoes();
      const user = await pickedOnTwoPanels();
      restedOnTheTab();
      nextSnapshot({ dashboard: OTHER });

      await dropOnTarget(BART);
      await user.click(await screen.findByRole('button', { name: 'Move them here' }));

      await waitFor(() => expect(held.send).toHaveBeenCalledTimes(2));
      expect(held.send.mock.calls.map(([call]) => [call.name, call.payload.itemId, call.payload.fromPanelIds])).toEqual([
        ['move_item_to_panel', BART.id, ['falcon']],
        ['move_item_to_panel', RENEW.id, ['reading']],
      ]);
      expect(filedOnPanels(BART)).toEqual(['target']);
      expect(filedOnPanels(RENEW)).toEqual(['target']);
      // Another Item of the Panel it left stays where it was.
      expect(filedOnPanels(CHASE)).toEqual(['reading']);
      expect(await screen.findByText('2 items moved to Target panel')).toBeVisible();
      // Nothing is left picked on a Dashboard it was not picked on.
      expect(pickedNow(here).size).toBe(0);
    });

    it('names the Dashboard the rows were picked on as the one a move leaves, not the one on screen', async () => {
      await pickedOnTwoPanels();
      restedOnTheTab();
      nextSnapshot({ dashboard: OTHER });

      await dropOnTarget(BART);

      expect(await screen.findByRole('alertdialog')).toHaveTextContent(
        'Moving them takes each off the other panels of Today;',
      );
    });

    it('puts every Item back on the Panels it left when the move is undone', async () => {
      filesAsTheServerDoes();
      const user = await pickedOnTwoPanels();
      restedOnTheTab();
      nextSnapshot({ dashboard: OTHER });
      await dropOnTarget(BART);
      await user.click(await screen.findByRole('button', { name: 'Move them here' }));
      await screen.findByText('2 items moved to Target panel');

      await user.click(screen.getByRole('button', { name: 'Undo' }));

      await waitFor(() => expect(filedOnPanels(BART)).toEqual(['falcon']));
      expect(filedOnPanels(RENEW)).toEqual(['reading']);
    });

    it('files nothing, and ends, when the question is cancelled', async () => {
      filesAsTheServerDoes();
      const user = await pickedOnTwoPanels();
      restedOnTheTab();
      nextSnapshot({ dashboard: OTHER });
      await dropOnTarget(BART);

      await user.click(await screen.findByRole('button', { name: 'Cancel' }));

      expect(held.send).not.toHaveBeenCalled();
      expect(pickedNow(here).size).toBe(0);
    });
  });
});
