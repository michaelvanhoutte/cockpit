import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A_DESK, onAScreen } from '../onAScreen';
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MIN_ROW_HEIGHT } from '@cockpit/shared';
import type {
  AgentRun,
  Attachment,
  Dashboard,
  Filing,
  FilterCondition,
  FilterMatch,
  Item,
  ItemType,
  Layout,
  Panel,
  PanelSort,
} from '@cockpit/shared';
import { PanelBoard } from '../../../src/components/PanelBoard';
import {
  NO_DASHBOARD_FILTER,
  writeDashboardFilter,
  type DashboardFilter,
} from '../../../src/dashboardFilter';
import { dayOf } from '../../../src/filters';
import { QUIET } from '../../../src/panels/PanelText';
import {
  NOTHING_CHOSEN_TO_SHOW,
  NOTHING_FILED_HERE,
  NOTHING_MATCHES_YET,
  NOTHING_WRITTEN_HERE,
} from '../../../src/whatThingsAre';
import { CommandRefused } from '../../../src/api/client';
import { ITEM_BEING_DRAGGED } from '../../../src/dropAt';
import { setPanelsCollapsed } from '../../../src/panelsCollapsed';
import { useCommand } from '../../../src/api/queries';
import { usePanelListing } from '../../../src/panelList';
import { renderHook } from '@testing-library/react';

/**
 * F1: what is under test is the board's own behaviour - what it sends, which
 * layout it sends it into, and what it does with an answer it does not like.
 * Which arrangement a screen produces is settled in
 * tests/unit/panels/arrangement.test.ts, and whether the store accepts what is
 * sent is settled against a real store in
 * apps/api/tests/integration/http/panels.test.ts. That the panels really fit
 * the screen without scrolling sideways needs a layout engine and is proved in
 * tests/e2e/panels.test.ts.
 */

vi.mock('../../../src/api/queries', async () => {
  const actual = await vi.importActual<typeof import('../../../src/api/queries')>(
    '../../../src/api/queries',
  );
  return { ...actual, useCommand: vi.fn() };
});

const mockUseCommand = vi.mocked(useCommand);

const DASHBOARD: Dashboard = {
  id: 'today',
  tenantId: 'tenant',
  workspaceId: 'ws-work',
  name: 'Today',
};

/** A second dashboard of the same workspace, for the cases about moving a panel to one. */
const RESEARCH: Dashboard = {
  id: 'research',
  tenantId: 'tenant',
  workspaceId: 'ws-work',
  name: 'Research',
};

const PERSONAL: Dashboard = {
  id: 'personal',
  tenantId: 'tenant',
  workspaceId: 'ws-work',
  name: 'Personal',
};

function aPanel(id: string, name: string): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'today',
    name,
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    filter: null,
    sort: null,
  };
}

/** A panel made of text, empty and open to be written in unless a case says otherwise. */
function aPanelOfText(
  id: string,
  name: string,
  holding: { body?: string; readOnly?: boolean; format?: 'plain' | 'rich' } = {},
): Panel {
  return {
    ...aPanel(id, name),
    kind: 'text',
    format: holding.format ?? 'plain',
    body: holding.body ?? '',
    readOnly: holding.readOnly ?? false,
  };
}

/**
 * Today, where whoever is running this is - the same reading the board takes
 * (`dayOf`), so a case about *due today* is about the board drawing the row
 * rather than about which day it is. Which items a window takes in is settled
 * against a fixed day in tests/unit/filters.test.ts.
 */
const TODAY = dayOf(new Date());

/** The one condition there is today: due today, or already past. */
const DUE_TODAY: FilterCondition = { field: 'dueDate', window: 'today', orOverdue: true };

/** A panel that gathers what it shows, with nothing chosen unless a case says otherwise. */
function aFilter(
  id: string,
  name: string,
  conditions: FilterCondition[] = [],
  match: FilterMatch = 'all',
): Panel {
  return { ...aPanel(id, name), kind: 'filter', filter: { conditions, match } };
}

const PRIORITY_HIGH: FilterCondition = { field: 'priority', values: ['high'] };

/** A live Type, exactly as `itemTypeSchema` shapes one. */
function aType(id: string, name: string): ItemType {
  return { id, tenantId: 'tenant', name, color: '#000000', position: 0, createdAt: '2026-08-31T08:00:00.000Z' };
}

/**
 * A layout of one row holding every panel, side by side - which is what the
 * flat arrangement these cases were written against drew, so a panel still has
 * somewhere to move left to.
 */
function aLayout(id: string, panelIds: string[]): Layout {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'today',
    rows: [{ height: null, cells: panelIds.map((panelId) => ({ panelId, span: 12 })) }],
  };
}

