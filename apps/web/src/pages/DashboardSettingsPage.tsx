import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7 } from '@cockpit/shared';
import type { Dashboard } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { snapshotQuery, useCommand } from '../api/queries';
import { dashboardSettingsRoute } from '../router';
import { DeleteQuestion } from '../components/DeleteQuestion';
import { LoadFailure } from '../components/LoadFailure';
import { RowMenu } from '../components/Menu';

/**
 * Where the dashboards of one workspace are managed: renaming and deleting
 * them ("Rename and delete a dashboard from a dashboard settings page", issue
 * 90). Reached from "Manage dashboards" in the menu at the right of the bar it
 * governs ("Open every menu from the same control", issue 115), so what it acts
 * on is obvious from where it sits rather than from what was last clicked.
 *
 * **The Inbox is not in the list.** It is in the bar but it is not a dashboard,
 * so there is nothing here to rename or delete - which is a fact of the schema
 * rather than a case this page has to remember.
 *
 * **A row keeps its shape.** What can be done to a dashboard is in its own
 * menu, renaming happens in the row because it is not destructive, and deleting
 * asks in a dialog - so the row never rewrites itself under the pointer that is
 * about to press it ("Ask before deleting in a dialog, from the row's own
 * menu", issue 116).
 *
 * One `useCommand` for the whole page rather than one per control, so a refusal
 * can only belong to the last thing asked for - and `variables` says which
 * control that was, which is how the refusal ends up next to the thing that was
 * refused instead of at the bottom of the page.
 */
const quietButton =
  'shrink-0 rounded-md border border-black/10 px-2 py-1 text-xs hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50';
const primaryButton =
  'shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-deep disabled:opacity-50';

