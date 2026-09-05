import { useCallback, useEffect } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_WORKSPACE_THEME, isPaletteTheme, themeOf } from '@cockpit/shared';
import { NotSignedIn, signOut } from '../api/client';
import { meQuery, snapshotQuery, workspacesQuery } from '../api/queries';
import { useServerEvents } from '../api/useServerEvents';
import { CaptureWindow } from '../components/CaptureWindow';
import { DashboardBar } from '../components/DashboardBar';
import { InboxHeading, InboxPanel } from '../components/InboxPanel';
import { ItemForm } from '../components/ItemForm';
import { LoadFailure } from '../components/LoadFailure';
import { MenuContent, MenuTrigger, menuItemClass } from '../components/Menu';
import { OpensItemForms } from '../itemForm';
import { litForChrome } from '../chrome';
import { useRoomForTheInbox } from '../roomForTheInbox';

/** The default theme in the shape a workspace carries it. */
const DEFAULT_WORKSPACE_THEME_COLORS = {
  color: DEFAULT_WORKSPACE_THEME.tint,
  bar: DEFAULT_WORKSPACE_THEME.bar,
  ground: DEFAULT_WORKSPACE_THEME.ground,
  header: DEFAULT_WORKSPACE_THEME.header,
};

/**
 * The id of the Inbox's heading, which is in the band while the column it names
 * is in the page below. Fixed rather than generated, because the two are in
 * different components and only one of them can own a `useId`.
 */
const INBOX_HEADING = 'the-inbox';

/** The four colors of a workspace, which is all the shell reads off one. */
type Painted = typeof DEFAULT_WORKSPACE_THEME_COLORS;

/**
 * What to paint a workspace in: its own four colors where they are a theme the
 * palette actually has, and otherwise the theme its tint belongs to.
 *
 * **The fallback is not decoration.** A workspace stores its surfaces resolved
 * rather than as a theme name, so a copy of one held from before the palette
 * changed carries the surfaces of the old palette - and the app paints from the
 * stored copy before the read behind it lands, which offline is a while. Under
 * the near-black chrome the text on it is a fixed light set, so those old pale
 * surfaces are not merely the wrong shade: they are a bar whose own text cannot
 * be read on it. Falling back to the tint's theme closes that window, and
 * closes the same hole for a workspace wearing a tint the palette never had.
 *
 * The tint itself is never overridden. It is the one color a person already
 * recognises in the tabs, and it is what the fallback is looked up by.
 */
function paint(workspace: Painted | undefined): Painted {
  if (!workspace) return DEFAULT_WORKSPACE_THEME_COLORS;
  const { color, bar, ground, header } = workspace;
  if (isPaletteTheme({ tint: color, bar, ground, header })) return workspace;
  const theme = themeOf(color);
  return { color, bar: theme.bar, ground: theme.ground, header: theme.header };
}

/**
 * The app shell: workspace tabs on top (the workspace color identity from the
 * functional definition's container hierarchy), the active workspace below.
 *
 * **The Inbox is part of the shell, not part of a page** ("Show the Inbox
 * beside the dashboards instead of as a tab", issue 117). Inside a workspace,
 * and where there is room for it, it is a column down the left of every screen
 * - the dashboards and the Inbox's own alike - because it is the thing
 * everything else flows out of rather than one more view to switch to.
 * The workspaces settings page is reached without a workspace, so it has no
 * column: there is no Inbox to show.
 */
/**
 * The shell, and the one thing that wraps it: every row drawn below here can
 * ask for an Item's form, which is a change of address (`itemForm.tsx`).
 */
export function Layout() {
  return (
    <OpensItemForms>
      <TheShell />
    </OpensItemForms>
  );
}