/** The width the board reads, which is what decides whether it has to ask. */
function screenIs(width: number) {
  Object.defineProperty(globalThis, 'innerWidth', { value: width, configurable: true, writable: true });
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

function showBoard({
  panels = [aPanel('falcon', 'Project Falcon'), aPanel('reading', 'To read')],
  /**
   * Every panel of the workspace, which the page passes unfiltered where
   * `panels` above is this dashboard's alone. This dashboard's, unless a case is
   * about a Panel on another one - which only a Filter can be, filings being
   * the one thing read workspace-wide.
   */
  panelsInWorkspace = panels,
  // Just this one dashboard unless a case wants another to move to - most
  // cases here are about drag-and-drop mechanics, not about moving a panel
  // off the dashboard.
  dashboards = [DASHBOARD] as Dashboard[],
  layouts = [] as Layout[],
  items = [] as Item[],
  attachments = [] as Attachment[],
  agentRuns = [] as AgentRun[],
  filings = [] as Filing[],
  /** The account's live Types - what a Filter's Type condition offers, unless a case wants its own. */
  itemTypes = [] as ItemType[],
  error,
  variables,
  /**
   * False leaves every change in flight, which is the state the board spends
   * a real gesture in: sent, not yet re-read, and still drawn from what was
   * dragged rather than from the snapshot in hand.
   */
  settles = true,
  /** A change already on its way out when the board is first drawn. */
  pending = false,
}: {
  panels?: Panel[];
  panelsInWorkspace?: Panel[];
  dashboards?: Dashboard[];
  layouts?: Layout[];
  items?: Item[];
  attachments?: Attachment[];
  agentRuns?: AgentRun[];
  filings?: Filing[];
  itemTypes?: ItemType[];
  error?: Error;
  variables?: { name: string; payload: Record<string, unknown> };
  settles?: boolean;
  pending?: boolean;
} = {}) {
  const mutate = vi.fn(
    (_args, options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => {
      // A refusal answers too, and answers differently: the board has to hear
      // about it to put the arrangement back.
      if (error) options?.onError?.(error);
      else if (settles) options?.onSuccess?.();
    },
  );
  mockUseCommand.mockReturnValue({
    mutate,
    reset: vi.fn(),
    isPending: pending,
    error: error ?? null,
    variables,
  } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const board = (
    drawing: Panel[],
    drawnItems: Item[] = items,
    drawnAttachments: Attachment[] = attachments,
    drawnRuns: AgentRun[] = agentRuns,
  ) => (
    <QueryClientProvider client={client}>
      <PanelBoard
        workspaceId="ws-work"
        dashboard={DASHBOARD}
        dashboards={dashboards}
        panels={drawing}
        panelsInWorkspace={panelsInWorkspace}
        layouts={layouts}
        items={drawnItems}
        attachments={drawnAttachments}
        agentRuns={drawnRuns}
        filings={filings}
        itemTypes={itemTypes}
      />
    </QueryClientProvider>
  );
  const { unmount, rerender } = render(board(panels));
  // `unmount` because a panel of text sends what is unsent on the way out, and
  // switching dashboard is what takes it off screen. `redrawnWith` is the next
  // snapshot arriving under a board already on screen - a change made on
  // another device, which is not the same as this one being re-opened.
  return {
    mutate,
    unmount,
    redrawnWith: (next: Panel[]) => rerender(board(next)),
    /** The next snapshot arriving with an item changed, or an attachment added. */
    /** The next snapshot arriving with the open runs changed. */
    redrawnWithRuns: (next: AgentRun[]) => rerender(board(panels, items, attachments, next)),
    redrawnWithItems: (next: Item[], nextAttachments: Attachment[] = attachments) =>
      rerender(board(panels, next, nextAttachments)),
    user: userEvent.setup(),
  };
}

/**
 * Opens a panel's menu the way a real right-click does. A browser focuses a
 * focusable target on the mousedown a right-click carries, before the
 * `contextmenu` event that follows it - which is what Radix reads back to
 * know what to return focus to once the menu closes. jsdom takes no such
 * default action on a mousedown, so it is taken here by hand; a real header
 * needs no help doing this.
 */
function openMenu(panel: string) {
  const header = handleOf(panel);
  header.focus();
  fireEvent.contextMenu(header);
}

/**
 * What a panel offers is in the panel's own menu, opened by right-click on
 * its header - one of the ways a dashboard's or a workspace's own tab opens
 * its too (`WorkspaceTabs.test.tsx`, `menuOf`), and (unlike a tab) also from
 * the visible button on the header, proven separately below.
 */
async function choose(user: ReturnType<typeof userEvent.setup>, panel: string, entry: string) {
  openMenu(panel);
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

/** The visible "..." button on a panel's header, its own way into the same menu. */
function menuButtonOf(panelName: string) {
  return screen.getByRole('button', { name: `Actions for ${panelName}` });
}

/** Opens *+ Add a condition* and chooses one field from its menu - what every case that adds a row does first. */
async function addCondition(user: ReturnType<typeof userEvent.setup>, field: string) {
  await user.click(await screen.findByRole('button', { name: '+ Add a condition' }));
  await user.click(await screen.findByRole('menuitem', { name: field }));
}

/**
 * What a panel drag carries. Without one every handler reads `types` off null
 * and the drop is a no-op - which a test expecting *no* change would pass on,
 * for entirely the wrong reason.
 *
 * Empty, because a panel drag is the absence of `ITEM_BEING_DRAGGED`: that mark
 * is what a row of a panel's list carries, and it is how a panel being moved is
 * told apart from an item being filed.
 */
/**
 * Lays the board out, because jsdom does not.
 *
 * A drag asks where the rows and the panels actually are (`panels/dragging.ts`)
 * and jsdom measures every element as zero pixels in the same place, so a drag
 * driven here would read every pointer position as the first slot of the first
 * row. The geometry is handed over instead: rows 100 tall, stacked with the
 * 22-pixel seam the board opens between them, and the panels across a row
 * splitting 0-600 evenly.
 *
 * What this stands in for is the page's measurements, and only those. That the
 * page really puts the rows where this says is the browser's half, and is the
 * walk in tests/e2e/panels.test.ts.
 *
 * Called after the pick-up rather than before: picking a panel up opens the
 * seams, which redraws the board, and a stub put on a node before that is a
 * stub on whatever React decides to keep.
 */
function layOut() {
  const rows = [...document.querySelectorAll('[data-panel-row]')];
  rows.forEach((row, index) => {
    const top = index * 122;
    // A width as well as a band, because sizing a row asks how wide it is - a
    // column is a twelfth of the row, and a twelfth of nothing is nothing.
    row.getBoundingClientRect = () =>
      ({ top, bottom: top + 100, left: 0, right: 600 }) as DOMRect;
    const cells = [...row.querySelectorAll('[data-panel-cell]')];
    const width = 600 / cells.length;
    cells.forEach((cell, at) => {
      cell.getBoundingClientRect = () =>
        ({ left: at * width, right: (at + 1) * width }) as DOMRect;
    });
  });
  return rows.length;
}

/**
 * Whether the gaps between the rows have opened up, which is the board saying a
 * panel is in the air. Read off the height they are drawn at rather than off a
 * class: it is the rows moving apart that is the affordance.
 */
function seamsAreOpen() {
  return screen.getAllByTestId('row-seam').every((seam) => seam.style.height === '22px');
}

/** The board itself, which no rearrangement unmounts - and so what holds the pointer. */
function boardEl() {
  return document.querySelector('[data-panel-row]')!.parentElement!;
}

/** The header a panel is dragged by, and the trigger its own menu opens from. */
function handleOf(panelName: string) {
  return screen.getByRole('region', { name: panelName }).querySelector('header')!;
}

/**
 * Drags a panel by its header to a point, and lets it go there.
 *
 * The board is measured between the pick-up and the move, which is the order a
 * real drag has: the seams open when the panel leaves the ground, and where
 * everything is is read from the board as drawn.
 */
function dragTo(panelName: string, point: { x: number; y: number }, andDrop = true) {
  const handle = handleOf(panelName);
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
  layOut();
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: point.x, clientY: point.y });
  // Where the drop lands, for a drop onto a dashboard tab to read - a real
  // release happens wherever the last move left off.
  if (andDrop) fireEvent.pointerUp(handle, { pointerId: 1, clientX: point.x, clientY: point.y });
}

/**
 * A dashboard's tab, standing in for the one `DashboardBar` draws - which is
 * not part of this board's own tree, so a drop onto it is read off a plain
 * element carrying the same `data-dashboard-tab-id` (`panels/dashboardDrop.ts`).
 */
function aTabElement(dashboardId: string, rect: { left: number; right: number; top: number; bottom: number }) {
  const tab = document.createElement('a');
  tab.setAttribute('data-dashboard-tab-id', dashboardId);
  tab.getBoundingClientRect = () => rect as DOMRect;
  document.body.appendChild(tab);
  return tab;
}

/** Where the pointer has to be to land in the slot before `panelName` on its row. */
function slotBefore(panelName: string): { x: number; y: number } {
  const rows = [...document.querySelectorAll('[data-panel-row]')];
  for (const [index, row] of rows.entries()) {
    const cells = [...row.querySelectorAll('[data-panel-cell]')];
    const at = cells.findIndex((cell) => cell.getAttribute('data-panel-cell') === panelName);
    if (at === -1) continue;
    const width = 600 / cells.length;
    return { x: at * width + 1, y: index * 122 + 50 };
  }
  throw new Error(`no panel with id ${panelName} is on the board`);
}

/** Where the pointer has to be to land in the gap above row `at`. */
const gapAbove = (at: number) => ({ x: 300, y: at * 122 - 11 });

/** The arrangement the board is drawing, as the panels on each line. */
function drawnLines(): string[][] {
  return [...document.querySelectorAll('[data-panel-row]')].map((row) =>
    [...row.querySelectorAll('[data-panel-cell]')].map(
      (cell) => cell.getAttribute('data-panel-cell')!,
    ),
  );
}

/** The arrangement the last save_layout carried, as the panels on each line. */
function sentRows(mutate: ReturnType<typeof vi.fn>): string[][] {
  const [asked] = mutate.mock.calls.at(-1)!;
  return asked.payload.rows.map((row: { cells: { panelId: string }[] }) =>
    row.cells.map((cell) => cell.panelId),
  );
}

/** The same, flattened, for the cases that are about the order and not the lines. */
function sentOrder(mutate: ReturnType<typeof vi.fn>): string[] {
  return sentRows(mutate).flat();
}

/** How tall the last save_layout said each row is. */
function sentHeights(mutate: ReturnType<typeof vi.fn>): (number | null)[] {
  const [asked] = mutate.mock.calls.at(-1)!;
  return asked.payload.rows.map((row: { height: number | null }) => row.height);
}

/** What share of its row the last save_layout gave each panel, row by row. */
function sentSpans(mutate: ReturnType<typeof vi.fn>): number[][] {
  const [asked] = mutate.mock.calls.at(-1)!;
  return asked.payload.rows.map((row: { cells: { span: number }[] }) =>
    row.cells.map((cell) => cell.span),
  );
}

/** How tall the board is drawing each row right now, which is not what it has sent. */
function drawnHeights(): string[] {
  return [...document.querySelectorAll('[data-panel-row]')].map(
    (row) => (row as HTMLElement).style.height,
  );
}

/**
 * A whole column of a row, in the pixels `layOut` measures one in: the rows are
 * 600 wide there, and a column is a twelfth of the row.
 */
const ONE_COLUMN = 600 / 12;

/**
 * Drags the line under row `rowIndex` by `byY` pixels.
 *
 * `layOut` first, because this gesture measures the row the moment it is taken
 * hold of - a row without a height of its own has one only on the page, and
 * jsdom measures every element as nothing. The rows are 100 tall there, so a
 * drag of 200 asks for 300.
 */
function dragRowLine(rowIndex: number, byY: number, andLetGo = true) {
  layOut();
  const line = screen.getAllByTestId('row-line')[rowIndex]!;
  fireEvent.pointerDown(line, { button: 0, pointerId: 1, clientX: 300, clientY: 0 });
  fireEvent.pointerMove(line, { pointerId: 1, clientX: 300, clientY: byY });
  if (andLetGo) fireEvent.pointerUp(line, { pointerId: 1 });
}

/** Lets go of a line left in hand by `dragRowLine(..., false)`. */
function letGoOfRowLine() {
  fireEvent.pointerUp(window, { pointerId: 1 });
}

/** Drags the line to the right of the panel at `at` on the first row, by `byX` pixels. */
function dragColumnLine(at: number, byX: number) {
  layOut();
  const line = screen.getAllByTestId('column-line')[at]!;
  fireEvent.pointerDown(line, { button: 0, pointerId: 1, clientX: 0, clientY: 50 });
  fireEvent.pointerMove(line, { pointerId: 1, clientX: byX, clientY: 50 });
  fireEvent.pointerUp(line, { pointerId: 1 });
}

beforeEach(() => {
  screenIs(1280);
  onAScreen(A_DESK);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // `aTabElement` appends straight to `document.body`, outside anything RTL's
  // own cleanup unmounts - so it is not there to leak into the next case.
  document.querySelectorAll('[data-dashboard-tab-id]').forEach((tab) => tab.remove());
});

describe('Panels', () => {
  describe('a dashboard with nothing on it says what a dashboard is for', () => {
    it('says it, and offers no control of its own', async () => {
      showBoard({ panels: [] });

      // Matched on the opening clause, so rewording the rest of the sentence
      // does not break the walk that only cares that the empty state is there.
      expect(screen.getByText(/A dashboard holds the panels you want in view/)).toBeVisible();
      // The way to add one is in the dashboard's own bar (DashboardBar), which
      // is the one strip on screen that is about this dashboard. A second
      // control here would be a second thing to keep in step.
      expect(screen.queryByRole('button', { name: /Add a panel/ })).toBeNull();
    });
  });

  describe('a panel’s menu opens from its own header, the way a tab’s does', () => {
    it('opens on a right-click anywhere on the header, not only on a control', () => {
      showBoard();

      openMenu('Project Falcon');

      expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    });

    it('can be reached by keyboard, so the browser’s own menu key has something to open it from', () => {
      showBoard();

      expect(handleOf('Project Falcon')).toHaveAttribute('tabindex', '0');
    });

    it.each([{ key: 'Enter' }, { key: ' ' }])(
      'opens on $key too, since the browser’s own menu key does not exist on every keyboard',
      ({ key }) => {
        // Found in review: macOS has no key that fires the browser's own menu
        // key, and a panel's header - unlike a tab's `Link` - activates
        // nothing else on Enter, so without this a keyboard-only Mac user has
        // no way to reach a panel's menu at all.
        showBoard();

        fireEvent.keyDown(handleOf('Project Falcon'), { key });
        expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
      },
    );

    it('stays shut on Enter while the name is being edited in place, the same as a right-click', async () => {
      const { user } = showBoard();

      await choose(user, 'Project Falcon', 'Rename');
      fireEvent.keyDown(handleOf('Project Falcon'), { key: 'Enter' });

      expect(screen.queryByRole('menuitem')).toBeNull();
    });

    it('drops out of the tab order while the name is being edited in place, where the input already is', async () => {
      const { user } = showBoard();

      await choose(user, 'Project Falcon', 'Rename');

      expect(handleOf('Project Falcon')).toHaveAttribute('tabindex', '-1');
    });

    it('stays shut on a right-click while the name is being edited in place', async () => {
      const { user } = showBoard();

      await choose(user, 'Project Falcon', 'Rename');
      openMenu('Project Falcon');

      expect(screen.queryByRole('menuitem')).toBeNull();
    });

    it('leaves a plain click on the header as the drag it is, opening nothing', async () => {
      // `userEvent`, not bare `fireEvent.click`: a real mouse click carries
      // `detail` 1 or more, which is the one thing telling it apart from the
      // screen reader's own activation click `opensOnActivate` reads below -
      // `fireEvent.click` defaults `detail` to 0, indistinguishable from that.
      const { user } = showBoard();

      await user.click(handleOf('Project Falcon'));

      expect(screen.queryByRole('menuitem')).toBeNull();
    });

    it('opens on the click a screen reader’s own activation gesture sends, which a pointer never does', () => {
      // Found in review: `role="group"` is not a widget role, so VoiceOver's
      // VO+Space (or the double-tap it stands in for on iOS) is delivered as
      // a `click` with no pointer behind it rather than as the `keydown`
      // `opensOnKey` reads - the same `detail` 0 `opensOnPress` already reads
      // to tell a keyboard's Enter on a tab from a real press.
      showBoard();

      fireEvent.click(handleOf('Project Falcon'), { detail: 0 });

      expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    });

    it('leaves a touch on the header for Radix’s own long press, not the drag', () => {
      // Found in review: the header is both the drag handle and the menu's
      // trigger now, and picking the panel up moves pointer capture off the
      // header before Radix ever sees a release - so a drag started here on
      // every touch, mouse or not, would silently arm a menu that could never
      // close, and starve `SurfaceMenu`'s long press of the touch it needs to
      // open at all. `pointerType` is the whole of what tells the two apart,
      // the same guard `tabDrag.ts` carries for the same reason.
      showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });
      const lifted = () => screen.getByRole('region', { name: 'To read' }).className;

      fireEvent.pointerDown(handleOf('To read'), {
        button: 0,
        pointerId: 1,
        pointerType: 'touch',
      });

      expect(lifted()).not.toContain('opacity-40');
      expect(seamsAreOpen()).toBe(false);
    });

    it('names the header for what it opens, since right-click and the menu key still land there rather than on the button', () => {
      // Found in review: a bare header nested in a section computes to
      // ARIA's `generic` role, which prohibits a name - `role="group"` is
      // what makes the label and the popup hint legal as well as present,
      // without pruning what is inside it the way `role="button"` would
      // have (a second finding on the first fix).
      showBoard();

      const header = handleOf('Project Falcon');
      expect(header).toHaveAttribute('role', 'group');
      expect(header).toHaveAttribute('aria-label', 'Actions for Project Falcon');
      expect(header).toHaveAttribute('aria-haspopup', 'menu');
    });

    it('keeps what is inside the header its own, named role rather than swallowing it', () => {
      // The header's role names the header; it must not also swallow the
      // heading, the count and the read-only word into itself the way
      // `role="button"`'s presentational children would have.
      showBoard({
        panels: [aPanelOfText('words', 'What matters', { readOnly: true })],
      });

      expect(screen.getByRole('heading', { name: 'What matters' })).toBeVisible();
      expect(screen.getByText('read-only')).toBeVisible();
    });

    it('drops the header’s own name for what it opens while the input already carries one', async () => {
      const { user } = showBoard();

      await choose(user, 'Project Falcon', 'Rename');

      const header = handleOf('Project Falcon');
      expect(header).not.toHaveAttribute('role');
      expect(header).not.toHaveAttribute('aria-label');
      expect(header).not.toHaveAttribute('aria-haspopup');
    });
  });

  describe('a panel also carries a visible button for the same menu, unlike a tab', () => {
    it('opens it on a click, with the same entries a right-click offers', async () => {
      const { user } = showBoard();

      await user.click(menuButtonOf('Project Falcon'));

      // `findByRole`, not `getByRole`: unlike `openMenu`'s synchronous
      // `fireEvent.contextMenu`, `user.click` runs across several
      // microtasks, so the portalled menu content is not guaranteed mounted
      // in the same tick the click resolves in (found in review).
      expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    });

    it('names itself for what it opens, the same name the header carries', () => {
      showBoard();

      expect(menuButtonOf('Project Falcon')).toHaveAttribute('aria-haspopup', 'menu');
    });

    it('opens on Enter while it is the one focused, not the header underneath it', async () => {
      // Found in review: Enter bubbles from the button to the header's own
      // `opensOnKey`, which centres on `event.currentTarget` - the header,
      // once it is the one running - and its `preventDefault` swallows the
      // key before the browser can turn it into this button's own click.
      // Centring is what tells the two apart, so the header and the button
      // are given distinct rectangles and the real `contextmenu` this opens
      // with is read back off `document`, past both of `SurfaceMenu`'s own
      // fakes for the same event.
      const { user } = showBoard();
      const header = handleOf('Project Falcon');
      const button = menuButtonOf('Project Falcon');
      header.getBoundingClientRect = () =>
        ({ x: 0, y: 0, width: 400, height: 40 }) as DOMRect;
      button.getBoundingClientRect = () =>
        ({ x: 380, y: 10, width: 20, height: 20 }) as DOMRect;
      const openedAt: number[] = [];
      document.addEventListener('contextmenu', (event) => openedAt.push(event.clientX), {
        once: true,
      });
      button.focus();

      await user.keyboard('{Enter}');

      expect(openedAt).toEqual([390]);
    });

    it('leaves the header’s own drag alone, rather than being read as a press on it', () => {
      // The button sits inside the header, which is the drag handle -
      // `onPointerDown`'s own `closest('button, ...')` guard is what this
      // proves against a real element rather than only by reading the guard.
      // A bare `pointerDown` with no matching `pointerUp`, the same as
      // the touch guard just above: a full `user.click` cycle clears any
      // lift on its own `pointerup` regardless of whether the guard ran,
      // which would pass even with the guard deleted (found in review).
      showBoard();
      const lifted = () => screen.getByRole('region', { name: 'Project Falcon' }).className;

      fireEvent.pointerDown(menuButtonOf('Project Falcon'), {
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
      });

      expect(lifted()).not.toContain('opacity-40');
    });

    it('is gone while the name is being edited in place, the same as the rest of the menu', async () => {
      const { user } = showBoard();

      await choose(user, 'Project Falcon', 'Rename');

      expect(screen.queryByRole('button', { name: 'Actions for Project Falcon' })).toBeNull();
    });
  });

  describe('what a panel offers is in the panel’s own menu, and none of it needs a pointer', () => {
    it('renames it from the title, starting from the one it has', async () => {
      const { user, mutate } = showBoard();

      await choose(user, 'Project Falcon', 'Rename');
      const box = screen.getByLabelText('New name for Project Falcon');
      expect(box).toHaveValue('Project Falcon');
      await user.clear(box);
      await user.type(box, '  Falcon  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('rename_panel');
      expect(asked.payload.name).toBe('Falcon');
      expect(asked.payload.panelId).toBe('falcon');
    });

    it('asks before deleting it, and says what it takes with it', async () => {
      const { user, mutate } = showBoard();

      await choose(user, 'To read', 'Delete');
      expect(
        screen.getByText('Delete To read? It goes from every layout of this dashboard.'),
      ).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Yes, delete To read' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('delete_panel');
      expect(asked.payload.panelId).toBe('reading');
    });

    it('names the text when the panel going is one of text', async () => {
      const { user } = showBoard({
        panels: [aPanelOfText('words', 'What matters', { body: 'Standing agenda' })],
      });

      await choose(user, 'What matters', 'Delete');

      // The layouts are an arrangement anybody can make again; the words are
      // not, so they are what the question has to name.
      expect(
        screen.getByText(
          'Delete What matters? The text in it goes too, and it goes from every layout of this dashboard.',
        ),
      ).toBeVisible();
    });

    it('names a live Filter that looks at it, and that it would then show nothing', async () => {
      const project = aPanel('reading', 'To read');
      const due = aFilter('due', 'Due soon', [{ field: 'panel', values: ['reading'] }]);
      const { user } = showBoard({
        panels: [project],
        panelsInWorkspace: [project, due],
      });

      await choose(user, 'To read', 'Delete');

      expect(
        screen.getByText(
          'Delete To read? It goes from every layout of this dashboard. Due soon uses it as a Panel condition. Due soon will then show nothing.',
        ),
      ).toBeVisible();
    });

    it('names two live Filters that look at it, saying only the one left with nothing would show nothing', async () => {
      const project = aPanel('reading', 'To read');
      const other = aPanel('other', 'Somewhere else');
      const emptied = aFilter('due', 'Due soon', [{ field: 'panel', values: ['reading'] }]);
      const keptGoing = aFilter('over', 'Overdue', [
        { field: 'panel', values: ['reading', 'other'] },
      ]);
      const { user } = showBoard({
        panels: [project],
        panelsInWorkspace: [project, other, emptied, keptGoing],
      });

      await choose(user, 'To read', 'Delete');

      expect(
        screen.getByText(
          'Delete To read? It goes from every layout of this dashboard. Due soon and Overdue use it as a Panel condition. Due soon will then show nothing.',
        ),
      ).toBeVisible();
    });

    it.each([
      { situation: 'cancelled', answer: 'Cancel' },
      { situation: 'dismissed with Escape', answer: null },
    ])('sends nothing when the question is $situation', async ({ answer }) => {
      const { user, mutate } = showBoard();

      await choose(user, 'To read', 'Delete');
      if (answer) await user.click(screen.getByRole('button', { name: answer }));
      else await user.keyboard('{Escape}');

      expect(mutate).not.toHaveBeenCalled();
      expect(screen.getByRole('region', { name: 'To read' })).toBeVisible();
    });

    it.each(['Wider', 'Narrower', 'Taller', 'Shorter'])(
      'offers no %s, resizing being the corner grip’s alone',
      (gone) => {
        // Four step-at-a-time entries in a menu read on every panel, beside a
        // gesture that does the whole thing at once.
        showBoard();

        openMenu('Project Falcon');

        expect(screen.queryByRole('menuitem', { name: new RegExp(`^${gone}`) })).toBeNull();
        // And the count, so they cannot come back under other words: rename,
        // sort, move to another dashboard, delete.
        expect(screen.getAllByRole('menuitem')).toHaveLength(4);
      },
    );
  });

  describe('a panel moves to another dashboard from its own menu', () => {
    it('says why it cannot be chosen on a workspace with no other dashboard', async () => {
      showBoard({ dashboards: [DASHBOARD] });

      openMenu('Project Falcon');

      expect(
        screen.getByRole('menuitem', {
          name: 'Move to another dashboard: This workspace has no other dashboard',
        }),
      ).toHaveAttribute('aria-disabled', 'true');
    });

    it('does nothing when chosen while unavailable', async () => {
      const { user, mutate } = showBoard({ dashboards: [DASHBOARD] });

      openMenu('Project Falcon');
      await user.click(
        await screen.findByRole('menuitem', {
          name: 'Move to another dashboard: This workspace has no other dashboard',
        }),
      );

      expect(mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('opens a picker listing the workspace’s other dashboards, in tab order', async () => {
      const { user } = showBoard({ dashboards: [DASHBOARD, RESEARCH, PERSONAL] });

      await choose(user, 'Project Falcon', 'Move to another dashboard');

      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('button', { name: 'Research' })).toBeVisible();
      expect(within(dialog).getByRole('button', { name: 'Personal' })).toBeVisible();
      // The dashboard the panel is already on is never offered as somewhere
      // to move it to.
      expect(within(dialog).queryByRole('button', { name: 'Today' })).toBeNull();
    });

    it('sends the move, naming the panel and the dashboard picked', async () => {
      const { user, mutate } = showBoard({ dashboards: [DASHBOARD, RESEARCH] });

      await choose(user, 'Project Falcon', 'Move to another dashboard');
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Research' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('move_panel_to_dashboard');
      expect(asked.payload.panelId).toBe('falcon');
      expect(asked.payload.dashboardId).toBe('research');
    });

    it('sends nothing when the picker is cancelled', async () => {
      const { user, mutate } = showBoard({ dashboards: [DASHBOARD, RESEARCH] });

      await choose(user, 'Project Falcon', 'Move to another dashboard');
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

      expect(mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('changing the arrangement changes the layout you are on, and asks nothing', () => {
    it('draws the dashboard from its one layout, with no list of screen sizes to read', () => {
      // Another dashboard's layout beside it, as the workspace's snapshot
      // carries every dashboard's.
      showBoard({
        layouts: [
          { ...aLayout('elsewhere', ['falcon', 'reading']), dashboardId: 'research' },
          {
            ...aLayout('mine', []),
            rows: [
              { height: null, cells: [{ panelId: 'reading', span: 12 }] },
              { height: null, cells: [{ panelId: 'falcon', span: 12 }] },
            ],
          },
        ],
      });

      expect(drawnLines()).toEqual([['reading'], ['falcon']]);
    });

    it('changes the layout on screen, asking nothing', async () => {
      const layouts = [aLayout('mine', ['falcon', 'reading'])];
      const { mutate } = showBoard({ layouts });

      dragTo('To read', slotBefore('falcon'));

      expect(screen.queryByRole('alertdialog')).toBeNull();
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.payload.layoutId).toBe('mine');
      expect(sentOrder(mutate)).toEqual(['reading', 'falcon']);
    });

    it('makes the first arrangement of a dashboard nobody has arranged without naming a screen size or a width', async () => {
      // There is nothing to change and nothing worth interrupting a drag to
      // ask: the first move makes the dashboard's one layout (`save_layout`).
      screenIs(1280);
      const { mutate } = showBoard();

      dragTo('To read', slotBefore('falcon'));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('save_layout');
      expect(asked.payload).not.toHaveProperty('screenSizeId');
      expect(asked.payload).not.toHaveProperty('screenWidth');
    });

    it('changes the layout it just made rather than naming a second one', async () => {
      // Two gestures before the first has been re-read both find a dashboard
      // with no layout, and the second is about the one the first made.
      // Left in flight, which is the state two quick gestures happen in: the
      // first is sent and not yet re-read, so the second still finds a
      // dashboard with no layout.
      const { mutate } = showBoard({ settles: false });

      dragTo('To read', slotBefore('falcon'));
      dragTo('Project Falcon', slotBefore('reading'));

      expect(mutate).toHaveBeenCalledTimes(2);
      const [first] = mutate.mock.calls[0]!;
      const [second] = mutate.mock.calls[1]!;
      expect(second.payload.layoutId).toBe(first.payload.layoutId);
    });

    it('sends a change that puts the panels back where the stored layout has them', async () => {
      // The second gesture is a change from where the panels are *now*, which
      // is the arrangement the first one made and the snapshot in hand does not
      // have yet. Measured against the snapshot it would look like no change at
      // all, and the move would be silently dropped.
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
        settles: false,
      });

      dragTo('To read', slotBefore('falcon'));
      dragTo('Project Falcon', slotBefore('reading'));

      expect(mutate).toHaveBeenCalledTimes(2);
      expect(sentOrder(mutate)).toEqual(['falcon', 'reading']);
    });

    it('sends nothing when the gesture leaves the arrangement where it already was', async () => {
      // Dropped back where it already is - on its own slot. A gesture
      // happened, and what it asks for is what the layout already holds;
      // sending it would make every abandoned drag a write.
      const { mutate } = showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });

      dragTo('Project Falcon', slotBefore('falcon'));

      expect(mutate).not.toHaveBeenCalled();
    });

    it('puts a panel on a line of its own when it is let go in the gap', async () => {
      // The seam between two rows is the gesture that makes a row, and it is
      // the one thing the wrapping grid had no way to express.
      const { mutate } = showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });

      dragTo('To read', gapAbove(0));

      expect(sentRows(mutate)).toEqual([['reading'], ['falcon']]);
    });

    it('draws a row at the height it was given, and one with none at the floor', async () => {
      // The conversion from the arrangement that came before this hands every
      // row the height its panels were drawn at (changes.ts, `0013-panel-rows`)
      // so that nothing changes size on the day it lands - which only holds if
      // the height is read back out. A row nobody has ever sized has none, and
      // is as tall as what is on it, never below the floor.
      showBoard({
        layouts: [
          {
            ...aLayout('laptop', ['falcon']),
            rows: [
              { height: 248, cells: [{ panelId: 'falcon', span: 12 }] },
              { height: null, cells: [{ panelId: 'reading', span: 12 }] },
            ],
          },
        ],
      });

      const rows = screen
        .getAllByRole('region')
        .map((panel) => (panel.parentElement as HTMLElement).style);

      expect(rows[0]!.height).toBe('248px');
      expect(rows[1]!.height).toBe('');
      expect(rows[1]!.minHeight).toBe(`${MIN_ROW_HEIGHT}px`);
    });

    it('closes the gaps again when a panel is picked up and let go nowhere', async () => {
      // The seams open to be aimed at, so they have to close when there is no
      // longer anything to aim.
      showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });
      const handle = handleOf('To read');

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
      expect(seamsAreOpen()).toBe(true);

      fireEvent.pointerUp(handle, { pointerId: 1 });

      expect(seamsAreOpen()).toBe(false);
    });

    it('draws the panels moved while the drag is on, and sends nothing until it ends', async () => {
      // The whole of this gesture: what is under the hand is the arrangement
      // the drop will keep. Before this the board drew nothing at all while a
      // panel was in the air - not the panel that had been picked up, not the
      // side it would land on - so the only way to find out what a drag meant
      // was to finish it.
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });

      dragTo('To read', gapAbove(0), false);

      expect(drawnLines()).toEqual([['reading'], ['falcon']]);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('marks the panel that is in the air, and unmarks it once it lands', async () => {
      // A gesture with no sign that it has begun is one you find out about
      // afterwards: the panel picked up used to be drawn exactly as it was.
      showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });
      const lifted = () => screen.getByRole('region', { name: 'To read' }).className;
      const handle = handleOf('To read');

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
      expect(lifted()).toContain('opacity-40');

      fireEvent.pointerUp(handle, { pointerId: 1 });

      expect(lifted()).not.toContain('opacity-40');
    });

    it('puts the panels back and sends nothing when the browser takes the gesture', async () => {
      // A touch that became a scroll, or the window losing focus. The panels
      // have already moved on screen by then, so leaving them there would be
      // a change nobody asked for and nobody sent.
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });
      const handle = handleOf('To read');

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
      layOut();
      fireEvent.pointerMove(handle, { pointerId: 1, ...{ clientX: 300, clientY: -11 } });
      expect(drawnLines()).toEqual([['reading'], ['falcon']]);

      fireEvent.pointerCancel(handle, { pointerId: 1 });

      // Back on the one row the layout stores, which is where they started.
      expect(drawnLines()).toEqual([['falcon', 'reading']]);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('keeps following the pointer after the panels have moved once', async () => {
      // Found in the browser, and invisible to a case that only moves once. A
      // panel that joins another row is drawn under a different parent, so
      // React remounts it - and the drag was holding the pointer on the header
      // it started on, which goes with the node. It answered the first move and
      // then went deaf, so the board sat showing an arrangement the pointer had
      // long since left. The board holds the pointer now, and it outlives every
      // rearrangement.
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });
      const handle = handleOf('To read');

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
      layOut();
      // Onto its own line above everything, which moves it between rows.
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: -11 });
      expect(drawnLines()).toEqual([['reading'], ['falcon']]);

      // And on, back onto the row it left but ahead of the panel there - which
      // is a different arrangement from the one it started in, so a drag that
      // had gone deaf would send nothing at all.
      layOut();
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10, clientY: 172 });
      fireEvent.pointerUp(handle, { pointerId: 1 });

      expect(sentRows(mutate)).toEqual([['reading', 'falcon']]);
    });

    it('puts the panels back and sends nothing when the drag is abandoned with Escape', async () => {
      // Escape abandons the innermost thing that is open everywhere else in the
      // app, and a drag in progress had nothing to abandon: the only way out
      // was to drop the panel somewhere and move it back.
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });
      const handle = handleOf('To read');

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
      layOut();
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: -11 });
      expect(drawnLines()).toEqual([['reading'], ['falcon']]);

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(drawnLines()).toEqual([['falcon', 'reading']]);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('ends the drag when the panel is let go away from the board', async () => {
      // The pointer is captured, so a release reaches the board wherever it
      // lands - unless the browser refused the capture, which it is allowed to
      // do. The board would then sit lifted around a drag that was over.
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });
      const handle = handleOf('To read');

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
      layOut();
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: -11 });

      fireEvent.pointerUp(window, { pointerId: 1 });

      expect(seamsAreOpen()).toBe(false);
      expect(sentRows(mutate)).toEqual([['reading'], ['falcon']]);
    });

    it('holds the arrangement while the pointer sits on the panel it just moved', async () => {
      // Found in review. The rows a drag measures are the rows as drawn, and
      // what is drawn already has the panel moved - so an ordinary position,
      // anywhere on the half of the row it has just joined, resolves to
      // beside itself. `movedBeside` refuses that by handing back the
      // arrangement at pick-up, which threw the preview away and flung the
      // panel home; a drop landing on one of those frames sent nothing at
      // all, having visibly moved the panel.
      const { mutate } = showBoard({
        layouts: [
          {
            ...aLayout('laptop', ['falcon']),
            rows: [
              { height: null, cells: [{ panelId: 'falcon', span: 12 }] },
              { height: null, cells: [{ panelId: 'reading', span: 12 }] },
            ],
          },
        ],
      });
      const handle = handleOf('To read');

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
      layOut();
      // Onto the right-hand half of the row above, which joins it.
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500, clientY: 50 });
      expect(drawnLines()).toEqual([['falcon', 'reading']]);

      // The same spot again, which is now inside the panel own slot. Fired at
      // the board rather than the header: the header went with the row the
      // panel left, and a captured pointer delivers to the board anyway.
      layOut();
      fireEvent.pointerMove(boardEl(), { pointerId: 1, clientX: 500, clientY: 50 });

      expect(drawnLines()).toEqual([['falcon', 'reading']]);

      // On the window, which is where a captured pointer delivers a release -
      // and the only node still in the tree, the header having been redrawn
      // on another row.
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(sentRows(mutate)).toEqual([['falcon', 'reading']]);
    });

    it('starts the drag even where the browser refuses the pointer', async () => {
      // Capture keeps the moves coming once the pointer has left the board, and
      // the browser is free to refuse it for a pointer it does not consider
      // active. Taken before the drag was recorded, that refusal threw and the
      // line that begins the drag never ran - so the gesture silently did
      // nothing at all. It is worth having and it is not worth the gesture.
      const refused = vi
        .spyOn(Element.prototype, 'setPointerCapture')
        .mockImplementation(() => {
          throw new DOMException('no such pointer', 'NotFoundError');
        });
      try {
        const { mutate } = showBoard({
          layouts: [aLayout('laptop', ['falcon', 'reading'])],
        });
        const handle = handleOf('To read');

        fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
        expect(seamsAreOpen()).toBe(true);

        layOut();
        fireEvent.pointerMove(boardEl(), { pointerId: 1, clientX: 300, clientY: -11 });
        fireEvent.pointerUp(window, { pointerId: 1 });

        expect(sentRows(mutate)).toEqual([['reading'], ['falcon']]);
      } finally {
        refused.mockRestore();
      }
    });

    it('sends nothing for a drag that ends where it started', async () => {
      // Every wander that comes home is one of these, and sending it would
      // make a change out of a gesture that changed nothing.
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });

      dragTo('To read', slotBefore('reading'));

      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('dropping a dragged panel on another dashboard’s tab moves it there', () => {
    /** Off the board entirely - where a dashboard's own tab strip actually sits. */
    const onTheTab = { x: 40, y: -400 };

    it('sends the same move the picker would, rather than an arrangement', async () => {
      const { mutate } = showBoard({
        dashboards: [DASHBOARD, RESEARCH],
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });
      aTabElement('research', { left: 0, right: 80, top: -420, bottom: -380 });

      dragTo('Project Falcon', onTheTab);

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('move_panel_to_dashboard');
      expect(asked.payload.panelId).toBe('falcon');
      expect(asked.payload.dashboardId).toBe('research');
    });

    it('changes nothing when dropped on the tab of the dashboard already open', async () => {
      // Mirrors "a drag that ends where it started" (above): the drop is read
      // as no target at all, since it is the dashboard already open - so what
      // is left is a drag ending exactly where it started, on the board it
      // never left.
      const { mutate } = showBoard({
        dashboards: [DASHBOARD, RESEARCH],
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });
      const point = slotBefore('falcon');
      aTabElement('today', {
        left: point.x - 5,
        right: point.x + 5,
        top: point.y - 5,
        bottom: point.y + 5,
      });

      dragTo('Project Falcon', point);

      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('the line under a row sets how tall it is, and the line between two panels how much each takes', () => {
    /** One panel, so the board has the one row these are about. */
    const oneRow = { panels: [aPanel('falcon', 'Project Falcon')] };

    it('keeps the height the line was dragged to, and sends nothing until the hand stops', () => {
      // The whole gesture: what is under the hand is the size letting go will
      // keep. Sending as the pointer moved would be a change per pixel.
      const { mutate } = showBoard({
        ...oneRow,
        layouts: [aLayout('laptop', ['falcon'])],
      });

      dragRowLine(0, 200, false);
      expect(drawnHeights()).toEqual(['300px']);
      expect(mutate).not.toHaveBeenCalled();

      letGoOfRowLine();
      expect(sentHeights(mutate)).toEqual([300]);
    });

    it('gives one panel what the other gives up, and leaves the row adding up to a whole', () => {
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });

      dragColumnLine(0, ONE_COLUMN);

      expect(sentSpans(mutate)).toEqual([[7, 5]]);
    });

    it('puts a row back to being as tall as what is in it when the line is double-clicked', () => {
      // The only way back: a drag always leaves a number behind, and the height
      // a row has without one is not a number anything could drag to.
      const { mutate } = showBoard({
        ...oneRow,
        layouts: [
          {
            ...aLayout('laptop', ['falcon']),
            rows: [{ height: 400, cells: [{ panelId: 'falcon', span: 12 }] }],
          },
        ],
      });

      fireEvent.doubleClick(screen.getAllByTestId('row-line')[0]!);

      expect(sentHeights(mutate)).toEqual([null]);
    });

    it.each([
      { situation: 'a row already the height it is being dragged to', act: () => dragRowLine(0, 0) },
      { situation: 'a line moved less than a whole column', act: () => dragColumnLine(0, 4) },
    ])('sends nothing for $situation', ({ act }) => {
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', ['falcon', 'reading'])],
      });

      act();

      expect(mutate).not.toHaveBeenCalled();
    });

    it('takes no hold of a line pressed with anything but the primary button', () => {
      // A right-click opens a menu over the line, so no release ever reaches
      // the handler - and a gesture begun by it would go on sizing the row
      // under every mouse move until some later click ended it.
      const { mutate } = showBoard({
        ...oneRow,
        layouts: [aLayout('laptop', ['falcon'])],
      });

      layOut();
      const line = screen.getAllByTestId('row-line')[0]!;
      fireEvent.pointerDown(line, { button: 2, pointerId: 1, clientX: 300, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 200 });

      expect(drawnHeights()).toEqual(['']);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('sizes the row the line belongs to and leaves every other row alone', () => {
      const { mutate } = showBoard({
        layouts: [
          {
            ...aLayout('laptop', ['falcon']),
            rows: [
              { height: 240, cells: [{ panelId: 'falcon', span: 12 }] },
              { height: null, cells: [{ panelId: 'reading', span: 12 }] },
            ],
          },
        ],
      });

      // The second of the two lines, which is the one under the second row.
      dragRowLine(1, 200);

      expect(sentHeights(mutate)).toEqual([240, 300]);
      expect(sentRows(mutate)).toEqual([['falcon'], ['reading']]);
    });
  });

  describe('a size the hand did not finish setting is not kept', () => {
    it.each([
      {
        situation: 'the gesture is abandoned with Escape',
        end: () => fireEvent.keyDown(window, { key: 'Escape' }),
      },
      {
        situation: 'the browser takes the gesture back',
        end: () => fireEvent.pointerCancel(window, { pointerId: 1 }),
      },
    ])('puts the row back and sends nothing when $situation', ({ end }) => {
      const { mutate } = showBoard({
        panels: [aPanel('falcon', 'Project Falcon')],
        layouts: [aLayout('laptop', ['falcon'])],
      });

      dragRowLine(0, 200, false);
      expect(drawnHeights()).toEqual(['300px']);

      end();

      expect(drawnHeights()).toEqual(['']);
      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('while a panel is in the air the lines between the rows are the drag’s', () => {
    it('takes the lines away for the length of a drag and gives them back when it lands', () => {
      // The seam a panel is dropped into and the line that sizes a row are the
      // same four pixels, so only one of them can mean anything at a time.
      showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });
      const handle = handleOf('To read');
      expect(screen.queryAllByTestId('row-line')).not.toHaveLength(0);

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: 'mouse' });
      expect(screen.queryAllByTestId('row-line')).toHaveLength(0);
      expect(screen.queryAllByTestId('column-line')).toHaveLength(0);

      fireEvent.pointerUp(handle, { pointerId: 1 });

      expect(screen.queryAllByTestId('row-line')).not.toHaveLength(0);
    });

    // One line per row and none above the first, so every row has exactly the
    // one under it to pull and a dashboard with nothing on it has none at all.
    it.each([
      { situation: 'no panels on it at all', panels: [] as Panel[], lines: 0 },
      { situation: 'one row', panels: [aPanel('falcon', 'Project Falcon')], lines: 1 },
      {
        situation: 'two rows',
        panels: [aPanel('falcon', 'Project Falcon'), aPanel('reading', 'To read')],
        lines: 2,
      },
    ])('gives a dashboard with $situation $lines of them', ({ panels, lines }) => {
      showBoard({ panels, layouts: [aLayout('laptop', ['falcon'])] });

      expect(screen.queryAllByTestId('row-line')).toHaveLength(lines);
    });
  });

  describe('a phone is drawn one panel across and offers nothing to rearrange with', () => {
    const rowsDrawn = () => document.querySelectorAll('[data-panel-row]').length;

    it('ignores the layout made for a wider screen, however near it is', () => {
      screenIs(375);
      showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });

      expect(rowsDrawn()).toBe(2);
    });

    it('takes away every line and the grab that rearranging is done with', () => {
      screenIs(375);
      showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });

      expect(screen.queryAllByTestId('row-line')).toHaveLength(0);
      expect(screen.queryAllByTestId('column-line')).toHaveLength(0);

      // The header is no handle: pressing it picks nothing up, so no seam opens.
      fireEvent.pointerDown(handleOf('To read'), { button: 0, pointerId: 1, pointerType: 'mouse' });
      expect(screen.queryAllByTestId('row-seam')[0]).not.toHaveStyle({ height: '22px' });
    });

    it('keeps nothing of a drag the window was shrunk to a phone in the middle of', () => {
      const { mutate } = showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });
      const point = slotBefore('falcon');
      dragTo('To read', point, false);

      act(() => {
        screenIs(375);
        window.dispatchEvent(new Event('resize'));
      });
      fireEvent.pointerUp(handleOf('To read'), { pointerId: 1, clientX: point.x, clientY: point.y });

      expect(mutate).not.toHaveBeenCalled();
    });

    it('switches between the layout and one panel across as the window crosses the line, without a reload', () => {
      screenIs(1280);
      showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });
      expect(rowsDrawn()).toBe(1);
      expect(screen.queryAllByTestId('column-line')).toHaveLength(1);

      act(() => {
        screenIs(479);
        window.dispatchEvent(new Event('resize'));
      });
      expect(rowsDrawn()).toBe(2);
      expect(screen.queryAllByTestId('column-line')).toHaveLength(0);

      act(() => {
        screenIs(480);
        window.dispatchEvent(new Event('resize'));
      });
      expect(rowsDrawn()).toBe(1);
      expect(screen.queryAllByTestId('column-line')).toHaveLength(1);
    });
  });

  describe('a change that could not happen says so where it was asked for', () => {
    it.each([
      {
        situation: 'a title another panel already holds',
        error: new CommandRefused(409, 'a panel called To read is already on this dashboard'),
        variables: { name: 'rename_panel', payload: { panelId: 'falcon' } },
        act: async (user: ReturnType<typeof userEvent.setup>) => {
          await choose(user, 'Project Falcon', 'Rename');
          await user.click(screen.getByRole('button', { name: 'Save' }));
        },
        says: 'a panel called To read is already on this dashboard',
        stillOpen: 'New name for Project Falcon',
        holding: 'Project Falcon',
      },
      {
        situation: 'a request that never reached the server',
        error: new Error('Failed to fetch'),
        variables: { name: 'rename_panel', payload: { panelId: 'falcon' } },
        act: async (user: ReturnType<typeof userEvent.setup>) => {
          await choose(user, 'Project Falcon', 'Rename');
          await user.click(screen.getByRole('button', { name: 'Save' }));
        },
        says: 'That did not reach the server. Try again.',
        stillOpen: 'New name for Project Falcon',
        holding: 'Project Falcon',
      },
    ])('$situation', async ({ error, variables, act, says, stillOpen, holding }) => {
      const { user } = showBoard({ error, variables });

      await act(user);

      expect(screen.getByRole('alert')).toHaveTextContent(says);
      // Still there to be corrected: the box does not close over a refusal, and
      // it still holds what was typed into it.
      expect(screen.getByLabelText(stillOpen)).toHaveValue(holding);
    });

    it('puts a refused arrangement back, rather than leaving it under the message', async () => {
      // The draft is what the grid draws while a change is in flight. Left
      // standing through a refusal, the panels say the change happened and the
      // notice above them says it did not.
      //
      // Reachable: two tabs on a dashboard with no layout, both on a screen of
      // the same size, both dragging - the second is refused for the name.
      showBoard({
        error: new CommandRefused(409, 'a layout called Wide already arranges this dashboard'),
        variables: { name: 'save_layout', payload: {} },
      });

      dragTo('To read', slotBefore('falcon'));

      expect(screen.getByRole('alert')).toHaveTextContent('a layout called Wide already arranges');
      expect(panelOrderOnScreen()).toEqual(['Project Falcon', 'To read']);
    });

    it('says a refused arrangement above the board, which is the only place it belongs', async () => {
      // Nothing asked for the arrangement in a box that could hold the answer -
      // it came from a drag - so the board itself says it.
      showBoard({
        layouts: [aLayout('wide', ['falcon', 'reading'])],
        error: new CommandRefused(404, 'panel reading is not on this dashboard'),
        variables: { name: 'save_layout', payload: {} },
      });

      dragTo('To read', slotBefore('falcon'));

      expect(screen.getByRole('alert')).toHaveTextContent('panel reading is not on this dashboard');
    });
  });
});

