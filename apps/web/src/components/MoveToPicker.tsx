import * as Dialog from '@radix-ui/react-dialog';
import type { Dashboard, Panel, Workspace } from '@cockpit/shared';

/**
 * Where an item can be moved: onto a panel, or into a workspace's Inbox.
 *
 * The Inbox arm names its workspace rather than being a bare null, because
 * since "Capture something before you know which workspace it belongs to"
 * (issue 165) there is more than one Inbox to mean: an item belonging to no
 * workspace is in every one of them, and picking which is how it gets one.
 */
export type MoveTarget = { panel: string } | { inboxOf: string };

/**
 * Where an item should go: the Inbox, or any panel of this workspace ("Panels
 * hold the items filed into them, and the Inbox holds the rest", issue 36).
 *
 * **An ordinary dialog rather than an alert dialog.** The delete question is an
 * alert because it demands an answer before anything else happens; this is a
 * choice among many, so pressing outside it means "not now" and closes it.
 *
 * **The dashboard you are on comes first**, because the panel you want is
 * nearly always on the dashboard you are looking at. Above that, the panels
 * most recently filed into (recentPanels.ts), because the other common case is
 * filing five things into the same panel in a row - and that panel is often on
 * a dashboard you are not on.
 *
 * **The Inbox is one of the targets**, so there is a way to say "put this back
 * for me to deal with later" rather than only the side effect of removing an
 * item from its last panel. It sits on its own at the top: it is not a panel,
 * and it is where the item already is more often than not.
 *
 * **Focus goes back where the question came from.** Opened from an entry in a
 * row's menu rather than by a trigger of its own, so Radix has nothing to
 * return the focus to and would leave it at the top of the page - which, in a
 * list of rows, is losing your place.
 */
