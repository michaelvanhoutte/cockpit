import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

function aLayout(id: string, screenWidth: number, panelIds: string[], columns = 4): Layout {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'today',
    name: id,
    screenWidth,
    placements: panelIds.map((panelId) => ({ panelId, columns, rows: 3 })),
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
 * Drags a panel's corner to the right and lets go.
 *
 * The two halves of the browser the grip needs are stood in for here, and only
 * those: jsdom implements no pointer capture and no layout, so a grip pressed
 * in it captures nothing and measures a panel zero pixels wide. What is under
 * test is the board's half - that letting go of a drag is *sent*, where every
 * move before it was only drawn - so the size the corner lands on is left to
 * the browser tier, which is the only place a real one exists.
 */
function dragTheCornerOf(panelName: string, toX = 600) {
  const panel = screen.getByRole('region', { name: panelName });
  const grip = panel.querySelector('[data-resize-grip]') as HTMLElement;
  // A panel 300px across at whatever it spans, with its corner at the origin.
  panel.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 300, height: 240 }) as DOMRect;
  grip.setPointerCapture = () => undefined;
  grip.hasPointerCapture = () => true;
  grip.releasePointerCapture = () => undefined;

  fireEvent.pointerDown(grip, { pointerId: 1, clientX: 300, clientY: 240 });
  fireEvent.pointerMove(grip, { pointerId: 1, clientX: toX, clientY: 240 });
  fireEvent.pointerUp(grip, { pointerId: 1, clientX: toX, clientY: 240 });
}

/** The arrangement the last save_layout carried, as panel ids in order. */
function sentOrder(mutate: ReturnType<typeof vi.fn>): string[] {
  const [asked] = mutate.mock.calls.at(-1)!;
  return asked.payload.placements.map((p: { panelId: string }) => p.panelId);
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

    it('leaves the focus on the panel’s own menu, which is where the next move is chosen', async () => {
      // Moving opens nothing, so there is nowhere else for the focus to go -
      // and these are the entries somebody presses three times in a row.
      // Dropped to the top of the page between two presses is losing your
      // place on the dashboard.
      const { user } = showBoard();

      await choose(user, 'To read', 'Move left');

      expect(screen.getByRole('button', { name: 'Actions for To read' })).toHaveFocus();
    });

    it.each([
      { situation: 'the first panel cannot move earlier', panel: 'Project Falcon', entry: 'Move left: This panel is already first' },
      { situation: 'the last panel cannot move later', panel: 'To read', entry: 'Move right: This panel is already last' },
    ])('says so rather than doing nothing when $situation', async ({ panel, entry }) => {
      // Offered and chosen and nothing happens is indistinguishable from
      // broken - and on a dashboard with no layout it is worse than nothing,
      // because a change that moves no panel would still record a layout for
      // this screen out of a gesture that arranged nothing.
      const { user, mutate } = showBoard();

      await user.click(await screen.findByRole('button', { name: `Actions for ${panel}` }));
      await user.click(await screen.findByRole('menuitem', { name: entry }));

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
      // what makes the automatic choice go on meaning something.
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

    it('sends the size a corner was dragged to, which was only drawn while the hand moved', async () => {
      // Every pointer move draws the new size without sending it, so by the
      // time the hand stops the board is already showing what letting go is
      // about to send. Measured against what is *drawn*, that release looks
      // like no change at all and the resize is silently never stored - it
      // survives on screen and is gone on the next reload.
      const { mutate } = showBoard({
        layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])],
        settles: false,
      });

      dragTheCornerOf('Project Falcon');

      const [asked] = mutate.mock.calls.at(-1)!;
      expect(asked.name).toBe('save_layout');
      expect(asked.payload.placements[0].columns).toBeGreaterThan(4);
    });

    it('sends nothing when the gesture leaves the arrangement where it already was', async () => {
      // A corner nudged and let go inside the step it started in: a gesture
      // happened, and what it asks for is what the layout already holds. It
      // must not be sent, or every twitch of a grip would be a change to
      // answer the question about.
      const { mutate } = showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });

      dragTheCornerOf('Project Falcon', 300);

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