/**
 * The panels as they are drawn, in order - which is the arrangement on screen.
 *
 * `hidden: true` because a question is a modal dialog: Radix marks the rest of
 * the page `aria-hidden` while one is open, and the whole point of two of the
 * cases here is what the page behind the question looks like.
 */
function panelOrderOnScreen(): string[] {
  return screen
    .getAllByRole('region', { hidden: true })
    .map((region) => region.getAttribute('aria-label') ?? '')
    .filter(Boolean);
}

describe('Panels', () => {
  describe('a panel holds either the items filed into it or the text written in it', () => {
    /**
     * What each kind draws. The kind itself is settled when the panel is made
     * and proved in apps/api/tests/unit/domain/panels.test.ts; what is asked
     * here is that the board draws two different things from it.
     */
    it('draws a list and a count for items, and a box to write in for text', async () => {
      showBoard({
        panels: [aPanel('falcon', 'Project Falcon'), aPanelOfText('words', 'What matters')],
        items: [anItem('one', 'Answer Tom')],
        filings: [{ panelId: 'falcon', itemId: 'one', position: 0 }],
      });

      expect(await screen.findByText('Answer Tom')).toBeInTheDocument();
      // The count belongs to a panel that holds items; a panel of text has no
      // answer to "how many", so it draws none.
      const words = screen.getByRole('region', { name: 'What matters' });
      expect(within(words).queryByText('0')).not.toBeInTheDocument();
      expect(within(words).getByRole('textbox', { name: 'What matters' })).toBeInTheDocument();
    });

    it('shows a read-only panel’s text without a box, and says it is read-only', async () => {
      showBoard({
        panels: [aPanelOfText('words', 'What matters', { body: 'Standing agenda', readOnly: true })],
      });

      const words = await screen.findByRole('region', { name: 'What matters' });
      expect(within(words).getByText('Standing agenda')).toBeInTheDocument();
      expect(within(words).getByText('read-only')).toBeInTheDocument();
      expect(within(words).queryByRole('textbox')).not.toBeInTheDocument();
    });

    /**
     * The third way an item reaches a panel, after the picker and a direct
     * request. There is nothing to drop on because the list is not drawn at
     * all - which is the point: the target is the list, so a panel without one
     * offers none.
     *
     * The picker's half is in tests/unit/components/ItemList.test.tsx and the
     * store's refusal, whatever the app does, in
     * apps/api/tests/integration/http/panel-items.test.ts.
     */
    it('takes no item dropped on it', async () => {
      const { mutate } = showBoard({ panels: [aPanelOfText('words', 'What matters')] });
      const words = await screen.findByRole('region', { name: 'What matters' });

      expect(within(words).queryByRole('list')).not.toBeInTheDocument();
      const carrying = { types: [ITEM_BEING_DRAGGED], getData: () => 'one', setData: vi.fn() };
      fireEvent.dragOver(words, { dataTransfer: carrying });
      fireEvent.drop(words, { dataTransfer: carrying });

      expect(mutate).not.toHaveBeenCalled();
    });

    it('says so rather than showing an empty box when there is nothing to read', async () => {
      showBoard({ panels: [aPanelOfText('words', 'What matters', { readOnly: true })] });

      expect(await screen.findByText(NOTHING_WRITTEN_HERE)).toBeInTheDocument();
    });
  });

  describe('a panel of text is read-only until somebody says otherwise', () => {
    it.each([
      { situation: 'locking one that is open', readOnly: false, entry: 'Make read-only', sends: true },
      { situation: 'opening one that is locked', readOnly: true, entry: 'Allow editing', sends: false },
    ])('$situation', async ({ readOnly, entry, sends }) => {
      const { mutate, user } = showBoard({
        panels: [aPanelOfText('words', 'What matters', { readOnly })],
      });

      await choose(user, 'What matters', entry);

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_panel_read_only',
          payload: expect.objectContaining({ panelId: 'words', readOnly: sends }),
        }),
      );
    });

    it.each([
      { situation: 'asking for formatting', format: 'plain' as const, entry: 'Use rich text', sends: 'rich' },
      { situation: 'asking for the characters back', format: 'rich' as const, entry: 'Use plain text', sends: 'plain' },
    ])('$situation', async ({ format, entry, sends }) => {
      const { mutate, user } = showBoard({
        panels: [aPanelOfText('words', 'What matters', { format })],
      });

      await choose(user, 'What matters', entry);

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_panel_format',
          payload: expect.objectContaining({ panelId: 'words', format: sends }),
        }),
      );
    });

    /**
     * A panel of items has no text to lock and none to draw, and an entry that
     * means nothing where it is offered is worse than one that is not there -
     * which is why these are absent rather than unavailable, unlike the moves
     * beside them.
     */
    it('offers the choice on a panel of text and on no other', async () => {
      const { user } = showBoard({
        panels: [aPanel('falcon', 'Project Falcon'), aPanelOfText('words', 'What matters')],
      });

      openMenu('Project Falcon');
      expect(screen.queryByRole('menuitem', { name: /read-only|Allow editing/ })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: /rich text|plain text/ })).toBeNull();
      await user.keyboard('{Escape}');

      openMenu('What matters');
      expect(await screen.findByRole('menuitem', { name: 'Make read-only' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Use rich text' })).toBeInTheDocument();
    });
  });

  describe('what is written in a panel of text is kept', () => {
    /**
     * A clock this describe owns, because both cases below are about *when* the
     * change is sent rather than about what is in it.
     *
     * `shouldAdvanceTime`, so the queries that find the box still settle: a
     * frozen clock stops `findBy*` polling and every case here would time out
     * waiting for a board that is already drawn.
     */
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Not on a keystroke, and not lost either. The box reports every change as
     * it happens; what is sent is one change once the typing stops, and again
     * on the way out - so a panel left mid-sentence is saved rather than losing
     * the sentence with the timer that never fired.
     */
    it('sends what was typed once the typing stops', async () => {
      {
        const { mutate } = showBoard({ panels: [aPanelOfText('words', 'What matters')] });
        const box = await screen.findByRole('textbox', { name: 'What matters' });

        fireEvent.change(box, { target: { value: 'Standing' } });
        fireEvent.change(box, { target: { value: 'Standing agenda' } });
        expect(mutate).not.toHaveBeenCalled();

        vi.advanceTimersByTime(QUIET);

        expect(mutate).toHaveBeenCalledTimes(1);
        expect(mutate).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'set_panel_text',
            payload: expect.objectContaining({ panelId: 'words', body: 'Standing agenda' }),
          }),
        );
      }
    });

    it('sends what was typed but not yet sent when the panel goes off screen', async () => {
      {
        const { mutate, unmount } = showBoard({ panels: [aPanelOfText('words', 'What matters')] });
        const box = await screen.findByRole('textbox', { name: 'What matters' });
        fireEvent.change(box, { target: { value: 'Mid-sentence' } });

        // Switching dashboard, before the pause was long enough to send.
        unmount();

        expect(mutate).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'set_panel_text',
            payload: expect.objectContaining({ body: 'Mid-sentence' }),
          }),
        );
      }
    });
  });

  describe('a dashboard draws each panel with the items filed on it', () => {
    it('hands each panel the items filed on it, and says so when one has none', async () => {
      const bart = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
      const domain = anItem('11111111-1111-7111-8111-000000000002', 'Renew the domain');
      // Already in position order: that a panel *sorts* by position is
      // apps/web/tests/unit/filing.test.ts's rule, and re-proving it here would
      // be the same calculation twice. What is asked here is that the board
      // hands each panel its own items at all.
      showBoard({
        items: [bart, domain],
        filings: [
          { panelId: 'falcon', itemId: bart.id, position: 0 },
          { panelId: 'falcon', itemId: domain.id, position: 1 },
        ],
      });

      const falcon = await screen.findByRole('region', { name: 'Project Falcon' });
      expect(within(falcon).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
        expect.stringContaining('Reply to Bart'),
        expect.stringContaining('Renew the domain'),
      ]);

      const reading = await screen.findByRole('region', { name: 'To read' });
      expect(within(reading).getByText(NOTHING_FILED_HERE)).toBeVisible();
    });
  });

  /**
   * Which order a sort puts rows in is tests/unit/sorting.test.ts; what is
   * asked here is that the board draws a sorted Panel through it, says so, and
   * that the Sort question opens on what is stored and sends the whole sort.
   */
  describe('a sorted panel says so beside its name, and draws its rows by the sort', () => {
    const BY_TITLE: PanelSort = [{ field: 'title', direction: 'asc' }];

    it('reads the sort back on hover and draws the rows by it, where a Manual panel has no mark', async () => {
      const zebra = anItem('11111111-1111-7111-8111-000000000001', 'Zebra crossing');
      const apple = anItem('11111111-1111-7111-8111-000000000002', 'Apple harvest');
      showBoard({
        panels: [aSortedPanel('falcon', 'Project Falcon', BY_TITLE), aPanel('reading', 'To read')],
        items: [zebra, apple],
        filings: [
          { panelId: 'falcon', itemId: zebra.id, position: 0 },
          { panelId: 'falcon', itemId: apple.id, position: 1 },
          { panelId: 'reading', itemId: zebra.id, position: 0 },
          { panelId: 'reading', itemId: apple.id, position: 1 },
        ],
      });

      const falcon = await screen.findByRole('region', { name: 'Project Falcon' });
      expect(within(falcon).getByRole('img', { name: 'Sorted: Title ascending' })).toBeVisible();
      expect(within(falcon).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
        expect.stringContaining('Apple harvest'),
        expect.stringContaining('Zebra crossing'),
      ]);

      const reading = screen.getByRole('region', { name: 'To read' });
      expect(within(reading).queryByRole('img', { name: /Sorted/ })).toBeNull();
      expect(within(reading).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
        expect.stringContaining('Zebra crossing'),
        expect.stringContaining('Apple harvest'),
      ]);
    });

    it('marks a Filter that has a sort of its own, and none that goes by the order nobody changed', async () => {
      showBoard({
        panels: [
          { ...aFilter('due', 'Due soon'), sort: BY_TITLE },
          aFilter('other', 'Other filter'),
        ],
      });

      const sorted = await screen.findByRole('region', { name: 'Due soon' });
      expect(within(sorted).getByRole('img', { name: 'Sorted: Title ascending' })).toBeVisible();
      const unsorted = screen.getByRole('region', { name: 'Other filter' });
      expect(within(unsorted).queryByRole('img', { name: /Sorted/ })).toBeNull();
    });

    it('is offered on a panel of items and a Filter, never on a panel of text', async () => {
      showBoard({
        panels: [aPanel('falcon', 'Project Falcon'), aPanelOfText('words', 'Words'), aFilter('due', 'Due soon')],
      });

      for (const sortable of ['Project Falcon', 'Due soon']) {
        openMenu(sortable);
        expect(await screen.findByRole('menuitem', { name: 'Sort…' })).toBeVisible();
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      }

      openMenu('Words');
      await screen.findByRole('menuitem', { name: 'Rename' });
      expect(screen.queryByRole('menuitem', { name: 'Sort…' })).toBeNull();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    });
  });

  describe('the Sort question opens on what is stored and saves the whole sort', () => {
    const MODE = 'Manual or sorted';

    /** Opens *+ Sort by…* or *+ Then by…* and chooses one field. */
    async function addCriterion(user: ReturnType<typeof userEvent.setup>, field: string) {
      await user.click(await screen.findByRole('button', { name: /^\+ (Sort|Then) by…$/ }));
      await user.click(await screen.findByRole('menuitem', { name: field }));
    }

    /** What the last change sent as the sort. */
    function sentSort(mutate: ReturnType<typeof vi.fn>) {
      const [asked] = mutate.mock.calls.at(-1)!;
      expect(asked.name).toBe('set_panel_sort');
      return asked.payload.sort;
    }

    it('opens on Manual for a panel never sorted, and on its rows for one that is', async () => {
      const { user } = showBoard({
        panels: [
          aPanel('falcon', 'Project Falcon'),
          aSortedPanel('reading', 'To read', [
            { field: 'dueDate', direction: 'asc' },
            { field: 'priority', direction: 'desc' },
          ]),
        ],
      });

      await choose(user, 'Project Falcon', 'Sort…');
      expect(await screen.findByRole('radio', { name: 'Manual' })).toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await choose(user, 'To read', 'Sort…');
      expect(await screen.findByRole('radio', { name: 'Sorted' })).toBeChecked();
      expect(screen.getByRole('radiogroup', { name: 'Due date direction' })).toBeVisible();
      expect(within(screen.getByRole('radiogroup', { name: 'Priority direction' })).getByRole('radio', { name: 'Descending' })).toBeChecked();
    });

    it('asks a Filter without the Manual switch, opens on what it goes by, and never removes the last row', async () => {
      const { user, mutate } = showBoard({ panels: [aFilter('due', 'Due soon')] });

      await choose(user, 'Due soon', 'Sort…');

      expect(await screen.findByRole('radiogroup', { name: 'Due date direction' })).toBeVisible();
      expect(screen.queryByRole('radiogroup', { name: MODE })).toBeNull();
      expect(within(screen.getByRole('radiogroup', { name: 'Due date direction' })).getByRole('radio', { name: 'Ascending' })).toBeChecked();
      expect(within(screen.getByRole('radiogroup', { name: 'Priority direction' })).getByRole('radio', { name: 'Descending' })).toBeChecked();
      expect(within(screen.getByRole('radiogroup', { name: 'Created direction' })).getByRole('radio', { name: 'Ascending' })).toBeChecked();

      await user.click(screen.getByRole('button', { name: 'Remove Priority' }));
      await user.click(screen.getByRole('button', { name: 'Remove Created' }));
      expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(sentSort(mutate)).toEqual([{ field: 'dueDate', direction: 'asc' }]);
    });

    it('offers each field once, starts Priority on Descending and every other on Ascending, and says what each direction means', async () => {
      const { user, mutate } = showBoard();

      await choose(user, 'Project Falcon', 'Sort…');
      await user.click(await screen.findByRole('radio', { name: 'Sorted' }));
      await addCriterion(user, 'Priority');
      await addCriterion(user, 'Title');

      await user.click(screen.getByRole('button', { name: '+ Then by…' }));
      expect((await screen.findAllByRole('menuitem')).map((entry) => entry.textContent)).toEqual([
        'Created',
        'Due date',
        'Type',
      ]);
      await user.keyboard('{Escape}');

      const priority = screen.getByRole('radiogroup', { name: 'Priority direction' });
      expect(within(priority).getByRole('radio', { name: 'Descending' })).toBeChecked();
      expect(within(priority).getByText('Ascending').closest('label')).toHaveAttribute('title', 'Low to High');
      const title = screen.getByRole('radiogroup', { name: 'Title direction' });
      expect(within(title).getByRole('radio', { name: 'Ascending' })).toBeChecked();

      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(sentSort(mutate)).toEqual([
        { field: 'priority', direction: 'desc' },
        { field: 'title', direction: 'asc' },
      ]);
    });

    it('stops offering to add once every field has a row', async () => {
      const { user } = showBoard();

      await choose(user, 'Project Falcon', 'Sort…');
      await user.click(await screen.findByRole('radio', { name: 'Sorted' }));
      for (const field of ['Title', 'Priority', 'Created', 'Due date', 'Type']) await addCriterion(user, field);

      expect(screen.queryByRole('button', { name: '+ Then by…' })).toBeNull();
    });

    it('moves a row up and down, and never removes the last one', async () => {
      const { user, mutate } = showBoard({
        panels: [
          aSortedPanel('falcon', 'Project Falcon', [
            { field: 'dueDate', direction: 'asc' },
            { field: 'priority', direction: 'desc' },
          ]),
        ],
      });

      await choose(user, 'Project Falcon', 'Sort…');
      expect(await screen.findByRole('button', { name: 'Move Due date up' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move Priority down' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Move Priority up' }));
      await user.click(screen.getByRole('button', { name: 'Remove Due date' }));

      expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(sentSort(mutate)).toEqual([{ field: 'priority', direction: 'desc' }]);
    });

    it('keeps the rows through Manual and back, and saves Manual as no sort at all', async () => {
      const { user, mutate } = showBoard({
        panels: [aSortedPanel('falcon', 'Project Falcon', [{ field: 'dueDate', direction: 'asc' }])],
      });

      await choose(user, 'Project Falcon', 'Sort…');
      await user.click(await screen.findByRole('radio', { name: 'Manual' }));
      expect(screen.queryByRole('radiogroup', { name: 'Due date direction' })).toBeNull();
      await user.click(screen.getByRole('radio', { name: 'Sorted' }));
      expect(screen.getByRole('radiogroup', { name: 'Due date direction' })).toBeVisible();

      await user.click(screen.getByRole('radio', { name: 'Manual' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(sentSort(mutate)).toBeNull();
    });

    it.each([
      { situation: 'Cancel', leave: (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Cancel' })) },
      { situation: 'Escape', leave: (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}') },
    ])('discards what was changed on $situation, and opens again on what is stored', async ({ leave }) => {
      const { user, mutate } = showBoard({
        panels: [aSortedPanel('falcon', 'Project Falcon', [{ field: 'dueDate', direction: 'asc' }])],
      });

      await choose(user, 'Project Falcon', 'Sort…');
      await addCriterion(user, 'Title');
      await user.click(screen.getByRole('radio', { name: 'Manual' }));
      await leave(user);

      expect(mutate).not.toHaveBeenCalled();
      await choose(user, 'Project Falcon', 'Sort…');
      expect(await screen.findByRole('radio', { name: 'Sorted' })).toBeChecked();
      expect(screen.queryByRole('radiogroup', { name: 'Title direction' })).toBeNull();
      expect(screen.getByRole('radio', { name: 'Sorted' }).closest('[role="dialog"]')).toHaveTextContent(SORTED_DESCRIPTION);
    });
  });
});

/** What the Sort question says under its title while Sorted is chosen. */
const SORTED_DESCRIPTION ='By the first of these, then the next wherever two tie, then the order you set.';

/** A panel of items drawing its rows by a sort. */
function aSortedPanel(id: string, name: string, sort: PanelSort): Panel {
  return { ...aPanel(id, name), sort };
}

describe('Onboarding', () => {
  /**
   * An empty panel says it is empty and nothing about how an item gets there,
   * whatever has or has not been filed in the workspace.
   */
  describe('an empty panel says only that nothing is filed on it', () => {
    const bart = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
    it.each([
      { situation: 'nothing has been filed anywhere in the workspace', items: [], filings: [] },
      {
        situation: 'something has been filed on another panel',
        items: [bart],
        filings: [{ panelId: 'falcon', itemId: bart.id, position: 0 }],
      },
    ])('when $situation', async ({ items, filings }) => {
      showBoard({ items, filings });

      const reading = await screen.findByRole('region', { name: 'To read' });
      expect(within(reading).getByText('Nothing filed here yet.', { exact: true })).toBeVisible();
      expect(within(reading).queryByText(/Drag an item onto it/)).toBeNull();
    });
  });

  /**
   * What a Filter gathers is worked out in tests/unit/filters.test.ts against
   * the items and filings alone; what is asked here is the panel's own
   * behaviour - what it says while nothing has been chosen, what its menu
   * offers, what it sends, and what it refuses to take.
   */
  describe('a panel that gathers what it shows says so until somebody chooses what that is', () => {
    it('says to choose from its menu, and shows no rows at all', async () => {
      // An item that would match if anything had been chosen, so this cannot
      // pass merely for want of something to draw.
      const bart = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
      showBoard({
        panels: [aFilter('due', 'Due soon')],
        items: [{ ...bart, dueDate: TODAY }],
        filings: [{ panelId: 'falcon', itemId: bart.id, position: 0 }],
      });

      const due = await screen.findByRole('region', { name: 'Due soon' });
      expect(within(due).getByText(NOTHING_CHOSEN_TO_SHOW)).toBeVisible();
      expect(within(due).queryByRole('listitem')).toBeNull();
    });

    it('draws the items it gathers once it has been told what to show', async () => {
      const bart = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
      showBoard({
        panels: [aFilter('due', 'Due soon', [DUE_TODAY])],
        items: [{ ...bart, dueDate: TODAY }],
        filings: [{ panelId: 'falcon', itemId: bart.id, position: 0 }],
      });

      const due = await screen.findByRole('region', { name: 'Due soon' });
      expect(within(due).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
        expect.stringContaining('Reply to Bart'),
      ]);
      expect(within(due).queryByText(NOTHING_CHOSEN_TO_SHOW)).toBeNull();
    });

    it('reads its conditions back beside its name', async () => {
      showBoard({ panels: [aFilter('due', 'Due soon', [DUE_TODAY])] });

      const due = await screen.findByRole('region', { name: 'Due soon' });
      expect(within(due).getByRole('img', { name: 'Shows due today or overdue' })).toBeVisible();
    });

    it('sends what was chosen, and opens again on it', async () => {
      const { mutate, user } = showBoard({ panels: [aFilter('due', 'Due soon')] });

      await choose(user, 'Due soon', 'Filter…');
      await addCondition(user, 'Due date');
      await user.selectOptions(screen.getByRole('combobox', { name: /Due date is/ }), 'week');
      await user.click(screen.getByRole('checkbox', { name: 'or overdue' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_panel_filter',
          payload: expect.objectContaining({
            panelId: 'due',
            conditions: [{ field: 'dueDate', window: 'week', orOverdue: false }],
          }),
        }),
        expect.anything(),
      );
    });

    it('opens on the conditions the panel already has', async () => {
      const { user } = showBoard({ panels: [aFilter('due', 'Due soon', [DUE_TODAY])] });

      await choose(user, 'Due soon', 'Filter…');

      expect(await screen.findByRole('combobox', { name: /Due date is/ })).toHaveValue('today');
      expect(screen.getByRole('checkbox', { name: 'or overdue' })).toBeChecked();
    });

    it('keeps the rows being added when the same filter is saved on another device', async () => {
      // The question is read once and is the person's from then on: a snapshot
      // arriving under it would otherwise take a half-finished row away with
      // no way back, where everywhere else here the later save stands.
      const { user, redrawnWith } = showBoard({ panels: [aFilter('due', 'Due soon')] });
      await choose(user, 'Due soon', 'Filter…');
      await addCondition(user, 'Due date');
      await user.selectOptions(screen.getByRole('combobox', { name: /Due date is/ }), 'month');

      redrawnWith([aFilter('due', 'Due soon', [DUE_TODAY])]);

      expect(screen.getByRole('combobox', { name: /Due date is/ })).toHaveValue('month');
    });

    it('saves with nothing left, which puts it back to saying nothing has been chosen', async () => {
      const { mutate, user } = showBoard({ panels: [aFilter('due', 'Due soon', [DUE_TODAY])] });

      await choose(user, 'Due soon', 'Filter…');
      await user.click(await screen.findByRole('button', { name: 'Remove condition 1' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_panel_filter',
          payload: expect.objectContaining({ conditions: [] }),
        }),
        expect.anything(),
      );
    });

    describe('it can be told an item need only meet any of its conditions', () => {
      const ALL_OR_ANY = 'How the conditions combine';

      it('offers the choice only from two conditions, on all of these', async () => {
        const { user } = showBoard({ panels: [aFilter('due', 'Due soon', [DUE_TODAY])] });

        await choose(user, 'Due soon', 'Filter…');
        await screen.findByRole('button', { name: 'Save' });
        expect(screen.queryByRole('radiogroup', { name: ALL_OR_ANY })).toBeNull();

        await addCondition(user, 'Priority');

        expect(screen.getByRole('radiogroup', { name: ALL_OR_ANY })).toBeVisible();
        expect(screen.getByRole('radio', { name: 'All of these' })).toBeChecked();
        expect(screen.getByText(/meets all of these/)).toBeVisible();
      });

      it('says any in its description and puts an or between the cards once any is chosen', async () => {
        const { user } = showBoard({
          panels: [aFilter('due', 'Due soon', [DUE_TODAY, PRIORITY_HIGH])],
        });

        await choose(user, 'Due soon', 'Filter…');
        expect(screen.queryByText('or', { selector: 'li' })).toBeNull();
        await user.click(await screen.findByRole('radio', { name: 'Any of these' }));

        expect(screen.getByText(/meets any of these/)).toBeVisible();
        expect(screen.getAllByText('or', { selector: 'li' })).toHaveLength(1);
      });

      it('sends the choice with the rows, and keeps it when the rows are taken down to one', async () => {
        const { mutate, user } = showBoard({
          panels: [aFilter('due', 'Due soon', [DUE_TODAY, PRIORITY_HIGH])],
        });

        await choose(user, 'Due soon', 'Filter…');
        await user.click(await screen.findByRole('radio', { name: 'Any of these' }));
        await user.click(screen.getByRole('button', { name: 'Remove condition 2' }));
        // One row left: the switch is gone and the question reads as it always did.
        expect(screen.queryByRole('radiogroup', { name: ALL_OR_ANY })).toBeNull();
        expect(screen.getByText(/meets all of these/)).toBeVisible();
        await user.click(screen.getByRole('button', { name: 'Save' }));

        expect(mutate).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'set_panel_filter',
            payload: expect.objectContaining({ conditions: [DUE_TODAY], match: 'any' }),
          }),
          expect.anything(),
        );
      });

      it('sends all where it was never changed', async () => {
        const { mutate, user } = showBoard({ panels: [aFilter('due', 'Due soon')] });

        await choose(user, 'Due soon', 'Filter…');
        await addCondition(user, 'Due date');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        expect(mutate).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({ match: 'all' }),
          }),
          expect.anything(),
        );
      });

      it('opens on any for a filter that is set to it', async () => {
        const { user } = showBoard({
          panels: [aFilter('due', 'Due soon', [DUE_TODAY, PRIORITY_HIGH], 'any')],
        });

        await choose(user, 'Due soon', 'Filter…');

        expect(await screen.findByRole('radio', { name: 'Any of these' })).toBeChecked();
      });

      it('saves nothing where it is cancelled', async () => {
        const { mutate, user } = showBoard({
          panels: [aFilter('due', 'Due soon', [DUE_TODAY, PRIORITY_HIGH])],
        });

        await choose(user, 'Due soon', 'Filter…');
        await user.click(await screen.findByRole('radio', { name: 'Any of these' }));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(mutate).not.toHaveBeenCalled();
      });

      it('reads what it shows as any of them, beside its name', async () => {
        showBoard({ panels: [aFilter('due', 'Due soon', [DUE_TODAY, PRIORITY_HIGH], 'any')] });

        const due = await screen.findByRole('region', { name: 'Due soon' });
        expect(
          within(due).getByRole('img', {
            name: 'Shows any of: due today or overdue; priority is high',
          }),
        ).toBeVisible();
      });

      it('draws an item meeting one condition, where all of them would draw nothing', async () => {
        const bart = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
        showBoard({
          panels: [aFilter('due', 'Due soon', [DUE_TODAY, PRIORITY_HIGH], 'any')],
          items: [{ ...bart, dueDate: TODAY, priority: 'low' }],
          filings: [{ panelId: 'falcon', itemId: bart.id, position: 0 }],
        });

        const due = await screen.findByRole('region', { name: 'Due soon' });
        expect(within(due).getByText(/Reply to Bart/)).toBeVisible();
      });
    });

    it('is not asked what a panel of items or a panel of text shows', async () => {
      const { user } = showBoard({
        panels: [aPanel('falcon', 'Project Falcon'), aPanelOfText('words', 'What matters')],
      });

      for (const panel of ['Project Falcon', 'What matters']) {
        openMenu(panel);
        expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
        expect(screen.queryByRole('menuitem', { name: 'Filter…' })).toBeNull();
        await user.keyboard('{Escape}');
      }
    });

    it('takes no row dropped on it, so its rows cannot be put in an order', async () => {
      // The third way an item reaches a panel, after the picker and a direct
      // request - and the one a Filter has a list for, which is why it needs a
      // case of its own where a panel of text's is the absence of a list.
      //
      // Two rows, and the second one dragged: dropped at the top, that is a
      // reorder on any other panel, which is exactly what a gathered list must
      // not accept.
      const bart = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
      const domain = anItem('11111111-1111-7111-8111-000000000002', 'Renew the domain');
      const { mutate } = showBoard({
        panels: [aFilter('due', 'Due soon', [DUE_TODAY])],
        items: [
          { ...bart, dueDate: TODAY },
          { ...domain, dueDate: TODAY },
        ],
        filings: [
          { panelId: 'falcon', itemId: bart.id, position: 0 },
          { panelId: 'falcon', itemId: domain.id, position: 1 },
        ],
      });
      const due = await screen.findByRole('region', { name: 'Due soon' });
      // On the list rather than on the panel, because that is where the target
      // is: an event fired on the section never reaches a handler inside it.
      const rows = within(due).getByRole('list');

      const carrying = { types: [ITEM_BEING_DRAGGED], getData: () => domain.id, setData: vi.fn() };
      fireEvent.dragOver(rows, { dataTransfer: carrying });
      fireEvent.drop(rows, { dataTransfer: carrying });

      expect(mutate).not.toHaveBeenCalled();
    });

    it('gathers nothing from a filing onto a filter on another dashboard', async () => {
      // A board is handed this dashboard's panels to draw and the workspace's
      // to answer filings with, because whether a filing files is a fact about
      // the Panel it names: a Filter on the next dashboard along still gathers
      // rather than holds. Without the second list this row would be drawn
      // here while the Inbox - which always reads workspace-wide - went on
      // holding it, the same Item in two places at once.
      const bart = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
      const here = aFilter('due', 'Due soon', [DUE_TODAY]);
      const elsewhere = { ...aFilter('over-there', 'Due elsewhere'), dashboardId: 'research' };
      showBoard({
        panels: [here],
        panelsInWorkspace: [here, elsewhere],
        items: [{ ...bart, dueDate: TODAY }],
        filings: [{ panelId: elsewhere.id, itemId: bart.id, position: 0 }],
      });

      const due = await screen.findByRole('region', { name: 'Due soon' });
      expect(within(due).queryByText(/Reply to Bart/)).toBeNull();
      expect(within(due).getByText(NOTHING_MATCHES_YET)).toBeVisible();
    });

    it('offers a row the usual menu without taking it off a panel it was never filed on', async () => {
      const bart = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
      const { user } = showBoard({
        panels: [aFilter('due', 'Due soon', [DUE_TODAY])],
        items: [{ ...bart, dueDate: TODAY }],
        filings: [{ panelId: 'falcon', itemId: bart.id, position: 0 }],
      });
      const due = await screen.findByRole('region', { name: 'Due soon' });

      await user.click(within(due).getByRole('button', { name: 'Item actions' }));

      expect(await screen.findByRole('menuitem', { name: 'Move to…' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Also show on…' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Remove from this panel' })).toBeNull();
    });

    /**
     * What a Priority, a Type or a Panel condition sends, and what its
     * checkboxes offer, is worked out here; that any of them actually gathers
     * or excludes an item is settled against items and filings alone in
     * tests/unit/filters.test.ts.
     */
    it('sends a Priority condition’s chosen levels', async () => {
      const { mutate, user } = showBoard({ panels: [aFilter('due', 'Due soon')] });

      await choose(user, 'Due soon', 'Filter…');
      await addCondition(user, 'Priority');
      await user.click(screen.getByRole('checkbox', { name: 'High' }));
      await user.click(screen.getByRole('checkbox', { name: 'Normal' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_panel_filter',
          payload: expect.objectContaining({
            panelId: 'due',
            conditions: [{ field: 'priority', values: ['high', 'normal'] }],
          }),
        }),
        expect.anything(),
      );
    });

    it('sends a Type condition’s chosen Type, offered from the account’s live Types', async () => {
      const okr = aType('type-okr', 'OKR');
      const { mutate, user } = showBoard({
        panels: [aFilter('due', 'Due soon')],
        itemTypes: [okr],
      });

      await choose(user, 'Due soon', 'Filter…');
      await addCondition(user, 'Type');
      await user.click(screen.getByRole('checkbox', { name: 'OKR' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_panel_filter',
          payload: expect.objectContaining({
            panelId: 'due',
            conditions: [{ field: 'type', values: ['type-okr'] }],
          }),
        }),
        expect.anything(),
      );
    });

    it('sends a Panel condition’s chosen panels, offered only from the workspace’s items panels', async () => {
      const project = aPanel('project', 'Project Falcon');
      const notes = aPanelOfText('notes', 'Notes');
      const due = aFilter('due', 'Due soon');
      const { mutate, user } = showBoard({
        panels: [due],
        panelsInWorkspace: [due, project, notes],
      });

      await choose(user, 'Due soon', 'Filter…');
      await addCondition(user, 'Panel');
      // Never a Filter - not itself, and not any other - and never a panel of
      // text: nothing is ever filed onto either ("Filter a Filter panel by
      // panel, and name the Filters a panel's deletion affects", issue 465).
      expect(screen.queryByRole('checkbox', { name: 'Due soon' })).toBeNull();
      expect(screen.queryByRole('checkbox', { name: 'Notes' })).toBeNull();
      await user.click(screen.getByRole('checkbox', { name: 'Project Falcon' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_panel_filter',
          payload: expect.objectContaining({
            panelId: 'due',
            conditions: [{ field: 'panel', values: ['project'] }],
          }),
        }),
        expect.anything(),
      );
    });

    it('does not offer a field already on the filter, from its own add menu', async () => {
      const { user } = showBoard({ panels: [aFilter('due', 'Due soon', [DUE_TODAY])] });

      await choose(user, 'Due soon', 'Filter…');
      await user.click(await screen.findByRole('button', { name: '+ Add a condition' }));

      expect(screen.queryByRole('menuitem', { name: 'Due date' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Priority' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Type' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Panel' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Status' })).toBeVisible();
    });

    it('stops offering to add once every field is already on the filter', async () => {
      const { user } = showBoard({
        panels: [
          aFilter('due', 'Due soon', [
            DUE_TODAY,
            { field: 'priority', values: ['high'] },
            { field: 'type', values: [] },
            { field: 'panel', values: [] },
            { field: 'status' },
          ]),
        ],
      });

      await choose(user, 'Due soon', 'Filter…');
      // The question is fetched only once opened (`FilterQuestion.tsx`, the
      // lazy boundary the performance budget draws around it) - waited for
      // here through a row it is certain to draw, so the assertion below
      // reads an add menu that is truly absent rather than a question still
      // in flight.
      await screen.findByRole('button', { name: 'Remove condition 1' });

      expect(screen.queryByRole('button', { name: '+ Add a condition' })).toBeNull();
    });

    it('reads a Priority and a Type condition back on hover, beside what a Due date already reads', async () => {
      const okr = aType('type-okr', 'OKR');
      const task = aType('type-task', 'Task');
      showBoard({
        panels: [
          aFilter('due', 'Due soon', [
            { field: 'priority', values: ['high'] },
            { field: 'type', values: [okr.id, task.id] },
          ]),
        ],
        itemTypes: [okr, task],
      });

      const due = await screen.findByRole('region', { name: 'Due soon' });
      expect(
        within(due).getByRole('img', { name: 'Shows priority is high and type is okr or task' }),
      ).toBeVisible();
    });
  });
});

