import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  Dashboard,
  Layout,
  Panel,
  PossibleDuplicate,
  WorkspaceSnapshot,
} from '@cockpit/shared';
import { DashboardBar } from '../../../src/components/DashboardBar';
import { readAllItemsTab, setAllItemsTab } from '../../../src/allItemsTab';
import { DashboardFilterBar } from '../../../src/components/DashboardFilterBar';
import { filterPills } from '../../../src/components/FilterSummary';
import {
  NO_DASHBOARD_FILTER,
  readDashboardFilter,
  useFilterBarOpen,
  writeDashboardFilter,
} from '../../../src/dashboardFilter';
import { CommandRefused } from '../../../src/api/client';
import { useCommand, useSendCommand } from '../../../src/api/queries';
import { A_DESK, A_PHONE, onAScreen } from '../onAScreen';
import { ITEM_BEING_DRAGGED } from '../../../src/dropAt';
import { setPanelsCollapsed, usePanelsCollapsed } from '../../../src/panelsCollapsed';
import { DWELL_MS } from '../../../src/switchWhileDragging';
import { WHAT_A_DASHBOARD_IS, WHAT_A_PANEL_IS } from '../../../src/whatThingsAre';

/**
 * F1: what is under test is the bar's own behaviour - what it shows, what it
 * asks for, and what it does with an answer it does not like. Whether a name is
 * actually refused is the server's rule and is proved against a real store in
 * apps/api/tests/integration/http/dashboards.test.ts.
 */
const held = vi.hoisted(() => ({
  dashboards: [] as Dashboard[],
  panels: [] as Panel[],
  layouts: [] as Layout[],
  duplicates: [] as PossibleDuplicate[],
  /**
   * Which dashboard the address names, so the stand-in `Link` below can mark
   * that tab the way the router marks it. Without it no tab is ever current
   * here, and every rule about the tab you are on would pass by asking nothing.
   */
  openDashboardId: null as string | null,
  /** That the address is *All items*, so its tab is marked the way the router marks it. */
  allItemsOpen: false,
}));

// The router is not under test, and `to`/`params` are its props rather than an
// anchor's, so they stop here instead of being spread onto the DOM.
const wentTo = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@tanstack/react-router', () => ({
  // `href` so it is a link to the accessibility tree, which is what the bar's
  // entries are; where each one goes is the router's, and is walked in
  // tests/e2e/dashboards.test.ts.
  //
  // Everything else is passed through rather than dropped: the entry inside
  // the bar's menu is a `Link` rendered `asChild`, so the role that makes it a
  // menu entry arrives as a prop from Radix and a mock that kept only
  // `children` would quietly render it as an ordinary anchor.
  Link: ({
    children,
    to,
    search: _search,
    params,
    className,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: string;
    search?: unknown;
    params?: { dashboardId?: string };
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href="#"
      // `active` the way the router adds it to the tab whose address is the one
      // on screen, which is what the bar's own styling and its focus after a
      // delete both read.
      className={`${className ?? ''}${
        (params?.dashboardId && params.dashboardId === held.openDashboardId) ||
        (to === '/w/$workspaceId/items' && held.allItemsOpen)
          ? ' active'
          : ''
      }`}
      {...rest}
    >
      {children}
    </a>
  ),
  // Adding one switches to it, so the navigating is replaced and what it was
  // asked for is read back.
  useNavigate: () => (to: unknown) => {
    wentTo.calls.push(to);
  },
}));

vi.mock('../../../src/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/queries')>()),
  useCommand: vi.fn(),
  useSendCommand: vi.fn(),
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        workspace: {
          id: workspaceId,
          tenantId: 'tenant',
          name: 'Work',
          color: '#6f62b5',
          bar: '#dbd7ee',
          ground: '#e3e1f2',
          header: '#d2cdea',
        },
        items: [],
        dashboards: held.dashboards,
        panels: held.panels,
        layouts: held.layouts,
        associations: [],
        attachments: [],
        itemTypes: [],
        itemFormPresentation: 'centered',
        duplicates: held.duplicates,
        filings: [],
        agents: [],
        hiddenAgents: [],
        hasClaudeCodeConnection: false,
        agentRuns: [],
        claudeCodeFailing: null,
        generatedAt: '2026-09-01T09:00:00.000Z',
      } as WorkspaceSnapshot),
  }),
}));

const mockUseCommand = vi.mocked(useCommand);
const mockUseSendCommand = vi.mocked(useSendCommand);

function aDashboard(name: string): Dashboard {
  return {
    id: `ws-work-${name.toLowerCase()}`,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    name,
  };
}

/** What the unavailable *Collapse panels* says beside its name, as the menu's text reads it. */
const NOT_A_PHONE = 'Only on a phone, where panels are drawn one above the next';

/** The width the bar reads, which is what decides whether this is a phone. */
function screenIs(width: number) {
  Object.defineProperty(globalThis, 'innerWidth', { value: width, configurable: true, writable: true });
}

/** What the bar asks the server for, in the shape both senders take it. */
type AskedFor = { name: string; payload: Record<string, string> };

/** A panel on a dashboard, which is what deleting that dashboard takes with it. */
function aPanel(name: string, dashboardId: string): Panel {
  return {
    id: name.toLowerCase().replace(/\s/g, '-'),
    tenantId: 'tenant',
    dashboardId,
    name,
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    filter: null,
    sort: null,
  };
}

/**
 * The bar of a workspace holding these dashboards.
 *
 * The mutation is replaced by one that behaves like the real one rather than by
 * a fixed value: `reset` really clears the error, because "the refusal is not
 * still there next time" is a claim about what the screen shows afterwards, and
 * a mock that only recorded the call could not tell that from a screen that
 * still shows it.
 */
