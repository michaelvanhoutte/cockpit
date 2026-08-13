import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { workspacesQuery } from './api/queries';
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
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
