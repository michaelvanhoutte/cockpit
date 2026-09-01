import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_WORKSPACE_THEME } from '@cockpit/shared';
import { workspacesQuery } from '../api/queries';
import { useServerEvents } from '../api/useServerEvents';
import { DashboardBar } from '../components/DashboardBar';
import { InboxPanel } from '../components/InboxPanel';
import { MenuContent, MenuTrigger, menuItemClass } from '../components/Menu';
import { useRoomForTheInbox } from '../roomForTheInbox';

/** The default theme in the shape a workspace carries it. */
const DEFAULT_WORKSPACE_THEME_COLORS = {
  color: DEFAULT_WORKSPACE_THEME.tint,
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
  const { data } = useQuery(workspacesQuery);
  const params = useParams({ strict: false });
  const roomForTheInbox = useRoomForTheInbox();
  const active = data?.workspaces.find((w) => w.id === params.workspaceId);
  /**
   * The workspace you are in, painted. Only these two move: the ground behind
   * the panels and the bar across the top, plus the tint on the stripe and the
   * dots. Cards, rows, controls and text keep the fixed neutral and accent
   * palette, which is what makes a palette of designed triples enough to keep
   * everything legible - nothing else can be affected by the choice.
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
    <div className="flex h-dvh flex-col" style={{ backgroundColor: theme.ground }}>
      <header
        className="border-b border-black/10 backdrop-blur"
        style={{
          backgroundColor: theme.header,
          borderTopColor: theme.color,
          borderTopWidth: 3,
          borderTopStyle: 'solid',
        }}
      >
        {/* Full width, not a centred column: the brand and the workspaces sit
            against the left edge and the menu against the right, so the header
            is a bar across the screen rather than a strip down the middle. */}
        <div className="flex w-full items-center gap-4 px-3 py-2">
          <span className="shrink-0 text-lg font-semibold tracking-tight">Cockpit</span>
          {/* Scrolls within itself rather than widening the page. Until
              workspaces could be made, three of them fit any screen and this
              was a plain row; the fourth one pushed a 480px phone to 571px and
              took the whole page sideways with it.

              The scrollbar itself is hidden, the way a tab strip's is
              everywhere: drag, trackpad and keyboard focus all still move it,
              and the full list is on the settings page a click away, so the
              bar would cost a permanent grey slab under the tabs to say
              something the tabs already show by being cut off. */}
          <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {data?.workspaces.map((ws) => (
              <Link
                key={ws.id}
                to="/w/$workspaceId"
                params={{ workspaceId: ws.id }}
                className="shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint [&.active]:bg-accent-tint [&.active]:font-medium [&.active]:text-accent-deep"
              >
                <span
                  className="mr-1.5 inline-block size-2 rounded-full align-middle"
                  style={{ backgroundColor: ws.color }}
                />
                {ws.name}
              </Link>
            ))}
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
            </MenuContent>
          </DropdownMenu.Root>
        </div>
        {/* The dashboards of the workspace you are in, directly under its tab.
            Only where there is a workspace to have them: the settings page is
            reached without one. */}
        {params.workspaceId && <DashboardBar workspaceId={params.workspaceId} />}
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
