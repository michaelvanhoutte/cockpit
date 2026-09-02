import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, Layout, Panel } from '@cockpit/shared';
import { PanelBoard } from '../../../src/components/PanelBoard';
import { CommandRefused } from '../../../src/api/client';
import { useCommand } from '../../../src/api/queries';

/**
 * F1: what is under test is the board's own behaviour - what it sends, when it
 * asks which layout to keep a change in, and what it does with an answer it
 * does not like. Which arrangement a screen produces is settled in
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
    screenWidth,
    placements: panelIds.map((panelId) => ({ panelId, columns, rows: 3 })),
  };
}

/** The width the board reads, which is what decides whether it has to ask. */
function screenIs(width: number) {
  Object.defineProperty(globalThis, 'innerWidth', { value: width, configurable: true, writable: true });
}

function showBoard({
  panels = [aPanel('falcon', 'Project Falcon'), aPanel('reading', 'To read')],
  layouts = [] as Layout[],
  error,
  variables,
  /**
   * False leaves every change in flight, which is the state the board spends
   * a real gesture in: sent, not yet re-read, and still drawn from what was
   * dragged rather than from the snapshot in hand.
   */
  settles = true,
}: {
  panels?: Panel[];
  layouts?: Layout[];
  error?: Error;
  variables?: { name: string; payload: Record<string, unknown> };
  settles?: boolean;
} = {}) {
  const mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => {
    if (!error && settles) options?.onSuccess?.();
  });
  mockUseCommand.mockReturnValue({
    mutate,
    reset: vi.fn(),
    isPending: false,
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
  describe('a dashboard with nothing on it says so, and invites a panel', () => {
    it('offers the way to add one either way', async () => {
      showBoard({ panels: [] });

      expect(screen.getByText('Nothing on this dashboard yet. Panels are what go here.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add a panel' })).toBeVisible();
    });
  });

  describe('adding a panel asks for the title you typed, on the dashboard you are on', () => {
    it('sends it without the blanks around it', async () => {
      const { user, mutate } = showBoard({ panels: [] });

      await user.click(screen.getByRole('button', { name: 'Add a panel' }));
      await user.type(screen.getByLabelText('Name of the new panel'), '  Project Falcon  ');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('add_panel');
      expect(asked.payload.name).toBe('Project Falcon');
      expect(asked.payload.dashboardId).toBe('today');
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

    it('names the move after the direction the screen actually goes in', async () => {
      // On a screen only one panel wide the panels are stacked, so "Move left"
      // would name a direction nothing goes in.
      screenIs(480);
      const { user } = showBoard();

      await user.click(await screen.findByRole('button', { name: 'Actions for To read' }));

      expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Move left' })).toBeNull();
    });

    it.each([
      { entry: 'Wider', columns: 5, rows: 3 },
      { entry: 'Narrower', columns: 3, rows: 3 },
      { entry: 'Taller', columns: 4, rows: 4 },
      { entry: 'Shorter', columns: 4, rows: 2 },
    ])('resizes it: $entry', async ({ entry, columns, rows }) => {
      const { user, mutate } = showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });

      await choose(user, 'Project Falcon', entry);

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('save_layout');
      expect(asked.payload.placements[0]).toEqual({ panelId: 'falcon', columns, rows });
    });

    it('says why a panel cannot get any wider instead of doing nothing', async () => {
      const full = { ...aLayout('laptop', 1280, ['falcon']), placements: [{ panelId: 'falcon', columns: 12, rows: 8 }] };
      const { user, mutate } = showBoard({ panels: [aPanel('falcon', 'Project Falcon')], layouts: [full] });

      await user.click(await screen.findByRole('button', { name: 'Actions for Project Falcon' }));
      await user.click(
        await screen.findByRole('menuitem', { name: 'Wider: This panel is already the full width' }),
      );

      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('changing the arrangement on a screen the layout was not made for asks which one to change', () => {
    it('keeps it without asking when the layout is this screen’s', async () => {
      const { user, mutate } = showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });

      await choose(user, 'To read', 'Move left');

      expect(screen.queryByText(/Keep the change where\?/)).toBeNull();
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.payload.layoutId).toBe('laptop');
      expect(asked.payload.screenWidth).toBe(1280);
    });

    it('keeps it without asking when the dashboard has no layout at all', async () => {
      // There is no "change the layout you are on" when you are not on one.
      const { user, mutate } = showBoard();

      await choose(user, 'To read', 'Move left');

      expect(screen.queryByText(/Keep the change where\?/)).toBeNull();
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('save_layout');
      expect(asked.payload.screenWidth).toBe(1280);
    });

    it('asks, naming both widths, when the layout was made for another screen', async () => {
      const { user, mutate } = showBoard({ layouts: [aLayout('wide', 2560, ['falcon', 'reading'])] });

      await choose(user, 'To read', 'Move left');

      expect(
        screen.getByText('This layout was made for a 2560 px screen, and this one is 1280 px. Keep the change where?'),
      ).toBeVisible();
      // Nothing is sent until the question is answered.
      expect(mutate).not.toHaveBeenCalled();
      // And the change is on screen behind it: what is being asked is where to
      // keep it, not whether it happened.
      expect(panelOrderOnScreen()).toEqual(['To read', 'Project Falcon']);
    });

    it('changes the layout in use when that is the answer, keeping the width it was made at', async () => {
      const { user, mutate } = showBoard({ layouts: [aLayout('wide', 2560, ['falcon', 'reading'])] });

      await choose(user, 'To read', 'Move left');
      await user.click(screen.getByRole('button', { name: 'Change this layout' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.payload.layoutId).toBe('wide');
      expect(asked.payload.screenWidth).toBe(2560);
      expect(sentOrder(mutate)).toEqual(['reading', 'falcon']);
    });

    it('defines a layout for this screen when that is the answer', async () => {
      const { user, mutate } = showBoard({ layouts: [aLayout('wide', 2560, ['falcon', 'reading'])] });

      await choose(user, 'To read', 'Move left');
      await user.click(screen.getByRole('button', { name: 'Make a layout for this screen' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.payload.layoutId).not.toBe('wide');
      expect(asked.payload.screenWidth).toBe(1280);
      expect(sentOrder(mutate)).toEqual(['reading', 'falcon']);
    });

    it.each([
      { situation: 'cancelled', answer: 'Cancel' },
      { situation: 'dismissed with Escape', answer: null },
    ])('sends nothing and puts the panels back when the question is $situation', async ({ answer }) => {
      const { user, mutate } = showBoard({ layouts: [aLayout('wide', 2560, ['falcon', 'reading'])] });

      await choose(user, 'To read', 'Move left');
      if (answer) await user.click(screen.getByRole('button', { name: answer }));
      else await user.keyboard('{Escape}');

      expect(mutate).not.toHaveBeenCalled();
      expect(panelOrderOnScreen()).toEqual(['Project Falcon', 'To read']);
    });

    it('records a layout for this screen the first time the button is pressed, though nothing moves', async () => {
      // A dashboard with no layout is already drawn the way fitting it would
      // draw it, so the press changes nothing on screen - and what it is for is
      // the layout, which was not there before.
      const { user, mutate } = showBoard();

      await user.click(screen.getByRole('button', { name: 'Fit to this screen' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('save_layout');
      expect(asked.payload.screenWidth).toBe(1280);
      expect(asked.payload.placements).toEqual([
        { panelId: 'falcon', columns: 4, rows: 3 },
        { panelId: 'reading', columns: 4, rows: 3 },
      ]);
    });

    it('changes the layout it just made rather than defining a second one at the same width', async () => {
      // Two gestures before the first has been re-read both find a dashboard
      // with no layout. A fresh id each time would leave the Layouts menu
      // listing the same width twice with nothing to tell the two apart.
      const { user, mutate } = showBoard();

      await user.click(screen.getByRole('button', { name: 'Fit to this screen' }));
      await choose(user, 'To read', 'Move left');

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

    it('sends nothing when the layout in use already holds this arrangement', async () => {
      const { user, mutate } = showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });

      await user.click(screen.getByRole('button', { name: 'Fit to this screen' }));

      expect(mutate).not.toHaveBeenCalled();
    });

    it('rearranges for this screen when the button is pressed, and asks the same question', async () => {
      // Four across is what a 2560px layout holds; this screen fits three.
      const { user, mutate } = showBoard({
        layouts: [aLayout('wide', 2560, ['falcon', 'reading'], 3)],
      });

      await user.click(screen.getByRole('button', { name: 'Fit to this screen' }));
      await user.click(screen.getByRole('button', { name: 'Make a layout for this screen' }));

      const [asked] = mutate.mock.calls[0]!;
      // Three across at 1280px, in the order the panels were already in.
      expect(asked.payload.placements).toEqual([
        { panelId: 'falcon', columns: 4, rows: 3 },
        { panelId: 'reading', columns: 4, rows: 3 },
      ]);
    });
  });

  describe('the layout a dashboard is drawn with is the closest to the screen, until you choose one', () => {
    it('draws the one you chose, and remembers it for next time', async () => {
      const { user, mutate } = showBoard({
        layouts: [aLayout('phone', 480, ['falcon', 'reading']), aLayout('wide', 2560, ['reading', 'falcon'])],
      });

      await user.click(screen.getByRole('button', { name: 'Layouts' }));
      await user.click(screen.getByRole('menuitemradio', { name: /Made for 2560 px/ }));

      // Drawn with it: the wide layout has the panels the other way round.
      expect(panelOrderOnScreen()).toEqual(['To read', 'Project Falcon']);
      // And a change now belongs to that layout rather than to the closest one.
      await choose(user, 'Project Falcon', 'Move left');
      await user.click(screen.getByRole('button', { name: 'Change this layout' }));
      expect(mutate.mock.calls.at(-1)![0].payload.layoutId).toBe('wide');
    });

    it('deletes the layout it is drawing, leaving the panels where they are', async () => {
      const { user, mutate } = showBoard({ layouts: [aLayout('laptop', 1280, ['falcon', 'reading'])] });

      await user.click(screen.getByRole('button', { name: 'Layouts' }));
      await user.click(screen.getByRole('menuitem', { name: 'Delete the 1280 px layout' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('delete_layout');
      expect(asked.payload.layoutId).toBe('laptop');
    });

    it('offers nothing to delete on a dashboard that has never been arranged', async () => {
      const { user } = showBoard();

      await user.click(screen.getByRole('button', { name: 'Layouts' }));

      expect(screen.queryByRole('menuitem', { name: /^Delete the/ })).toBeNull();
      expect(screen.getByRole('menuitemradio', { name: 'Whichever fits this screen' })).toBeVisible();
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
      },
    ])('$situation', async ({ error, variables, act, says }) => {
      const { user } = showBoard({ error, variables });

      await act(user);

      expect(screen.getByRole('alert')).toHaveTextContent(says);
      // Still there to be corrected: the box does not close over a refusal.
      expect(screen.getByLabelText('New name for Project Falcon')).toBeVisible();
    });

    it('keeps the layout question open and says why, rather than looking like it worked', async () => {
      const { user } = showBoard({
        layouts: [aLayout('wide', 2560, ['falcon', 'reading'])],
        error: new CommandRefused(404, 'panel reading is not on this dashboard'),
        variables: { name: 'save_layout', payload: {} },
      });

      await choose(user, 'To read', 'Move left');
      await user.click(screen.getByRole('button', { name: 'Change this layout' }));

      expect(screen.getByRole('alert')).toHaveTextContent('panel reading is not on this dashboard');
      expect(screen.getByText(/Keep the change where\?/)).toBeVisible();
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
