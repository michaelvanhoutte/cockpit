import { useCallback, useEffect } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_WORKSPACE_THEME } from '@cockpit/shared';
import { NotSignedIn, signOut } from '../api/client';
import { meQuery, workspacesQuery } from '../api/queries';
import { useServerEvents } from '../api/useServerEvents';
import { DashboardBar } from '../components/DashboardBar';
import { InboxPanel } from '../components/InboxPanel';
import { MenuContent, MenuTrigger, menuItemClass } from '../components/Menu';
import { useRoomForTheInbox } from '../roomForTheInbox';

/** The default theme in the shape a workspace carries it. */
const DEFAULT_WORKSPACE_THEME_COLORS = {
  color: DEFAULT_WORKSPACE_THEME.tint,
  bar: DEFAULT_WORKSPACE_THEME.bar,
  ground: DEFAULT_WORKSPACE_THEME.ground,
  header: DEFAULT_WORKSPACE_THEME.header,
};

/**
 * The app shell: workspace tabs on top (the workspace color identity from the
 * functional definition's container hierarchy), the active workspace below.
 *
 * **The Inbox is part of the shell, not part of a page** ("Show the Inbox
 * beside the dashboards instead of as a tab", issue 117). Inside a workspace,
 * and where there is room for it, it is a column down the left of every screen
 * - the dashboards and the dashboard settings page alike - because it is the
 * thing everything else flows out of rather than one more view to switch to.
 * The workspaces settings page is reached without a workspace, so it has no
 * column: there is no Inbox to show.
 */
