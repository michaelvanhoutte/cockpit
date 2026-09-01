import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7, type Dashboard } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { snapshotQuery, useCommand } from '../api/queries';

/**
 * The bar under the workspace tabs: the workspace's Inbox, its dashboards, and
 * a `+` that adds one ("Add and switch dashboards", issue 32).
 *
 * **The Inbox is pinned at the left and is not a dashboard.** It is always
 * there, it cannot be renamed, deleted or moved, and it is not a row of the
 * dashboards table at all - so nothing can address it to change it.
 *
 * The dashboards come from the workspace's snapshot, which the page below is
 * reading anyway (architecture, "The read model: persisted snapshot,
 * revalidate, push"), so switching workspace changes this bar without a second
 * call of its own to keep in step.
 */
export function DashboardBar({ workspaceId }: { workspaceId: string }) {
  const { data } = useQuery(snapshotQuery(workspaceId));
  const dashboards = data?.dashboards ?? [];

  return (
    <nav
      aria-label="Dashboards"
      className="flex w-full items-center gap-1 overflow-x-auto border-t border-black/5 px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <Link
        to="/w/$workspaceId/inbox"
        params={{ workspaceId }}
        className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-sm text-ink-soft hover:bg-accent-tint [&.active]:bg-accent-tint [&.active]:font-medium [&.active]:text-accent-deep"
      >
        Inbox
      </Link>
      {dashboards.map((dashboard: Dashboard) => (
        <Link
          key={dashboard.id}
          to="/w/$workspaceId/d/$dashboardId"
          params={{ workspaceId, dashboardId: dashboard.id }}
          className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-sm text-ink-soft hover:bg-accent-tint [&.active]:bg-accent-tint [&.active]:font-medium [&.active]:text-accent-deep"
        >
          {dashboard.name}
        </Link>
      ))}
      <AddDashboard workspaceId={workspaceId} />
      {/* The way to what a dashboard has beyond its name. One entry today -
          renaming and deleting - and where "Panels on a dashboard, with
          per-screen-size layouts" (issue 33) will put its layouts. */}
      <Link
        to="/w/$workspaceId/settings/dashboards"
        params={{ workspaceId }}
        aria-label="Manage dashboards"
        className="ml-auto shrink-0 rounded-md px-2.5 py-1 text-sm text-ink-faint hover:bg-accent-tint hover:text-accent-deep"
      >
        ···
      </Link>
    </nav>
  );
}

/**
 * The `+`, and the field it grows where the new tab will be. Adding a dashboard
 * is a one-gesture thing you do often, unlike making a workspace, so it asks
 * for the name in place rather than in a dialog.
 */
function AddDashboard({ workspaceId }: { workspaceId: string }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const command = useCommand();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // The id is made here rather than inside the payload so that the dashboard
    // to switch to is known before the answer comes back.
    const dashboardId = uuidv7();
    command.mutate(
      {
        name: 'add_dashboard',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          dashboardId,
          name: trimmed,
        },
      },
      // Closed, emptied, and switched to only once it worked. A refusal leaves
      // the field open with what was typed still in it, so the name can be
      // fixed rather than typed again.
      {
        onSuccess: async () => {
          close();
          // Re-read before going there. The dashboard's own route checks that
          // it is one of the workspace's, against the snapshot in hand - and
          // the snapshot in hand is the one from before this dashboard
          // existed, so without this it decides the new dashboard is not real
          // and sends you back to the one you were already on: adding one
          // would look like doing nothing.
          //
          // Here rather than in the route because this is where it is known to
          // be needed, and where the network is known to be working: the add
          // has just come back.
          await queryClient.refetchQueries({ queryKey: ['snapshot', workspaceId] });
          // You are put on the dashboard you just made: adding one and then
          // having to find it in the bar is two gestures for what reads as one.
          void navigate({
            to: '/w/$workspaceId/d/$dashboardId',
            params: { workspaceId, dashboardId },
          });
        },
      },
    );
  };

  // The server's words where it gave any ("a dashboard called Research already
  // exists in this workspace"), and something plain where the request never got
  // an answer.
  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  /**
   * Closing the field forgets the refusal with it. `AddDashboard` stays
   * mounted either way - the `+` and the field are two renders of it - so a
   * refusal that is only hidden comes back the moment the field is opened
   * again, over a name nobody has typed yet.
   */
  const close = () => {
    setNaming(false);
    setName('');
    command.reset();
  };

  if (!naming) {
    return (
      <button
        type="button"
        onClick={() => setNaming(true)}
        aria-label="Add a dashboard"
        className="shrink-0 rounded-md px-2.5 py-1 text-sm text-ink-faint hover:bg-accent-tint hover:text-accent-deep"
      >
        +
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      // Escape on the form rather than on the box: after a refusal the focus is
      // on Add, and a handler that only listened to the box would leave Escape
      // doing nothing exactly when there is something to cancel.
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
      className="flex shrink-0 items-center gap-2"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Name of the new dashboard"
        placeholder="Research, Today…"
        maxLength={60}
        autoFocus
        className="w-40 rounded-md border border-black/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      />
      <button
        type="submit"
        disabled={command.isPending}
        className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-deep disabled:opacity-50"
      >
        Add
      </button>
      {refusal && (
        <p role="alert" className="text-xs text-over">
          {refusal}
        </p>
      )}
    </form>
  );
}
