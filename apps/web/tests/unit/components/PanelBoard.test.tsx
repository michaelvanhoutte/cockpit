import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MIN_ROW_HEIGHT } from '@cockpit/shared';
import type { Dashboard, Filing, Item, Layout, Panel } from '@cockpit/shared';
import { PanelBoard } from '../../../src/components/PanelBoard';
import { CommandRefused } from '../../../src/api/client';
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
  return { id, tenantId: 'tenant', dashboardId: 'today', name };
}

/**
 * A layout of one row holding every panel, side by side - which is what the
 * flat arrangement these cases were written against drew at this width, so a
 * panel still has somewhere to move left to.
 */
function aLayout(id: string, screenWidth: number, panelIds: string[]): Layout {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'today',
    name: id,
    screenWidth,
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
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PanelBoard
        workspaceId="ws-work"
        dashboard={DASHBOARD}
        panels={panels}
        layouts={layouts}
        items={items}
        filings={filings}
      />
    </QueryClientProvider>,
  );
  return { mutate, user: userEvent.setup() };
}

/** What a panel offers is in the panel's own menu, so reaching any of it is two gestures. */
async function choose(user: ReturnType<typeof userEvent.setup>, panel: string, entry: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${panel}` }));
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
    row.getBoundingClientRect = () => ({ top, bottom: top + 100 }) as DOMRect;
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

/** The header a panel is dragged by. */
function handleOf(panelName: string) {
  const panel = screen.getByRole('region', { name: panelName });
  return within(panel).getByRole('heading').parentElement!;
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
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
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

    it('says so when a panel alone on the only row has nowhere left to go', async () => {
      const { user } = showBoard({
        panels: [aPanel('falcon', 'Project Falcon')],
        layouts: [aLayout('laptop', 1280, ['falcon'])],
      });

      await user.click(await screen.findByRole('button', { name: 'Actions for Project Falcon' }));

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

      expect(screen.getByRole('button', { name: 'Actions for To read' })).toHaveFocus();
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

      await user.click(await screen.findByRole('button', { name: 'Actions for Project Falcon' }));
      await user.click(
        await screen.findByRole('menuitem', { name: /Move up: This panel is already at the top/ }),
      );

      expect(mutate).not.toHaveBeenCalled();
    });

    it('names the move after the direction the screen actually goes in', async () => {
      // On a screen only one panel wide the panels are stacked, so "Move left"
      // would name a direction nothing goes in.
      screenIs(480);
      const { user } = showBoard();

      await user.click(await screen.findByRole('button', { name: 'Actions for To read' }));

      expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Move left' })).toBeNull();
    });

    it.each(['Wider', 'Narrower', 'Taller', 'Shorter'])(
      'offers no %s, resizing being the corner grip’s alone',
      async (gone) => {
        // Four step-at-a-time entries in a menu read on every panel, beside a
        // gesture that does the whole thing at once.
        const { user } = showBoard();

        await user.click(await screen.findByRole('button', { name: 'Actions for Project Falcon' }));

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
      // The width it was made at is kept, not moved to this screen: that is
      // what makes matching a screen to a layout go on meaning something.
      expect(asked.payload.screenWidth).toBe(layouts[0]!.screenWidth);
      expect(sentOrder(mutate)).toEqual(['reading', 'falcon']);
    });

    it('sends a name for a layout that has none, rather than one the server must refuse', async () => {
      // Every layout in a snapshot cached before names existed parses with an
      // empty name, as does one old code wrote during the deploy - and a name
      // is required on the way in. Sending the stored one would have the first
      // drag after an upgrade refused for a field nobody typed.
      const legacy = { ...aLayout('laptop', 1280, ['falcon', 'reading']), name: '' };
      const { user, mutate } = showBoard({ layouts: [legacy] });

      await choose(user, 'To read', 'Move left');

      expect(mutate.mock.calls[0]![0].payload.name).toBe('1280 px');
    });

    it.each([
      // A phone stacks its panels, so the entry that moves one names the
      // direction that screen actually goes in.
      { situation: 'a phone', screenWidth: 390, named: 'Phone', move: 'Move up' },
      { situation: 'a laptop', screenWidth: 1280, named: 'Wide', move: 'Move left' },
    ])(
      'makes a layout named for the screen when the dashboard has none, on $situation',
      async ({ screenWidth, named, move }) => {
        // There is nothing to change and nothing worth interrupting a drag to
        // ask, so the first arrangement records one and names it itself.
        screenIs(screenWidth);
        const { user, mutate } = showBoard();

        await choose(user, 'To read', move);

        const [asked] = mutate.mock.calls[0]!;
        expect(asked.name).toBe('save_layout');
        expect(asked.payload.name).toBe(named);
        expect(asked.payload.screenWidth).toBe(screenWidth);
      },
    );

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

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
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

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
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

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
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

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
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

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
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

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
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

      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
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

        fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
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
      expect(within(reading).getByText('Nothing filed here yet.')).toBeVisible();
    });
  });
});
