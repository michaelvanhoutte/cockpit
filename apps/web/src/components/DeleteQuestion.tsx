import * as AlertDialog from '@radix-ui/react-alert-dialog';

/**
 * The question asked before anything is deleted ("Ask before deleting in a
 * dialog, from the row's own menu", issue 116).
 *
 * **The row it was asked from does not change.** Before this, asking rewrote
 * the row in place: the name was replaced by the question, the destructive
 * button moved from the right-hand slot to the left, and Cancel landed exactly
 * where Delete had been a moment earlier - so the button under the pointer
 * changed meaning between the press that asks and the press that answers, in
 * the one place in the app where that must never happen.
 *
 * **Cancel then Delete, in that order, always.** Both settings pages use this,
 * so the answer is in the same place whatever is being deleted.
 *
 * **A refusal keeps the dialog open.** The confirming button is an ordinary
 * button rather than `AlertDialog.Action`, which would close the dialog on
 * press: a dialog that closed and left a message behind on the page would make
 * a refusal look like a delete that had worked. `AlertDialog.Cancel` really
 * does close, because that is what cancelling is.
 */
export function DeleteQuestion({
  question,
  confirmLabel,
  open,
  onCancel,
  onConfirm,
  canConfirm = true,
  refusal,
}: {
  /** The whole question, in one sentence: what is going, and what goes with it. */
  question: string;
  /** The name of the confirming button, which says which thing it deletes. */
  confirmLabel: string;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** False while the question cannot honestly be answered yet, or is being answered. */
  canConfirm?: boolean;
  /** Why the last answer did not happen, if it did not. */
  refusal?: string | null;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/30" />
        <AlertDialog.Content
          // The question is the whole of what is being said, so there is no
          // separate description to point at. Radix asks for the attribute to
          // be undefined rather than absent when a dialog genuinely has none.
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          <AlertDialog.Title className="text-base font-semibold">{question}</AlertDialog.Title>
          {refusal && (
            <p role="alert" className="pt-3 text-sm text-over">
              {refusal}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-5">
            <AlertDialog.Cancel className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Cancel
            </AlertDialog.Cancel>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={onConfirm}
              aria-label={confirmLabel}
              className="shrink-0 rounded-md bg-over px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