export function DashboardSettingsPage() {
  const { workspaceId } = dashboardSettingsRoute.useParams();
  const { data, error, refetch } = useQuery(snapshotQuery(workspaceId));
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /**
   * The control the question was opened from, so the focus can go back to it.
   * A ref rather than state: nothing on screen depends on it, and it is read
   * only as the question closes.
   */
  const askedFrom = useRef<HTMLElement | null>(null);
  const command = useCommand();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const dashboards = data?.dashboards ?? [];
  const answered = data !== undefined;
  const listFailed = Boolean(error) && !answered;
  /**
   * The dashboard the question is about, read from the list rather than kept
   * beside the id: one deleted in another tab is gone from the next snapshot,
   * and a question about a dashboard that is no longer there closes itself
   * instead of asking about a name nothing holds.
   */
  const beingDeleted = dashboards.find((d) => d.id === deleting);

  /** Starting one leaves the other, so at most one row is ever asking something. */
  const startRenaming = (dashboard: Dashboard) => {
    setDeleting(null);
    command.reset();
    setRenaming({ id: dashboard.id, name: dashboard.name });
  };
  const startDeleting = (dashboard: Dashboard, openedFrom: HTMLElement | null) => {
    setRenaming(null);
    command.reset();
    askedFrom.current = openedFrom;
    setDeleting(dashboard.id);
  };
  const stopAsking = () => {
    setRenaming(null);
    setDeleting(null);
    command.reset();
  };

  const rename = (e: React.FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const trimmed = renaming.name.trim();
    if (!trimmed) return;
    command.mutate(
      {
        name: 'rename_dashboard',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          dashboardId: renaming.id,
          name: trimmed,
        },
      },
      // The box closes only once the new name is really the dashboard's, so a
      // refused one is still there to be corrected.
      { onSuccess: () => setRenaming(null) },
    );
  };

  const confirmDelete = (dashboardId: string) => {
    command.mutate(
      {
        name: 'delete_dashboard',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          dashboardId,
        },
      },
      {
        onSuccess: async () => {
          setDeleting(null);
          // Re-read before going anywhere, for the reason adding one does
          // (components/DashboardBar.tsx): the snapshot in hand still holds the
          // dashboard that has just gone, and the workspace's own route reads
          // it to decide where to land. Without this it can land back on the
          // deleted one and remember it, leaving you on a dashboard that is not
          // there. `useCommand` asks for the same re-read but does not wait for
          // it, and this is the caller that has to.
          await queryClient.refetchQueries({ queryKey: ['snapshot', workspaceId] });
          // The workspace decides where to land, which is the dashboard you
          // were last on - and if that was this one, the re-read above means it
          // is no longer among them. Nothing here has to know which is next.
          void navigate({ to: '/w/$workspaceId', params: { workspaceId } });
        },
      },
    );
  };

  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  /** The refusal belongs to the control that asked for it. */
  const refusalFor = (what: 'rename_dashboard' | 'delete_dashboard', dashboardId: string) =>
    refusal &&
    command.variables?.name === what &&
    'dashboardId' in command.variables.payload &&
    command.variables.payload.dashboardId === dashboardId
      ? refusal
      : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Dashboards</h1>

      <section className="rounded-lg bg-surface shadow-panel">
        <ul>
          {dashboards.map((dashboard) => (
            <li key={dashboard.id} className="border-b border-black/5 px-4 py-2 last:border-b-0">
              <div className="flex items-center gap-3">
                {renaming?.id === dashboard.id ? (
                  <form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: dashboard.id, name: e.target.value })}
                      aria-label={`New name for ${dashboard.name}`}
                      maxLength={60}
                      autoFocus
                      className="min-w-0 flex-1 rounded-md border border-black/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                    />
                    <button type="submit" disabled={command.isPending} className={primaryButton}>
                      Save
                    </button>
                    <button type="button" onClick={stopAsking} className={quietButton}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">{dashboard.name}</span>
                    <RowMenu
                      label={`Actions for ${dashboard.name}`}
                      entries={[
                        { label: 'Rename', onSelect: () => startRenaming(dashboard) },
                        {
                          label: 'Delete',
                          destructive: true,
                          // Offered and then refused is how this read before:
                          // the server keeps a workspace's last dashboard, so
                          // the only way to find out was to answer the
                          // question ("Ask before deleting in a dialog, from
                          // the row's own menu", issue 116).
                          unavailable:
                            dashboards.length === 1
                              ? 'A workspace keeps at least one dashboard'
                              : undefined,
                          onSelect: (openedFrom) => startDeleting(dashboard, openedFrom),
                        },
                      ]}
                    />
                  </>
                )}
              </div>
              {refusalFor('rename_dashboard', dashboard.id) && (
                <p role="alert" className="pt-2 text-sm text-over">
                  {refusalFor('rename_dashboard', dashboard.id)}
                </p>
              )}
            </li>
          ))}
        </ul>
        {/* One question for the page, not one per row: at most one row can be
            asking, and the dialog covers the page while it is. */}
        {beingDeleted && (
          <DeleteQuestion
            open
            question={deleteQuestion(beingDeleted.name)}
            confirmLabel={`Yes, delete ${beingDeleted.name}`}
            canConfirm={!command.isPending}
            refusal={refusalFor('delete_dashboard', beingDeleted.id)}
            returnFocusTo={askedFrom.current}
            onCancel={stopAsking}
            onConfirm={() => confirmDelete(beingDeleted.id)}
          />
        )}
        {answered && dashboards.length === 0 && (
          <p className="px-4 py-4 text-sm text-ink-faint">No dashboards yet.</p>
        )}
        {listFailed && (
          <div className="px-4 py-4">
            <LoadFailure error={error} onRetry={() => void refetch()} canTakeOver />
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * What deleting takes with it, in the words a person would use.
 *
 * Panels are what a dashboard holds, and there are none until "Panels on a
 * dashboard, with per-screen-size layouts" (issue 33) lands - so every
 * dashboard says the same thing today, and this is where the count goes when
 * there is one to give.
 */
function deleteQuestion(name: string): string {
  return `Delete ${name}? There is nothing on it.`;
}
