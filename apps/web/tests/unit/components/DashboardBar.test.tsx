import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, Layout, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { DashboardBar } from '../../../src/components/DashboardBar';
import { CommandRefused } from '../../../src/api/client';
import { useCommand } from '../../../src/api/queries';
import { ITEM_BEING_DRAGGED } from '../../../src/dropAt';
import { DWELL_MS } from '../../../src/switchWhileDragging';

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
    params: _params,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: unknown;
    params?: unknown;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href="#" {...rest}>
      {children}
    </a>
  ),
  // Adding one switches to it, so the navigating is replaced and what it was
  // asked for is read back.
  useNavigate: () => (to: unknown) => {
    wentTo.calls.push(to);
  },
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
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

function aDashboard(name: string): Dashboard {
  return {
    id: `ws-work-${name.toLowerCase()}`,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    name,
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
  } = {},
) {
  held.dashboards = names.map(aDashboard);
  held.panels = answer.panels ?? [];
  held.layouts = answer.layouts ?? [];
  wentTo.calls = [];
  const asked = { error: answer.error ?? null };
  const mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => {
    if (!answer.error) options?.onSuccess?.();
  });
  const reset = vi.fn(() => {
    asked.error = null;
  });
  mockUseCommand.mockImplementation(
    () => ({ mutate, reset, isPending: false, error: asked.error }) as never,
  );
  const { container } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DashboardBar
        workspaceId="ws-work"
        tint="#6f62b5"
        ground="#e3e1f2"
        openDashboardId={answer.openDashboardId ?? null}
      />
    </QueryClientProvider>,
  );
  return { mutate, container, user: userEvent.setup() };
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

  describe('the bar opens a menu of its own, and managing dashboards is an entry in it', () => {
    // It used to be three dots that navigated straight to the settings page:
    // a menu's glyph on a link ("Open every menu from the same control",
    // issue 115). What the list itself does is
    // tests/unit/components/ManageDashboards.test.tsx.
    it('opens on the control and closes again without going anywhere', async () => {
      const { user } = showBar(['Dashboard 1']);

      expect(screen.queryByRole('menu')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Dashboard actions' }));

      expect(await screen.findByRole('menuitem', { name: 'Manage dashboards' })).toBeVisible();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  describe('the dashboards are managed over the workspace, not on a screen of their own', () => {
    it('opens the list in place, leaving the bar behind it', async () => {
      const { user } = showBar(['Dashboard 1', 'Research']);
      await screen.findByRole('link', { name: 'Research' });

      await user.click(screen.getByRole('button', { name: 'Dashboard actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Manage dashboards' }));

      expect(await screen.findByRole('dialog', { name: 'Manage dashboards' })).toBeVisible();
      // Nowhere: the whole point of it being a dialog is that what you were
      // looking at is still there when it closes. The bar is behind it and
      // hidden from a reader while it is open, which is what a modal is for -
      // so this asks for it again afterwards rather than through it.
      expect(wentTo.calls).toEqual([]);

      await user.click(screen.getByRole('button', { name: 'Done' }));

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('link', { name: 'Research' })).toBeVisible();
      expect(wentTo.calls).toEqual([]);
    });

    it('leaves the focus on the control it was opened from, and puts it back', async () => {
      // The entry is the only way in, so the dialog has no trigger of its own
      // to return the focus to and Radix would drop it at the top of the page.
      // The menu closing must not claim it back either, or it would take it
      // straight off the dialog that has just opened.
      const { user } = showBar(['Dashboard 1', 'Research']);

      await user.click(screen.getByRole('button', { name: 'Dashboard actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Manage dashboards' }));
      const list = await screen.findByRole('dialog', { name: 'Manage dashboards' });
      expect(list.contains(document.activeElement)).toBe(true);

      await user.click(screen.getByRole('button', { name: 'Done' }));

      expect(screen.getByRole('button', { name: 'Dashboard actions' })).toHaveFocus();
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
 * ("Pick the layout you are on, by name"). Which layout the automatic choice
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
  };

  /** The width the picker reads, which is what the automatic choice compares. */
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

  describe('the control says which arrangement you are looking at, and how it was picked', () => {
    it.each([
      {
        situation: 'nothing has been picked in this browser',
        pick: null,
        saysAuto: true,
        andNames: 'Laptop',
      },
      {
        situation: 'a layout was picked by hand',
        pick: 'wide',
        saysAuto: false,
        andNames: 'Wide',
      },
    ])('$situation', async ({ pick, saysAuto, andNames }) => {
      if (pick) localStorage.setItem('cockpit.layout.' + OPEN, pick);
      showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        layouts: [aLayout('laptop', 'Laptop', 1280), aLayout('wide', 'Wide', 2560)],
      });

      const control = await theControl(andNames);
      // Saying *which* of the two ways you are on it is the whole point: the
      // automatic choice used to happen with nothing on screen admitting to it.
      if (saysAuto) expect(control).toHaveTextContent('Auto');
      else expect(control).not.toHaveTextContent('Auto');
    });

    it.each([
      {
        situation: 'the choice was made by the screen',
        pick: null,
        announced: /^Layout for this dashboard: Laptop, chosen automatically$/,
      },
      {
        situation: 'a layout was picked by hand',
        pick: 'wide',
        announced: /^Layout for this dashboard: Wide$/,
      },
    ])('says which layout is in use to a screen reader too, when $situation', async ({
      pick,
      announced,
    }) => {
      // The label used to name the control and not its value, so anything not
      // looking at the bar was told there was a layout control and never which
      // layout - which is the whole of what it is for.
      if (pick) localStorage.setItem('cockpit.layout.' + OPEN, pick);
      showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        layouts: [aLayout('laptop', 'Laptop', 1280), aLayout('wide', 'Wide', 2560)],
      });

      expect(await screen.findByRole('button', { name: announced })).toBeVisible();
    });

    it('falls back to Automatic when the layout you picked was deleted elsewhere', async () => {
      // The stored choice outlives the layout it names: falling through to the
      // closest remaining one is deliberate, and nothing clears the id. Read
      // raw, that choice would drop the Auto badge, announce a hand-picked
      // layout, and leave the menu marking neither Automatic nor any layout in
      // it - which is the undifferentiated list this control replaces.
      localStorage.setItem('cockpit.layout.' + OPEN, 'deleted-elsewhere');
      const { user } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        layouts: [aLayout('laptop', 'Laptop', 1280)],
      });

      const control = await theControl('Laptop');
      expect(control).toHaveTextContent('Auto');
      expect(control).toHaveAccessibleName(/chosen automatically$/);

      await user.click(control);
      expect(screen.getByRole('menuitemradio', { name: /^Automatic/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    it('draws a layout written before names existed as the width it was made for', async () => {
      // What old code writes for the seconds of a deploy that both versions
      // serve. A blank entry in the menu would be worse than the old label.
      showBar(['Dashboard 1'], { openDashboardId: OPEN, layouts: [aLayout('l', '', 1440)] });

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
      const { user, mutate } = showBar(['Dashboard 1'], {
        openDashboardId: OPEN,
        panels: [FALCON],
        layouts: [aLayout('laptop', 'Laptop', 1280)],
      });

      await user.click(await theControl('Laptop'));
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
      // as one.
      expect(localStorage.getItem('cockpit.layout.' + OPEN)).toBe(asked.payload.layoutId);
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
});
