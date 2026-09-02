import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { Dashboard, Workspace } from '@cockpit/shared';
import { createAppRouter } from '../../src/router';
import { NotSignedIn, fetchMe, fetchSnapshot, fetchUsers, fetchWorkspaces } from '../../src/api/client';

/**
 * F1: where the app sends you is a decision the router makes from the list of
 * workspaces, and both ends of that are replaced here - the reads at the API
 * client, the history in memory. What it cannot prove is that a real browser's
 * Back button lands on it, which is the one walk in
 * tests/e2e/workspace-management.test.ts.
 *
 * Stated as what is on screen rather than as which route resolved: a redirect
 * to a route whose page does not render leaves someone looking at nothing, and
 * a test of the redirect alone would pass through that.
 */
vi.mock('../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/api/client')>()),
  fetchWorkspaces: vi.fn(),
  fetchSnapshot: vi.fn(),
  fetchMe: vi.fn(),
  fetchUsers: vi.fn(),
}));

const readsWorkspaces = vi.mocked(fetchWorkspaces);
const readsSnapshot = vi.mocked(fetchSnapshot);
const readsWhoIAm = vi.mocked(fetchMe);
const readsUsers = vi.mocked(fetchUsers);

const SIGNED_IN = { user: { id: 'user-michael', name: 'Michael' } };

