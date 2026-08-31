import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { workspacesQuery } from '../api/queries';
import { useServerEvents } from '../api/useServerEvents';

/**
 * The app shell: workspace tabs on top (the workspace color identity from the
 * functional definition §4.1), the active page below. Pages and panels arrive
 * with the dashboard work; the shell only owns workspace scoping.
 */
export function Layout() {
  useServerEvents();
  const { data } = useQuery(workspacesQuery);
  const params = useParams({ strict: false });
  const active = data?.workspaces.find((w) => w.id === params.workspaceId);

  return (
    <div className="flex h-dvh flex-col">
      <header
        className="border-b border-black/10 bg-surface/80 backdrop-blur"
        style={{ borderTopColor: active?.color, borderTopWidth: 3, borderTopStyle: 'solid' }}
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

          <DropdownMenu.Root>
            {/* Reads as a control, rather than as three characters that
                happen to be there. It was styled like the row menu inside a
                panel — faint, unbordered — which is right for something one of
                many rows owns and wrong for the only way into settings. */}
            <DropdownMenu.Trigger
              aria-label="Settings"
              className="shrink-0 rounded-md border border-accent-soft/70 bg-accent-tint px-3 py-1 text-lg font-semibold leading-6 text-accent-deep hover:border-accent hover:bg-accent hover:text-white data-[state=open]:border-accent data-[state=open]:bg-accent data-[state=open]:text-white"
            >
              ···
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                className="min-w-44 rounded-md border border-black/10 bg-surface p-1 shadow-lg"
              >
                <DropdownMenu.Item asChild>
                  <Link
                    to="/settings/workspaces"
                    className="block cursor-default rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-tint data-[highlighted]:text-accent-deep"
                  >
                    Workspaces
                  </Link>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>
      {/* Left-aligned and full width, matching the header: pages get the whole
          screen instead of a centred column with empty gutters either side. */}
      <main className="w-full flex-1 overflow-y-auto px-3 py-5">
        <Outlet />
      </main>
    </div>
  );
}