export function Layout() {
  useServerEvents();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useQuery(workspacesQuery);
  const params = useParams({ strict: false });
  const roomForTheInbox = useRoomForTheInbox();

  /**
   * Who is signed in - and, when it comes back refused, that nobody is.
   *
   * **Nothing waits for it.** The screen below paints from the stored copy
   * first and this settles behind it, which is the standing never-block-paint
   * rule (architecture, "Performance budgets and the standing rules"): opening
   * the app on a train should show your work, not a spinner over an
   * unanswerable question. The cost of that is a moment where a sign-in that
   * has gone is not known to have gone, and the moment ends here.
   */
  const { data: me, error: sessionFailure } = useQuery(meQuery);
  const signedOut = sessionFailure instanceof NotSignedIn;

  useEffect(() => {
    if (!signedOut) return;
    void navigate({ to: '/signin' });
  }, [signedOut, navigate]);

  const leave = useMutation({
    mutationFn: signOut,
    // `onSettled`, not `onSuccess`. Somebody who asked to sign out on a shared
    // machine has to end up signed out of *this browser* whether or not the
    // request reached the server - and if it did not, the sign-in it failed to
    // end expires on its own.
    //
    // Emptying what the browser holds is not done here but on the logon page,
    // which is the one screen with none of this mounted to write it back out
    // again; the reason is worth reading there before moving it.
    onSettled: () => navigate({ to: '/signin' }),
  });
  /**
   * The tab you are on, brought into view.
   *
   * The strip scrolls within itself rather than widening the page, so with
   * enough workspaces the one you are on can be outside the visible part of
   * it - and a tab joined to the strip below leaves a notch behind when it
   * scrolls away, which reads as broken rather than as cut off.
   *
   * **A callback ref rather than an effect on the workspace id.** The id
   * settles from the address before the workspace list has arrived, so an
   * effect keyed on it runs while there are no tabs at all and finds a null
   * ref; the tabs then appear and nothing scrolls. This fires when the node
   * itself mounts, which is the moment there is something to scroll to. The
   * browser found that: the tab was cut off at the edge of the strip with
   * seven workspaces, and every unit test passed, because jsdom has no
   * `scrollIntoView` to call in the first place.
   *
   * **And again once the font has landed.** Inter is loaded rather than
   * assumed, so between first paint and the swap every tab is measured in the
   * fallback face and then gets wider. A scroll computed before that lands
   * short by exactly however much the strip grew - fifty-one pixels, with
   * seven workspaces, which left the tab clipped at the edge in precisely the
   * way this exists to prevent. The first call is what makes it right when the
   * font is already cached; the second is what makes it right the first time.
   *
   * Both are optional-called and the promise is guarded: this is a
   * real-viewport behaviour, covered end to end, and neither `scrollIntoView`
   * nor `document.fonts` exists in jsdom.
   */
  const bringIntoView = useCallback((tab: HTMLAnchorElement) => {
    // Still the tab you are on when the font finally lands. Without this the
    // second pass scrolls to whichever tab was current when it was registered:
    // switch workspace inside that window - a few hundred milliseconds, and
    // the stored copy paints instantly - and the strip jumps back to the tab
    // you just left. The cleanup runs when this stops being the current tab,
    // which is exactly when the pending pass should stop meaning anything.
    let current = true;
    const bring = () => {
      if (current) tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    bring();
    void document.fonts?.ready.then(bring).catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  const active = data?.workspaces.find((w) => w.id === params.workspaceId);
  /**
   * The workspace you are in, painted. Only the three surfaces move - the bar
   * across the top, the strip the dashboard tabs sit on, and the ground behind
   * the panels - plus the tint on the stripe, the dots and the selected tab.
   * Cards, rows, controls and text keep the fixed neutral and accent palette,
   * which is what makes a palette of designed sets enough to keep everything
   * legible - nothing else can be affected by the choice.
   *
   * The three run deepest at the top to lightest at the bottom, and the two tab
   * strips sit at the steps between them: a selected workspace tab is filled
   * with `bar` and meets the strip below it, a selected dashboard tab is filled
   * with `ground` and meets the page. That is what makes the container
   * hierarchy legible as depth rather than as two rows of pills on one fill
   * ("Modernise the app shell", issue 125).
   *
   * The shell carries them rather than `:root`, unlike the prototype: this
   * element covers the viewport, so painting it is enough, and a page that
   * writes to `document.documentElement` has to remember to clean up after
   * itself when there is no workspace to be in at all.
   *
   * With none - the settings page reached before any workspace exists - it
   * falls back to the default theme rather than to nothing, so the app is never
   * unpainted.
   */
  const theme = active ?? DEFAULT_WORKSPACE_THEME_COLORS;

  return (
    <div className="ground-wash flex h-dvh flex-col" style={{ backgroundColor: theme.ground }}>
      {/* No bottom border: the strip below ends in the selected dashboard tab,
          which is filled with the ground and has to meet the page without a
          line drawn between them. */}
      <header
        style={{
          backgroundColor: theme.header,
          borderTopColor: theme.color,
          borderTopWidth: 3,
          borderTopStyle: 'solid',
        }}
      >
        {/* Full width, not a centred column: the brand and the workspaces sit
            against the left edge and the menu against the right, so the header
            is a bar across the screen rather than a strip down the middle.

            `items-end` rather than `items-center`, because the tabs are not
            pills floating on the bar any more - they stand on its bottom edge
            so the selected one can run into the strip underneath. */}
        <div className="flex w-full items-end gap-4 px-3 pt-2">
          <span className="shrink-0 pb-2 text-lg font-semibold tracking-tight">Cockpit</span>
          {/* Scrolls within itself rather than widening the page. Until
              workspaces could be made, three of them fit any screen and this
              was a plain row; the fourth one pushed a 480px phone to 571px and
              took the whole page sideways with it.

              The scrollbar itself is hidden, the way a tab strip's is
              everywhere: drag, trackpad and keyboard focus all still move it,
              and the full list is on the settings page a click away, so the
              bar would cost a permanent grey slab under the tabs to say
              something the tabs already show by being cut off. */}
          {/* Named, because it is not the only bar of links in this header: the
              dashboards of the workspace you are in sit under it, and two
              unnamed navigations are two identical landmarks to choose between.
              The name is what says which is which, and it is what the walks
              reach for when they ask what order the workspaces are in. */}
          <nav
            aria-label="Workspaces"
            className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {data?.workspaces.map((ws) => {
              const here = ws.id === params.workspaceId;
              return (
                <Link
                  key={ws.id}
                  ref={here ? bringIntoView : undefined}
                  to="/w/$workspaceId"
                  params={{ workspaceId: ws.id }}
                  // Rounded at the top only and square at the bottom, because
                  // the bottom is not an edge: the one you are on is filled
                  // with its own bar color and the strip below it is that same
                  // color, so the two are one surface and a rounded corner
                  // there would draw a seam across it.
                  className={`shrink-0 whitespace-nowrap rounded-t-lg px-3 pt-1.5 pb-2 text-sm ${
                    here ? 'font-medium text-ink' : 'text-ink-soft hover:bg-black/5'
                  }`}
                  style={here ? { backgroundColor: ws.bar } : undefined}
                >
                  <span
                    className="mr-1.5 inline-block size-2 rounded-full align-middle"
                    style={{ backgroundColor: ws.color }}
                  />
                  {ws.name}
                </Link>
              );
            })}
          </nav>

          {/* The same control as every other menu in the app (components/
              Menu.tsx). It used to be a bordered pill, given that weight
              because three faint characters did not read as a control - which
              an icon with a hover and a focus state does without inventing a
              second look for the one menu in the header. */}
          <DropdownMenu.Root>
            <MenuTrigger label="Settings" />
            <MenuContent>
              <DropdownMenu.Item asChild>
                <Link to="/settings/workspaces" className={menuItemClass}>
                  Workspaces
                </Link>
              </DropdownMenu.Item>
              {/* Who you are, and the way out. Both in the menu rather than on
                  the bar: the tabs are the thing you use all day and the header
                  is already full on a phone, while this is read once when you
                  wonder whose Cockpit you are looking at. */}
              <DropdownMenu.Separator className="my-1 h-px bg-black/10" />
              <DropdownMenu.Label className="px-2 py-1 text-xs text-ink-faint">
                {me ? `Signed in as ${me.user.name}` : 'Signed in'}
              </DropdownMenu.Label>
              <DropdownMenu.Item onSelect={() => leave.mutate()} className={menuItemClass}>
                Sign out
              </DropdownMenu.Item>
            </MenuContent>
          </DropdownMenu.Root>
        </div>
        {/* The dashboards of the workspace you are in, directly under its tab
            and on the same color, so the tab and this strip are one surface.
            Only where there is a workspace to have them: the settings page is
            reached without one, and there is then nothing for a tab to join. */}
        {params.workspaceId && (
          <DashboardBar workspaceId={params.workspaceId} bar={theme.bar} ground={theme.ground} />
        )}
      </header>
      {/* Left-aligned and full width, matching the header: pages get the whole
          screen instead of a centred column with empty gutters either side.

          Two columns where there is room for two ("Show the Inbox beside the
          dashboards instead of as a tab", issue 117). Each scrolls on its own,
          which is the point of the split: a long Inbox never pushes the
          dashboard off the screen, and a tall dashboard never scrolls the
          Inbox away. */}
      <main className="flex w-full min-h-0 flex-1">
        {params.workspaceId && roomForTheInbox && (
          <aside
            aria-label="Inbox"
            // A fifth of the width, with a floor and a ceiling: 20% of a
            // 1280px screen is 256px, which an item row cannot hold, and 20%
            // of a very wide one is more Inbox than anybody asked for.
            className="w-1/5 min-w-70 max-w-105 shrink-0 overflow-y-auto py-5 pl-3"
          >
            <InboxPanel workspaceId={params.workspaceId} />
          </aside>
        )}
        <div className="min-w-0 flex-1 overflow-y-auto px-3 py-5">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