function showBar(
  names: string[],
  answer: {
    error?: Error;
    openDashboardId?: string | null;
    panels?: Panel[];
    layouts?: Layout[];
    /** What a Save comes back with, the form sending its own change. */
    sendFails?: Error;
    /** A dashboard another tab adds while a refused move is in flight. */
    arrivesInFlight?: string;
    /** Draws the filter bar beneath, which the page does in the board's own place. */
    withFilterBar?: boolean;
    /** *All items* is the page on screen, as its address makes it. */
    allItemsOpen?: boolean;
  } = {},
) {
  held.dashboards = names.map(aDashboard);
  held.panels = answer.panels ?? [];
  held.layouts = answer.layouts ?? [];
  held.openDashboardId = answer.openDashboardId ?? null;
  held.allItemsOpen = answer.allItemsOpen ?? false;
  wentTo.calls = [];
  const asked: { error: Error | null; variables: unknown; keptOnRefusal: string[] } = {
    error: answer.error ?? null,
    variables: null,
    keptOnRefusal: [],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mutate = vi.fn(
    (args: AskedFor, options?: { onSuccess?: () => void; onError?: () => void }) => {
      asked.variables = args;
      if (answer.error) {
        if (answer.arrivesInFlight) {
          const arrived = aDashboard(answer.arrivesInFlight);
          // In front on the server's side and behind in the cache, so what the
          // cache holds is told apart from what the re-read would put there.
          held.dashboards = [arrived, ...held.dashboards];
          client.setQueryData<WorkspaceSnapshot>(['snapshot', 'ws-work'], (now) =>
            now ? { ...now, dashboards: [...now.dashboards, arrived] } : now,
          );
        }
        options?.onError?.();
        // Read before the re-read the refusal asks for can land, which would
        // put every dashboard back on its own and hide what the rollback did.
        asked.keptOnRefusal = (
          client.getQueryData<WorkspaceSnapshot>(['snapshot', 'ws-work'])?.dashboards ?? []
        ).map((one) => one.name);
        return;
      }
      // A delete really takes the dashboard out of the workspace, and the read
      // behind the bar is asked again - which the real `useCommand` does through
      // `afterChanging`. Without it the bar goes on drawing the dashboard that
      // has just gone, and every rule about what happens once it has gone passes
      // by never happening.
      if (args.name === 'delete_dashboard') {
        held.dashboards = held.dashboards.filter((one) => one.id !== args.payload.dashboardId);
        void client.invalidateQueries({ queryKey: ['snapshot', 'ws-work'] });
      }
      options?.onSuccess?.();
    },
  );
  const reset = vi.fn(() => {
    asked.error = null;
  });
  mockUseCommand.mockImplementation(
    () =>
      ({
        mutate,
        reset,
        isPending: false,
        get error() {
          return asked.error;
        },
        get variables() {
          return asked.variables;
        },
      }) as never,
  );
  const sent = vi.fn((_args: AskedFor) =>
    answer.sendFails ? Promise.reject(answer.sendFails) : Promise.resolve(),
  );
  mockUseSendCommand.mockImplementation(() => sent as never);
  const bar = (openDashboardId: string | null) => (
    <QueryClientProvider client={client}>
      <DashboardBar
        workspaceId="ws-work"
        tint="#6f62b5"
        ground="#e3e1f2"
        openDashboardId={openDashboardId}
        allItemsOpen={held.allItemsOpen}
      />
      {answer.withFilterBar && openDashboardId && (
        <DashboardFilterBar dashboardId={openDashboardId} />
      )}
    </QueryClientProvider>
  );
  const { container, rerender } = render(bar(answer.openDashboardId ?? null));
  return {
    mutate,
    sent,
    container,
    client,
    /** The dashboards the cache held the moment a refusal had been put back. */
    keptOnRefusal: () => asked.keptOnRefusal,
    /** The same bar with another dashboard open, which is what a switch is. */
    switchTo: (openDashboardId: string | null) => {
      held.openDashboardId = openDashboardId;
      rerender(bar(openDashboardId));
    },
    user: userEvent.setup(),
  };
}

/**
 * Lays the bar out, because jsdom does not: `tabDrag.ts`'s `placeAt` reads each
 * tab's right edge off `getBoundingClientRect`, which jsdom always answers with
 * zeroes. Each tab is given a 100-pixel-wide slot instead, the same stand-in
 * `WorkspaceTabs.test.tsx` uses for the strip above it.
 *
 * **Every tab of the bar, the Inbox included**, and not only the ones the drag
 * measures: the Inbox really occupies the leftmost slot, so laying out the
 * dashboards alone would put the first of them where the Inbox is and a drop
 * aimed past the Inbox would never be aimed past anything.
 */
function layOutTabs() {
  [...document.querySelectorAll('nav[aria-label="Dashboards"] a')].forEach((tab, index) => {
    tab.getBoundingClientRect = () => ({ right: (index + 1) * 100 }) as DOMRect;
  });
}

/**
 * Drags a tab far enough to let go over the bar's `overSlot`th tab, and drops
 * it there. The slots are the bar's own, so slot 0 is the Inbox.
 */
function dragTab(name: string, overSlot: number) {
  const tab = screen.getByRole('link', { name });
  fireEvent.pointerDown(tab, {
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 0,
    buttons: 1,
  });
  layOutTabs();
  fireEvent.pointerMove(tab, {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: overSlot * 100 + 50,
    buttons: 1,
  });
  fireEvent.pointerUp(tab, { pointerId: 1, pointerType: 'mouse' });
}

/** The bar as it is drawn, the Inbox included. */
function theBar(): (string | null)[] {
  return screen.getAllByRole('link').map((tab) => tab.textContent);
}

describe('Dashboards', () => {
  describe('a dashboard you move is shown where you moved it before the server agrees', () => {
    /*
     * F1: what the gesture asks for, what the bar paints while it is in
     * flight, and what it does with an answer it does not like. The gesture
     * itself is `useTabDrag`'s and is walked in a real browser in
     * tests/e2e/dashboards.test.ts, where there is a layout engine to measure;
     * that the server keeps the order is proved against a real store in
     * apps/api/tests/integration/http/dashboards.test.ts.
     */
    it('paints the new order at once, and asks for the whole order', async () => {
      // Not politeness: the order a move is computed from is the order in
      // hand, so a second move made before the first came back would undo it.
      const { mutate } = showBar(['Dashboard 1', 'Research', 'Admin']);
      await screen.findByRole('link', { name: 'Admin' });

      dragTab('Dashboard 1', 2);

      await waitFor(() =>
        expect(theBar()).toEqual(['Inbox', 'Research', 'Dashboard 1', 'Admin']),
      );
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        name: 'reorder_dashboards',
        payload: {
          workspaceId: 'ws-work',
          dashboardId: 'ws-work-dashboard 1',
          dashboardIds: ['ws-work-research', 'ws-work-dashboard 1', 'ws-work-admin'],
        },
      });
    });

    it('asks for nothing when a drag ends where it started', async () => {
      const { mutate } = showBar(['Dashboard 1', 'Research', 'Admin']);
      await screen.findByRole('link', { name: 'Admin' });

      dragTab('Research', 2);

      // Settled before asking, because a move that did go out would only reach
      // the sender a microtask later - so a bare "not called" here would pass
      // over exactly the regression this case exists to catch.
      await act(async () => {});
      expect(mutate).not.toHaveBeenCalled();
      expect(theBar()).toEqual(['Inbox', 'Dashboard 1', 'Research', 'Admin']);
    });

    it('puts the tabs back when the move is refused', async () => {
      const { mutate } = showBar(['Dashboard 1', 'Research', 'Admin'], {
        error: new CommandRefused(409, 'the dashboards changed while they were being put in order'),
      });
      await screen.findByRole('link', { name: 'Admin' });

      dragTab('Dashboard 1', 3);

      // Otherwise this passes vacuously: the order it puts back is the order
      // it started in, so a drag that silently did nothing would look the same
      // as one that was sent and refused.
      await waitFor(() => expect(mutate).toHaveBeenCalled());
      await waitFor(() =>
        expect(theBar()).toEqual(['Inbox', 'Dashboard 1', 'Research', 'Admin']),
      );
    });

    it('keeps a dashboard added meanwhile when it puts the tabs back', async () => {
      // A refusal is most likely because a dashboard came or went elsewhere, so
      // putting the old order back must not take the one that came off the bar.
      const { keptOnRefusal, mutate } = showBar(['Dashboard 1', 'Research', 'Admin'], {
        error: new CommandRefused(409, 'the dashboards changed while they were being put in order'),
        arrivesInFlight: 'Newest',
      });
      await screen.findByRole('link', { name: 'Admin' });

      dragTab('Dashboard 1', 3);

      await waitFor(() => expect(mutate).toHaveBeenCalled());
      expect(keptOnRefusal()).toEqual(['Dashboard 1', 'Research', 'Admin', 'Newest']);
    });

    it('keeps a dashboard that arrived since the bar was drawn when it shows the move', async () => {
      const { client } = showBar(['Dashboard 1', 'Research', 'Admin']);
      await screen.findByRole('link', { name: 'Admin' });

      // Written to the cache and dropped in the same tick, before React Query has
      // told the bar about it: the window a snapshot re-read lands in unseen. The
      // drop is computed from the bar as drawn, so the newcomer is not in it.
      act(() => {
        client.setQueryData<WorkspaceSnapshot>(['snapshot', 'ws-work'], (held) =>
          held ? { ...held, dashboards: [...held.dashboards, aDashboard('Newest')] } : held,
        );
        dragTab('Dashboard 1', 3);
      });

      expect(
        client
          .getQueryData<WorkspaceSnapshot>(['snapshot', 'ws-work'])
          ?.dashboards.map((one) => one.name),
      ).toEqual(['Research', 'Admin', 'Dashboard 1', 'Newest']);
    });

    it('does not move the Inbox, which is no dashboard of this workspace', async () => {
      const { mutate } = showBar(['Dashboard 1', 'Research', 'Admin']);
      await screen.findByRole('link', { name: 'Admin' });

      dragTab('Inbox', 3);

      await act(async () => {});
      expect(mutate).not.toHaveBeenCalled();
      expect(theBar()).toEqual(['Inbox', 'Dashboard 1', 'Research', 'Admin']);
      // The two above pass on their own whether or not the Inbox carries the
      // gesture, since it is in no order for a move to be computed against - so
      // what says it is out is that the bar does not count it as one of its
      // tabs, which is what `placeAt` (`tabDrag.ts`) measures.
      expect(screen.getByRole('link', { name: 'Inbox' })).not.toHaveAttribute('data-tab-id');
    });

    it('puts a dashboard dropped over the Inbox first among the dashboards, behind it', async () => {
      // The other half of the Inbox being fixed: it is not a place in the
      // order either, so dropping past it lands first among the dashboards
      // rather than in front of it.
      const { mutate } = showBar(['Dashboard 1', 'Research', 'Admin']);
      await screen.findByRole('link', { name: 'Admin' });

      dragTab('Admin', 0);

      await waitFor(() =>
        expect(theBar()).toEqual(['Inbox', 'Admin', 'Dashboard 1', 'Research']),
      );
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        payload: {
          dashboardIds: ['ws-work-admin', 'ws-work-dashboard 1', 'ws-work-research'],
        },
      });
    });
  });

  describe('the bar holds the Inbox and the workspace’s dashboards', () => {
    it('shows the Inbox first, then each dashboard by name', async () => {
      showBar(['Dashboard 1', 'Research']);

      const bar = await screen.findByRole('navigation', { name: 'Dashboards' });
      // Waited for by name rather than by count: the Inbox is there from the
      // first paint and the dashboards arrive with the snapshot, so asking for
      // every link straight away finds the Inbox alone and passes.
      await screen.findByRole('link', { name: 'Research' });
      const entries = screen.getAllByRole('link');
      // The Inbox first, then the dashboards in the order the workspace holds
      // them. jsdom answers every media query with "no", so this is the narrow
      // shape, where the Inbox is a tab in the bar rather than a column beside
      // it ("Show the Inbox beside the dashboards instead of as a tab", issue
      // 117); which shape a screen gets is in tests/unit/router.test.tsx.
      //
      // The way to manage them is a menu rather than a fourth entry, and is
      // covered by the rule below.
      expect(entries.map((entry) => entry.textContent)).toEqual([
        'Inbox',
        'Dashboard 1',
        'Research',
      ]);
      expect(bar).toBeVisible();
    });

    it('shows the Inbox even in a workspace with no dashboards', () => {
      showBar([]);

      // It is a fixture, not a row of anything: nothing can take it away.
      expect(screen.getByRole('link', { name: 'Inbox' })).toBeVisible();
    });
  });

  describe('what can be done to a dashboard is on the tab it is', () => {
    // The list this replaces was behind the bar's own menu at the far right,
    // which is now gone: it held that one entry and nothing else.
    it('offers editing and deleting on the tab itself', async () => {
      const { user } = showBar(['Dashboard 1', 'Research']);

      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Research' }));

      expect((await screen.findAllByRole('menuitem')).map((entry) => entry.textContent)).toEqual([
        'Edit…',
        'Delete',
        'Show all items',
      ]);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('says why a workspace’s last dashboard cannot be deleted, rather than offering it', async () => {
      // The one place the app refuses to delete something: a workspace with no
      // dashboard has no view at all. Said in the entry, not hidden.
      showBar(['Dashboard 1']);

      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Dashboard 1' }));

      expect(
        await screen.findByRole('menuitem', {
          name: 'Delete: A workspace keeps its last dashboard',
        }),
      ).toBeVisible();
    });

    it('leaves the Inbox without one, it being no dashboard of this workspace', async () => {
      showBar(['Dashboard 1']);

      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Inbox' }));

      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('opens the menu of the tab you are already on when it is pressed', async () => {
      // The press has no other job - you are looking at what it would switch
      // to - and it is the way in a touchscreen has without a long press.
      const { user } = showBar(['Dashboard 1', 'Research'], {
        openDashboardId: 'ws-work-research',
      });

      await user.click(await screen.findByRole('link', { name: 'Research' }));

      expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeVisible();
    });
  });

  describe('the dashboard you are on also carries the menu as a visible "…"', () => {
    // "Give the open workspace and dashboard their own "…", and split the
    // header's menu into settings and you", issue 567: a menu reachable only
    // by right-click, a long press or the menu key was invisible until found.
    it('offers the same entries the tab’s own menu offers, beside + Panel', async () => {
      const { user } = showBar(['Dashboard 1', 'Research'], {
        openDashboardId: 'ws-work-research',
      });

      await user.click(await screen.findByRole('button', { name: 'Actions for Research' }));

      expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
        'Edit…',
        'Delete',
        `Collapse panels${NOT_A_PHONE}`,
        'Show all items',
      ]);
    });

    it('is not drawn where there is no dashboard open, the bar being the Inbox’s too', async () => {
      showBar(['Dashboard 1', 'Research'], { openDashboardId: null });

      await screen.findByRole('link', { name: 'Dashboard 1' });
      expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    });

    it('says why a workspace’s last dashboard cannot be deleted, the same as the tab’s own menu', async () => {
      const { user } = showBar(['Dashboard 1'], { openDashboardId: 'ws-work-dashboard 1' });

      await user.click(await screen.findByRole('button', { name: 'Actions for Dashboard 1' }));

      expect(
        await screen.findByRole('menuitem', {
          name: 'Delete: A workspace keeps its last dashboard',
        }),
      ).toBeVisible();
    });
  });

  describe('changing a dashboard sends only what actually changed', () => {
    it.each([
      { situation: 'a new name', typed: 'Reading', sends: ['rename_dashboard'] },
      { situation: 'the name it already had', typed: 'Research', sends: [] },
    ])('sends what moved and no more, given $situation', async (row) => {
      // An untouched box must send nothing, or it would carry the name the
      // form opened with over an edit made somewhere else in the meantime.
      const { sent, user } = showBar(['Dashboard 1', 'Research']);
      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Research' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));

      await user.clear(screen.getByRole('textbox', { name: 'Name of Research' }));
      await user.type(screen.getByRole('textbox', { name: 'Name of Research' }), row.typed);
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(sent.mock.calls.map(([args]) => args.name)).toEqual(row.sends);
    });

    it('keeps the form open with what was typed when the server refuses it', async () => {
      const { user } = showBar(['Dashboard 1', 'Research'], {
        sendFails: new CommandRefused(409, 'a dashboard called Dashboard 1 already exists'),
      });
      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Research' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
      await user.clear(screen.getByRole('textbox', { name: 'Name of Research' }));
      await user.type(screen.getByRole('textbox', { name: 'Name of Research' }), 'Dashboard 1');

      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'a dashboard called Dashboard 1 already exists',
      );
      expect(screen.getByRole('textbox', { name: 'Name of Research' })).toHaveValue('Dashboard 1');
    });
  });

  describe('deleting a dashboard asks first, and says what goes with it', () => {
    it.each([
      { situation: 'a dashboard with nothing on it', panels: 0, asks: 'Delete Research? There is nothing on it.' },
      { situation: 'a dashboard with one panel', panels: 1, asks: 'Delete Research? Its one panel goes with it.' },
      { situation: 'a dashboard with several', panels: 3, asks: 'Delete Research? Its 3 panels go with it.' },
    ])('says what goes with it, for $situation', async (row) => {
      const { user } = showBar(['Dashboard 1', 'Research'], {
        panels: Array.from({ length: row.panels }, (_, i) => aPanel(`Panel ${i}`, 'ws-work-research')),
      });
      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Research' }));

      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

      expect(await screen.findByRole('alertdialog', { name: row.asks })).toBeVisible();
    });

    it('does not take the focus to the next dashboard opened after a delete made on the Inbox', async () => {
      // The bar is the shell's and stays mounted, so a focus owed but never
      // given is a debt carried around: on the Inbox no tab is the current
      // one, and the next dashboard opened - by hand, by the back button, by a
      // drag resting on its tab - would have the focus taken to it by a delete
      // made minutes ago.
      const { user, switchTo } = showBar(['Dashboard 1', 'Research'], { openDashboardId: null });
      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Research' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Research' }));

      switchTo('ws-work-dashboard 1');

      // Waited a frame out, which is when the focus would be taken: the bar
      // puts it back on the next frame so the question's own restore has
      // finished. Asserting straight away would pass by being early.
      await act(async () => {
        await new Promise((frame) => requestAnimationFrame(() => frame(null)));
      });
      expect(screen.getByRole('link', { name: 'Dashboard 1' })).not.toHaveFocus();
    });

    // "Keep a docked item open across dashboards in the same workspace" (issue
    // 482): deleting the dashboard you are on moves the workspace on behind
    // you, and a form docked beside it is not the dashboard's to take along.
    it('keeps an open item’s form open when the dashboard on screen is the one deleted', async () => {
      const { user } = showBar(['Dashboard 1', 'Research'], { openDashboardId: 'ws-work-research' });
      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Research' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Research' }));

      await waitFor(() => expect(wentTo.calls).toHaveLength(1));
      const [{ to, search }] = wentTo.calls as [{ to: string; search: (was: object) => object }];
      expect(to).toBe('/w/$workspaceId');
      expect(search({ item: 'item-1', connected: 'teams' })).toEqual({ item: 'item-1' });
      expect(search({})).toEqual({});
    });

    it('sends the delete only once the question has been answered', async () => {
      const { mutate, user } = showBar(['Dashboard 1', 'Research']);
      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Research' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      await screen.findByRole('alertdialog');
      expect(mutate).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Yes, delete Research' }));

      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        name: 'delete_dashboard',
        payload: { dashboardId: 'ws-work-research' },
      });
    });
  });

  describe('a dashboard name is shown as text, never as markup', () => {
    // Not a test of React's escaping, which is framework mechanics and would be
    // cut. It guards the one way Cockpit can undo that escaping itself, on the
    // second screen where a name a person typed is rendered.
    it('puts the characters in the bar and builds nothing out of them', async () => {
      const { container } = showBar(['<img src=x onerror=alert(1)>']);

      expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeVisible();
      expect(container.querySelector('img')).toBeNull();
    });
  });

  /**
   * Nothing in the app said what a dashboard was for, and the word is a third of
   * the container hierarchy. Explaining it at sign-in does not work - nobody can
   * decide when they want a second dashboard before using the first - so the
   * answer goes where the question is actually asked, which is the moment
   * somebody presses `+`.
   *
   * That a question *can* carry an explanation, and that one which only renames
   * something does not, is the shared question's own rule and is proved on it
   * (NameQuestion.test.tsx). What is left here is the wiring: that this bar
   * hands it the right words.
   */
  describe('the question that makes a dashboard says what a dashboard is', () => {
    it('describes the dialog with it', async () => {
      const { user } = showBar(['Dashboard 1']);

      await user.click(screen.getByRole('button', { name: 'Add a dashboard' }));

      // Against the sentence *and* against it saying anything at all: an
      // emptied constant renders no description, which would otherwise match an
      // expectation that is itself the empty string.
      expect(WHAT_A_DASHBOARD_IS).not.toBe('');
      expect(screen.getByRole('dialog')).toHaveAccessibleDescription(WHAT_A_DASHBOARD_IS);
    });

  });

  describe('adding a dashboard asks for the name you typed', () => {
    it('asks for it without the blanks around it', async () => {
      const { user, mutate } = showBar(['Dashboard 1']);

      await user.click(screen.getByRole('button', { name: 'Add a dashboard' }));
      await user.type(screen.getByLabelText('Name of the new dashboard'), '  Research  ');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('add_dashboard');
      expect(asked.payload.name).toBe('Research');
      expect(asked.payload.workspaceId).toBe('ws-work');
    });

    it('switches to the dashboard it just made', async () => {
      const { user, mutate } = showBar(['Dashboard 1']);

      await user.click(screen.getByRole('button', { name: 'Add a dashboard' }));
      await user.type(screen.getByLabelText('Name of the new dashboard'), 'Research');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      // The one just made, by the id it was made with: adding a dashboard and
      // then having to find it in the bar is two gestures for what reads as one.
      const [asked] = mutate.mock.calls[0]!;
      expect(wentTo.calls).toEqual([
        {
          to: '/w/$workspaceId/d/$dashboardId',
          params: { workspaceId: 'ws-work', dashboardId: asked.payload.dashboardId },
          search: expect.any(Function),
        },
      ]);
    });

    // "Keep a docked item open across dashboards in the same workspace" (issue
    // 482): a form docked beside the page is the address's `item`, and the
    // switch this makes is the one move here that no tab is pressed for.
    it('keeps an open item’s form open when it switches', async () => {
      const { user } = showBar(['Dashboard 1']);

      await user.click(screen.getByRole('button', { name: 'Add a dashboard' }));
      await user.type(screen.getByLabelText('Name of the new dashboard'), 'Research');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      const [{ search }] = wentTo.calls as [{ search: (was: object) => object }];
      expect(search({ item: 'item-1', connected: 'teams' })).toEqual({ item: 'item-1' });
      expect(search({})).toEqual({});
    });

    it('does not still say why the last one was refused, next time the field opens', async () => {
      // The `+` and the field are two renders of the same component, so a
      // refusal that is only hidden comes back over a name nobody has typed.
      const { user } = showBar(['Research'], {
        error: new CommandRefused(409, 'a dashboard called Research already exists in this workspace'),
      });

      await user.click(screen.getByRole('button', { name: 'Add a dashboard' }));
      await user.type(screen.getByLabelText('Name of the new dashboard'), 'Research');
      await user.click(screen.getByRole('button', { name: 'Add' }));
      expect(screen.getByRole('alert')).toBeVisible();
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Add a dashboard' }));

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByLabelText('Name of the new dashboard')).toHaveValue('');
    });

    it('asks for nothing when the field holds only blanks', async () => {
      const { user, mutate } = showBar(['Dashboard 1']);

      await user.click(screen.getByRole('button', { name: 'Add a dashboard' }));
      await user.type(screen.getByLabelText('Name of the new dashboard'), '   ');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('an add that could not happen puts the screen back', () => {
    it.each([
      {
        situation: 'the name is already another dashboard’s',
        error: new CommandRefused(409, 'a dashboard called Research already exists in this workspace'),
        says: 'a dashboard called Research already exists in this workspace',
      },
      {
        situation: 'the request never reached the server',
        error: new Error('Failed to fetch'),
        says: 'That did not reach the server. Try again.',
      },
    ])('$situation', async ({ error, says }) => {
      const { user } = showBar(['Research'], { error });

      await user.click(screen.getByRole('button', { name: 'Add a dashboard' }));
      const box = screen.getByLabelText('Name of the new dashboard');
      await user.type(box, 'Research');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(screen.getByRole('alert')).toHaveTextContent(says);
      // Still there to be corrected, rather than typed again from nothing.
      expect(box).toHaveValue('Research');
    });
  });
});

describe('Dashboards', () => {
  describe('the strip carries the workspace’s colors, so a tab has something to meet above and below', () => {
    /*
     * F1 reaches the wiring and stops there. Which tab is the current one is
     * the router's `.active` class, which the mock above does not apply and
     * a jsdom tree has no styles to resolve anyway - so that a *selected* tab
     * ends up filled is proved at the viewport, in tests/e2e. What can be
     * wrong here, and is what this holds, is the strip being handed the wrong
     * two colors or handing them on under the wrong names.
     */
    it('offers the page’s colour and the workspace’s mark for whichever tab is current', () => {
      const { container } = showBar(['Dashboard 1']);

      const strip = container.querySelector('nav[aria-label="Dashboards"]') as HTMLElement;
      // No background of its own any more: the band around it is painted by
      // the shell, so the tabs can be inset past the Inbox without a seam.
      expect(strip.style.backgroundColor).toBe('');
      expect(strip.style.getPropertyValue('--tab-on')).toBe('#e3e1f2');
      expect(strip.style.getPropertyValue('--tab-mark')).toBe('#6f62b5');
    });
  });
});

describe('Dashboards', () => {
  describe('All items is switched on and off from a dashboard’s menu, per workspace, in this browser', () => {
    const OPEN = 'ws-work-research';
    const entries = () => screen.getAllByRole('menuitem').map((entry) => entry.textContent);

    beforeEach(() => localStorage.clear());
    afterEach(() => {
      localStorage.clear();
      Object.defineProperty(globalThis, 'innerWidth', { value: 1280, configurable: true, writable: true });
    });

    it('offers Show all items on a dashboard’s "…" and on its tab', async () => {
      const { user } = showBar(['Dashboard 1', 'Research'], { openDashboardId: OPEN });

      await user.click(await screen.findByRole('button', { name: 'Actions for Research' }));
      expect(entries()).toContain('Show all items');
      await user.keyboard('{Escape}');

      fireEvent.contextMenu(screen.getByRole('link', { name: 'Dashboard 1' }));
      expect((await screen.findAllByRole('menuitem')).map((entry) => entry.textContent)).toContain(
        'Show all items',
      );
    });

    it('puts the tab after the dashboards and before the +, and then offers Hide all items', async () => {
      const { user } = showBar(['Dashboard 1', 'Research'], { openDashboardId: OPEN });
      expect(screen.queryByRole('link', { name: 'All items' })).toBeNull();

      await user.click(await screen.findByRole('button', { name: 'Actions for Research' }));
      await user.click(screen.getByRole('menuitem', { name: 'Show all items' }));

      expect(screen.getAllByRole('link').map((tab) => tab.textContent)).toEqual([
        'Inbox',
        'Dashboard 1',
        'Research',
        'All items',
      ]);
      const tab = screen.getByRole('link', { name: 'All items' });
      const plus = screen.getByRole('button', { name: /add.*dashboard/i });
      expect(tab.compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Actions for Research' }));
      expect(entries()).toContain('Hide all items');
      expect(entries()).not.toContain('Show all items');
    });

    it('offers only Hide all items on its own "…", and nothing of a dashboard’s', async () => {
      setAllItemsTab('ws-work', true);
      const { user } = showBar(['Dashboard 1', 'Research'], { allItemsOpen: true });

      expect(await screen.findByRole('link', { name: 'Research' })).not.toHaveClass('active');
      expect(screen.getByRole('link', { name: 'All items' })).toHaveClass('active');
      await user.click(screen.getByRole('button', { name: 'Actions for All items' }));
      expect(entries()).toEqual(['Hide all items']);
      expect(screen.queryByRole('button', { name: '+ Panel' })).toBeNull();
    });

    it('takes the tab away from a dashboard’s menu, and stays where it was', async () => {
      setAllItemsTab('ws-work', true);
      const { user } = showBar(['Dashboard 1', 'Research'], { openDashboardId: OPEN });

      await user.click(await screen.findByRole('button', { name: 'Actions for Research' }));
      await user.click(screen.getByRole('menuitem', { name: 'Hide all items' }));

      expect(screen.queryByRole('link', { name: 'All items' })).toBeNull();
      expect(wentTo.calls).toEqual([]);
    });

    it('takes the tab away from its own menu, and goes to the first dashboard', async () => {
      setAllItemsTab('ws-work', true);
      const { user } = showBar(['Dashboard 1', 'Research'], { allItemsOpen: true });

      await user.click(await screen.findByRole('button', { name: 'Actions for All items' }));
      await user.click(screen.getByRole('menuitem', { name: 'Hide all items' }));

      expect(screen.queryByRole('link', { name: 'All items' })).toBeNull();
      expect(wentTo.calls).toMatchObject([
        { to: '/w/$workspaceId/d/$dashboardId', params: { dashboardId: 'ws-work-dashboard 1' } },
      ]);
    });

    it('stays on the dashboard when the tab is hidden from its menu while on another page', async () => {
      setAllItemsTab('ws-work', true);
      showBar(['Dashboard 1', 'Research'], { openDashboardId: OPEN });

      fireEvent.contextMenu(await screen.findByRole('link', { name: 'All items' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide all items' }));

      await waitFor(() => expect(screen.queryByRole('link', { name: 'All items' })).toBeNull());
      expect(wentTo.calls).toEqual([]);
    });

    it('is remembered for the workspace it was switched on in, and for no other', async () => {
      setAllItemsTab('ws-work', true);
      showBar(['Dashboard 1']);

      expect(await screen.findByRole('link', { name: 'All items' })).toBeVisible();
      expect(readAllItemsTab(localStorage, 'ws-work')).toBe(true);
      expect(readAllItemsTab(localStorage, 'ws-personal')).toBe(false);
    });

    it('is the same entry and tab on a phone-width screen', async () => {
      Object.defineProperty(globalThis, 'innerWidth', { value: 375, configurable: true, writable: true });
      const { user } = showBar(['Dashboard 1', 'Research'], { openDashboardId: OPEN });

      await user.click(await screen.findByRole('button', { name: 'Actions for Research' }));
      await user.click(screen.getByRole('menuitem', { name: 'Show all items' }));

      expect(screen.getByRole('link', { name: 'All items' })).toBeVisible();
    });
  });
});

describe('Panels', () => {
  describe('a drag resting on a dashboard’s name switches to it', () => {
    /**
     * A row of ours held over a tab.
     *
     * Two `dragover`s, because the first is what starts the dwell and the
     * second is what can end it — which is the browser's own behaviour, since
     * `dragover` keeps firing while a drag is held still. jsdom has no clock of
     * its own here, so `since` is moved rather than time: the rule about *how
     * long* is tests/unit/switchWhileDragging.test.ts.
     */
    function restOn(name: string, forMs: number) {
      const tab = screen.getByRole('link', { name });
      const dataTransfer = { types: [ITEM_BEING_DRAGGED] };
      const at = Date.now();
      vi.setSystemTime(at);
      fireEvent.dragOver(tab, { dataTransfer });
      vi.setSystemTime(at + forMs);
      fireEvent.dragOver(tab, { dataTransfer });
      return tab;
    }

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('goes to it once the drag has been held there long enough', async () => {
      showBar(['Dashboard 1', 'Research'], { openDashboardId: 'ws-work-dashboard 1' });
      await screen.findByRole('link', { name: 'Research' });

      restOn('Research', DWELL_MS);

      expect(wentTo.calls).toEqual([
        expect.objectContaining({ params: { workspaceId: 'ws-work', dashboardId: 'ws-work-research' } }),
      ]);
    });

    it('keeps an open item’s form open when it goes there', async () => {
      showBar(['Dashboard 1', 'Research'], { openDashboardId: 'ws-work-dashboard 1' });
      await screen.findByRole('link', { name: 'Research' });

      restOn('Research', DWELL_MS);

      const [{ search }] = wentTo.calls as [{ search: (was: object) => object }];
      expect(search({ item: 'item-1', connected: 'teams' })).toEqual({ item: 'item-1' });
      expect(search({})).toEqual({});
    });

    it('starts the dwell over when the drag leaves and comes back', async () => {
      // Not a case about *how long*, which is the pure function's own table:
      // this is the half the bar owns, that leaving a name forgets what it was
      // resting on rather than the two rests being added together.
      showBar(['Dashboard 1', 'Research'], { openDashboardId: 'ws-work-dashboard 1' });
      const tab = await screen.findByRole('link', { name: 'Research' });

      restOn('Research', DWELL_MS - 1);
      fireEvent.dragLeave(tab);
      restOn('Research', DWELL_MS - 1);

      expect(wentTo.calls).toEqual([]);
    });

    it('does not let the browser take a row let go on a name', async () => {
      // `dragover` is prevented to make a tab somewhere a drag can be *held*,
      // which also makes it somewhere a drop can happen — so without preventing
      // the drop too, the browser follows the text on the transfer as a link
      // and leaves the workspace.
      showBar(['Dashboard 1', 'Research'], { openDashboardId: 'ws-work-dashboard 1' });
      const tab = await screen.findByRole('link', { name: 'Research' });

      const dropped = fireEvent.drop(tab, { dataTransfer: { types: [ITEM_BEING_DRAGGED] } });

      // `fireEvent` answers false when the default was prevented.
      expect(dropped).toBe(false);
    });

    it('leaves a drag that is not one of our rows alone', async () => {
      showBar(['Dashboard 1', 'Research'], { openDashboardId: 'ws-work-dashboard 1' });
      const tab = await screen.findByRole('link', { name: 'Research' });

      // A panel being dragged by its header across the bar on its way
      // somewhere else.
      const dataTransfer = { types: ['text/plain'] };
      fireEvent.dragOver(tab, { dataTransfer });
      fireEvent.dragOver(tab, { dataTransfer });

      expect(wentTo.calls).toEqual([]);
    });
  });
});

/**
 * F1: the dashboard's own controls, which live at the right of its own bar.
 * Which layout is drawn is settled in tests/unit/panels/arrangement.test.ts.
 */
describe('Layouts', () => {
  const OPEN = 'ws-work-dashboard 1';

  function aLayout(id: string): Layout {
    return {
      id,
      tenantId: 'tenant',
      dashboardId: OPEN,
      rows: [{ height: null, cells: [{ panelId: 'falcon', span: 12 }] }],
    };
  }

  describe('nothing on a dashboard offers a choice of layout or screen size', () => {
    it.each([
      { situation: 'its layout', layouts: [aLayout('a')] },
      { situation: 'none', layouts: [] },
    ])('draws no layout control on a dashboard with $situation, and keeps + Panel and the actions menu', async ({ layouts }) => {
      showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        layouts,
      });

      expect(await screen.findByRole('button', { name: '+ Panel' })).toBeVisible();
      expect(await screen.findByRole('button', { name: 'Actions for Dashboard 1' })).toBeVisible();
      expect(screen.queryByRole('button', { name: /Layout for this dashboard/ })).toBeNull();
      expect(screen.queryByText(/screen size/i)).toBeNull();
    });

    it('offers neither on the Inbox, where there is no dashboard to have either', async () => {
      showBar(['Dashboard 1'], { openDashboardId: null });

      await screen.findByRole('link', { name: 'Dashboard 1' });
      expect(screen.queryByRole('button', { name: '+ Panel' })).toBeNull();
    });
  });
});

/**
 * F1: adding a panel, which is the other half of the dashboard's own controls.
 * It moved here from the foot of the board, where it was a hairline strip that
 * read as a rule drawn across an empty page.
 */
describe('Panels', () => {
  const OPEN = 'ws-work-dashboard 1';

  /**
   * The wiring half, for the reason the dashboard's says: that the shared
   * question can carry an explanation is proved on the question itself
   * (NameQuestion.test.tsx), and what belongs here is that this bar hands it
   * the words about a panel.
   */
  describe('the question that makes a panel says what a panel is', () => {
    it('describes the dialog with it', async () => {
      const { user } = showBar(['Dashboard 1'], { openDashboardId: OPEN });

      await user.click(await screen.findByRole('button', { name: '+ Panel' }));

      // For the reason the dashboard's says.
      expect(WHAT_A_PANEL_IS).not.toBe('');
      expect(screen.getByRole('dialog')).toHaveAccessibleDescription(WHAT_A_PANEL_IS);
    });
  });

  describe('adding a panel asks for the title you typed, on the dashboard you are on', () => {
    it('sends it without the blanks around it', async () => {
      const { user, mutate } = showBar(['Dashboard 1'], { openDashboardId: OPEN });

      await user.click(await screen.findByRole('button', { name: '+ Panel' }));
      await user.type(screen.getByLabelText('Name of the new panel'), '  Project Falcon  ');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('add_panel');
      expect(asked.payload.name).toBe('Project Falcon');
      expect(asked.payload.dashboardId).toBe(OPEN);
    });

    it('asks in a form of its own, which is not in the bar until it is asked for', async () => {
      // A box wide enough to read a title in would grow between two controls
      // and push the one beside it out from under the pointer.
      const { user } = showBar(['Dashboard 1'], { openDashboardId: OPEN });

      expect(screen.queryByLabelText('Name of the new panel')).toBeNull();
      await user.click(await screen.findByRole('button', { name: '+ Panel' }));

      expect(screen.getByRole('dialog')).toBeVisible();
      expect(screen.getByLabelText('Name of the new panel')).toHaveFocus();
    });

  });

  describe('adding a panel asks what it holds, because that is settled when it is made', () => {
    it.each([
      { situation: 'left as it opens', choose: null, kind: 'items' },
      { situation: 'asked for a panel of items', choose: 'Items', kind: 'items' },
      { situation: 'asked for a panel of text', choose: 'Text', kind: 'text' },
    ])('$situation', async ({ choose, kind }) => {
      const { user, mutate } = showBar(['Dashboard 1'], { openDashboardId: OPEN });

      await user.click(await screen.findByRole('button', { name: '+ Panel' }));
      if (choose) await user.click(screen.getByRole('radio', { name: new RegExp(choose) }));
      await user.type(screen.getByLabelText('Name of the new panel'), 'What matters');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('add_panel');
      expect(asked.payload.kind).toBe(kind);
    });

    /**
     * Not a preference. The kind is a question about the panel being made now,
     * so carrying the last answer into the next question would decide it for
     * somebody who never looked at it.
     */
    it('starts from Items again every time it is opened', async () => {
      const { user, mutate } = showBar(['Dashboard 1'], { openDashboardId: OPEN });
      await user.click(await screen.findByRole('button', { name: '+ Panel' }));
      await user.click(screen.getByRole('radio', { name: /Text/ }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await user.click(await screen.findByRole('button', { name: '+ Panel' }));
      await user.type(screen.getByLabelText('Name of the new panel'), 'Project Falcon');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(mutate.mock.calls[0]![0].payload.kind).toBe('items');
    });
  });
});

describe('Dashboards', () => {
  /** Distinct per case: whether the filter bar is open is kept in memory across them. */
  const id = (name: string) => `ws-work-${name.toLowerCase()}`;
  const BAR = { name: 'Dashboard filter' };

  beforeEach(() => {
    localStorage.clear();
    onAScreen(A_DESK);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('a filter is never on out of sight', () => {
    it('opens the filter bar from the funnel on the tab you are on, and closes it clearing the filter', async () => {
      const { user } = showBar(['Funnel one'], {
        openDashboardId: id('Funnel one'),
        withFilterBar: true,
      });
      expect(screen.queryByRole('search', BAR)).toBeNull();

      await user.click(await screen.findByRole('button', { name: 'Filter this dashboard' }));
      expect(screen.getByRole('search', BAR)).toBeVisible();

      await user.click(screen.getByRole('button', { name: 'High' }));
      expect(readDashboardFilter(localStorage, id('Funnel one')).priorities).toEqual(['high']);

      await user.click(screen.getByRole('button', { name: 'Clear the filter and close it' }));
      expect(screen.queryByRole('search', BAR)).toBeNull();
      expect(readDashboardFilter(localStorage, id('Funnel one'))).toEqual(NO_DASHBOARD_FILTER);
    });

    it('opens the filter bar from the keyboard, on the funnel of the tab you are on', async () => {
      const { user } = showBar(['Keys one'], {
        openDashboardId: id('Keys one'),
        withFilterBar: true,
      });
      (await screen.findByRole('button', { name: 'Filter this dashboard' })).focus();

      await user.keyboard('{Enter}');

      expect(screen.getByRole('search', BAR)).toBeVisible();
    });

    it('clears the conditions with × and keeps the bar open, where nothing set leaves × unavailable', async () => {
      const { user } = showBar(['Cross one'], {
        openDashboardId: id('Cross one'),
        withFilterBar: true,
      });
      await user.click(await screen.findByRole('button', { name: 'Filter this dashboard' }));
      expect(screen.getByRole('button', { name: 'Clear the filter' })).toBeDisabled();

      await user.type(screen.getByRole('searchbox'), 'vat');
      await user.click(screen.getByRole('button', { name: 'Clear the filter' }));

      expect(screen.getByRole('search', BAR)).toBeVisible();
      expect(readDashboardFilter(localStorage, id('Cross one'))).toEqual(NO_DASHBOARD_FILTER);
      expect(screen.getByRole('button', { name: 'Clear the filter' })).toBeDisabled();
    });

    it('shows the bar on a filtered Dashboard without being asked, as after a reload', async () => {
      writeDashboardFilter(localStorage, id('Reload one'), { ...NO_DASHBOARD_FILTER, text: 'vat' });
      showBar(['Reload one'], { openDashboardId: id('Reload one'), withFilterBar: true });

      expect(await screen.findByRole('search', BAR)).toBeVisible();
      expect(screen.getByRole('searchbox')).toHaveValue('vat');
    });

    it('opens the bar, fills the funnel, and is cleared by × and by the funnel, for Agent running alone', async () => {
      const { user } = showBar(['Agent one'], { openDashboardId: id('Agent one'), withFilterBar: true });
      await user.click(await screen.findByRole('button', { name: 'Filter this dashboard' }));

      await user.click(screen.getByRole('button', { name: 'Agent running' }));
      expect(screen.getByRole('button', { name: 'Agent running' })).toHaveAttribute('aria-pressed', 'true');
      expect(readDashboardFilter(localStorage, id('Agent one')).agentRunning).toBe(true);
      expect(screen.getByRole('button', { name: 'Clear the filter' })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: 'Clear the filter' }));
      expect(readDashboardFilter(localStorage, id('Agent one'))).toEqual(NO_DASHBOARD_FILTER);

      await user.click(screen.getByRole('button', { name: 'Agent running' }));
      await user.click(screen.getByRole('button', { name: 'Clear the filter and close it' }));
      expect(readDashboardFilter(localStorage, id('Agent one'))).toEqual(NO_DASHBOARD_FILTER);
      expect(screen.queryByRole('search', BAR)).toBeNull();
    });

    it('opens the bar, fills the funnel, and is cleared by ×, for a Status alone', async () => {
      const { user } = showBar(['Status one'], { openDashboardId: id('Status one'), withFilterBar: true });
      await user.click(await screen.findByRole('button', { name: 'Filter this dashboard' }));
      expect(screen.getByRole('button', { name: 'Clear the filter' })).toBeDisabled();

      await user.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'In progress' }));
      expect(readDashboardFilter(localStorage, id('Status one')).statuses).toEqual(['in_progress']);
      expect(screen.getByRole('button', { name: 'Clear the filter' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Clear the filter and close it' })).toBeVisible();

      await user.click(screen.getByRole('button', { name: 'Clear the filter' }));
      expect(readDashboardFilter(localStorage, id('Status one'))).toEqual(NO_DASHBOARD_FILTER);
      expect(screen.getByRole('button', { name: 'Clear the filter' })).toBeDisabled();
    });

    it('offers To do and In progress on a dashboard, and Done as well where it is told to', async () => {
      const group = () => within(screen.getByRole('group', { name: 'Status' }));
      writeDashboardFilter(localStorage, 'offers-a', { ...NO_DASHBOARD_FILTER, text: 'x' });
      const { unmount } = render(<DashboardFilterBar dashboardId="offers-a" />);
      expect(group().getAllByRole('button').map((b) => b.textContent)).toEqual(['To do', 'In progress']);
      unmount();

      writeDashboardFilter(localStorage, 'offers-b', { ...NO_DASHBOARD_FILTER, text: 'x' });
      render(<DashboardFilterBar dashboardId="offers-b" withDone />);
      expect(group().getAllByRole('button').map((b) => b.textContent)).toEqual(['To do', 'In progress', 'Done']);
    });

    it('reads Status, Priority, Due, Containing, Attachments (With, Without, no Any), Agent running, with Status, Priority and Attachments each one group', () => {
      writeDashboardFilter(localStorage, 'order-a', { ...NO_DASHBOARD_FILTER, text: 'x' });
      render(<DashboardFilterBar dashboardId="order-a" />);
      const bar = screen.getByRole('search', BAR);

      const controls = [
        screen.getByRole('group', { name: 'Status' }),
        screen.getByRole('group', { name: 'Priority' }),
        screen.getByRole('combobox'),
        screen.getByRole('searchbox', { name: 'Containing' }),
        screen.getByRole('group', { name: 'Attachments' }),
        screen.getByRole('button', { name: 'Agent running' }),
      ];
      for (let at = 1; at < controls.length; at += 1) {
        expect(controls[at - 1]!.compareDocumentPosition(controls[at]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      // Each chip filter is one fieldset holding its buttons; Agent running is a lone button beside them.
      expect(bar.querySelectorAll('fieldset')).toHaveLength(3);
      expect(controls[4]!.querySelector('span[aria-hidden="true"]')?.textContent).toBe('Attachments');
      expect(controls[0]!.querySelector('span[aria-hidden="true"]')).toBeNull();
      expect(controls[1]!.querySelector('span[aria-hidden="true"]')).toBeNull();
      expect(controls[5]!.closest('fieldset')).toBeNull();
      expect(within(controls[4]!).getAllByRole('button').map((b) => b.textContent)).toEqual(['With', 'Without']);
    });

    it('narrows by attachments only while With or Without is pressed, and pressing the pressed one lets every Item through again', async () => {
      const { user } = showBar(['Attach one'], { openDashboardId: id('Attach one'), withFilterBar: true });
      await user.click(await screen.findByRole('button', { name: 'Filter this dashboard' }));
      const group = within(screen.getByRole('group', { name: 'Attachments' }));
      const stored = () => readDashboardFilter(localStorage, id('Attach one'));

      await user.click(group.getByRole('button', { name: 'With' }));
      expect(stored().attachments).toBe('with');
      expect(group.getByRole('button', { name: 'With' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Clear the filter' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Clear the filter and close it' })).toBeVisible();

      await user.click(group.getByRole('button', { name: 'Without' }));
      expect(stored().attachments).toBe('without');
      expect(group.getByRole('button', { name: 'With' })).toHaveAttribute('aria-pressed', 'false');
      expect(group.getByRole('button', { name: 'Without' })).toHaveAttribute('aria-pressed', 'true');

      await user.click(group.getByRole('button', { name: 'Without' }));
      expect(stored()).toEqual(NO_DASHBOARD_FILTER);
      expect(group.getByRole('button', { name: 'Without' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Clear the filter' })).toBeDisabled();
    });

    it('carries a filled funnel on a tab filtered by Agent running alone', async () => {
      writeDashboardFilter(localStorage, id('Away agent'), { ...NO_DASHBOARD_FILTER, agentRunning: true });
      showBar(['Home two', 'Away agent'], { openDashboardId: id('Home two') });

      const tab = await screen.findByRole('link', { name: /Away agent/ });
      expect(within(tab).getByRole('img', { name: 'This dashboard is filtered' })).toBeVisible();
    });

    it('carries a filled funnel on a filtered tab you are not on, and none on an unfiltered one', async () => {
      writeDashboardFilter(localStorage, id('Away filtered'), { ...NO_DASHBOARD_FILTER, text: 'vat' });
      showBar(['Home one', 'Away filtered', 'Away plain'], { openDashboardId: id('Home one') });

      const filtered = await screen.findByRole('link', { name: /Away filtered/ });
      expect(within(filtered).getByRole('img', { name: 'This dashboard is filtered' })).toBeVisible();
      expect(within(screen.getByRole('link', { name: 'Away plain' })).queryByRole('img')).toBeNull();
    });

    it('draws no bar on another Dashboard, and draws the filter again on coming back', async () => {
      writeDashboardFilter(localStorage, id('Switch a'), { ...NO_DASHBOARD_FILTER, text: 'vat' });
      const { switchTo } = showBar(['Switch a', 'Switch b'], {
        openDashboardId: id('Switch a'),
        withFilterBar: true,
      });
      expect(await screen.findByRole('search', BAR)).toBeVisible();

      switchTo(id('Switch b'));
      expect(screen.queryByRole('search', BAR)).toBeNull();

      switchTo(id('Switch a'));
      expect(screen.getByRole('searchbox')).toHaveValue('vat');
    });

    it('does not carry a bar opened empty on one Dashboard to the next', async () => {
      const { user, switchTo } = showBar(['Empty a', 'Empty b'], {
        openDashboardId: id('Empty a'),
        withFilterBar: true,
      });
      await user.click(await screen.findByRole('button', { name: 'Filter this dashboard' }));
      expect(screen.getByRole('search', BAR)).toBeVisible();

      switchTo(id('Empty b'));

      expect(screen.queryByRole('search', BAR)).toBeNull();
    });
  });

  describe('on a phone the filter is a summary line and a sheet', () => {
    const summary = () => screen.getByRole('group', { name: 'Dashboard filter summary', hidden: true });
    const sheet = () => screen.getByRole('dialog', { name: /^Filter/ });
    // The phone's half is a chunk of its own, which a draw waits for before it is asked about.
    const drawn = async (ui: React.ReactElement) => {
      const drawing = render(ui);
      await act(async () => {
        await import('../../../src/components/FilterSummary');
      });
      return drawing;
    };
    const stored = (name: string) => readDashboardFilter(localStorage, id(name));

    describe('a filtered Dashboard draws the line, or the bar from 768px, and an unfiltered one neither on a phone', () => {
      it.each([
        { situation: 'a phone, filtered', width: A_PHONE, filter: { text: 'vat' }, line: true, bar: false },
        { situation: 'a phone, filtered, as after a reload', width: A_PHONE, filter: { priorities: ['high'] }, line: true, bar: false },
        { situation: 'a phone, unfiltered', width: A_PHONE, filter: {}, line: false, bar: false },
        { situation: '768px, filtered', width: 768, filter: { text: 'vat' }, line: false, bar: true },
        { situation: 'a desk, filtered', width: A_DESK, filter: { text: 'vat' }, line: false, bar: true },
      ])('$situation', async ({ width, filter, line, bar, situation }) => {
        onAScreen(width);
        const dashboardId = `ws-work-draws-${situation.replace(/\W+/g, '-')}`;
        writeDashboardFilter(localStorage, dashboardId, { ...NO_DASHBOARD_FILTER, ...filter } as never);
        await drawn(<DashboardFilterBar dashboardId={dashboardId} />);

        expect(screen.queryByRole('group', { name: 'Dashboard filter summary' }) !== null).toBe(line);
        expect(screen.queryByRole('search', BAR) !== null).toBe(bar);
      });
    });

    describe('the line names every condition in the bar’s order', () => {
      it.each([
        { situation: 'To do, High', filter: { statuses: ['to_do'], priorities: ['high'] }, pills: ['To do', 'High'] },
        { situation: 'High set before To do still reads Status first', filter: { priorities: ['high'], statuses: ['in_progress'] }, pills: ['In progress', 'High'] },
        { situation: 'Due this week, or overdue', filter: { due: { window: 'week', orOverdue: true } }, pills: ['Due this week or overdue'] },
        { situation: 'Due this week alone', filter: { due: { window: 'week', orOverdue: false } }, pills: ['Due this week'] },
        { situation: 'Overdue', filter: { due: { window: 'overdue', orOverdue: false } }, pills: ['Overdue'] },
        { situation: 'Containing invoice', filter: { text: ' invoice ' }, pills: ['"invoice"'] },
        { situation: 'With attachments', filter: { attachments: 'with' }, pills: ['With attachments'] },
        { situation: 'Without attachments', filter: { attachments: 'without' }, pills: ['Without attachments'] },
        { situation: 'Agent running', filter: { agentRunning: true }, pills: ['Agent running'] },
        {
          situation: 'every condition',
          filter: {
            statuses: ['to_do'],
            priorities: ['none'],
            due: { window: 'today', orOverdue: false },
            text: 'x',
            attachments: 'with',
            agentRunning: true,
          },
          pills: ['To do', 'No priority', 'Due today', '"x"', 'With attachments', 'Agent running'],
        },
      ])('$situation', ({ filter, pills }) => {
        expect(filterPills({ ...NO_DASHBOARD_FILTER, ...filter } as never)).toEqual(pills);
      });

      it.each([
        { situation: '2 panels hidden', panelsHidden: 2, said: '· 2 hidden' },
        { situation: 'none hidden', panelsHidden: 0, said: null },
      ])('says $situation', async ({ panelsHidden, said }) => {
        onAScreen(A_PHONE);
        writeDashboardFilter(localStorage, 'ws-work-said-hidden', { ...NO_DASHBOARD_FILTER, text: 'vat' });
        await drawn(<DashboardFilterBar dashboardId="ws-work-said-hidden" panelsHidden={panelsHidden} />);

        expect(within(summary()).queryByText(/hidden/)?.textContent ?? null).toBe(said);
        expect(within(summary()).getByText('Edit')).toBeVisible();
      });
    });

    describe('the sheet changes the filter as you tap, and closing it keeps what was set', () => {
      beforeEach(() => onAScreen(A_PHONE));

      it('opens from the line with every condition and focus inside, and stores each tap at once', async () => {
        const user = userEvent.setup();
        writeDashboardFilter(localStorage, id('Sheet one'), { ...NO_DASHBOARD_FILTER, text: 'vat' });
        await drawn(<DashboardFilterBar dashboardId={id('Sheet one')} panelsHidden={3} />);

        await user.click(within(summary()).getByText('Edit'));

        expect(sheet()).toHaveTextContent('3 panels hidden');
        for (const name of ['Status', 'Priority', 'Attachments']) {
          expect(within(sheet()).getByRole('group', { name })).toBeVisible();
        }
        expect(within(sheet()).getByRole('combobox')).toBeVisible();
        expect(within(sheet()).getByRole('searchbox', { name: 'Containing' })).toHaveValue('vat');
        expect(within(sheet()).getByRole('button', { name: 'Agent running' })).toBeVisible();
        await waitFor(() => expect(sheet().contains(document.activeElement)).toBe(true));

        await user.click(within(within(sheet()).getByRole('group', { name: 'Status' })).getByRole('button', { name: 'In progress' }));
        expect(stored('Sheet one').statuses).toEqual(['in_progress']);
        expect(within(summary()).getByText('In progress')).toBeVisible();
      });

      it.each([
        { how: 'Done', close: (user: ReturnType<typeof userEvent.setup>) => user.click(within(sheet()).getByRole('button', { name: 'Done' })) },
        { how: 'Escape', close: (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}') },
        {
          how: 'the scrim',
          close: (user: ReturnType<typeof userEvent.setup>) =>
            user.click(document.querySelector('[data-state="open"].fixed.inset-0') as HTMLElement),
        },
      ])('$how closes it, keeps the filter and puts focus back on the line', async ({ how, close }) => {
        const user = userEvent.setup();
        const name = `Sheet close ${how}`;
        writeDashboardFilter(localStorage, id(name), { ...NO_DASHBOARD_FILTER, priorities: ['high'] });
        await drawn(<DashboardFilterBar dashboardId={id(name)} />);
        await user.click(within(summary()).getByText('Edit'));
        await screen.findByRole('dialog');

        await close(user);

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(stored(name).priorities).toEqual(['high']);
        await waitFor(() => expect(summary().contains(document.activeElement)).toBe(true));
      });

      it('clears from the sheet and keeps it open, and leaves no line once it is closed', async () => {
        const user = userEvent.setup();
        writeDashboardFilter(localStorage, id('Sheet clear'), { ...NO_DASHBOARD_FILTER, text: 'vat' });
        await drawn(<DashboardFilterBar dashboardId={id('Sheet clear')} />);
        await user.click(within(summary()).getByText('Edit'));

        await user.click(within(sheet()).getByRole('button', { name: 'Clear the filter' }));

        expect(stored('Sheet clear')).toEqual(NO_DASHBOARD_FILTER);
        expect(sheet()).toBeVisible();
        await user.click(within(sheet()).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.queryByRole('group', { name: 'Dashboard filter summary' })).toBeNull();
      });

      it('clears from the × on the line, which goes with it', async () => {
        const user = userEvent.setup();
        writeDashboardFilter(localStorage, id('Line clear'), { ...NO_DASHBOARD_FILTER, text: 'vat' });
        await drawn(<DashboardFilterBar dashboardId={id('Line clear')} />);

        await user.click(within(summary()).getByRole('button', { name: 'Clear the filter' }));

        expect(stored('Line clear')).toEqual(NO_DASHBOARD_FILTER);
        expect(screen.queryByRole('group', { name: 'Dashboard filter summary' })).toBeNull();
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    describe('the funnel opens the sheet where nothing is set, and clears where something is', () => {
      beforeEach(() => onAScreen(A_PHONE));

      it('opens the sheet from the funnel, and closing it with nothing set leaves no line', async () => {
        const { user } = showBar(['Phone funnel'], { openDashboardId: id('Phone funnel'), withFilterBar: true });

        await user.click(await screen.findByRole('button', { name: 'Filter this dashboard' }));
        expect(sheet()).toBeVisible();
        expect(screen.queryByRole('search', BAR)).toBeNull();

        await user.click(within(sheet()).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.queryByRole('group', { name: 'Dashboard filter summary' })).toBeNull();
      });

      it('clears from the funnel of a filtered Dashboard, and the line goes', async () => {
        writeDashboardFilter(localStorage, id('Phone funnel set'), { ...NO_DASHBOARD_FILTER, text: 'vat' });
        const { user } = showBar(['Phone funnel set'], { openDashboardId: id('Phone funnel set'), withFilterBar: true });
        expect(await screen.findByRole('group', { name: 'Dashboard filter summary' })).toBeVisible();

        await user.click(await screen.findByRole('button', { name: 'Clear the filter and close it' }));

        expect(stored('Phone funnel set')).toEqual(NO_DASHBOARD_FILTER);
        expect(screen.queryByRole('group', { name: 'Dashboard filter summary' })).toBeNull();
      });
    });

    it('closes a bar left open on another Dashboard when 768px is crossed, so no sheet opens by itself on return', async () => {
      const screenNow = onAScreen(A_DESK);
      const { rerender } = await drawn(<DashboardFilterBar dashboardId={id('Away a')} />);
      const bar = renderHook(() => useFilterBarOpen(id('Away a')));
      act(() => bar.result.current[1](true));
      rerender(<DashboardFilterBar dashboardId={id('Away b')} />);
      act(() => screenNow.resize(A_PHONE));
      rerender(<DashboardFilterBar dashboardId={id('Away a')} />);
      await act(async () => {});
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('keeps the "+n" when a pill is added to a line that was already cut short', async () => {
      // Every pill 100px wide on a 300px strip: two fit beside the "+n" whatever is set.
      const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100 } as DOMRect);
      const room = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
      try {
        onAScreen(A_PHONE);
        writeDashboardFilter(localStorage, id('Cut'), { ...NO_DASHBOARD_FILTER, priorities: ['high', 'low', 'none'] });
        await drawn(<DashboardFilterBar dashboardId={id('Cut')} />);
        expect(within(summary()).getByText('+1')).toBeVisible();
        const user = userEvent.setup();
        await user.click(within(summary()).getByText('Edit'));
        await user.click(within(sheet()).getByRole('button', { name: 'Normal' }));
        expect(within(summary()).getByText('+2')).toBeInTheDocument();
      } finally {
        rect.mockRestore();
        room.mockRestore();
      }
    });

    it('keeps the filter across 768px: the bar when widened with the sheet open, the line when narrowed again', async () => {
      const user = userEvent.setup();
      const screenNow = onAScreen(A_PHONE);
      writeDashboardFilter(localStorage, id('Crossing'), { ...NO_DASHBOARD_FILTER, priorities: ['high'] });
      await drawn(<DashboardFilterBar dashboardId={id('Crossing')} />);
      await user.click(within(summary()).getByText('Edit'));
      expect(sheet()).toBeVisible();

      act(() => screenNow.resize(A_DESK));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(within(screen.getByRole('search', BAR)).getByRole('button', { name: 'High' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      act(() => screenNow.resize(A_PHONE));
      expect(screen.queryByRole('search', BAR)).toBeNull();
      expect(within(summary()).getByText('High')).toBeVisible();
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('while filtered, nothing about the arrangement can change', () => {
    it('says why a panel cannot be added', async () => {
      const open = id('Locked one');
      writeDashboardFilter(localStorage, open, { ...NO_DASHBOARD_FILTER, text: 'vat' });
      const layout: Layout = {
        id: 'laptop',
        tenantId: 'tenant',
        dashboardId: open,
        rows: [],
      };
      const { user } = showBar(['Locked one'], {
        openDashboardId: open,
        layouts: [layout],
      });

      const add = await screen.findByRole('button', { name: '+ Panel' });
      expect(add).toBeDisabled();
      expect(add).toHaveAttribute('title', expect.stringContaining('Clear the dashboard filter'));
    });
  });
});

describe('Panels', () => {
  describe('the dashboard’s menu collapses every panel to its header, on a phone', () => {
    const OPEN = 'ws-work-research';
    const panels = [aPanel('Falcon', OPEN)];
    const menu = async (extra: Parameters<typeof showBar>[1] = {}) => {
      const shown = showBar(['Dashboard 1', 'Research'], {
        openDashboardId: OPEN,
        panels,
        ...extra,
      });
      await shown.user.click(await screen.findByRole('button', { name: 'Actions for Research' }));
      return shown;
    };
    const collapsed = () => renderHook(() => usePanelsCollapsed(OPEN)).result.current.collapsed;
    const phone = () => {
      screenIs(390);
    };

    beforeEach(() => screenIs(1280));
    afterEach(() => {
      act(() => setPanelsCollapsed(null));
      screenIs(1024);
    });

    it('offers Collapse panels while open, and Open panels while collapsed', async () => {
      phone();
      const { user } = await menu();
      await user.click(await screen.findByRole('menuitem', { name: 'Collapse panels' }));
      expect(collapsed()).toBe(true);

      await user.click(screen.getByRole('button', { name: 'Actions for Research' }));
      expect(screen.queryByRole('menuitem', { name: 'Collapse panels' })).toBeNull();
      await user.click(await screen.findByRole('menuitem', { name: 'Open panels' }));

      expect(collapsed()).toBe(false);
    });

    it.each([
      {
        situation: 'a screen from 480 px up',
        width: 480,
        panelsHeld: panels,
        said: 'Collapse panels: Only on a phone, where panels are drawn one above the next',
      },
      {
        situation: 'a dashboard with no panels, on a phone',
        width: 390,
        panelsHeld: [] as Panel[],
        said: 'Collapse panels: This dashboard has no panels',
      },
    ])('stays on the menu but unavailable, saying why, on $situation', async ({ width, panelsHeld, said }) => {
      screenIs(width);
      const { user } = await menu({ panels: panelsHeld });

      const entry = await screen.findByRole('menuitem', { name: said });
      expect(entry).toHaveAttribute('aria-disabled', 'true');
      await user.click(entry);

      expect(collapsed()).toBe(false);
    });

    it('is offered on the open dashboard alone, not on another dashboard’s tab', async () => {
      phone();
      showBar(['Dashboard 1', 'Research'], { openDashboardId: OPEN, panels });

      fireEvent.contextMenu(await screen.findByRole('link', { name: 'Dashboard 1' }));

      expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: /Collapse panels/ })).toBeNull();
    });
  });
});