function TheShell() {
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

  /**
   * The workspace you are in, failing to be read - said once here for the whole
   * window rather than by each thing reading it.
   *
   * **Three components read this same snapshot** - the Inbox column, the
   * dashboard and the list its dashboards are managed in - and each used to
   * render its own notice, so one failed read put the same words on screen two
   * or three times,
   * in whatever width the box holding them happened to be. It is one read
   * (architecture, "The read model: persisted snapshot, revalidate, push") and
   * so it is one notice, and a screen added later gets it without knowing.
   *
   * Costs no request: it is the same query key those three already subscribe
   * to, so this is another reader of a cache entry rather than another fetch.
   *
   * **Only where there is a stored copy behind it.** With nothing to paint, the
   * route itself could not resolve and the failure screen already has the page
   * (router.tsx, `defaultErrorComponent`); adding this would be the duplicate
   * all over again, one column to its left.
   */
  const workspace = useQuery({
    ...snapshotQuery(params.workspaceId ?? ''),
    enabled: Boolean(params.workspaceId),
  });
  const workspaceUnread = Boolean(workspace.error) && workspace.data !== undefined;

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
  const theme = paint(active);

  return (
    <div
      className="flex h-dvh flex-col"
      // `--ground` and `--tint` beside the fill, because two things drawn far
      // below here are mixed from them rather than given them: the wells sunk
      // into the sheet (styles.css) and the lit tint a dot wears on the chrome.
      style={
        {
          backgroundColor: theme.ground,
          '--ground': theme.ground,
          '--tint': theme.color,
        } as React.CSSProperties
      }
    >
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
          {/* **Gone on a phone**, where it is the only thing in the bar that
              does nothing. The header holds four things now - the name, the
              workspaces, Capture… and the menu ("Capture something before you
              know which workspace it belongs to", issue 165) - and at 375px
              that left the strip showing one whole tab and a letter of the
              next. The workspaces are what the bar is for, so the wordmark is
              what gives way; the logon page still says whose app this is. */}
          <span className="hidden shrink-0 pb-2 text-lg font-semibold tracking-tight text-chrome-ink sm:block">
            Cockpit
          </span>

          {/* First in the strip, ahead of every workspace, and ruled off from
              them: what it captures belongs to no workspace, so it is not one
              more of them and cannot sit among them ("Capture something before
              you know which workspace it belongs to", issue 165; "Cockpit Shell
              Explorations", artboard 2c). It was a filled button after the tabs,
              which read as a control on the bar rather than as the first place
              you land.

              Outside the Workspaces navigation rather than inside it, for the
              same reason: it is not a workspace, and the strip beside it scrolls
              within itself, which would carry Capture off the screen. */}
          {params.workspaceId && (
            <>
              <CaptureWindow workspaceId={params.workspaceId} tint={theme.color} />
              <span
                aria-hidden="true"
                className="mx-2 mb-2 h-5 w-px shrink-0 self-end bg-white/15"
              />
            </>
          )}
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
                  // The workspace's own colour along the top edge of the tab you
                  // are on, for the reason the dashboard tab below carries one:
                  // the header and the strip under it are four values of grey
                  // apart, which is enough to read as joined and nowhere near
                  // enough to read as *selected*. An inset shadow rather than a
                  // border, so becoming current does not change the tab's
                  // height and shuffle the strip.
                  className={`shrink-0 whitespace-nowrap rounded-t-lg px-3 pt-1.5 pb-2 text-sm ${
                    here
                      ? 'font-medium text-chrome-ink shadow-[inset_0_2px_0_0_var(--tab-mark)]'
                      : 'text-chrome-ink-soft hover:bg-white/8 hover:text-chrome-ink'
                  }`}
                  style={
                    {
                      // The band's own colour rather than the workspace's
                      // stored one, so the tab you are on and the strip it runs
                      // into are the same fill even when the stored copy is
                      // from an older palette (`paint` above).
                      ...(here ? { backgroundColor: theme.bar } : undefined),
                      // Lifted towards white before it is drawn on the chrome
                      // (`chrome.ts`), which is where the reason is.
                      '--tab-mark': litForChrome(ws.color),
                    } as React.CSSProperties
                  }
                >
                  <span
                    className="mr-1.5 inline-block size-2 rounded-full align-middle bg-[var(--tab-mark)]"
                    // Only the one you are in glows. It is the cheapest way to
                    // say *this* workspace with a mark this small, and a bar of
                    // glowing dots would say nothing at all.
                    style={here ? { boxShadow: `0 0 8px ${ws.color}` } : undefined}
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
            <MenuTrigger label="Settings" onChrome />
            <MenuContent>
              <DropdownMenu.Item asChild>
                <Link to="/settings/workspaces" className={menuItemClass}>
                  Workspaces
                </Link>
              </DropdownMenu.Item>
              {/* Beside the workspaces page rather than inside one: types
                  belong to the account ("Manage the types, and put them in the
                  order you want", issue 156). */}
              <DropdownMenu.Item asChild>
                <Link to="/settings/types" className={menuItemClass}>
                  Types
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
      </header>
      {/* The workspace's own band, under its tab and on the same color, so the
          tab and this strip are one surface. Full width, because that is what
          the selected workspace tab joins onto and because the band belongs to
          the workspace rather than to either column under it.

          **The dashboard tabs inside it start where the dashboard starts.**
          They used to run from the left edge, which put them above the Inbox -
          and the Inbox is the workspace's, identical on every dashboard, so
          tabs sitting over it said they governed something they do not. What
          holds that space open is now the Inbox's own name and count, joined to
          the column below it exactly as a selected tab is joined to the sheet
          ("Cockpit Shell Explorations", artboard 2c): the band is a row of
          headings, and the Inbox is the leftmost of them. With no room for the
          Inbox there is no column to head, and the screen it opens instead
          carries its name itself (pages/WorkspacePage.tsx).

          Only where there is a workspace to have dashboards: the settings page
          is reached without one, and there is then nothing for a tab to join. */}
      {params.workspaceId && (
        <div className="flex w-full items-end" style={{ backgroundColor: theme.bar }}>
          {roomForTheInbox && (
            <div className="ml-1 w-1/5 min-w-70 max-w-105 shrink-0 bg-[color-mix(in_srgb,var(--ground)_90%,var(--tint))] px-4 pt-2 pb-1.5">
              <InboxHeading workspaceId={params.workspaceId} id={INBOX_HEADING} />
            </div>
          )}
          <DashboardBar
            workspaceId={params.workspaceId}
            tint={theme.color}
            ground={theme.ground}
            openDashboardId={params.dashboardId ?? null}
          />
        </div>
      )}
      {/* Left-aligned and full width, matching the header: pages get the whole
          screen instead of a centred column with empty gutters either side.

          Two columns where there is room for two ("Show the Inbox beside the
          dashboards instead of as a tab", issue 117). Each scrolls on its own,
          which is the point of the split: a long Inbox never pushes the
          dashboard off the screen, and a tall dashboard never scrolls the
          Inbox away. */}
      {/* Above the columns and across both, because it is about the workspace
          they are both showing rather than about either of them. */}
      {workspaceUnread && (
        <div className="px-1 pt-1">
          <LoadFailure error={workspace.error} onRetry={() => void workspace.refetch()} />
        </div>
      )}
      {/* One sheet, in the workspace's ground, with the columns' own hollows the
          only thing breaking it up ("Cockpit Shell Explorations", artboard 2c).
          Four pixels of padding rather than twelve and twenty: the panels are
          not cards floating with air around them any more, so the space between
          them is a seam rather than a margin, and what it used to buy - room for
          each card's shadow - is not needed by a surface that has none. */}
      <main className="flex w-full min-h-0 flex-1 gap-1 p-1">
        {params.workspaceId && roomForTheInbox && (
          <aside
            // Named by the heading up in the band rather than by a label of its
            // own, so the name a person reads and the name a screen reader
            // announces are the same string in one place.
            aria-labelledby={INBOX_HEADING}
            // A fifth of the width, with a floor and a ceiling: 20% of a
            // 1280px screen is 256px, which an item row cannot hold, and 20%
            // of a very wide one is more Inbox than anybody asked for.
            className="well-inbox w-1/5 min-w-70 max-w-105 shrink-0 overflow-y-auto"
          >
            <InboxPanel workspaceId={params.workspaceId} />
          </aside>
        )}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>

      {/* The Item's form, drawn over whatever the address below resolves to and
          opened by that same address (`itemForm.tsx`). Here rather than in the
          lists, because there is one form open at a time. */}
      <ItemForm />
    </div>
  );
}
