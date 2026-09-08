import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, Layout, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { DashboardBar } from '../../../src/components/DashboardBar';
import { CommandRefused } from '../../../src/api/client';
import { useCommand, useSendCommand } from '../../../src/api/queries';
import { ITEM_BEING_DRAGGED } from '../../../src/dropAt';
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
  /**
   * Which dashboard the address names, so the stand-in `Link` below can mark
   * that tab the way the router marks it. Without it no tab is ever current
   * here, and every rule about the tab you are on would pass by asking nothing.
   */
  openDashboardId: null as string | null,
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
    to: _to,
    params,
    className,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: unknown;
    params?: { dashboardId?: string };
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href="#"
      // `active` the way the router adds it to the tab whose address is the one
      // on screen, which is what the bar's own styling and its focus after a
      // delete both read.
      className={`${className ?? ''}${
        params?.dashboardId && params.dashboardId === held.openDashboardId ? ' active' : ''
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
        itemTypes: [],
        filings: [],
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
  } = {},
) {
  held.dashboards = names.map(aDashboard);
  held.panels = answer.panels ?? [];
  held.layouts = answer.layouts ?? [];
  held.openDashboardId = answer.openDashboardId ?? null;
  wentTo.calls = [];
  const asked: { error: Error | null; variables: unknown } = {
    error: answer.error ?? null,
    variables: null,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mutate = vi.fn((args: AskedFor, options?: { onSuccess?: () => void }) => {
    asked.variables = args;
    if (answer.error) return;
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
  });
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
      />
    </QueryClientProvider>
  );
  const { container, rerender } = render(bar(answer.openDashboardId ?? null));
  return {
    mutate,
    sent,
    container,
    /** The same bar with another dashboard open, which is what a switch is. */
    switchTo: (openDashboardId: string | null) => {
      held.openDashboardId = openDashboardId;
      rerender(bar(openDashboardId));
    },
    user: userEvent.setup(),
  };
}

describe('Dashboards', () => {
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
        },
      ]);
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
 * F1: the dashboard's own controls, which live at the right of its own bar
 * ("Layouts follow the screen you are on"). Which layout a screen
 * lands on is arithmetic and is settled in tests/unit/panels/arrangement.test.ts;
 * whether the server accepts a name is proved against a real store in
 * apps/api/tests/integration/http/panels.test.ts.
 */
describe('Layouts', () => {
  const OPEN = 'ws-work-dashboard 1';

  function aLayout(id: string, name: string, screenWidth: number): Layout {
    return {
      id,
      tenantId: 'tenant',
      dashboardId: OPEN,
      name,
      screenWidth,
      rows: [{ height: null, cells: [{ panelId: 'falcon', span: 12 }] }],
    };
  }

  const FALCON: Panel = {
    id: 'falcon',
    tenantId: 'tenant',
    dashboardId: OPEN,
    name: 'Project Falcon',
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
  };

  /** The width the picker reads, which is what a screen is matched on. */
  function screenIs(width: number) {
    Object.defineProperty(globalThis, 'innerWidth', {
      value: width,
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    screenIs(1280);
    localStorage.clear();
  });

  /**
   * The control, once the snapshot behind it has arrived.
   *
   * The bar paints from the first render and the layouts come with the
   * workspace's snapshot a tick later, so asking for the control straight away
   * finds it saying *No layout yet* - which is true of that instant and not of
   * what is being tested.
   */
  async function theControl(named: string) {
    const control = await screen.findByRole('button', { name: /^Layout for this dashboard/ });
    await waitFor(() => expect(control).toHaveTextContent(named));
    return control;
  }

  describe('the dashboard’s own controls are on the right of its bar, and only where there is one', () => {
    it('offers the layout in use and the way to add a panel while a dashboard is open', async () => {
      showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: [aLayout('l', 'Wide', 1280)] });

      expect(
        await screen.findByRole('button', { name: /^Layout for this dashboard/ }),
      ).toBeVisible();
      expect(screen.getByRole('button', { name: '+ Panel' })).toBeVisible();
    });

    it('offers neither on the Inbox, where there is no dashboard to have either', async () => {
      // The bar is the shell's and is drawn on the Inbox too. That is why these
      // used to be kept off it; mounting them only where a dashboard is open is
      // the answer instead.
      showBar(['Dashboard 1'], { openDashboardId: null });

      await screen.findByRole('link', { name: 'Dashboard 1' });
      expect(screen.queryByRole('button', { name: /^Layout for this dashboard/ })).toBeNull();
      expect(screen.queryByRole('button', { name: '+ Panel' })).toBeNull();
    });
  });

  describe('the control names the layout you are looking at, and its menu offers only layouts', () => {
    /** A pick of `layoutId`, made on a screen whose nearest layout is `whileNearestIs`. */
    function picked(layoutId: string, whileNearestIs: string) {
      localStorage.setItem(
        'cockpit.layout.' + OPEN,
        JSON.stringify({ layoutId, whileNearestIs }),
      );
    }

    const BOTH = [aLayout('laptop', 'Laptop', 1280), aLayout('wide', 'Wide', 2560)];

    it.each([
      { situation: 'nothing has been picked in this browser', pick: null, names: 'Laptop' },
      {
        situation: 'a layout was picked by hand, on this screen',
        pick: ['wide', 'laptop'],
        names: 'Wide',
      },
      // The screen moved out from under the pick, which is the feature: *Wide*
      // was pressed on the 4K screen and this is the laptop, so the bar names
      // the laptop's own layout rather than the one still stored.
      {
        situation: 'a layout picked on a screen you have since left',
        pick: ['wide', 'wide'],
        names: 'Laptop',
      },
      // The stored pick outlives the layout it names: falling through to the
      // nearest remaining one is deliberate, and nothing clears the id.
      {
        situation: 'a picked layout another device deleted',
        pick: ['deleted-elsewhere', 'laptop'],
        names: 'Laptop',
      },
    ])('$situation', async ({ pick, names }) => {
      if (pick) picked(pick[0]!, pick[1]!);
      showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: BOTH });

      await theControl(names);
    });

    it('says nothing about how the layout was picked, there being no mode to be in', async () => {
      // The badge said which of two ways you were on a layout, and it went with
      // the mode it was reporting on. A dashboard follows the screen now.
      showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: BOTH });

      expect(await theControl('Laptop')).not.toHaveTextContent('Auto');
    });

    it.each([
      { situation: 'nothing has been picked', pick: null, announced: 'Laptop' },
      { situation: 'a layout was picked by hand', pick: ['wide', 'laptop'], announced: 'Wide' },
    ])('names the layout in use to a screen reader too, when $situation', async ({
      pick,
      announced,
    }) => {
      // The label used to name the control and not its value, so anything not
      // looking at the bar was told there was a layout control and never which
      // layout - which is the whole of what it is for.
      if (pick) picked(pick[0]!, pick[1]!);
      showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: BOTH });

      expect(
        await screen.findByRole('button', {
          name: new RegExp(`^Layout for this dashboard: ${announced}$`),
        }),
      ).toBeVisible();
    });

    it.each([
      { situation: 'nothing has been picked', pick: null, marks: 'Laptop' },
      { situation: 'a layout was picked by hand', pick: ['wide', 'laptop'], marks: 'Wide' },
      // Read raw, a pick naming a layout that has gone would leave the menu
      // marking nothing at all - the undifferentiated list this control exists
      // to replace, one menu deeper.
      {
        situation: 'a picked layout another device deleted',
        pick: ['deleted-elsewhere', 'laptop'],
        marks: 'Laptop',
      },
    ])('marks the layout actually drawn, when $situation', async ({ pick, marks }) => {
      if (pick) picked(pick[0]!, pick[1]!);
      const { user } = showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: BOTH });

      await user.click(await theControl(marks));

      expect(screen.getByRole('menuitemradio', { name: new RegExp(`^${marks}`) })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    it('lists the layouts and no entry that is not one', async () => {
      // There was an *Automatic* row above them, meaning "draw whichever is
      // nearest". Following the screen is what a dashboard does rather than a
      // row you can be on, so the list is layouts and only layouts.
      const { user } = showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: BOTH });

      await user.click(await theControl('Laptop'));

      expect(screen.getAllByRole('menuitemradio').map((entry) => entry.textContent)).toEqual([
        'Laptopmade at 1280 px',
        'Widemade at 2560 px',
      ]);
    });

    it('puts you on the layout you press, for as long as you are on this screen', async () => {
      const { user } = showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: BOTH });

      await user.click(await theControl('Laptop'));
      await user.click(screen.getByRole('menuitemradio', { name: /^Wide/ }));

      await theControl('Wide');
      // The answer it overrides, not the width it was pressed at: that is what
      // makes it expire on the screen rather than on a resize.
      expect(JSON.parse(localStorage.getItem('cockpit.layout.' + OPEN)!)).toEqual({
        layoutId: 'wide',
        whileNearestIs: 'laptop',
      });
    });

    it('goes back to the screen’s own layout when you press the one it would draw', async () => {
      // Pressing the nearest layout is the way out of a pick, and the only one
      // from the menu - which is why it is stored even though it changes
      // nothing on its own. Without it the press would be a no-op and *Wide*
      // would still be drawn on a screen whose own layout is *Laptop*.
      picked('wide', 'laptop');
      const { user } = showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: BOTH });

      await user.click(await theControl('Wide'));
      await user.click(screen.getByRole('menuitemradio', { name: /^Laptop/ }));

      await theControl('Laptop');
    });

    it('draws a layout written before names existed as the width it was made for', async () => {
      // What old code writes for the seconds of a deploy that both versions
      // serve. A blank entry in the menu would be worse than the old label.
      showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: [aLayout('l', '', 1440)] });

      await theControl('1440 px');
    });

    it('draws one from a copy stored before names existed, rather than taking the bar down', async () => {
      // Not an empty name but no name at all, which is what the stored copy
      // holds: nothing parses what comes back out of IndexedDB, so a layout
      // written before the name existed arrives without the field. Reading it
      // threw inside this control and took the whole workspace off screen.
      const nameless = { ...aLayout('l', '', 1440) } as Partial<Layout>;
      delete nameless.name;
      showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: [nameless as Layout] });

      await theControl('1440 px');
    });
  });

  describe('a dashboard that has a layout keeps one', () => {
    it('says why the only one cannot go, rather than offering it and refusing', async () => {
      const { user } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        layouts: [aLayout('l', 'Wide', 1280)],
      });

      await user.click(await theControl('Wide'));

      expect(
        screen.getByRole('menuitem', { name: /A dashboard keeps at least one layout/ }),
      ).toHaveAttribute('aria-disabled', 'true');
    });

    it('offers the delete when there is another layout to fall back to', async () => {
      const { user } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        layouts: [aLayout('laptop', 'Laptop', 1280), aLayout('wide', 'Wide', 2560)],
      });

      await user.click(await theControl('Laptop'));

      expect(screen.getByRole('menuitem', { name: 'Delete Laptop' })).not.toHaveAttribute(
        'aria-disabled',
      );
    });
  });

  describe('a layout is renamed, made and deleted from the same control', () => {
    it('renames the one being drawn, without resending the arrangement', async () => {
      // Its own command, so a bar holding a stale arrangement cannot put the
      // panels back as the price of changing a word.
      const { user, mutate } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        layouts: [aLayout('laptop', 'Laptop', 1280)],
      });

      await user.click(await theControl('Laptop'));
      await user.click(screen.getByRole('menuitem', { name: 'Rename Laptop…' }));
      const box = screen.getByLabelText('New name for this layout');
      await user.clear(box);
      await user.type(box, '  The big one  ');
      await user.click(screen.getByRole('button', { name: 'Rename' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('rename_layout');
      expect(asked.payload.layoutId).toBe('laptop');
      expect(asked.payload.name).toBe('The big one');
      expect(asked.payload.placements).toBeUndefined();
    });

    it('makes a new one from the arrangement on screen, and puts you on it', async () => {
      // The one layout it has was made for a wider screen than this one, so
      // what is being made here is the nearest thing to 1280 the moment it
      // lands - the ordinary case, with the tie below as the other one.
      const { user, mutate } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        panels: [FALCON],
        layouts: [aLayout('wide', 'Wide', 2560)],
      });

      await user.click(await theControl('Wide'));
      await user.click(screen.getByRole('menuitem', { name: 'New layout from this one…' }));
      await user.click(screen.getByRole('button', { name: 'Create' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('save_layout');
      expect(asked.payload.screenWidth).toBe(1280);
      // A copy, which is what "from this one" means.
      expect(asked.payload.rows).toEqual([
        { height: null, cells: [{ panelId: 'falcon', span: 12 }] },
      ]);
      // Making one and then having to pick it is two gestures for what reads
      // as one - and on this screen only, since a layout made on the laptop is
      // not one the 4K screen should be left drawing. It is recorded at this
      // width, so it is what the screen will land on by itself.
      expect(JSON.parse(localStorage.getItem('cockpit.layout.' + OPEN)!)).toEqual({
        layoutId: asked.payload.layoutId,
        whileNearestIs: asked.payload.layoutId,
      });
    });

    it('puts you on a new one made at a width another layout already has', async () => {
      // The tie-break hands the width rule to whichever came first, so the one
      // just made is not what the screen would land on - and making a layout
      // and not being put on it is the gesture failing in front of you. This
      // is the case that makes recording the pick necessary at all.
      const { user, mutate } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        panels: [FALCON],
        layouts: [aLayout('laptop', 'Laptop', 1280)],
      });

      await user.click(await theControl('Laptop'));
      await user.click(screen.getByRole('menuitem', { name: 'New layout from this one…' }));
      await user.click(screen.getByRole('button', { name: 'Create' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.payload.screenWidth).toBe(1280);
      expect(JSON.parse(localStorage.getItem('cockpit.layout.' + OPEN)!)).toEqual({
        layoutId: asked.payload.layoutId,
        whileNearestIs: 'laptop',
      });
    });

    it('copies the arrangement as drawn, not the one stored, so it cannot name a panel that has gone', async () => {
      // The layout still names a panel the dashboard no longer has. The board
      // reconciles that when it draws (`drawnArrangement`); the copy has to as
      // well, or it sends a placement the server refuses outright.
      const { user, mutate } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        panels: [],
        layouts: [aLayout('laptop', 'Laptop', 1280)],
      });

      await user.click(await theControl('Laptop'));
      await user.click(screen.getByRole('menuitem', { name: 'New layout from this one…' }));
      await user.click(screen.getByRole('button', { name: 'Create' }));

      expect(mutate.mock.calls[0]![0].payload.rows).toEqual([]);
    });

    it('offers a name for the screen it is being made on, free on this dashboard', async () => {
      // The server refuses a name this dashboard already holds, and the offered
      // one is generated rather than typed - so a press cannot be met with a
      // collision the person did not cause.
      const { user } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        layouts: [aLayout('wide', 'Wide', 1280)],
      });

      await user.click(await theControl('Wide'));
      await user.click(screen.getByRole('menuitem', { name: 'New layout from this one…' }));

      // 1280px is a wide screen, and this dashboard already has a *Wide*.
      expect(screen.getByLabelText('Name of the new layout')).toHaveValue('Wide 2');
    });

    it('asks before deleting one, and says the panels are staying', async () => {
      const { user, mutate } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        layouts: [aLayout('laptop', 'Laptop', 1280), aLayout('wide', 'Wide', 2560)],
      });

      await user.click(await theControl('Laptop'));
      await user.click(screen.getByRole('menuitem', { name: 'Delete Laptop' }));
      expect(screen.getByRole('alertdialog')).toHaveTextContent(/The panels stay/);
      await user.click(screen.getByRole('button', { name: 'Yes, delete Laptop' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('delete_layout');
      expect(asked.payload.layoutId).toBe('laptop');
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
