import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { snapshotQuery, workspacesQuery } from './api/queries';
import { INBOX, browserStore, rememberView, rememberedIn, viewToOpen } from './lastVisited';
import { LoadFailure } from './components/LoadFailure';
import { DashboardPage } from './pages/DashboardPage';
import { Layout } from './pages/Layout';
import { WorkspacePage } from './pages/WorkspacePage';
import { WorkspaceSettingsPage } from './pages/WorkspaceSettingsPage';

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Layout,
});

/**
 * Where you go when you have not said which workspace: the first one you have,
 * or - when the last one has been deleted - the page that makes one. The
 * settings page *is* the invitation: it says there are none and the box to type
 * a name into is right under it. Anything else would be a screen whose only
 * content is a link to that one.
 */
const somewhereThatWorks = async (queryClient: QueryClient) => {
  const { workspaces } = await queryClient.ensureQueryData(workspacesQuery);
  const first = workspaces[0];
  throw first
    ? redirect({ to: '/w/$workspaceId', params: { workspaceId: first.id } })
    : redirect({ to: '/settings/workspaces' });
};

/**
 * A workspace that is no longer there is not a dead end. Deleting the one you
 * were looking at, or coming back to a link for one deleted in another tab,
 * lands you on a workspace that works instead of on a failed snapshot read.
 */
const workspaceMustExist = async (queryClient: QueryClient, workspaceId: string) => {
  const { workspaces } = await queryClient.ensureQueryData(workspacesQuery);
  if (!workspaces.some((w) => w.id === workspaceId)) await somewhereThatWorks(queryClient);
};

/**
 * The workspace's snapshot: re-read when the copy in hand is stale, and the
 * copy in hand when it cannot be re-read.
 *
 * `fetchQuery` rather than `ensureQueryData`, because the second answers from
 * the cache whenever there is one - and the moment this matters most, just
 * after adding a dashboard, that cache is the snapshot from before it existed.
 * The route would decide the new dashboard is not there and send you back to
 * the workspace, which is the dashboard you were on before: adding one would
 * look like doing nothing.
 *
 * But `fetchQuery` alone would trade one failure for a worse one. Past the
 * fifteen seconds a snapshot stays fresh it awaits the network and *rejects* if
 * that fails, which would take every navigation on a bad connection - and every
 * cold open offline - into the router's full-screen error boundary, over a
 * perfectly good snapshot sitting in the persisted cache. Reading what you
 * already have is exactly what that cache is for (functional definition,
 * "Offline / local-first behavior"), so a failed re-read falls back to it and
 * only a workspace with no stored copy at all reaches the boundary.
 */
const dashboardsOf = async (queryClient: QueryClient, workspaceId: string) => {
  const query = snapshotQuery(workspaceId);
  try {
    return await queryClient.fetchQuery(query);
  } catch (couldNotReRead) {
    const stored = queryClient.getQueryData(query.queryKey);
    if (stored) return stored;
    throw couldNotReRead;
  }
};

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ context }) => somewhereThatWorks(context.queryClient),
});

/**
 * A workspace with no view named: the one you were last on in it, and its first
 * dashboard when there is nothing to go on ("Add and switch dashboards", issue
 * 32).
 *
 * This address renders nothing of its own. It decides and forwards, so that the
 * address always says which view you are on and a dashboard can be linked to.
 */
export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId',
  beforeLoad: async ({ context, params }) => {
    await workspaceMustExist(context.queryClient, params.workspaceId);
    const { dashboards } = await dashboardsOf(context.queryClient, params.workspaceId);
    const view = viewToOpen(rememberedIn(browserStore(), params.workspaceId), dashboards);
    throw view.on === 'inbox'
      ? redirect({ to: '/w/$workspaceId/inbox', params: { workspaceId: params.workspaceId } })
      : redirect({
          to: '/w/$workspaceId/d/$dashboardId',
          params: { workspaceId: params.workspaceId, dashboardId: view.dashboardId },
        });
  },
});

/**
 * The workspace's Inbox: pinned, always there, and not a dashboard. It has an
 * address of its own so that switching to it is a switch like any other, and so
 * that being on it is what gets remembered.
 */
export const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/inbox',
  beforeLoad: async ({ context, params, preload }) => {
    await workspaceMustExist(context.queryClient, params.workspaceId);
    // Not on a preload. `defaultPreload: 'intent'` runs this on hover, and
    // remembering a view nobody went to would mean brushing past a tab decides
    // where the workspace opens next time.
    if (!preload) rememberView(browserStore(), params.workspaceId, INBOX);
  },
  component: WorkspacePage,
});

/**
 * One dashboard. A dashboard that is no longer there - a link from before it
 * was deleted, or one deleted in another tab - is not a dead end either: it
 * goes back to the workspace, which decides where to land all over again.
 */
export const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/d/$dashboardId',
  beforeLoad: async ({ context, params, preload }) => {
    await workspaceMustExist(context.queryClient, params.workspaceId);
    const { dashboards } = await dashboardsOf(context.queryClient, params.workspaceId);
    if (!dashboards.some((d) => d.id === params.dashboardId)) {
      throw redirect({ to: '/w/$workspaceId', params: { workspaceId: params.workspaceId } });
    }
    // Not on a preload, for the reason the Inbox above is not.
    if (!preload) {
      rememberView(browserStore(), params.workspaceId, {
        on: 'dashboard',
        dashboardId: params.dashboardId,
      });
    }
  },
  component: DashboardPage,
});

/** Reached from the header's "···" menu; the home of everything per-workspace. */
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/workspaces',
  component: WorkspaceSettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  workspaceRoute,
  inboxRoute,
  dashboardRoute,
  workspaceSettingsRoute,
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    // Without this the router falls back to its own ErrorComponent, which
    // prints the raw thrown error ("Failed to fetch") in unstyled markup and
    // makes an expired sign-in, a broken deployment and a stale build all look
    // identical. This boundary is only reached when there is no stored copy to
    // paint from, so it may take the screen over.
    defaultErrorComponent: ({ error, reset }) => (
      <LoadFailure error={error} onRetry={reset} canTakeOver />
    ),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
