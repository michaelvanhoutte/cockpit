import * as Dialog from '@radix-ui/react-dialog';

/**
 * What to call something, asked in a form of its own.
 *
 * **One dialog for every name the app asks for in one**, rather than one per
 * thing named: a new panel, a new layout and a layout being renamed are the
 * same question with different words, and three copies would be three places to
 * fix the phone keyboard rule below. What differs is the wording, so the
 * wording is what is passed in.
 *
 * **An ordinary dialog rather than an alert dialog**, for the reason the picker
 * gives: an alert demands an answer to a change already half made, and this is
 * one you can walk away from, so a press outside means "not now".
 *
 * **Some of these say what is being made, and that is where a dashboard and a
 * panel are explained.** Pressing `+` is the moment somebody is asking what the
 * thing *is*, so it is the moment worth answering in; a question that renames
 * something already made needs no such thing and must not grow one. It is also
 * what makes this a dialog rather than a box grown in a bar, for adding a
 * dashboard: a strip has room for a field and a button and nothing else.
 *
 * **It sits near the top of a phone rather than in the middle of it.** The
 * keyboard opens over the bottom half of the screen the moment the field takes
 * focus, and a dialog centred on a 667px screen has its Cancel and its answer
 * behind it. 768px is the width the Inbox needs beside the dashboards
 * (roomForTheInbox.ts) and the same boundary is the phone shape here.
 *
 * **The field is 16px, alone among the app's boxes.** iOS Safari zooms the page
 * in on a focused box with smaller text and never zooms back out, which on a
 * dialog leaves you typing into a page you now have to pan.
 *
 * **A refusal keeps it open with the name still in it**, so a name the server
 * would not take is corrected rather than typed again - and it cannot be closed
 * while the change is in flight, or the refusal would have nowhere to appear.
 *
 * **The focus goes back to the control that opened it**, which is where the
 * next press would go. Said here rather than left to Radix, which puts it on
 * the page itself: the same reason the delete question says it.
 */
export function NameQuestion({
  question,
  explains,
  fieldLabel,
  placeholder,
  submitLabel,
  name,
  open,
  onNameChange,
  onSubmit,
  onCancel,
  refusal,
  busy = false,
  returnFocusTo,
}: {
  question: string;
  /**
   * What the thing being named *is*, for the questions that answer that too.
   * Left off, the question is the whole of what is asked - which is what
   * renaming something you have already made needs.
   */
  explains?: string;
  fieldLabel: string;
  placeholder: string;
  submitLabel: string;
  /** The name as typed so far, which the caller holds so a refusal keeps it. */
  name: string;
  open: boolean;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** Why the last answer did not happen, if it did not. */
  refusal?: string | null;
  busy?: boolean;
  /** The control it was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          // Only where there is nothing to describe it with: the prop is how
          // Radix is told the omission is deliberate, and passing it beside a
          // Description would take that description back off the dialog.
          {...(explains ? {} : { 'aria-describedby': undefined })}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          // Near the top of a phone is where the status bar is, so the 16px is
          // measured from below it (styles.css, `--edge-top`). Nothing to
          // allow for at the desktop width, where it is centred anyway.
          className="fixed left-1/2 top-[calc(1rem_+_var(--edge-top))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">{question}</Dialog.Title>
          {explains && (
            <Dialog.Description className="pt-2 text-sm text-ink-soft">
              {explains}
            </Dialog.Description>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) onSubmit();
            }}
            className="pt-4"
          >
            <input
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              aria-label={fieldLabel}
              placeholder={placeholder}
              maxLength={60}
              autoFocus
              className="w-full rounded-md border border-black/10 bg-surface px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
            />

            {refusal && (
              <p role="alert" className="pt-3 text-sm text-over">
                {refusal}
              </p>
            )}

            {/* Cancel first, then the answer, where the delete question puts
                them: the way out is in the same place whatever is being
                asked. */}
            <div className="flex justify-end gap-2 pt-5">
              <Dialog.Close
                disabled={busy}
                className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={busy}
                className="milled shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
              >
                {submitLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
