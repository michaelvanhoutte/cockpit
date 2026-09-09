import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MIN_ROW_HEIGHT } from '@cockpit/shared';
import type { Dashboard, Filing, Item, Layout, Panel, ScreenSize } from '@cockpit/shared';
import { PanelBoard } from '../../../src/components/PanelBoard';
import { QUIET } from '../../../src/panels/PanelText';
import {
  NOTHING_FILED_HERE,
  NOTHING_FILED_HERE_YET_AND_HOW,
  NOTHING_WRITTEN_HERE,
} from '../../../src/whatThingsAre';
import { CommandRefused } from '../../../src/api/client';
import { ITEM_BEING_DRAGGED } from '../../../src/dropAt';
import { useCommand } from '../../../src/api/queries';

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
 * The width `aLayout` intended for the matching screen size `screenSizeOf`
 * derives - kept here rather than on the Layout itself, which no longer
 * carries a width of its own, keyed by the deterministic id the two share.
 */
const widthByScreenSizeId = new Map<string, number>();

/**
 * A layout of one row holding every panel, side by side - which is what the
 * flat arrangement these cases were written against drew at this width, so a
 * panel still has somewhere to move left to.
 *
 * Defined at a screen size of its own, one per layout, so the automatic
 * choice (`arrangement.ts`, `nearestLayout`) has something to find it by -
 * `showBoard` derives the matching `screenSizes` list from these unless a
 * case hands it its own.
 */
function aLayout(id: string, screenWidth: number, panelIds: string[]): Layout {
  const screenSizeId = `sz-${id}`;
  widthByScreenSizeId.set(screenSizeId, screenWidth);
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'today',
    screenSizeId,
    rows: [{ height: null, cells: panelIds.map((panelId) => ({ panelId, span: 12 })) }],
  };
}

