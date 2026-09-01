import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { workspacesQuery } from './api/queries';
import { LoadFailure } from './components/LoadFailure';
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
 * or - once the last one can be deleted ("Rename and delete a workspace", issue
 * 77) - the page that makes one. The settings page *is* the invitation: it says
 * there are none and the box to type a name into is right under it. Anything
 * else would be a screen whose only content is a link to that one.
 */
const somewhereThatWorks = async (queryClient: QueryClient) => {
  const { workspaces } = await queryClient.ensureQueryData(workspacesQuery);
  const first = workspaces[0];
  throw first
    ? redirect({ to: '/w/$workspaceId', params: { workspaceId: first.id } })
    : redirect({ to: '/settings/workspaces' });
};

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ context }) => somewhereThatWorks(context.queryClient),
});

export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId',
  /**
   * A workspace that is no longer there is not a dead end. Deleting the one you
   * were looking at, or coming back to a link for one deleted in another tab,
   * lands you on a workspace that works instead of on a failed snapshot read.
   */
  beforeLoad: async ({ context, params }) => {
    const { workspaces } = await context.queryClient.ensureQueryData(workspacesQuery);
    if (!workspaces.some((w) => w.id === params.workspaceId)) {
      await somewhereThatWorks(context.queryClient);
    }
  },
  component: WorkspacePage,
});

/** Reached from the header's "···" menu; the home of everything per-workspace. */
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/workspaces',
  component: WorkspaceSettingsPage,
});

const routeTree = rootRoute.addChildren([indexRoute, workspaceRoute, workspaceSettingsRoute]);

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
