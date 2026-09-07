import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { NotSignedIn } from './api/client';
import { snapshotQuery, workspacesQuery } from './api/queries';
import { itemFormSearch } from './itemForm';
import {
  INBOX,
  browserStore,
  rememberView,
  rememberWorkspace,
  rememberedIn,
  viewToOpen,
} from './lastVisited';
import { roomForTheInbox } from './roomForTheInbox';
import { LoadFailure } from './components/LoadFailure';
import { CapturePage } from './pages/CapturePage';
import { DashboardPage } from './pages/DashboardPage';
import { FirstWorkspacePage } from './pages/FirstWorkspacePage';
import { WelcomePage } from './pages/WelcomePage';
import { shouldWelcome, welcomedBefore } from './welcoming';
import { Layout } from './pages/Layout';
import { LogonPage } from './pages/LogonPage';
import { WorkspacePage } from './pages/WorkspacePage';

interface RouterContext {
  queryClient: QueryClient;
}

/**
 * Nothing of its own: it renders whichever of the two halves below applies. The
 * app shell is not here because the logon page must not wear it - a header
 * showing the last person's workspaces over a screen asking who you are is
 * exactly the leak this change exists to close.
 */
const rootRoute = createRootRouteWithContext<RouterContext>()({});

/**
 * A read that turns out to need a sign-in sends you to the logon page rather
 * than to a screen explaining that a read failed.
 *
 * This is the *cold* path - no stored copy to paint, so the route genuinely
 * cannot resolve. When there is a copy the read is answered from it, nothing
 * throws here, and the sign-in that has gone is noticed behind the painted
 * screen instead (`pages/Layout.tsx`).
 */
async function orTheLogonPage<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (failure) {
    if (failure instanceof NotSignedIn) throw redirect({ to: '/signin' });
    throw failure;
  }
}

/**
 * Where you go when you have not said which workspace: the first one you have,
 * or - when there are none - the screen that makes one.
 *
 * That screen hangs off the root rather than off the shell, because the shell
 * is only ever drawn inside a workspace: an account with none has nothing for
 * the header to wear or mark (pages/FirstWorkspacePage.tsx). It used to be the
 * workspaces settings page, which is what made that page have to exist without
 * one at all.
 */
const somewhereThatWorks = async (queryClient: QueryClient) => {
  const { workspaces } = await orTheLogonPage(queryClient.ensureQueryData(workspacesQuery));
  const first = workspaces[0];
  if (!first) throw redirect({ to: '/start' });
  // An account nobody has started on opens on the one question worth asking
  // before the app is drawn (pages/WelcomePage.tsx). **Only from here**, so a
  // link to a dashboard goes where it says and is never diverted into a screen
  // about something else.
  if (shouldWelcome(workspaces, welcomedBefore())) throw redirect({ to: '/welcome' });
  throw redirect({ to: '/w/$workspaceId', params: { workspaceId: first.id } });
};

/**
 * A workspace that is no longer there is not a dead end. Deleting the one you
 * were looking at, or coming back to a link for one deleted in another tab,
 * lands you on a workspace that works instead of on a failed snapshot read.
 */
const workspaceMustExist = async (queryClient: QueryClient, workspaceId: string) => {
  const { workspaces } = await orTheLogonPage(queryClient.ensureQueryData(workspacesQuery));
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
  orTheLogonPage(queryClient.ensureQueryData(snapshotQuery(workspaceId)));

/**
 * The logon page, and the only address that works before you have signed in.
 * It hangs off the root rather than off the shell below, so it carries none of
 * the app's chrome and reads nothing belonging to whoever was here last.
 */
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  component: LogonPage,
});

/**
 * The screen for an account with no workspaces, beside the logon page rather
 * than under the shell: both are the screens that exist when there is no
 * workspace to draw the app around.
 *
 * It reads the list rather than trusting whoever sent you: hanging off the
 * root means it is outside the shell's sign-in check, so a signed-out visit
 * straight to this address would otherwise get a box whose every press is
 * refused. Reading it also answers the other direction - an account that has
 * workspaces after all is sent to one rather than invited to make its first.
 */
const startRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/start',
  beforeLoad: async ({ context }) => {
    const { workspaces } = await orTheLogonPage(
      context.queryClient.ensureQueryData(workspacesQuery),
    );
    const first = workspaces[0];
    if (first) throw redirect({ to: '/w/$workspaceId', params: { workspaceId: first.id } });
  },
  component: FirstWorkspacePage,
});

/**
 * The question a new account is asked, beside the logon page for the reason the
 * screen above it is: it carries none of the app's chrome, because what it is
 * explaining is what the chrome is made of.
 *
 * It reads the list for the same reason too - an account somebody has already
 * started on is sent into it rather than shown a question it is past, whether
 * the address was typed, bookmarked or arrived at by going back.
 */
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/welcome',
  beforeLoad: async ({ context }) => {
    const { workspaces } = await orTheLogonPage(
      context.queryClient.ensureQueryData(workspacesQuery),
    );
    const first = workspaces[0];
    if (!first) throw redirect({ to: '/start' });
    if (!shouldWelcome(workspaces, welcomedBefore())) {
      throw redirect({ to: '/w/$workspaceId', params: { workspaceId: first.id } });
    }
  },
  component: WelcomePage,
});

/**
 * Everything you can only see signed in, under the app shell.
 *
 * A layout route with no path of its own: it adds the header and the tabs to
 * every address below it without appearing in any of them, which is what lets
 * the logon page sit beside them rather than inside them.
 */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  // Which Item's form is open, on every address under the shell rather than on
  // one of them (`itemForm.ts`). The form is drawn by the Layout, over whatever
  // page the address below it resolves to.
  validateSearch: itemFormSearch,
  component: Layout,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
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
  getParentRoute: () => appRoute,
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
  getParentRoute: () => appRoute,
  path: '/w/$workspaceId/inbox',
  beforeLoad: async ({ context, params, preload }) => {
    await workspaceMustExist(context.queryClient, params.workspaceId);
    // The same read its two sibling routes do, and for a reason of its own:
    // the page asks whether the workspace has a dashboard to send it to, and
    // on a cold cache - a hard reload, or a link straight to this address -
    // an unread snapshot answers "none", which renders the Inbox here as well
    // as in its column.
    await dashboardsOf(context.queryClient, params.workspaceId);
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
    // Which workspace you are in, whether or not the Inbox is a view to come
    // back to here: it is what the Capture page captures against.
    if (!preload) rememberWorkspace(browserStore(), params.workspaceId);
  },
  component: WorkspacePage,
});

/**
 * One dashboard. A dashboard that is no longer there - a link from before it
 * was deleted, or one deleted in another tab - is not a dead end either: it
 * goes back to the workspace, which decides where to land all over again.
 */
export const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
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
      rememberWorkspace(browserStore(), params.workspaceId);
    }
  },
  component: DashboardPage,
});

/*
 * There is no address for managing the dashboards, the workspaces or the
 * types. All three are windows over the workspace you are in, opened from a
 * menu (components/ManageWindow.tsx), so there is no screen to navigate to and
 * nothing to come back from - and the shell keeps its one state, which is
 * being inside a workspace.
 */

/**
 * Capture, as a screen rather than as a window over one ("Capture something
 * before you know which workspace it belongs to", issue 165).
 *
 * **Under the shell but outside every workspace**, which is what it means: what
 * it makes belongs to no workspace until somebody says so, so no workspace tab
 * is the one you are on and there is no Inbox column beside it - the Inbox it
 * lands in is whichever one you go to next. It heads itself, which is what lets
 * the band above it stay the workspace's own.
 *
 * With no workspace at all there is nowhere to capture *from*, and the screen
 * that makes one is the invitation, exactly as it is for the address above.
 */
const captureRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/capture',
  beforeLoad: async ({ context }) => {
    const { workspaces } = await orTheLogonPage(
      context.queryClient.ensureQueryData(workspacesQuery),
    );
    if (workspaces.length === 0) throw redirect({ to: '/start' });
  },
  component: CapturePage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  startRoute,
  welcomeRoute,
  appRoute.addChildren([indexRoute, captureRoute, workspaceRoute, inboxRoute, dashboardRoute]),
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
      <LoadFailure error={error} onRetry={reset} />
    ),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