/** The screen size a layout made by `aLayout` is drawn for. */
function screenSizeOf(layout: Layout): ScreenSize {
  return {
    id: layout.screenSizeId,
    tenantId: 'tenant',
    name: layout.id,
    width: widthByScreenSizeId.get(layout.screenSizeId) ?? 1280,
    createdAt: '2026-09-08T10:00:00.000Z',
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
    sourceResolvedAt: null,
    typeId: null,
    nextAction: null,
    completedAt: null,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

function showBoard({
  panels = [aPanel('falcon', 'Project Falcon'), aPanel('reading', 'To read')],
  layouts = [] as Layout[],
  // Derived from the layouts unless a case wants its own - most cases here
  // are about drag-and-drop mechanics, not about which screen sizes an
  // account has, and every layout `aLayout` makes needs its own size for the
  // board to draw it automatically at all.
  screenSizes = layouts.map(screenSizeOf) as ScreenSize[],
  items = [] as Item[],
  filings = [] as Filing[],
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
  layouts?: Layout[];
  screenSizes?: ScreenSize[];
  items?: Item[];
  filings?: Filing[];
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
  const { unmount } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PanelBoard
        workspaceId="ws-work"
        dashboard={DASHBOARD}
        panels={panels}
        layouts={layouts}
        screenSizes={screenSizes}
        items={items}
        filings={filings}
      />
    </QueryClientProvider>,
  );
  // `unmount` because a panel of text sends what is unsent on the way out, and
  // switching dashboard is what takes it off screen.
  return { mutate, unmount, user: userEvent.setup() };
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
 * its header rather than a button - the same way a dashboard's or a
 * workspace's own tab opens its (`WorkspaceTabs.test.tsx`, `menuOf`).
 */
async function choose(user: ReturnType<typeof userEvent.setup>, panel: string, entry: string) {
  openMenu(panel);
  await user.click(await screen.findByRole('menuitem', { name: entry }));
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
  if (andDrop) fireEvent.pointerUp(handle, { pointerId: 1 });
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
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
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

    it('leaves a plain click on the header as the drag it is, opening nothing', () => {
      showBoard();

      fireEvent.click(handleOf('Project Falcon'));

      expect(screen.queryByRole('menuitem')).toBeNull();
    });

    it('leaves a touch on the header for Radix’s own long press, not the drag', () => {
      // Found in review: the header is both the drag handle and the menu's
      // trigger now, and picking the panel up moves pointer capture off the
      // header before Radix ever sees a release - so a drag started here on
      // every touch, mouse or not, would silently arm a menu that could never
      // close, and starve `TabMenu`'s long press of the touch it needs to
      // open at all. `pointerType` is the whole of what tells the two apart,
      // the same guard `tabDrag.ts` carries for the same reason.
      showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });
      const lifted = () => screen.getByRole('region', { name: 'To read' }).className;

      fireEvent.pointerDown(handleOf('To read'), {
        button: 0,
        pointerId: 1,
        pointerType: 'touch',
      });

      expect(lifted()).not.toContain('opacity-40');
      expect(seamsAreOpen()).toBe(false);
    });

    it('names the header for what it opens, since nothing else does now the button is gone', () => {
      showBoard();

      const header = handleOf('Project Falcon');
      expect(header).toHaveAttribute('aria-label', 'Actions for Project Falcon');
      expect(header).toHaveAttribute('aria-haspopup', 'menu');
    });

    it('drops the header’s own name for what it opens while the input already carries one', async () => {
      const { user } = showBoard();

      await choose(user, 'Project Falcon', 'Rename');

      const header = handleOf('Project Falcon');
      expect(header).not.toHaveAttribute('aria-label');
      expect(header).not.toHaveAttribute('aria-haspopup');
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

    it.each([
      { situation: 'towards the front', entry: 'Move left', order: ['reading', 'falcon'] },
      { situation: 'towards the back', entry: 'Move right', order: ['reading', 'falcon'] },
    ])('moves it $situation', async ({ entry, order }) => {
      // "Move right" on the first panel and "Move left" on the second both swap
      // this pair, which is what makes one expected order right for both.
      const { user, mutate } = showBoard();
      const panel = entry === 'Move left' ? 'To read' : 'Project Falcon';

      await choose(user, panel, entry);

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('save_layout');
      expect(sentOrder(mutate)).toEqual(order);
    });

    it('offers a panel sharing a row the move that puts it on a line of its own', async () => {
      // The only way a keyboard has of making a row, and it was unreachable:
      // marking the first cell of the first row as having nowhere to go made
      // both ends of a single-row dashboard unavailable, so a dashboard with
      // one row could never be split without a pointer.
      const { user, mutate } = showBoard({
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
      });

      await choose(user, 'Project Falcon', 'Move left');

      expect(sentRows(mutate)).toEqual([['falcon'], ['reading']]);
    });

    it('says so when a panel alone on the only row has nowhere left to go', () => {
      showBoard({
        panels: [aPanel('falcon', 'Project Falcon')],
        layouts: [aLayout('laptop', 1280, ['falcon'])],
      });

      openMenu('Project Falcon');

      expect(
        screen.getByRole('menuitem', { name: /Move up: This panel is already at the top/ }),
      ).toHaveAttribute('aria-disabled', 'true');
    });

    it('leaves the focus on the panel’s own menu, which is where the next move is chosen', async () => {
      // Moving opens nothing, so there is nowhere else for the focus to go -
      // and these are the entries somebody presses three times in a row.
      // Dropped to the top of the page between two presses is losing your
      // place on the dashboard.
      const { user } = showBoard();

      await choose(user, 'To read', 'Move left');

      expect(handleOf('To read')).toHaveFocus();
    });

    it('says so rather than doing nothing when a panel has nowhere left to go', async () => {
      // Offered and chosen and nothing happens is indistinguishable from
      // broken - and on a dashboard with no layout it is worse than nothing,
      // because a change that moves no panel would still record a layout for
      // this screen out of a gesture that arranged nothing.
      const { user, mutate } = showBoard({
        panels: [aPanel('falcon', 'Project Falcon')],
        layouts: [aLayout('laptop', 1280, ['falcon'])],
      });

      openMenu('Project Falcon');
      await user.click(
        await screen.findByRole('menuitem', { name: /Move up: This panel is already at the top/ }),
      );

      expect(mutate).not.toHaveBeenCalled();
    });

    it('names the move after the direction the screen actually goes in', () => {
      // On a screen only one panel wide the panels are stacked, so "Move left"
      // would name a direction nothing goes in.
      screenIs(480);
      showBoard();

      openMenu('To read');

      expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Move left' })).toBeNull();
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
        // the two moves, delete.
        expect(screen.getAllByRole('menuitem')).toHaveLength(4);
      },
    );
  });

  describe('changing the arrangement changes the layout you are on, and asks nothing', () => {
    it.each([
      {
        situation: 'the layout is the one this screen was measured at',
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
      },
      {
        // The case that used to stop and ask which layout to keep the change
        // in. You picked the layout you are on, so the gesture means what it
        // says and goes into it.
        situation: 'the layout was made for a screen four times as wide',
        layouts: [aLayout('wide', 2560, ['falcon', 'reading'])],
      },
    ])('changes the layout on screen when $situation', async ({ layouts }) => {
      const { user, mutate } = showBoard({ layouts });

      await choose(user, 'To read', 'Move left');

      expect(screen.queryByRole('alertdialog')).toBeNull();
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.payload.layoutId).toBe(layouts[0]!.id);
      expect(sentOrder(mutate)).toEqual(['reading', 'falcon']);
    });

    it('makes an arrangement with nothing defined without naming a screen size, and leaves the server to resolve one', async () => {
      // There is nothing to change and nothing worth interrupting a drag to
      // ask - the server keeps it in the nearest size the account has, or
      // makes one called Default where it has none at all (`save_layout`,
      // `screenSizeId`). The board asks nothing about either.
      screenIs(1280);
      const { user, mutate } = showBoard();

      await choose(user, 'To read', 'Move left');

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('save_layout');
      expect(asked.payload.screenSizeId).toBeUndefined();
      expect(asked.payload.screenWidth).toBe(1280);
    });

    it('changes the layout it just made rather than defining a second one at the same width', async () => {
      // Two gestures before the first has been re-read both find a dashboard
      // with no layout. A fresh id each time would leave the layout menu
      // listing the same width twice with nothing to tell the two apart.
      // Left in flight, which is the state two quick gestures happen in: the
      // first is sent and not yet re-read, so the second still finds a
      // dashboard with no layout.
      const { user, mutate } = showBoard({ settles: false });

      await choose(user, 'To read', 'Move left');
      await choose(user, 'To read', 'Move right');

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
      const { user, mutate } = showBoard({
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
        settles: false,
      });

      await choose(user, 'To read', 'Move left');
      await choose(user, 'To read', 'Move right');

      expect(mutate).toHaveBeenCalledTimes(2);
      expect(sentOrder(mutate)).toEqual(['falcon', 'reading']);
    });

    it('sends nothing when the gesture leaves the arrangement where it already was', async () => {
      // Dropped back where it already is - before the panel it is already
      // before. A gesture happened, and what it asks for is what the layout
      // already holds; sending it would make every abandoned drag a write.
      const { mutate } = showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });

      dragTo('Project Falcon', slotBefore('reading'));

      expect(mutate).not.toHaveBeenCalled();
    });

    it('puts a panel on a line of its own when it is let go in the gap', async () => {
      // The seam between two rows is the gesture that makes a row, and it is
      // the one thing the wrapping grid had no way to express.
      const { mutate } = showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });

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
            ...aLayout('laptop', 1280, ['falcon']),
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
      showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });
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
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
      });

      dragTo('To read', gapAbove(0), false);

      expect(drawnLines()).toEqual([['reading'], ['falcon']]);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('marks the panel that is in the air, and unmarks it once it lands', async () => {
      // A gesture with no sign that it has begun is one you find out about
      // afterwards: the panel picked up used to be drawn exactly as it was.
      showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });
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
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
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
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
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
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
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
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
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
            ...aLayout('laptop', 1280, ['falcon']),
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
          layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
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
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
      });

      dragTo('To read', slotBefore('reading'));

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
        layouts: [aLayout('laptop', 1280, ['falcon'])],
      });

      dragRowLine(0, 200, false);
      expect(drawnHeights()).toEqual(['300px']);
      expect(mutate).not.toHaveBeenCalled();

      letGoOfRowLine();
      expect(sentHeights(mutate)).toEqual([300]);
    });

    it('gives one panel what the other gives up, and leaves the row adding up to a whole', () => {
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
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
            ...aLayout('laptop', 1280, ['falcon']),
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
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
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
        layouts: [aLayout('laptop', 1280, ['falcon'])],
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
            ...aLayout('laptop', 1280, ['falcon']),
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
        layouts: [aLayout('laptop', 1280, ['falcon'])],
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
      showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });
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
      showBoard({ panels, layouts: [aLayout('laptop', 1280, ['falcon'])] });

      expect(screen.queryAllByTestId('row-line')).toHaveLength(lines);
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
      const { user } = showBoard({
        error: new CommandRefused(409, 'a layout called Wide already arranges this dashboard'),
        variables: { name: 'save_layout', payload: {} },
      });

      await choose(user, 'To read', 'Move left');

      expect(screen.getByRole('alert')).toHaveTextContent('a layout called Wide already arranges');
      expect(panelOrderOnScreen()).toEqual(['Project Falcon', 'To read']);
    });

    it('says a refused arrangement above the board, which is the only place it belongs', async () => {
      // Nothing asked for the arrangement in a box that could hold the answer -
      // it came from a drag or a menu entry - so the board itself says it.
      const { user } = showBoard({
        layouts: [aLayout('wide', 2560, ['falcon', 'reading'])],
        error: new CommandRefused(404, 'panel reading is not on this dashboard'),
        variables: { name: 'save_layout', payload: {} },
      });

      await choose(user, 'To read', 'Move left');

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
});

