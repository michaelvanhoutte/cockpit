import * as AlertDialog from '@radix-ui/react-alert-dialog';

/**
 * Asked when a row is dropped onto a panel it did not come from, while it is on
 * a panel already ("Ask whether to move an item to a panel or add it to one",
 * issue 142).
 *
 * **Both answers are reasonable, which is why it is asked.** The same thing to
 * do can genuinely belong on *Project Falcon* and on *Anna* at once — that is
 * the whole reason a panel is a view over one shared list rather than a folder —
 * and a drag says nothing about which of the two was meant. Guessing would
 * silently take an item off a panel somebody else's dashboard shows.
 *
 * **A drop from the Inbox is not asked**, and that is a consequence of the model
 * rather than a case left out: the Inbox is what is filed nowhere, so there is
 * no answer that leaves it there.
 *
 * An alert dialog, like the delete question and unlike the picker: the change is
 * already half made — the row was let go — so this demands an answer rather than
 * being one choice among many. Escape and Cancel are the two ways to say no, and
 * pressing outside is deliberately not one.
 */
export function MoveOrAddQuestion({
  itemTitle,
  panelName,
  open,
  onMove,
  onAdd,
  onCancel,
  refusal,
  busy = false,
}: {
  itemTitle: string;
  /** The panel it was dropped on, named in both answers so neither is a guess. */
  panelName: string;
  open: boolean;
  onMove: () => void;
  onAdd: () => void;
  onCancel: () => void;
  /** Why the last answer did not happen, if it did not. */
  refusal?: string | null;
  busy?: boolean;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/30" />
        <AlertDialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          <AlertDialog.Title className="text-base font-semibold">
            Move “{itemTitle}” to {panelName}, or add it there as well?
          </AlertDialog.Title>
          <p className="pt-2 text-sm text-ink-soft">
            Adding it leaves it on the panels it is on now.
          </p>

          {refusal && (
            <p role="alert" className="pt-3 text-sm text-over">
              {refusal}
            </p>
          )}

          {/* Cancel first, then the two answers, in the order the delete
              question puts Cancel and Delete: the way out is always in the same
              place, whatever is being asked. */}
          <div className="flex justify-end gap-2 pt-5">
            <AlertDialog.Cancel className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Cancel
            </AlertDialog.Cancel>
            <button
              type="button"
              disabled={busy}
              onClick={onAdd}
              className="shrink-0 rounded-md border border-accent px-3 py-1.5 text-sm font-medium text-accent-deep hover:bg-accent-tint disabled:opacity-50"
            >
              Add it here as well
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onMove}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
            >
              Move it here
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