/** Puts a Dashboard filter on the Dashboard these cases draw, where the board reads it from. */
function filterTheDashboard(fields: Partial<DashboardFilter>) {
  writeDashboardFilter(localStorage, DASHBOARD.id, { ...NO_DASHBOARD_FILTER, ...fields });
}

/** What a panel lists, as the text of its rows. */
function rowsOf(panelName: string) {
  const region = screen.getByRole('region', { name: panelName });
  return within(region)
    .queryAllByRole('listitem')
    .map((row) => row.textContent ?? '');
}

describe('Dashboards', () => {
  const ID = (n: number) => `11111111-1111-7111-8111-00000000000${n}`;
  const vatHigh = { ...anItem(ID(1), 'VAT return'), priority: 'high' as const };
  const vatLow = { ...anItem(ID(2), 'VAT refund'), priority: 'low' as const };
  const rentHigh = { ...anItem(ID(3), 'Pay the rent'), priority: 'high' as const };
  const FILED = [
    { panelId: 'falcon', itemId: ID(1), position: 0 },
    { panelId: 'falcon', itemId: ID(2), position: 1 },
    { panelId: 'falcon', itemId: ID(3), position: 2 },
  ];

  const ITEMS = [vatHigh, vatLow, rentHigh];
  /** A panel of items, a Filter panel, a panel of text and a panel nothing is filed on. */
  const ALL_PANELS = [
    aPanel('falcon', 'Project Falcon'),
    aFilter('highs', 'The highs', [PRIORITY_HIGH]),
    aPanelOfText('notes', 'Notes', { body: 'Remember the VAT deadline' }),
    aPanel('reading', 'To read'),
  ];

  function aFilteredBoard(more: Parameters<typeof showBoard>[0] = {}) {
    return showBoard({
      panels: ALL_PANELS,
      items: ITEMS,
      filings: FILED,
      ...more,
    });
  }

  describe('a Dashboard filter shows, on every panel of items and Filter panel, only the Items meeting its conditions', () => {
    it('narrows a panel of items, a Filter panel and each header count', async () => {
      filterTheDashboard({ text: 'vat' });
      aFilteredBoard();

      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(rowsOf('Project Falcon')).toEqual([
        expect.stringContaining('VAT return'),
        expect.stringContaining('VAT refund'),
      ]);
      // A Filter panel shows the intersection of its own conditions and the Dashboard's.
      expect(rowsOf('The highs')).toEqual([expect.stringContaining('VAT return')]);
      expect(within(handleOf('Project Falcon')).getByText('2')).toBeVisible();
      expect(within(handleOf('The highs')).getByText('1')).toBeVisible();
    });

    it.each([
      { situation: 'a panel of items with nothing matching', hidden: 'Elsewhere' },
      { situation: 'a panel of items that held nothing before the filter', hidden: 'To read' },
      { situation: 'a panel of text, though its words match', hidden: 'Notes' },
    ])('does not draw $situation', async ({ hidden }) => {
      filterTheDashboard({ text: 'vat' });
      aFilteredBoard({
        panels: [...ALL_PANELS, aPanel('elsewhere', 'Elsewhere')],
        items: [...ITEMS, anItem(ID(4), 'Water bill')],
        filings: [...FILED, { panelId: 'elsewhere', itemId: ID(4), position: 0 }],
      });

      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(screen.queryByRole('region', { name: hidden })).toBeNull();
    });

    it('draws a Filter panel only where its own conditions and the Dashboard filter have Items in common', async () => {
      filterTheDashboard({ priorities: ['low'] });
      aFilteredBoard({ panels: [aPanel('falcon', 'Project Falcon'), aFilter('highs', 'The highs', [PRIORITY_HIGH])] });

      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(screen.queryByRole('region', { name: 'The highs' })).toBeNull();
    });

    it('draws every panel exactly as unfiltered where no condition is set, with no count', async () => {
      aFilteredBoard();

      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(rowsOf('Project Falcon')).toHaveLength(3);
      expect(rowsOf('The highs')).toHaveLength(2);
      expect(screen.getByRole('region', { name: 'Notes' })).toBeVisible();
      expect(screen.getByRole('region', { name: 'To read' })).toBeVisible();
      expect(screen.queryByText(/hidden/)).toBeNull();
    });

    it('reads attachments off the Items, and shows Items that hold one', async () => {
      filterTheDashboard({ attachments: 'with' });
      aFilteredBoard({ attachments: [{ itemId: ID(3) } as Attachment] });

      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(rowsOf('Project Falcon')).toEqual([expect.stringContaining('Pay the rent')]);
    });
  });

  describe('Agent running shows only the Items with an open run', () => {
    const runOn = (n: number, status: AgentRun['status'] = 'working') => ({ itemId: ID(n), status }) as AgentRun;

    it('narrows a panel of items and a Filter panel, meeting its own conditions too, to Items with a run', async () => {
      filterTheDashboard({ agentRunning: true });
      aFilteredBoard({ agentRuns: [runOn(2), runOn(3, 'failed')] });

      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(rowsOf('Project Falcon')).toEqual([
        expect.stringContaining('VAT refund'),
        expect.stringContaining('Pay the rent'),
      ]);
      // The highs are 1 and 3; only 3 has a run.
      expect(rowsOf('The highs')).toEqual([expect.stringContaining('Pay the rent')]);
      expect(within(handleOf('Project Falcon')).getByText('2')).toBeVisible();
      expect(within(handleOf('The highs')).getByText('1')).toBeVisible();
    });

    it('draws no panel where nothing has a run', async () => {
      filterTheDashboard({ agentRunning: true });
      aFilteredBoard();

      expect(await screen.findByText('No panel has an item matching the filter.')).toBeVisible();
      expect(screen.queryAllByRole('region')).toEqual([]);
    });

    it('follows a run as it starts and finishes', async () => {
      filterTheDashboard({ agentRunning: true });
      const { redrawnWithRuns } = aFilteredBoard({ agentRuns: [runOn(1)] });
      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(rowsOf('Project Falcon')).toEqual([expect.stringContaining('VAT return')]);

      redrawnWithRuns([runOn(1), runOn(2, 'starting')]);
      expect(rowsOf('Project Falcon')).toHaveLength(2);

      redrawnWithRuns([]);
      expect(screen.queryByRole('region', { name: 'Project Falcon' })).toBeNull();
    });
  });

  describe('what is drawn follows the Items as they change', () => {
    it('drops an Item that stops matching and shows one that starts to', async () => {
      filterTheDashboard({ text: 'vat' });
      const { redrawnWithItems } = aFilteredBoard();
      await screen.findByRole('region', { name: 'Project Falcon' });

      redrawnWithItems([{ ...vatHigh, title: 'Tax return' }, vatLow, { ...rentHigh, title: 'VAT rent' }]);

      expect(rowsOf('Project Falcon')).toEqual([
        expect.stringContaining('VAT refund'),
        expect.stringContaining('VAT rent'),
      ]);
    });

    it('shows an Item that comes to hold an attachment, and the panel it is on with it', async () => {
      filterTheDashboard({ attachments: 'with' });
      const { redrawnWithItems } = aFilteredBoard();
      await screen.findByText('No panel has an item matching the filter.');

      redrawnWithItems([vatHigh, vatLow, rentHigh], [{ itemId: ID(2) } as Attachment]);

      expect(rowsOf('Project Falcon')).toEqual([expect.stringContaining('VAT refund')]);
    });

    it('takes a panel away when its only matching Item stops matching, and counts it', async () => {
      filterTheDashboard({ text: 'refund' });
      const { redrawnWithItems } = aFilteredBoard();
      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(screen.getByText('3 panels hidden')).toBeVisible();

      redrawnWithItems([vatHigh, { ...vatLow, title: 'VAT rebate' }, rentHigh]);

      expect(screen.queryByRole('region', { name: 'Project Falcon' })).toBeNull();
      expect(screen.getByText('No panel has an item matching the filter.')).toBeVisible();
    });

    it('brings a panel back when an Item on it comes to match, and the count goes down', async () => {
      filterTheDashboard({ text: 'rebate' });
      const { redrawnWithItems } = aFilteredBoard();
      await screen.findByText('No panel has an item matching the filter.');
      expect(screen.getByText('4 panels hidden')).toBeVisible();

      redrawnWithItems([vatHigh, { ...vatLow, title: 'VAT rebate' }, rentHigh]);

      expect(rowsOf('Project Falcon')).toEqual([expect.stringContaining('VAT rebate')]);
      expect(screen.getByText('3 panels hidden')).toBeVisible();
    });
  });

  describe('the bar says how many panels the filter hid', () => {
    it('says nothing where no panel is hidden', async () => {
      filterTheDashboard({ text: 'vat' });
      aFilteredBoard({ panels: [aPanel('falcon', 'Project Falcon')] });

      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(screen.queryByText(/hidden/)).toBeNull();
    });

    it.each([
      { situation: 'one panel', panels: [aPanel('falcon', 'Project Falcon'), aPanel('reading', 'To read')], said: '1 panel hidden' },
      { situation: 'a panel of items and a panel of text', panels: ALL_PANELS.filter((p) => p.id !== 'highs'), said: '2 panels hidden' },
    ])('says $said where the filter hid $situation', async ({ panels, said }) => {
      filterTheDashboard({ text: 'vat' });
      aFilteredBoard({ panels });

      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(screen.getByText(said)).toBeVisible();
    });

    it('says so on the board, with the count, where the filter hid every panel', async () => {
      filterTheDashboard({ text: 'zzz' });
      aFilteredBoard();

      expect(await screen.findByText('No panel has an item matching the filter.')).toBeVisible();
      expect(screen.getByText('4 panels hidden')).toBeVisible();
    });

    it('keeps the invitation, and says no count, on a dashboard with no panels', async () => {
      filterTheDashboard({ text: 'vat' });
      showBoard({ panels: [] });

      expect(await screen.findByText(/This one has none yet/)).toBeVisible();
      expect(screen.queryByText(/hidden/)).toBeNull();
      expect(screen.queryByText('No panel has an item matching the filter.')).toBeNull();
    });
  });

  describe('the panels left in a row share it in their proportions', () => {
    const SHARES_3_3_6: Layout = {
      ...aLayout('wide', []),
      rows: [
        {
          height: null,
          cells: [
            { panelId: 'falcon', span: 3 },
            { panelId: 'reading', span: 3 },
            { panelId: 'highs', span: 6 },
          ],
        },
        { height: null, cells: [{ panelId: 'notes', span: 12 }] },
      ],
    };

    it('draws 1 : 2 where the first of 3 : 3 : 6 is hidden, and no row for panels all hidden', async () => {
      filterTheDashboard({ priorities: ['high'] });
      showBoard({
        panels: [
          aPanel('falcon', 'Project Falcon'),
          aPanel('reading', 'To read'),
          aFilter('highs', 'The highs', [PRIORITY_HIGH]),
          aPanelOfText('notes', 'Notes'),
        ],
        layouts: [SHARES_3_3_6],
        items: [vatHigh, rentHigh, vatLow],
        filings: [
          { panelId: 'falcon', itemId: ID(2), position: 0 },
          { panelId: 'reading', itemId: ID(1), position: 0 },
        ],
      });

      await screen.findByRole('region', { name: 'To read' });
      expect(screen.queryByRole('region', { name: 'Project Falcon' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Notes' })).toBeNull();
      const rows = [...document.querySelectorAll<HTMLElement>('[data-panel-row]')];
      expect(rows).toHaveLength(1);
      const shares = [...rows[0]!.style.gridTemplateColumns.matchAll(/minmax\(0, ([\d.]+)fr\)/g)].map((m) =>
        Number(m[1]),
      );
      expect(shares).toHaveLength(2);
      expect(shares[1]! / shares[0]!).toBeCloseTo(2);
    });

    it('keeps a panel mounted when the row above it is hidden', async () => {
      filterTheDashboard({ text: 'vat' });
      const { redrawnWithItems } = showBoard({
        panels: [aPanel('reading', 'To read'), aPanel('falcon', 'Project Falcon')],
        layouts: [
          {
            ...aLayout('wide', []),
            rows: [
              { height: null, cells: [{ panelId: 'reading', span: 12 }] },
              { height: null, cells: [{ panelId: 'falcon', span: 12 }] },
            ],
          },
        ],
        items: [vatHigh, vatLow],
        filings: [
          { panelId: 'reading', itemId: ID(1), position: 0 },
          { panelId: 'falcon', itemId: ID(2), position: 0 },
        ],
      });
      const falcon = await screen.findByRole('region', { name: 'Project Falcon' });

      redrawnWithItems([{ ...vatHigh, title: 'Tax return' }, vatLow]);

      expect(screen.queryByRole('region', { name: 'To read' })).toBeNull();
      // The same element, not a new one: a remount would drop what was typed into it.
      expect(screen.getByRole('region', { name: 'Project Falcon' })).toBe(falcon);
    });
  });

  describe('while filtered, nothing about the arrangement can change', () => {
    const SIDE_BY_SIDE = [aLayout('wide', ['falcon', 'reading'])];
    const TWO = [aPanel('falcon', 'Project Falcon'), aPanel('reading', 'To read')];
    const BOTH_MATCHING = {
      items: [vatHigh, vatLow],
      filings: [
        { panelId: 'falcon', itemId: ID(1), position: 0 },
        { panelId: 'reading', itemId: ID(2), position: 0 },
      ],
    };

    it('offers a line between two panels where the board is not filtered', async () => {
      showBoard({ panels: TWO, layouts: SIDE_BY_SIDE });
      await screen.findByRole('region', { name: 'Project Falcon' });
      expect(screen.getAllByTestId('column-line')).toHaveLength(1);
    });

    it('offers no line between two panels, and a header drag sends nothing', async () => {
      filterTheDashboard({ text: 'vat' });
      const { mutate } = showBoard({ panels: TWO, layouts: SIDE_BY_SIDE, ...BOTH_MATCHING });
      await screen.findByRole('region', { name: 'Project Falcon' });

      expect(screen.queryAllByTestId('column-line')).toHaveLength(0);
      dragTo('Project Falcon', { x: 500, y: 150 });

      expect(mutate).not.toHaveBeenCalled();
    });

    it('says to clear the dashboard filter where a panel is moved to another dashboard', async () => {
      filterTheDashboard({ text: 'vat' });
      showBoard({ dashboards: [DASHBOARD, RESEARCH], items: [vatHigh], filings: [{ panelId: 'falcon', itemId: ID(1), position: 0 }] });
      await screen.findByRole('region', { name: 'Project Falcon' });

      openMenu('Project Falcon');

      expect(
        await screen.findByRole('menuitem', {
          name: 'Move to another dashboard: Clear the dashboard filter to move a panel',
        }),
      ).toHaveAttribute('aria-disabled', 'true');
    });
  });
});

describe('Panels', () => {
  describe('while a panel is in the air every panel is its header alone and every row a header tall', () => {
    const BART = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
    const TALL = {
      ...aLayout('laptop', ['falcon']),
      rows: [
        { height: 600, cells: [{ panelId: 'falcon', span: 6 }, { panelId: 'notes', span: 6 }] },
        { height: null, cells: [{ panelId: 'due', span: 6 }, { panelId: 'reading', span: 6 }] },
      ],
    };
    const board = (extra: Parameters<typeof showBoard>[0] = {}) =>
      showBoard({
        panels: [
          aPanel('falcon', 'Project Falcon'),
          aPanelOfText('notes', 'Notes', { body: 'Some prose' }),
          aFilter('due', 'Due today', [DUE_TODAY]),
          aPanel('reading', 'To read'),
        ],
        layouts: [TALL],
        items: [BART],
        filings: [{ panelId: 'falcon', itemId: BART.id, position: 0 }],
        ...extra,
      });
    const regions = () => screen.getAllByRole('region');
    const rowStyles = () =>
      [...document.querySelectorAll<HTMLElement>('[data-panel-row]')].map((row) => row.style);
    const pickUp = (name: string) =>
      fireEvent.pointerDown(handleOf(name), { button: 0, pointerId: 1, pointerType: 'mouse' });

    it('draws each kind of panel as its header alone, the one in hand too, and the rows as tall as a header', () => {
      board();
      expect(within(screen.getByRole('region', { name: 'Project Falcon' })).getAllByRole('listitem')).toHaveLength(1);
      expect(rowStyles()[0]!.height).toBe('600px');

      pickUp('To read');

      for (const region of regions()) {
        expect(within(region).queryAllByRole('listitem')).toHaveLength(0);
        notShown(within(region).queryByText(/Add an item/));
        notShown(within(region).queryByText(NOTHING_FILED_HERE));
        notShown(within(region).queryByText('Some prose'));
        expect(within(region).queryByRole('textbox')).toBeNull();
        expect(within(region).getByRole('heading', { level: 3 })).toBeVisible();
      }
      expect(screen.getByRole('region', { name: 'To read' }).className).toContain('opacity-40');
      for (const style of rowStyles()) {
        expect(style.height).toBe('');
        expect(style.minHeight).toBe('');
      }
    });

    // Hidden rather than unmounted: absent from the page, still held by it.
    const notShown = (element: HTMLElement | null) => {
      if (element) expect(element).not.toBeVisible();
    };

    it('keeps a half-typed item on a panel through a drag, hidden while it is in the air', () => {
      board();
      fireEvent.click(within(screen.getByRole('region', { name: 'Project Falcon' })).getByRole('button', { name: '+ Add an item' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Capture a note or to-do' }), { target: { value: 'Call Bart' } });

      pickUp('To read');
      expect(screen.queryByRole('textbox', { name: 'Capture a note or to-do' })).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });

      expect(screen.getByRole('textbox', { name: 'Capture a note or to-do' })).toHaveValue('Call Bart');
    });

    it.each([
      { situation: 'dropped on the board', end: () => fireEvent.pointerUp(window, { pointerId: 1 }) },
      { situation: 'abandoned with Escape', end: () => fireEvent.keyDown(window, { key: 'Escape' }) },
      { situation: 'taken back by the browser', end: () => fireEvent.pointerCancel(window, { pointerId: 1 }) },
    ])('opens everything again when it is $situation', ({ end }) => {
      board();
      pickUp('To read');
      expect(within(screen.getByRole('region', { name: 'Project Falcon' })).queryAllByRole('listitem')).toHaveLength(0);

      end();

      expect(within(screen.getByRole('region', { name: 'Project Falcon' })).getAllByRole('listitem')).toHaveLength(1);
      expect(within(screen.getByRole('region', { name: 'Notes' })).getByText('Some prose')).toBeVisible();
      expect(rowStyles()[0]!.height).toBe('600px');
      expect(rowStyles()[1]!.minHeight).toBe(`${MIN_ROW_HEIGHT}px`);
    });

    it('opens the board it left when the panel is dropped on another dashboard’s tab', () => {
      board({ dashboards: [DASHBOARD, RESEARCH] });
      aTabElement(RESEARCH.id, { left: 0, right: 100, top: 0, bottom: 30 });
      pickUp('To read');
      layOut();

      fireEvent.pointerUp(window, { pointerId: 1, clientX: 50, clientY: 15 });

      expect(within(screen.getByRole('region', { name: 'Project Falcon' })).getAllByRole('listitem')).toHaveLength(1);
      expect(rowStyles()[0]!.height).toBe('600px');
    });

    it('opens without a fuss when the panel in hand was deleted in another tab', () => {
      const { redrawnWith } = board();
      pickUp('To read');
      redrawnWith([aPanel('falcon', 'Project Falcon')]);

      expect(() => fireEvent.keyDown(window, { key: 'Escape' })).not.toThrow();

      expect(within(screen.getByRole('region', { name: 'Project Falcon' })).getAllByRole('listitem')).toHaveLength(1);
    });

    it.each([
      { situation: 'the line under a row', take: () => dragRowLine(0, 100, false) },
      { situation: 'the line between two panels', take: () => dragColumnLine(0, ONE_COLUMN) },
    ])('collapses nothing while $situation is taken and moved', ({ take }) => {
      board();
      // A column drag ends on its own pointer-up; the row line is left in hand.
      take();

      for (const name of ['Project Falcon', 'Notes', 'To read']) {
        expect(screen.getByRole('region', { name })).toBeVisible();
      }
      expect(within(screen.getByRole('region', { name: 'Project Falcon' })).getAllByRole('listitem')).toHaveLength(1);
      expect(within(screen.getByRole('region', { name: 'Notes' })).getByText('Some prose')).toBeVisible();
    });
  });
});

describe('Panels', () => {
  describe('a whole row is moved by a grip at its left edge', () => {
    const THREE_ROWS: Layout = {
      ...aLayout('laptop', ['falcon']),
      rows: [
        { height: 300, cells: [{ panelId: 'falcon', span: 12 }] },
        { height: null, cells: [{ panelId: 'notes', span: 4 }, { panelId: 'due', span: 8 }] },
        { height: 150, cells: [{ panelId: 'reading', span: 12 }] },
      ],
    };
    const board = (extra: Parameters<typeof showBoard>[0] = {}) =>
      showBoard({
        panels: [
          aPanel('falcon', 'Project Falcon'),
          aPanel('notes', 'Notes'),
          aPanel('due', 'Due'),
          aPanel('reading', 'To read'),
        ],
        layouts: [THREE_ROWS],
        ...extra,
      });
    const grips = () => screen.queryAllByTestId('row-grip');
    /** Takes the grip of row `at` the way a mouse does, then measures the collapsed board. */
    const take = (at: number) => {
      fireEvent.pointerDown(grips()[at]!, { button: 0, pointerId: 1, pointerType: 'mouse' });
      layOut();
    };
    /** The middles of the rows `layOut` draws: 50, 172 and 294. */
    const ROW_MIDDLE = [50, 172, 294];
    const moveTo = (y: number) =>
      fireEvent.pointerMove(boardEl(), { pointerId: 1, clientX: 300, clientY: y });

    it('is offered on every row, and picks the row up as a Panel is picked up', () => {
      board();
      expect(grips()).toHaveLength(3);

      take(2);

      expect(screen.getByRole('region', { name: 'To read' }).className).toContain('opacity-40');
      expect(screen.getByRole('region', { name: 'Project Falcon' }).className).not.toContain('opacity-40');
    });

    it('collapses every Panel to its header and every row to a header tall', () => {
      board();
      expect(document.querySelector<HTMLElement>('[data-panel-row]')!.style.height).toBe('300px');

      take(0);

      for (const row of document.querySelectorAll<HTMLElement>('[data-panel-row]')) {
        expect(row.style.height).toBe('');
        expect(row.style.minHeight).toBe('');
      }
      for (const name of ['Project Falcon', 'Notes', 'Due', 'To read']) {
        const region = screen.getByRole('region', { name });
        expect(within(region).queryByText(/Add an item/)).not.toBeVisible();
      }
    });

    it('draws every Panel of the lifted row as lifted, and the others as they are', () => {
      board();

      take(1);

      expect(screen.getByRole('region', { name: 'Notes' }).className).toContain('opacity-40');
      expect(screen.getByRole('region', { name: 'Due' }).className).toContain('opacity-40');
      expect(screen.getByRole('region', { name: 'Project Falcon' }).className).not.toContain('opacity-40');
    });

    it('moves the row between the others as the pointer passes their middles, keeping its Panels together', () => {
      board();
      take(0);

      moveTo(ROW_MIDDLE[1]! - 10);
      expect(drawnLines()).toEqual([['falcon'], ['notes', 'due'], ['reading']]);

      moveTo(ROW_MIDDLE[1]! + 10);
      expect(drawnLines()).toEqual([['notes', 'due'], ['falcon'], ['reading']]);

      moveTo(ROW_MIDDLE[2]! + 10);
      expect(drawnLines()).toEqual([['notes', 'due'], ['reading'], ['falcon']]);
    });

    it('sends one save naming the new order, heights and shares travelling with their rows', () => {
      const { mutate } = board({ settles: false });
      take(0);
      moveTo(ROW_MIDDLE[1]! + 10);

      fireEvent.pointerUp(boardEl(), { pointerId: 1, clientX: 300, clientY: ROW_MIDDLE[1]! + 10 });

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(sentRows(mutate)).toEqual([['notes', 'due'], ['falcon'], ['reading']]);
      expect(sentHeights(mutate)).toEqual([null, 300, 150]);
      expect(sentSpans(mutate)).toEqual([[4, 8], [12], [12]]);
    });

    it('sends one save, not two, for a release inside the board that reaches the window as well', () => {
      const { mutate } = board({ settles: false });
      take(2);
      moveTo(10);

      fireEvent.pointerUp(boardEl(), { pointerId: 1, clientX: 300, clientY: 10 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 10 });

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(sentRows(mutate)).toEqual([['reading'], ['falcon'], ['notes', 'due']]);
    });

    it('sends nothing for a row dropped where it started', () => {
      const { mutate } = board();
      take(1);
      moveTo(ROW_MIDDLE[2]! + 10);
      moveTo(ROW_MIDDLE[1]!);

      fireEvent.pointerUp(boardEl(), { pointerId: 1, clientX: 300, clientY: ROW_MIDDLE[1]! });

      expect(mutate).not.toHaveBeenCalled();
    });

    it.each([
      { situation: 'Escape', end: () => fireEvent.keyDown(window, { key: 'Escape' }) },
      { situation: 'the pointer cancelled', end: () => fireEvent.pointerCancel(window, { pointerId: 1 }) },
    ])('sends nothing and puts the rows back on $situation', ({ end }) => {
      const { mutate } = board();
      take(0);
      moveTo(ROW_MIDDLE[2]! + 10);
      expect(drawnLines()[2]).toEqual(['falcon']);

      end();

      expect(drawnLines()).toEqual([['falcon'], ['notes', 'due'], ['reading']]);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('is not dropped on a dashboard tab, which only a Panel can be', () => {
      const { mutate } = board({ dashboards: [DASHBOARD, RESEARCH] });
      aTabElement(RESEARCH.id, { left: 0, right: 100, top: -40, bottom: -10 });
      take(0);

      fireEvent.pointerUp(window, { pointerId: 1, clientX: 50, clientY: -20 });

      expect(mutate.mock.calls.some(([asked]) => asked.name === 'move_panel_to_dashboard')).toBe(false);
    });

    it('offers no grip at phone width', () => {
      screenIs(375);
      board();

      expect(grips()).toHaveLength(0);
    });

    it('offers no grip on a filtered dashboard', () => {
      filterTheDashboard({ text: 'bart' });
      board();

      expect(grips()).toHaveLength(0);
    });

    it('offers no grip while a Panel is in the air, and gives it back once it lands', () => {
      board();

      fireEvent.pointerDown(handleOf('To read'), { button: 0, pointerId: 1, pointerType: 'mouse' });
      expect(grips()).toHaveLength(0);

      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(grips()).toHaveLength(3);
    });

    it('offers no grip while an Item is dragged to be filed, so no drop lands on it', () => {
      board();

      fireEvent.dragStart(window);
      expect(grips()).toHaveLength(0);

      fireEvent.dragEnd(window);
      expect(grips()).toHaveLength(3);
    });

    it.each([
      { situation: 'a touch', press: { button: 0, pointerType: 'touch' } },
      { situation: 'a right-click', press: { button: 2, pointerType: 'mouse' } },
    ])('picks nothing up on $situation', ({ press }) => {
      board();

      fireEvent.pointerDown(grips()[0]!, { pointerId: 1, ...press });

      expect(screen.getByRole('region', { name: 'Project Falcon' }).className).not.toContain('opacity-40');
      expect(grips()).toHaveLength(3);
    });
  });
});

describe('Panels', () => {
  describe('on a phone every panel collapses to its header on a double-tap, and a tap opens them again', () => {
    const BART = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
    const board = (extra: Parameters<typeof showBoard>[0] = {}) =>
      showBoard({
        panels: [aPanel('falcon', 'Project Falcon'), aPanel('reading', 'To read')],
        items: [BART],
        filings: [{ panelId: 'falcon', itemId: BART.id, position: 0 }],
        ...extra,
      });
    /** A press and release on a header, `at` milliseconds on the page's own clock. */
    const tap = (target: Element, at: number, { pressFor = 40 } = {}) => {
      const down = createEvent.pointerDown(target, { button: 0, pointerId: 1, pointerType: 'touch' });
      Object.defineProperty(down, 'timeStamp', { value: at });
      fireEvent(target, down);
      const up = createEvent.pointerUp(target, { button: 0, pointerId: 1, pointerType: 'touch' });
      Object.defineProperty(up, 'timeStamp', { value: at + pressFor });
      fireEvent(target, up);
    };
    const doubleTap = (name: string, at = 1000) => {
      tap(handleOf(name), at);
      tap(handleOf(name), at + 150);
    };
    // Read off the page rather than the accessibility tree, which an open
    // menu empties of everything behind it.
    const itemsShown = () =>
      [...document.querySelectorAll('[data-item-row]')].filter(
        (row) => !row.closest('[style*="display: none"]'),
      ).length;
    const everyPanelIsItsHeaderAlone = (panelsDrawn = 2) => {
      expect(itemsShown()).toBe(0);
      expect(document.querySelectorAll('[data-panel-cell] h3')).toHaveLength(panelsDrawn);
    };
    const everyPanelIsOpen = () => expect(itemsShown()).toBe(1);

    beforeEach(() => screenIs(390));
    afterEach(() => act(() => setPanelsCollapsed(null)));

    it.each([
      {
        situation: 'a double-tap on a panel’s header',
        collapse: () => doubleTap('To read'),
      },
      {
        situation: 'collapsing from the dashboard’s menu',
        collapse: () => act(() => setPanelsCollapsed('today')),
      },
    ])('draws every panel as its header alone on $situation', ({ collapse }) => {
      board();
      everyPanelIsOpen();

      collapse();

      everyPanelIsItsHeaderAlone();
    });

    it('draws a filtered dashboard’s panels as their headers alone the same way', () => {
      writeDashboardFilter(localStorage, 'today', { ...NO_DASHBOARD_FILTER, text: 'bart' });
      board();
      everyPanelIsOpen();

      doubleTap('Project Falcon');

      // Only the panel with a matching item is drawn while filtered.
      everyPanelIsItsHeaderAlone(1);
    });

    it.each([
      { situation: 'a single tap', taps: [0] },
      { situation: 'two taps too far apart to be one gesture', taps: [0, 800] },
    ])('collapses nothing on $situation on an open header', ({ taps }) => {
      board();

      for (const at of taps) tap(handleOf('To read'), 1000 + at);

      everyPanelIsOpen();
    });

    it('collapses nothing for a press that is held, which is the menu’s long press', () => {
      board();

      tap(handleOf('To read'), 1000, { pressFor: 700 });
      tap(handleOf('To read'), 1150, { pressFor: 700 });

      everyPanelIsOpen();
    });

    it('opens the panel’s menu, and collapses nothing, on a double-tap of its menu button', () => {
      board();
      const button = within(screen.getByRole('region', { name: 'To read' })).getByRole('button', {
        name: 'Actions for To read',
      });

      tap(button, 1000);
      tap(button, 1150);
      fireEvent.click(button, { detail: 2 });

      everyPanelIsOpen();
    });

    it.each([
      { situation: 'a tap', taps: [0] },
      { situation: 'a double-tap, the second tap not collapsing it again', taps: [0, 150] },
    ])('opens every panel on $situation on a collapsed header, and leaves them open', ({ taps }) => {
      board();
      act(() => setPanelsCollapsed('today'));

      for (const at of taps) tap(handleOf('To read'), 5000 + at);

      everyPanelIsOpen();
    });

    it('leaves the board collapsed when the panel’s own menu is what is pressed', async () => {
      board();
      act(() => setPanelsCollapsed('today'));
      const button = within(screen.getByRole('region', { name: 'To read' })).getByRole('button', {
        name: 'Actions for To read',
      });

      tap(button, 5000);
      fireEvent.click(button, { detail: 1 });
      await screen.findByRole('menuitem', { name: 'Rename' });

      everyPanelIsItsHeaderAlone();
    });

    it('opens its menu on a right-click of a collapsed header, and stays collapsed', async () => {
      board();
      act(() => setPanelsCollapsed('today'));

      fireEvent.contextMenu(handleOf('To read'));

      expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
      everyPanelIsItsHeaderAlone();
    });

    it('opens every panel from the dashboard’s menu without anything being tapped', () => {
      board();
      act(() => setPanelsCollapsed('today'));
      everyPanelIsItsHeaderAlone();

      act(() => setPanelsCollapsed(null));

      everyPanelIsOpen();
    });

    it('does not remember it: another dashboard opens every panel, and so does coming back', () => {
      const first = board();
      doubleTap('To read');
      everyPanelIsItsHeaderAlone();

      first.unmount();
      board();

      everyPanelIsOpen();
    });

    it('opens every panel when the window widens past the phone', () => {
      board();
      doubleTap('To read');
      everyPanelIsItsHeaderAlone();

      act(() => {
        screenIs(480);
        window.dispatchEvent(new Event('resize'));
      });

      everyPanelIsOpen();
      act(() => {
        screenIs(390);
        window.dispatchEvent(new Event('resize'));
      });
      everyPanelIsOpen();
    });

    it('collapses nothing for quick taps on two different headers', () => {
      board();

      tap(handleOf('Project Falcon'), 1000);
      tap(handleOf('To read'), 1100);

      everyPanelIsOpen();
    });

    it('leaves the board open after an opening double-tap, even when its second tap lands on another header', () => {
      board();
      act(() => setPanelsCollapsed('today'));

      tap(handleOf('Project Falcon'), 5000);
      tap(handleOf('To read'), 5100);

      everyPanelIsOpen();
    });

    it('collapses nothing from 480 px up, on a double-click or on a double-tap', () => {
      screenIs(1280);
      board();

      fireEvent.doubleClick(handleOf('To read'));
      doubleTap('To read');

      everyPanelIsOpen();
    });

    it('keeps the header a tap leaves on the page free to be dragged on a wider screen', () => {
      screenIs(1280);
      board({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });

      expect(handleOf('To read').className).not.toContain('touch-manipulation');
    });

    it('stops a double-tap zooming the page on a phone’s header, leaving the finger to scroll', () => {
      board();

      expect(handleOf('To read').className).toContain('touch-manipulation');
      expect(handleOf('To read').className).not.toContain('touch-none');
    });
  });
});

describe('Dashboards', () => {
  /** What the board hands the Panel list, read the way the shell reads it. */
  function listed() {
    const { result } = renderHook(() => usePanelListing());
    return result;
  }
  /** Each row as the titles and counts the list would draw, `-` where there is no count. */
  const namesIn = (result: ReturnType<typeof listed>) =>
    result.current?.rows.map((row) => row.map((entry) => `${entry.title} ${entry.count ?? '-'}`));

  describe('the Panel list names each Panel the board draws, in reading order, with the count the board shows', () => {
    const ID = (n: number) => `11111111-1111-7111-8111-00000000000${n}`;
    const four = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => aPanel(id, `Panel ${id}`));
    const rowsOfOneTwoAndFour: Layout = {
      id: 'laptop',
      tenantId: 'tenant',
      dashboardId: 'today',
      rows: [
        { height: null, cells: [{ panelId: 'a', span: 12 }] },
        {
          height: null,
          cells: [
            { panelId: 'b', span: 6 },
            { panelId: 'c', span: 6 },
          ],
        },
        { height: null, cells: ['d', 'e', 'f', 'g'].map((panelId) => ({ panelId, span: 3 })) },
      ],
    };

    it('lists the Panels row by row, left to right, and a Panel of text without a count', () => {
      screenIs(1280);
      const result = listed();
      showBoard({
        panels: [...four.slice(0, 2), aPanelOfText('c', 'Panel c'), ...four.slice(3)],
        layouts: [rowsOfOneTwoAndFour],
        items: [anItem(ID(1), 'One'), anItem(ID(2), 'Two')],
        filings: [
          { panelId: 'b', itemId: ID(1), position: 0 },
          { panelId: 'b', itemId: ID(2), position: 1 },
        ],
      });

      expect(namesIn(result)).toEqual([
        ['Panel a 0'],
        ['Panel b 2', 'Panel c -'],
        ['Panel d 0', 'Panel e 0', 'Panel f 0', 'Panel g 0'],
      ]);
    });

    it('lists only the Panels a filtered Dashboard draws, each with its matching count', () => {
      screenIs(1280);
      const result = listed();
      filterTheDashboard({ text: 'vat' });
      showBoard({
        panels: [aPanel('falcon', 'Project Falcon'), aPanel('reading', 'To read'), aPanelOfText('notes', 'Notes')],
        items: [anItem(ID(1), 'VAT return'), anItem(ID(2), 'VAT refund'), anItem(ID(3), 'Pay the rent')],
        filings: [
          { panelId: 'falcon', itemId: ID(1), position: 0 },
          { panelId: 'falcon', itemId: ID(2), position: 1 },
          { panelId: 'falcon', itemId: ID(3), position: 2 },
        ],
      });

      expect(namesIn(result)).toEqual([['Project Falcon 2']]);
    });

    it('follows a Panel added, renamed or deleted, as the next snapshot says', () => {
      screenIs(1280);
      const result = listed();
      const { redrawnWith } = showBoard({ panels: [aPanel('falcon', 'Project Falcon')] });
      expect(namesIn(result)).toEqual([['Project Falcon 0']]);

      redrawnWith([aPanel('falcon', 'Project Falcon'), aPanel('reading', 'To read')]);
      expect(namesIn(result)).toEqual([['Project Falcon 0', 'To read 0']]);

      redrawnWith([aPanel('falcon', 'Falcon, renamed'), aPanel('reading', 'To read')]);
      expect(namesIn(result)).toEqual([['Falcon, renamed 0', 'To read 0']]);

      redrawnWith([aPanel('reading', 'To read')]);
      expect(namesIn(result)).toEqual([['To read 0']]);
    });

    it('says nothing once the board has left, rather than listing Panels that are gone', () => {
      screenIs(1280);
      const result = listed();
      const { unmount } = showBoard();
      expect(result.current).not.toBeNull();

      unmount();

      expect(result.current).toBeNull();
    });
  });

  describe('a click on a Panel in the list outlines that Panel briefly', () => {
    it('outlines the Panel it names, and only that one, until the moment is over', () => {
      vi.useFakeTimers();
      try {
        screenIs(1280);
        const result = listed();
        showBoard({ layouts: [aLayout('laptop', ['falcon', 'reading'])] });
        const cellOf = (name: string) => screen.getByRole('region', { name }).closest('[data-panel-cell]')!;

        act(() => result.current!.jumpTo('reading'));

        expect(cellOf('To read')).toHaveAttribute('data-jumped-to');
        expect(cellOf('Project Falcon')).not.toHaveAttribute('data-jumped-to');

        act(() => void vi.advanceTimersByTime(5000));

        expect(cellOf('To read')).not.toHaveAttribute('data-jumped-to');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
