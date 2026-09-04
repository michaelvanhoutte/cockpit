import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, WorkspaceSnapshot } from '@cockpit/shared';
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
const held = vi.hoisted(() => ({ dashboards: [] as Dashboard[] }));

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
        panels: [],
        layouts: [],
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
  answer: { error?: Error; openDashboardId?: string | null } = {},
) {
  held.dashboards = names.map(aDashboard);
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