const work: Workspace = { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', ground: '#e3e1f2', header: '#d2cdea' };
const personal: Workspace = { id: 'ws-personal', tenantId: 'tenant', name: 'Personal', color: '#c06a45', ground: '#f2e5d4', header: '#ead2b3' };

/**
 * The dashboards a workspace has. Every workspace has at least one - it is
 * created with it - so the first of these is what a workspace opens on when
 * nothing has been remembered.
 */
function dashboardsOf(workspaceId: string): Dashboard[] {
  return [
    { id: `${workspaceId}-dashboard-1`, tenantId: 'tenant', workspaceId, name: 'Dashboard 1' },
    { id: `${workspaceId}-research`, tenantId: 'tenant', workspaceId, name: 'Research' },
  ];
}

/**
 * Opens the app at `at`, with `have` as the workspaces there are and, where a
 * case cares, `boards` as the dashboards each of them has.
 */
async function open(
  at: string,
  have: Workspace[],
  boards: (workspaceId: string) => Dashboard[] = dashboardsOf,
) {
  readsWorkspaces.mockResolvedValue({ workspaces: have });
  // A workspace that is not there has no snapshot, exactly as the server has
  // none for it. Answering anyway would let a page for a deleted workspace
  // render, and every case below would pass whether or not it redirected.
  readsSnapshot.mockImplementation((workspaceId) => {
    const workspace = have.find((w) => w.id === workspaceId);
    return workspace
      ? Promise.resolve({
          workspace,
          items: [],
          dashboards: boards(workspace.id),
          panels: [],
          layouts: [],
          associations: [],
          generatedAt: '2026-08-31T10:00:00.000Z',
        })
      : Promise.reject(new Error(`snapshot failed: 404`));
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Through the address bar jsdom already has, rather than by replacing the
  // router's history after it was built: the app's own router is what is under
  // test, and one built differently from the real one proves less.
  window.history.pushState({}, '', at);
  const router = createAppRouter(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** jsdom has no EventSource, and the app shell opens one on every route. */
class NoStream {
  addEventListener() {}
  close() {}
}

/**
 * A screen whose width can change, which is what the app has to survive: jsdom
 * answers every media query with "no" and never changes its mind, so a window
 * being resized past the breakpoint exists only if a case makes it.
 *
 * Returns the handle for doing that. `withRoomForTheInbox()` is the common
 * case - wide from the start - and says so out loud, because everything else
 * here runs on the narrow shape jsdom gives for free.
 */
function screenThatCanBeResized() {
  const watching = new Set<() => void>();
  let wide = false;
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return wide;
    },
    addEventListener: (_: string, listener: () => void) => void watching.add(listener),
    removeEventListener: (_: string, listener: () => void) => void watching.delete(listener),
  }));
  return {
    widen() {
      wide = true;
      act(() => watching.forEach((listener) => listener()));
    },
  };
}

function withRoomForTheInbox() {
  screenThatCanBeResized().widen();
}

/** The Inbox as the column it is where there is room for one. */
const inboxColumn = () => screen.queryByRole('complementary', { name: 'Inbox' });

beforeEach(() => {
  vi.stubGlobal('EventSource', NoStream);
  // Signed in unless a case says otherwise: the shell asks who you are on every
  // route, and a browser holding no answer would be sent to the logon page.
  readsWhoIAm.mockResolvedValue(SIGNED_IN);
  readsUsers.mockResolvedValue([{ id: 'user-michael', name: 'Michael' }]);
  // Which view a workspace opens on is remembered in the browser, so each case
  // starts having remembered nothing.
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Workspace management', () => {
  describe('the app opens somewhere you can work, whatever workspaces you have', () => {
    it('opens the first workspace you have', async () => {
      await open('/', [work, personal]);

      // On that workspace, and on a view of it: the tabs say which workspace,
      // the bar under them says which view.
      expect(await screen.findByRole('navigation', { name: 'Dashboards' })).toBeVisible();
      expect(screen.getByRole('link', { name: 'Work' })).toBeVisible();
    });

    it('opens another workspace when the one asked for is no longer there', async () => {
      await open('/w/ws-deleted', [work, personal]);

      expect(await screen.findByRole('navigation', { name: 'Dashboards' })).toBeVisible();
    });

    it.each([
      { situation: 'from the start page', at: '/' },
      { situation: 'from a workspace that has been deleted', at: '/w/ws-deleted' },
    ])('invites you to make one when you have none, $situation', async ({ at }) => {
      await open(at, []);

      // The invitation is the box you type the name into, not a screen whose
      // only content is a link to it.
      expect(await screen.findByLabelText('Name of the new workspace')).toBeVisible();
      expect(screen.getByText('No workspaces yet. Make your first one below.')).toBeVisible();
    });
  });
});

describe('Triage', () => {
  describe('a workspace always shows its Inbox, beside the dashboards or instead of them', () => {
    it.each([
      { situation: 'on a dashboard', at: '/w/ws-work/d/ws-work-research' },
      { situation: 'on the page its dashboards are managed from', at: '/w/ws-work/settings/dashboards' },
    ])('$situation, it is the column beside it', async ({ at }) => {
      withRoomForTheInbox();

      await open(at, [work, personal]);

      await screen.findByRole('navigation', { name: 'Dashboards' });
      // The Inbox itself, not merely a column: capture is its first row
      // wherever it is rendered. Waited for, because the column paints before
      // the snapshot behind it has arrived.
      expect(await screen.findByLabelText('Capture a note or to-do')).toBeVisible();
      expect(inboxColumn()).toBeVisible();
      // And it is no longer one of the views to switch between, because it is
      // not something you switch to any more.
      expect(screen.queryByRole('link', { name: 'Inbox' })).toBeNull();
    });

    it('arrives when the window is widened past the breakpoint, without going anywhere', async () => {
      // The whole reason the shell watches the question rather than asking it
      // once: a route decides on arrival, and a window is resized long after.
      const screenWidth = screenThatCanBeResized();
      await open('/w/ws-work/d/ws-work-research', [work, personal]);
      const bar = await screen.findByRole('navigation', { name: 'Dashboards' });
      expect(inboxColumn()).toBeNull();

      screenWidth.widen();

      expect(inboxColumn()).toBeVisible();
      // Still on the dashboard it was on: widening the window is not a
      // navigation, and the tab it no longer needs has gone.
      expect(screen.getByRole('heading', { name: 'Research' })).toBeVisible();
      expect(within(bar).queryByRole('link', { name: 'Inbox' })).toBeNull();
    });

    it('is not there on the page reached without a workspace', async () => {
      // The workspaces settings page is where the first workspace is made, so
      // there is no workspace to have an Inbox.
      withRoomForTheInbox();

      await open('/settings/workspaces', [work, personal]);

      expect(await screen.findByLabelText('Name of the new workspace')).toBeVisible();
      expect(inboxColumn()).toBeNull();
    });

    it('is a view of its own where there is no room to put it beside', async () => {
      await open('/w/ws-work/d/ws-work-research', [work, personal]);

      const bar = await screen.findByRole('navigation', { name: 'Dashboards' });
      expect(inboxColumn()).toBeNull();
      expect(within(bar).getByRole('link', { name: 'Inbox' })).toBeVisible();
    });

    it('answers its own address with a dashboard where it is already on screen', async () => {
      // The address stays good - a link made on a phone, or a workspace that
      // remembered the Inbox - and rendering it here as well would show the
      // Inbox twice.
      withRoomForTheInbox();

      await open('/w/ws-work/inbox', [work, personal]);

      expect(await screen.findByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(inboxColumn()).toBeVisible();
    });

    it('answers its own address with the Inbox where there is no room beside', async () => {
      await open('/w/ws-work/inbox', [work, personal]);

      expect(await screen.findByRole('region', { name: 'Inbox' })).toBeVisible();
      expect(inboxColumn()).toBeNull();
    });

    it('says a workspace could not be read once, not once per place the Inbox is drawn', async () => {
      // The address reads the workspace before it paints, like the two routes
      // beside it. Without that, a cold cache - a hard reload, or a link
      // straight here - renders the Inbox in the outlet *and* in its column,
      // neither of them knowing yet that there is a dashboard to go to; and a
      // read that then fails leaves both of them there, saying the same thing
      // twice, for good.
      withRoomForTheInbox();
      readsWorkspaces.mockResolvedValue({ workspaces: [work, personal] });
      readsSnapshot.mockRejectedValue(new TypeError('Failed to fetch'));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      window.history.pushState({}, '', '/w/ws-work/inbox');
      render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={createAppRouter(queryClient)} />
        </QueryClientProvider>,
      );

      const said = await screen.findAllByRole('heading', { name: "Cockpit can't be reached" });
      expect(said).toHaveLength(1);
    });

    it('stays on the Inbox where there is nowhere else to go, rather than bouncing', async () => {
      // A workspace with no dashboards cannot happen - one is created with a
      // dashboard and its last cannot be deleted - and both this and
      // `viewToOpen` answer it anyway, because the two answers together are a
      // loop if either is careless: the workspace's address sends you here,
      // and here would send you straight back.
      withRoomForTheInbox();

      await open('/w/ws-work/inbox', [work, personal], () => []);

      // Twice: the column, and the screen that did not send you away. That is
      // the price of the guard, and it is a better screen than two addresses
      // bouncing off each other.
      expect(await screen.findAllByRole('region', { name: 'Inbox' })).toHaveLength(2);
    });
  });
});

describe('Dashboards', () => {
  describe('opening a workspace lands you on the view you were last on there', () => {
    /** Being on a view is what remembers it, so this is how a case arranges one. */
    async function havingBeenOn(at: string) {
      await open(at, [work, personal]);
      await screen.findByRole('navigation', { name: 'Dashboards' });
      cleanup();
    }

    it('opens its first dashboard when the workspace has never been opened', async () => {
      await open('/w/ws-work', [work, personal]);

      expect(await screen.findByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
    });

    it('opens the dashboard you were last on', async () => {
      await havingBeenOn('/w/ws-work/d/ws-work-research');

      await open('/w/ws-work', [work, personal]);

      expect(await screen.findByRole('heading', { name: 'Research' })).toBeVisible();
    });

    it('opens the Inbox when that is what you were last on', async () => {
      await havingBeenOn('/w/ws-work/inbox');

      await open('/w/ws-work', [work, personal]);

      expect(await screen.findByLabelText('Capture a note or to-do')).toBeVisible();
    });

    it('opens the first dashboard when the one remembered is no longer there', async () => {
      await havingBeenOn('/w/ws-work/d/ws-work-research');
      // The same workspace, without the dashboard that was remembered.
      await open('/w/ws-work', [work, personal], (id) => dashboardsOf(id).slice(0, 1));

      expect(await screen.findByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
    });

    it('does not remember a view you only brushed past', async () => {
      // Links are preloaded on intent, which runs a route's `beforeLoad`
      // without anybody having gone there. Remembering in it would mean the
      // mouse passing over a tab decides where the workspace opens next time.
      //
      // Preloaded through the router's own API rather than by hovering: a
      // hover in jsdom never reaches the preload path, so a case that hovered
      // would pass whether or not the guard was there.
      await havingBeenOn('/w/ws-work/inbox');
      readsWorkspaces.mockResolvedValue({ workspaces: [work, personal] });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const router = createAppRouter(queryClient);

      await router.preloadRoute({
        to: '/w/$workspaceId/d/$dashboardId',
        params: { workspaceId: 'ws-work', dashboardId: 'ws-work-research' },
      });

      await open('/w/ws-work', [work, personal]);
      expect(await screen.findByLabelText('Capture a note or to-do')).toBeVisible();
    });

    it('opens from the copy it already has when the workspace cannot be read', async () => {
      // What this pins is that the route reads the stored copy rather than the
      // network. A network-first read costs the person twice over: a failing
      // fetch retries with backoff before it rejects, and a genuinely offline
      // one is paused rather than failed, so it never settles and the route
      // never commits. Reading what you already have is what the stored copy is
      // for (functional definition, "Offline / local-first behavior").
      readsWorkspaces.mockResolvedValue({ workspaces: [work, personal] });
      readsSnapshot.mockRejectedValue(new Error('Failed to fetch'));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(
        ['snapshot', 'ws-work'],
        {
          workspace: work,
          items: [],
          dashboards: dashboardsOf('ws-work'),
          panels: [],
          layouts: [],
          associations: [],
          generatedAt: '2026-08-31T10:00:00.000Z',
        },
        // Older than the fifteen seconds a snapshot stays fresh, which is what
        // makes the route re-read it at all. A copy stored a moment ago is
        // answered from the cache and never reaches the network, so the case
        // would pass whether or not the failed read fell back to it.
        { updatedAt: Date.now() - 60_000 },
      );
      window.history.pushState({}, '', '/w/ws-work');
      render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={createAppRouter(queryClient)} />
        </QueryClientProvider>,
      );

      expect(await screen.findByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
    });

    it('opens the first dashboard, not the Inbox, when the Inbox is beside it anyway', async () => {
      // A remembered Inbox is not a view to return to where the Inbox has a
      // column of its own: returning to it would land you on a workspace
      // showing the same thing twice.
      await havingBeenOn('/w/ws-work/inbox');
      withRoomForTheInbox();

      await open('/w/ws-work', [work, personal]);

      expect(await screen.findByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
    });

    it('opens each workspace on its own, not on the other one’s', async () => {
      await havingBeenOn('/w/ws-work/d/ws-work-research');

      await open('/w/ws-personal', [work, personal]);

      // Personal was never opened, so it opens on its own first dashboard -
      // not on the Research that Work remembers.
      expect(await screen.findByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
    });
  });
});

describe('Sign-in', () => {
  describe('opening the app shows your last view before it checks that you are still signed in', () => {
    /**
     * F1 because this is about what renders while the check is in flight -
     * component state, not layout - and because both halves of it need the
     * check held open or failed on purpose, which no browser can be asked for.
     *
     * It gets a rule of its own because this is the first change able to break
     * the standing never-block-paint rule (architecture, "Performance budgets
     * and the standing rules"): opening the app on a train has to show your
     * work, not a spinner over a question nothing can answer.
     */
    async function openWithAStoredCopy() {
      readsWorkspaces.mockResolvedValue({ workspaces: [work] });
      readsSnapshot.mockResolvedValue({
        workspace: work,
        items: [],
        dashboards: dashboardsOf('ws-work'),
        panels: [],
        layouts: [],
        associations: [],
        generatedAt: '2026-08-31T10:00:00.000Z',
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      window.history.pushState({}, '', '/w/ws-work');
      render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={createAppRouter(queryClient)} />
        </QueryClientProvider>,
      );
    }

    it('paints the view without waiting to hear whether the sign-in is still good', async () => {
      // Never answers, so anything that waited for it would wait forever.
      readsWhoIAm.mockImplementation(() => new Promise(() => {}));

      await openWithAStoredCopy();

      expect(await screen.findByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
    });

    it('paints the view, then puts the logon page over it once the sign-in turns out to be gone', async () => {
      readsWhoIAm.mockRejectedValue(new NotSignedIn('sign-in failed: 401'));

      await openWithAStoredCopy();

      expect(await screen.findByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(await screen.findByText('Choose who you are.')).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'Dashboard 1' })).not.toBeInTheDocument();
      // A logon page you can actually sign in from. That it lists anybody is
      // not free: emptying what the browser was holding happens while this
      // page's own read is in flight, and the browser walk in
      // tests/e2e/sign-in.test.ts is what caught that going wrong - this level
      // cannot produce the timing, and is here to say the page is usable at
      // all rather than to guard that.
      expect(await screen.findByRole('button', { name: 'Michael' })).toBeVisible();
    });
  });
});
