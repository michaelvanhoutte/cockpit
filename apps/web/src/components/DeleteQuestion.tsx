import * as AlertDialog from '@radix-ui/react-alert-dialog';

/**
 * The question asked before anything is deleted ("Ask before deleting in a
 * dialog, from the row's own menu", issue 116) - and, since "Draw a dashboard
 * against the screen sizes its account has" (issue 263), before defining a
 * Layout at a screen size, which is not a deletion at all.
 *
 * **The row it was asked from does not change.** Before this, asking rewrote
 * the row in place: the name was replaced by the question, the destructive
 * button moved from the right-hand slot to the left, and Cancel landed exactly
 * where Delete had been a moment earlier - so the button under the pointer
 * changed meaning between the press that asks and the press that answers, in
 * the one place in the app where that must never happen.
 *
 * **Cancel then the answer, in that order, always.** Every window that asks a
 * yes/no question this way uses this component, so the answer is in the same
 * place whatever is being asked.
 *
 * **The confirming button draws its own label rather than a fixed word.** It
 * used to say "Delete" no matter what was passed in, which is why every caller
 * before issue 263 was asking about a deletion - the one non-destructive
 * question this app asks, defining a Layout, could not reuse it until this
 * drew the word it was actually given. `destructive` (the default, so every
 * existing caller is unchanged) wears the same red the confirm always has;
 * `affirmative` is the ordinary accent, for a question whose answer is not
 * something going away.
 *
 * **A refusal keeps the dialog open.** The confirming button is an ordinary
 * button rather than `AlertDialog.Action`, which would close the dialog on
 * press: a dialog that closed and left a message behind on the page would make
 * a refusal look like the answer had not been kept. `AlertDialog.Cancel` really
 * does close, because that is what cancelling is.
 *
 * **Pressing outside does not answer it**, deliberately and not as an
 * oversight: this is an alert dialog, which asks a question it expects an
 * answer to, and Radix enforces that by handling outside presses itself.
 * Escape and Cancel are the two ways to say no.
 *
 * **The focus goes back where the question came from.** The dialog is opened
 * from an entry in a row's menu rather than by a trigger of its own, so Radix
 * has nothing to return the focus to and would leave it at the top of the
 * page - which, in a list of rows, is losing your place.
 */
export function DeleteQuestion({
  question,
  confirmLabel,
  confirmText = 'Delete',
  variant = 'destructive',
  open,
  onCancel,
  onConfirm,
  canConfirm = true,
  refusal,
  returnFocusTo,
}: {
  /** The whole question, in one sentence: what is going, and what goes with it. */
  question: string;
  /** What a screen reader announces for the confirming button. */
  confirmLabel: string;
  /** What the confirming button reads on screen - "Delete" where nothing more specific is given. */
  confirmText?: string;
  /** The red of a deletion, or the ordinary accent of a question that is not one. */
  variant?: 'destructive' | 'affirmative';
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** False while the question cannot honestly be answered yet, or is being answered. */
  canConfirm?: boolean;
  /** Why the last answer did not happen, if it did not. */
  refusal?: string | null;
  /** The control the question was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null;
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
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
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
              className={
                variant === 'destructive'
                  ? 'shrink-0 rounded-md bg-over px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50'
                  : 'shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50'
              }
            >
              {confirmText}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
