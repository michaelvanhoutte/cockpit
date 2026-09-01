import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { snapshotQuery, workspacesQuery } from './api/queries';
import { INBOX, browserStore, rememberView, rememberedIn, viewToOpen } from './lastVisited';
import { roomForTheInbox } from './roomForTheInbox';
import { LoadFailure } from './components/LoadFailure';
import { DashboardPage } from './pages/DashboardPage';
import { DashboardSettingsPage } from './pages/DashboardSettingsPage';
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
 * The workspace's snapshot, from the copy in hand where there is one.
 *
 * Deliberately cache-first, like every other read in this file. Making it
 * network-first was tried and is worse in two ways that both land on the
 * person: a failing fetch retries twice with backoff before it rejects, so the
 * route sits on the previous screen for about three seconds with nothing said;
 * and a query made while genuinely offline is *paused* rather than run and
 * failed, so it never settles at all and the route never commits. Reading what
 * you already have is what the stored copy is for (functional definition,
 * "Offline / local-first behavior").
 *
 * What that costs is freshness, and it is paid where the freshness is actually
 * needed rather than on every navigation: adding a dashboard re-reads the
 * snapshot before going to it (components/DashboardBar.tsx), because that is
 * the one moment the copy in hand is known to be a snapshot from before the
 * thing being navigated to existed - and the one moment the network is known to
 * be working, since the add just came back.
 */
const dashboardsOf = (queryClient: QueryClient, workspaceId: string) =>
  queryClient.ensureQueryData(snapshotQuery(workspaceId));

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
    const view = viewToOpen(
      rememberedIn(browserStore(), params.workspaceId),
      dashboards,
      roomForTheInbox(),
    );
    throw view.on === 'inbox'
      ? redirect({ to: '/w/$workspaceId/inbox', params: { workspaceId: params.workspaceId } })
      : redirect({
          to: '/w/$workspaceId/d/$dashboardId',
          params: { workspaceId: params.workspaceId, dashboardId: view.dashboardId },
        });
  },
});

/**
 * The workspace's Inbox as a screen of its own: what the tab in the bar opens
 * on a screen too narrow to hold the Inbox beside the dashboards. It keeps its
 * own address whatever the width, so a link made on a phone is never a dead
 * end on a desktop - where the page answers it by going to the workspace,
 * because the Inbox is already on the screen there (pages/WorkspacePage.tsx).
 */
export const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/inbox',
  beforeLoad: async ({ context, params, preload }) => {
    await workspaceMustExist(context.queryClient, params.workspaceId);
    // Not on a preload. `defaultPreload: 'intent'` runs this on hover, and
    // remembering a view nobody went to would mean brushing past a tab decides
    // where the workspace opens next time.
    //
    // Nor where the Inbox has a column of its own: this address does not stay
    // on screen there, and remembering a view you were sent straight off is
    // remembering somewhere you never were.
    if (!preload && !roomForTheInbox()) {
      rememberView(browserStore(), params.workspaceId, INBOX);
    }
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

/**
 * The dashboards of one workspace, managed. Reached from "Manage dashboards"
 * in the menu at the right of the bar it governs ("Open every menu from the
 * same control", issue 115), and addressed under the workspace for the same
 * reason:
 * what it acts on is where it sits ("Rename and delete a dashboard from a
 * dashboard settings page", issue 90).
 */
export const dashboardSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/settings/dashboards',
  beforeLoad: async ({ context, params }) => {
    await workspaceMustExist(context.queryClient, params.workspaceId);
  },
  component: DashboardSettingsPage,
});

/** Reached from the header's menu; the home of everything per-workspace. */
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
  dashboardSettingsRoute,
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
