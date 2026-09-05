import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7 } from '@cockpit/shared';
import type { Dashboard } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { snapshotQuery, useCommand } from '../api/queries';
import { DeleteQuestion } from './DeleteQuestion';
import { LoadFailure } from './LoadFailure';
import { RowMenu } from './Menu';

/**
 * Where the dashboards of one workspace are managed: renaming and deleting
 * them ("Rename and delete a dashboard from a dashboard settings page", issue
 * 90). Opened by "Manage dashboards" in the menu at the right of the bar it
 * governs ("Open every menu from the same control", issue 115), so what it acts
 * on is obvious from where it sits rather than from what was last clicked.
 *
 * **Over the workspace rather than instead of it**, which is the difference
 * from the page this was. Renaming a dashboard is a detour from working on one,
 * and a page took the whole screen away for it: the Inbox, the panels and the
 * bar all went, and coming back was a navigation. A dialog leaves them behind
 * it, and closing it puts you back where you were with nothing to reload.
 *
 * **The `+` in the bar is not in here.** Adding a dashboard is a one-gesture
 * thing you do often (DashboardBar), so it stays where the new tab will be;
 * this is for the two things you do rarely and want a list for.
 *
 * **The Inbox is not in the list.** It is beside this workspace rather than one
 * of its dashboards, and it is not a row of the dashboards table at all, so
 * there is nothing here to rename or delete.
 *
 * **A row keeps its shape.** What can be done to a dashboard is in its own
 * menu, renaming happens in the row because it is not destructive, and deleting
 * asks in a dialog of its own - so the row never rewrites itself under the
 * pointer that is about to press it ("Ask before deleting in a dialog, from the
 * row's own menu", issue 116).
 *
 * One `useCommand` for the whole list rather than one per control, so a refusal
 * can only belong to the last thing asked for - and `variables` says which
 * control that was, which is how the refusal ends up next to the thing that was
 * refused instead of at the bottom of the list.
 */
const quietButton =
  'shrink-0 rounded-md border border-black/10 px-2 py-1 text-xs hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50';
const primaryButton =
  'shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-deep disabled:opacity-50';

