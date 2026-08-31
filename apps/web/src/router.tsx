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

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Layout,
});

/** "/" resolves to the first workspace; there is no workspace-less view. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const { workspaces } = await context.queryClient.ensureQueryData(workspacesQuery);
    const first = workspaces[0];
    if (first) {
      throw redirect({ to: '/w/$workspaceId', params: { workspaceId: first.id } });
    }
  },
  component: () => <p className="p-6 text-ink-soft">No workspaces yet.</p>,
});

export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId',
  component: WorkspacePage,
});

const routeTree = rootRoute.addChildren([indexRoute, workspaceRoute]);

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
