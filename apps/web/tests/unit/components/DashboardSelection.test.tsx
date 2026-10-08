import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, Filing, Item, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { PanelBoard } from '../../../src/components/PanelBoard';
import { ItemList } from '../../../src/components/ItemList';
import { UndoWhatJustHappened } from '../../../src/undo';
import { NO_DASHBOARD_FILTER, useDashboardFilter } from '../../../src/dashboardFilter';
import { useCommand } from '../../../src/api/queries';

/**
 * F1: one selection across a Dashboard's Panels, as the person sees it - the
 * ticks, the one bar and the Panels' own menus. What the selection is made of
 * (a pick, a prune, a hand-over between the Inbox and a Dashboard) is decided
 * in tests/unit/selection.test.ts; this holds that the board is wired to it.
 * Where the bar sits and sticks needs a layout engine, and filing from it is
 * proved in the browser (tests/e2e/selecting.test.ts).
 */

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')),
  useNavigate: () => vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/api/queries', async () => {
  const actual = await vi.importActual<typeof import('../../../src/api/queries')>(
    '../../../src/api/queries',
  );
  return { ...actual, useCommand: vi.fn() };
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
    itemTypes: [],
    itemFormPresentation: 'centered',
    duplicates: [],
    filings: now.filings,
    agents: [],
    hiddenAgents: [],
    hasClaudeCodeConnection: false,
    agentRuns: [],
    claudeCodeFailing: null,
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
          itemTypes={[]}
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

const isPicked = (li: HTMLElement) => li.classList.contains('bg-accent-tint');

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

      expect(screen.getByText('1 selected')).toBeVisible();
      expect(isPicked(rowOf('To read', BART))).toBe(true);
    });

    it('draws no bar of its own on a Panel', async () => {
      const user = await showDashboard(TWO_PANELS);

      await tick(user, 'To read', RENEW);

      expect(within(screen.getByRole('region', { name: 'To read' })).queryByText('1 selected')).toBeNull();
      expect(within(screen.getByRole('region', { name: 'Project Falcon' })).queryByText('1 selected')).toBeNull();
      expect(screen.getByText('1 selected')).toBeVisible();
    });
  });

  describe('one scope holds a selection at a time, and leaving it ends it', () => {
    it('ends a Dashboard’s selection when another Dashboard is opened, and finds nothing picked on coming back', async () => {
      const later = aPanel('later-panel', 'Later panel', {}, OTHER.id);
      const user = await showDashboard({ ...TWO_PANELS, panels: [FALCON, READING, later] });
      await tick(user, 'Project Falcon', BART);
      expect(screen.getByText('1 selected')).toBeVisible();

      nextSnapshot({ dashboard: OTHER });
      expect(screen.queryByText('1 selected')).toBeNull();

      nextSnapshot({ dashboard: DASHBOARD });
      expect(screen.queryByText('1 selected')).toBeNull();
      expect(isPicked(rowOf('Project Falcon', BART))).toBe(false);
    });

    it('ends the Inbox’s selection when one is started on a Panel', async () => {
      const user = await showDashboard({ ...TWO_PANELS, inbox: [FILED_AWAY] });
      await user.keyboard('{Control>}');
      await user.click(screen.getByText(FILED_AWAY.title));
      await user.keyboard('{/Control}');
      expect(screen.getByText('1 selected')).toBeVisible();

      await tick(user, 'Project Falcon', BART);

      // One bar, and it is the Dashboard's: the Inbox's own is gone.
      expect(screen.getAllByText('1 selected')).toHaveLength(1);
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
      expect(await screen.findByText('1 selected')).toBeVisible();

      act(() => filter.result.current[1](NO_DASHBOARD_FILTER));
      expect(await screen.findByText('1 selected')).toBeVisible();
      expect(isPicked(rowOf('To read', RENEW))).toBe(false);
    });

    it('keeps an Item picked when it is moved to another Panel of the Dashboard', async () => {
      const user = await showDashboard(TWO_PANELS);
      await tick(user, 'Project Falcon', BART);

      nextSnapshot({
        filings: [filedOn('reading', BART.id, 2), filedOn('reading', RENEW.id), filedOn('reading', CHASE.id, 1)],
      });

      expect(await screen.findByText('1 selected')).toBeVisible();
      expect(isPicked(rowOf('To read', BART))).toBe(true);
    });

    it.each([
      { situation: 'moved off the Dashboard', filings: [filedOn('reading', RENEW.id), filedOn('reading', CHASE.id, 1)], items: TWO_PANELS.items },
      { situation: 'finished elsewhere', filings: TWO_PANELS.filings, items: [{ ...BART, completedAt: '2026-08-31T09:00:00.000Z' }, RENEW, CHASE] },
    ])('drops an Item $situation', async ({ filings, items }) => {
      const user = await showDashboard(TWO_PANELS);
      await tick(user, 'Project Falcon', BART);
      await tick(user, 'To read', RENEW);

      nextSnapshot({ filings, items });

      expect(await screen.findByText('1 selected')).toBeVisible();
    });

    it('is not emptied by the Inbox refreshing its list', async () => {
      // The prototype's bug: the Inbox's own housekeeping, run after every edit,
      // claimed the one held selection with nothing in it.
      const user = await showDashboard({ ...TWO_PANELS, inbox: [FILED_AWAY] });
      await tick(user, 'Project Falcon', BART);
      expect(screen.getByText('1 selected')).toBeVisible();

      nextSnapshot({ inbox: [FILED_AWAY, anItem('11111111-1111-7111-8111-000000000005', 'Newly captured')] });
      nextSnapshot({ inbox: [] });

      expect(screen.getByText('1 selected')).toBeVisible();
      expect(isPicked(rowOf('Project Falcon', BART))).toBe(true);
    });

    it('leaves what is picked on the other Panels alone when a Panel is removed', async () => {
      const user = await showDashboard(TWO_PANELS);
      await tick(user, 'Project Falcon', BART);
      await tick(user, 'To read', RENEW);

      nextSnapshot({ panels: [FALCON], filings: [filedOn('falcon', BART.id)] });

      expect(await screen.findByText('1 selected')).toBeVisible();
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
        filter: { conditions: [{ field: 'priority', values: ['high'] }], match: 'all', groupBy: 'none' },
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

      await screen.findByRole('menuitem', { name: 'Rename' });
      expect(screen.queryByRole('menuitem', { name: /^Select all/ })).toBeNull();
    });

    it('sits in a group of its own above Rename', async () => {
      const user = await showDashboard(TWO_PANELS);

      await user.click(screen.getByRole('button', { name: 'Actions for To read' }));

      const entries = (await screen.findAllByRole('menuitem')).map((entry) => entry.textContent);
      expect(entries.slice(0, 2)).toEqual(['Select all', 'Rename']);
    });
  });
});