export function ManageDashboards({
  workspaceId,
  open,
  onClose,
  returnFocusTo,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** The control it was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null;
}) {
  const { data, error, refetch } = useQuery(snapshotQuery(workspaceId));
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /**
   * The control the question was opened from, so the focus can go back to it.
   * A ref rather than state: nothing on screen depends on it, and it is read
   * only as the question closes.
   */
  const askedFrom = useRef<HTMLElement | null>(null);
  /**
   * The list itself, which the focus goes back to when a delete has happened:
   * the row's menu it was asked from went with the row, and the question closes
   * by ceasing to exist rather than by being dismissed, so nothing else puts it
   * anywhere. Left alone it falls to the page behind the dialog, and the next
   * Tab starts from the top of a screen you cannot see.
   */
  const list = useRef<HTMLDivElement>(null);
  /** That a delete has happened, so the focus is owed to the list. */
  const focusTheList = useRef(false);
  const command = useCommand();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const dashboards = data?.dashboards ?? [];
  const panels = data?.panels ?? [];
  const answered = data !== undefined;
  const listFailed = Boolean(error) && !answered;
  /**
   * The dashboard the question is about, read from the list rather than kept
   * beside the id: one deleted in another tab is gone from the next snapshot,
   * and a question about a dashboard that is no longer there closes itself
   * instead of asking about a name nothing holds.
   */
  const beingDeleted = dashboards.find((d) => d.id === deleting);

  /**
   * The focus, once a delete has taken the question away with the row.
   *
   * A frame later rather than in the answer itself: the question does not close
   * so much as cease to exist, and its own focus scope puts the focus back as
   * it unmounts - onto a row that is no longer there, which is the page behind
   * the dialog. This runs after that.
   */
  useEffect(() => {
    if (!focusTheList.current || beingDeleted) return;
    focusTheList.current = false;
    const frame = requestAnimationFrame(() => list.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [beingDeleted]);

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

  /**
   * Closing it forgets what was half-typed and what was refused, for the reason
   * adding one does (DashboardBar): this stays mounted between openings, so a
   * refusal that is merely hidden comes back the next time over a name nobody
   * has touched.
   */
  const close = () => {
    stopAsking();
    onClose();
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
          focusTheList.current = true;
          // Re-read before going anywhere, for the reason adding one does
          // (DashboardBar): the snapshot in hand still holds the dashboard that
          // has just gone, and the workspace's own route reads it to decide
          // where to land. Without this it can land back on the deleted one and
          // remember it, leaving you on a dashboard that is not there.
          // `useCommand` asks for the same re-read but does not wait for it,
          // and this is the caller that has to.
          await queryClient.refetchQueries({ queryKey: ['snapshot', workspaceId] });
          // The workspace decides where to land, which is the dashboard you
          // were last on - and if that was this one, the re-read above means it
          // is no longer among them. Nothing here has to know which is next.
          //
          // **The list stays open behind that**, minus the row: the row going
          // is the confirmation, and a second rename should not cost opening
          // this again. Where the deleted one was what you were looking at, the
          // workspace has moved on underneath and you see it on closing.
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
    <Dialog.Root
      open={open}
      // Not while a change is in flight, or the refusal it might come back with
      // would have nowhere left to appear.
      onOpenChange={(nowOpen) => !nowOpen && !command.isPending && close()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          ref={list}
          // The title is the whole of what this is, so there is no separate
          // description to point at.
          aria-describedby={undefined}
          // Escape cancels the innermost thing that is open, as it does
          // everywhere else in the app: the name box where one is being typed
          // in, and the list itself otherwise. Said here rather than on the box
          // because Radix listens for the key on the document, above anything
          // a field of ours could stop. The delete question is a layer of its
          // own and takes the key before this ever sees it.
          onEscapeKeyDown={(event) => {
            if (!renaming) return;
            event.preventDefault();
            stopAsking();
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          // Near the top on a phone rather than centred on it, for the reason
          // naming a panel gives (NewPanelQuestion is the same shape): renaming
          // opens the keyboard over the bottom half of the screen, and a dialog
          // centred on a 667px screen has its Save and Cancel behind it. The
          // list scrolls inside the dialog rather than growing past the screen,
          // because a workspace may hold plenty of dashboards. On a phone it is
          // the one dialog that can reach both ends of the screen, so both the
          // 16px it starts at and the height it may grow to are measured
          // inside the screen's own edges (styles.css, `--edge-top`).
          className="fixed left-1/2 top-[calc(1rem_+_var(--edge-top))] flex max-h-[calc(100dvh_-_2rem_-_var(--edge-top)_-_var(--edge-bottom))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-lg border border-black/10 bg-surface p-5 shadow-lg md:top-1/2 md:max-h-[min(40rem,calc(100dvh-8rem))] md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">Manage dashboards</Dialog.Title>

          <ul className="-mx-2 mt-4 min-h-0 flex-1 overflow-y-auto">
            {dashboards.map((dashboard) => (
              <li key={dashboard.id} className="border-b border-black/5 px-2 py-2 last:border-b-0">
                <div className="flex items-center gap-3">
                  {renaming?.id === dashboard.id ? (
                    <form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-2">
                      <input
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: dashboard.id, name: e.target.value })}
                        aria-label={`New name for ${dashboard.name}`}
                        maxLength={60}
                        autoFocus
                        // 16px, alone among the app's boxes, for the reason the
                        // new-panel field is: iOS Safari zooms the page in on a
                        // focused box with smaller text and never zooms back
                        // out, which on a dialog leaves you typing into a page
                        // you now have to pan.
                        className="min-w-0 flex-1 rounded-md border border-black/10 bg-surface px-2 py-1 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
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
          {/* One question for the list, not one per row: at most one row can be
              asking, and it covers this dialog while it is. */}
          {beingDeleted && (
            <DeleteQuestion
              open
              question={deleteQuestion(
                beingDeleted.name,
                panels.filter((panel) => panel.dashboardId === beingDeleted.id).length,
              )}
              confirmLabel={`Yes, delete ${beingDeleted.name}`}
              canConfirm={!command.isPending}
              refusal={refusalFor('delete_dashboard', beingDeleted.id)}
              returnFocusTo={askedFrom.current}
              onCancel={stopAsking}
              onConfirm={() => confirmDelete(beingDeleted.id)}
            />
          )}
          {answered && dashboards.length === 0 && (
            <p className="py-4 text-sm text-ink-faint">No dashboards yet.</p>
          )}
          {listFailed && (
            <div className="py-4">
              <LoadFailure error={error} onRetry={() => void refetch()} />
            </div>
          )}

          <div className="flex justify-end pt-5">
            <Dialog.Close
              disabled={command.isPending}
              className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
            >
              Done
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * What deleting takes with it, in the words a person would use.
 *
 * Panels are what a dashboard holds ("Panels on a dashboard, with
 * per-screen-size layouts", issue 33), so the count is the whole of the answer
 * and a dashboard with none says so rather than saying "0 panels".
 *
 * The count is never missing the way a workspace's item count can be. It comes
 * from the same snapshot the list of dashboards is drawn from, so a row on
 * screen always has its panels in hand and there is nothing to wait for.
 */
function deleteQuestion(name: string, panels: number): string {
  if (panels === 0) return `Delete ${name}? There is nothing on it.`;
  if (panels === 1) return `Delete ${name}? Its one panel goes with it.`;
  return `Delete ${name}? Its ${panels} panels go with it.`;
}