export function MoveToPicker({
  itemTitle,
  adding = false,
  dashboards,
  panels,
  workspaceId,
  inboxesOf,
  openDashboardId,
  recent,
  open,
  onPick,
  onCancel,
  refusal,
  busy = false,
  returnFocusTo,
}: {
  /** What is being moved, so the question says which row it was asked from. */
  itemTitle: string;
  /**
   * That this is showing the Item somewhere *as well* rather than moving it
   * ("Ask whether to move an item to a panel or add it to one", issue 142).
   *
   * The same picker either way, because the question it answers is the same
   * one - which panel - and two pickers would be two lists of the same panels
   * to keep in step. What changes is the sentence at the top and the Inbox,
   * which is not a place anything can be added to: it is what is filed nowhere.
   */
  adding?: boolean;
  dashboards: readonly Dashboard[];
  /** Every panel of the workspace, whichever dashboard it is on. */
  panels: readonly Panel[];
  /** The workspace being looked at, whose Inbox is the plain one at the top. */
  workspaceId: string;
  /**
   * Every workspace, listed as Inboxes above the panels - given only for an
   * item that belongs to none of them yet ("Capture something before you know
   * which workspace it belongs to", issue 165).
   *
   * **First, and in the order of the tabs.** For an item that is in every Inbox
   * at once, which Inbox it should be in is the question actually being asked,
   * and the panels below are the answer to a longer one. The tab order rather
   * than any other, because a second arrangement of the same workspaces is a
   * second thing to learn.
   */
  inboxesOf?: readonly Workspace[];
  /** The dashboard being looked at, or null on a screen that is not one. */
  openDashboardId: string | null;
  /** Panel ids, most recently filed into first. */
  recent: readonly string[];
  open: boolean;
  /** The chosen target: a panel, or the Inbox of one of the workspaces. */
  onPick: (target: MoveTarget) => void;
  onCancel: () => void;
  /** Why the last choice did not happen, if it did not. */
  refusal?: string | null;
  /** True while a choice is being sent, so it cannot be sent twice. */
  busy?: boolean;
  returnFocusTo?: HTMLElement | null;
}) {
  const groups = dashboardsInOrder(dashboards, openDashboardId).map((dashboard) => ({
    dashboard,
    panels: panels.filter((panel) => panel.dashboardId === dashboard.id),
  }));
  const recentPanels = recent
    .map((panelId) => panels.find((panel) => panel.id === panelId))
    .filter((panel): panel is Panel => panel !== undefined);

  return (
    // **Not closeable while a choice is in flight.** Cancelling resets the
    // change that is still running, so a move that goes on to happen loses the
    // handling that follows it - the panel is not remembered as a recent one
    // and no way back is offered. Escape and a press outside come through here
    // as well as the button, which is why the guard is on the root rather than
    // only on the control.
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-1/2 flex max-h-[min(32rem,calc(100vh-2rem))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">
            {adding ? `Also show “${itemTitle}” on` : `Move “${itemTitle}” to`}
          </Dialog.Title>

          {refusal && (
            <p role="alert" className="pt-3 text-sm text-over">
              {refusal}
            </p>
          )}

          {/* Its own scroller rather than the dialog growing: a workspace with
              six dashboards of panels is a list longer than any screen, and a
              dialog taller than the window has a Cancel nobody can reach. */}
          <div className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1">
            {!adding &&
              (inboxesOf ? (
                <Group title="Workspaces">
                  {inboxesOf.map((workspace) => (
                    <Target
                      key={workspace.id}
                      label={workspace.name}
                      hint={workspace.id === workspaceId ? 'the one you are in' : undefined}
                      busy={busy}
                      onPick={() => onPick({ inboxOf: workspace.id })}
                    />
                  ))}
                </Group>
              ) : (
                <Target
                  label="Inbox"
                  hint="still to deal with"
                  busy={busy}
                  onPick={() => onPick({ inboxOf: workspaceId })}
                />
              ))}

            {recentPanels.length > 0 && (
              <Group title="Recent">
                {recentPanels.map((panel) => (
                  <Target
                    key={panel.id}
                    label={panel.name}
                    hint={nameOfDashboard(dashboards, panel.dashboardId)}
                    busy={busy}
                    onPick={() => onPick({ panel: panel.id })}
                  />
                ))}
              </Group>
            )}

            {groups.map(({ dashboard, panels: onIt }) => (
              <Group key={dashboard.id} title={dashboard.name}>
                {onIt.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-ink-faint">No panels yet.</p>
                ) : (
                  onIt.map((panel) => (
                    <Target
                      key={panel.id}
                      label={panel.name}
                      busy={busy}
                      onPick={() => onPick({ panel: panel.id })}
                    />
                  ))
                )}
              </Group>
            ))}
          </div>

          <div className="flex justify-end pt-4">
            <Dialog.Close
              disabled={busy}
              className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
            >
              Cancel
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The dashboards, the one being looked at first.
 *
 * The rest keep the order the snapshot gives them, which is the order of the
 * bar across the top: a picker that sorted them some other way would be a
 * second arrangement of the same dashboards to learn.
 */
function dashboardsInOrder(
  dashboards: readonly Dashboard[],
  openDashboardId: string | null,
): Dashboard[] {
  const open = dashboards.find((dashboard) => dashboard.id === openDashboardId);
  if (!open) return [...dashboards];
  return [open, ...dashboards.filter((dashboard) => dashboard.id !== open.id)];
}

function nameOfDashboard(dashboards: readonly Dashboard[], dashboardId: string): string | undefined {
  return dashboards.find((dashboard) => dashboard.id === dashboardId)?.name;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-3">
      <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One place an item can go.
 *
 * A button rather than a row with a button in it, so the whole target is the
 * hit area — the same reason a panel is the drop target while only its header
 * is the handle.
 */
function Target({
  label,
  hint,
  busy,
  onPick,
}: {
  label: string;
  /** Which dashboard it is on, where the list does not already say. */
  hint?: string | undefined;
  busy: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onPick}
      className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent-tint hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-xs text-ink-faint">{hint}</span>}
    </button>
  );
}
