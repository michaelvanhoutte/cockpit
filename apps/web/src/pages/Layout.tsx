import { Link, Outlet, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { workspacesQuery } from '../api/queries';
import { useServerEvents } from '../api/useServerEvents';

/**
 * The app shell: workspace tabs on top (the workspace color identity from the
 * functional definition's container hierarchy), the active workspace below.
 * Dashboards and panels arrive with their own issues; the shell only owns
 * workspace scoping.
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
        <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-4 py-2">
          <span className="text-lg font-semibold tracking-tight">Cockpit</span>
          <nav className="flex gap-1">
            {data?.workspaces.map((ws) => (
              <Link
                key={ws.id}
                to="/w/$workspaceId"
                params={{ workspaceId: ws.id }}
                className="rounded-md px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint [&.active]:bg-accent-tint [&.active]:font-medium [&.active]:text-accent-deep"
              >
                <span
                  className="mr-1.5 inline-block size-2 rounded-full align-middle"
                  style={{ backgroundColor: ws.color }}
                />
                {ws.name}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
