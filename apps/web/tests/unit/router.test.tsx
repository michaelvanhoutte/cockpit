import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
