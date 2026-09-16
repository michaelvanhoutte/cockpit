import * as Dialog from '@radix-ui/react-dialog';
import type { Dashboard } from '@cockpit/shared';

/**
 * Which dashboard a panel should move to ("Move a panel to another dashboard,
 * from its menu or by dragging it onto a tab", issue 439).
 *
 * **An ordinary dialog rather than an alert dialog**, for the reason
 * `MoveToPicker`'s is: a choice among several, where pressing outside it
 * means "not now".
 *
 * **Only ever opened with somewhere to go.** The menu entry that opens this is
 * `unavailable` when the workspace has no other dashboard (`PanelCard.tsx`),
 * so `dashboards` is never empty here - there is nothing for an empty list
 * inside the dialog to say.
 *
 * **Focus goes back where the menu was opened from**, the same reason
 * `MoveToPicker`'s does: opened from a menu entry rather than a trigger of its
 * own, Radix has nothing to return the focus to otherwise.
 */
export function MovePanelToDashboardPicker({
  panelName,
  dashboards,
  open,
  onPick,
  onCancel,
  refusal,
  busy = false,
  returnFocusTo,
}: {
  panelName: string;
  /** Every other dashboard of the workspace, in tab order - the one the panel is already on is never among them. */
  dashboards: readonly Dashboard[];
  open: boolean;
  onPick: (dashboardId: string) => void;
  onCancel: () => void;
  /** Why the last move did not happen, if it did not. */
  refusal?: string | null;
  /** True while a move is being sent, so it cannot be sent twice. */
  busy?: boolean;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
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
          className="fixed left-1/2 top-1/2 flex max-h-[min(32rem,calc(100vh_-_2rem_-_2_*_max(var(--edge-top),var(--edge-bottom))))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">Move {panelName} to</Dialog.Title>

          {refusal && (
            <p role="alert" className="pt-3 text-sm text-over">
              {refusal}
            </p>
          )}

          <div className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1">
            {dashboards.map((dashboard) => (
              <button
                key={dashboard.id}
                type="button"
                disabled={busy}
                onClick={() => onPick(dashboard.id)}
                className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent-tint hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate">{dashboard.name}</span>
              </button>
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