describe('Onboarding', () => {
  /**
   * "Nothing filed here yet." is true and says nothing about how anything gets
   * here, and a new account is looking at exactly that: one panel, empty, with
   * the Inbox beside it. So until the gesture has been done once the empty
   * panel says how - and afterwards it stops, because it has been done rather
   * than read about.
   *
   * **Asked of the workspace, not the panel.** An empty panel beside a full one
   * is empty on purpose.
   */
  describe('an empty panel says how an item gets onto it, until one has been filed', () => {
    it('says how while nothing in the workspace has been filed', async () => {
      showBoard({ items: [], filings: [] });

      const reading = await screen.findByRole('region', { name: 'To read' });
      expect(within(reading).getByText(NOTHING_FILED_HERE_YET_AND_HOW)).toBeVisible();
    });

    it('says only that it is empty once something has been filed anywhere in the workspace', async () => {
      const bart = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');
      showBoard({ items: [bart], filings: [{ panelId: 'falcon', itemId: bart.id, position: 0 }] });

      const reading = await screen.findByRole('region', { name: 'To read' });
      expect(within(reading).getByText(NOTHING_FILED_HERE)).toBeVisible();
      expect(within(reading).queryByText(NOTHING_FILED_HERE_YET_AND_HOW)).toBeNull();
    });
  });
});
