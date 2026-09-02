import * as AlertDialog from '@radix-ui/react-alert-dialog';

/**
 * The question asked when a dashboard's arrangement is changed on a screen the
 * layout in use was not made for ("Panels on a dashboard, with per-screen-size
 * layouts", issue 33).
 *
 * **It is asked because either answer is reasonable.** Widening a panel on a
 * laptop while the dashboard is being drawn with the layout made for a 4K
 * screen either means "the wide layout should have this panel wider" or "this
 * laptop wants a layout of its own" - and there is nothing in the gesture that
 * says which. Guessing would silently rewrite an arrangement made somewhere
 * else, which is the failure this whole feature exists to avoid.
 *
 * **It is not asked when there is nothing to choose between.** On the screen a
 * layout was made for, and on a dashboard with no layout at all, one of the two
 * answers is not an answer, so the change is simply kept.
 *
 * **The change is already on screen behind it.** You dragged the panel and the
 * panel moved; what is being asked is where to keep it, not whether it
 * happened. Cancelling is what puts it back.
 *
 * Cancel comes first, as it does in the delete question, so the way out of a
 * dialog is in the same place whatever the dialog asks. A refusal keeps it open
 * and says why, for the same reason: a dialog that closed and left a message on
 * the page would make a refusal look like a change that had worked.
 */
export function LayoutQuestion({
  open,
  madeFor,
  screenWidth,
  onCancel,
  onChangeThisLayout,
  onMakeANewLayout,
  canAnswer = true,
  refusal,
  returnFocusTo,
}: {
  open: boolean;
  /** The width the layout being drawn was made at. */
  madeFor: number;
  /** The width of the screen it is being drawn on now. */
  screenWidth: number;
  onCancel: () => void;
  onChangeThisLayout: () => void;
  onMakeANewLayout: () => void;
  /** False while the question is being answered. */
  canAnswer?: boolean;
  refusal?: string | null;
  /** The control the change came from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/30" />
        <AlertDialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-1/2 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          <AlertDialog.Title className="text-base font-semibold">
            {`This layout was made for a ${madeFor} px screen, and this one is ${screenWidth} px. Keep the change where?`}
          </AlertDialog.Title>
          {refusal && (
            <p role="alert" className="pt-3 text-sm text-over">
              {refusal}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 pt-5">
            <AlertDialog.Cancel className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Cancel
            </AlertDialog.Cancel>
            {/* Ordinary buttons rather than `AlertDialog.Action`, which closes
                the dialog on press: a refusal has to leave the question open
                and answerable a second way. */}
            <button
              type="button"
              disabled={!canAnswer}
              onClick={onChangeThisLayout}
              className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
            >
              Change this layout
            </button>
            <button
              type="button"
              disabled={!canAnswer}
              onClick={onMakeANewLayout}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
            >
              Make a layout for this screen
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
