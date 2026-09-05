import * as Dialog from '@radix-ui/react-dialog';

/**
 * The form a settings row is edited on: its name and its colour, together, over
 * the page the row is in.
 *
 * **Editing left the row.** The name was changed in the row, in a box that took
 * the row over, and the colour on a strip of swatches under it that was always
 * on screen and sent a change on every press - so a list of five workspaces was
 * five names and forty swatches, most of them for a workspace nobody was
 * looking at, and choosing a colour to see it was a change you could not take
 * back except by choosing again. Both are one thing you occasionally do to one
 * row, and both now happen here.
 *
 * **Two ways in, neither the lesser**, exactly as an Item's form has ("Edit an
 * item's title and description on a form of its own", issue 159): a
 * double-click on the row, and **Edit…** in the row's own menu - which is the
 * only way a keyboard has and the comfortable one on a phone, where a
 * double-tap is a gesture the browser has already spent on zooming.
 *
 * **Nothing is sent until Save**, so the swatches are a draft like the name is.
 * Escape, Cancel and a press outside all discard, and a refusal keeps the form
 * open with what was typed still in it - the one case where closing would throw
 * work away.
 *
 * **The focus goes back to the control it was opened from**, for the reason the
 * delete question does it: opened from an entry in a row's menu, the dialog has
 * no trigger of its own and Radix would leave the focus at the top of the page,
 * which in a list of rows is losing your place.
 */
export function RowForm({
  title,
  name,
  nameLabel,
  onName,
  palette,
  paletteLabel,
  refusal,
  saving,
  onCancel,
  onSave,
  returnFocusTo,
}: {
  /** What is being edited, named: "Edit Personal". */
  title: string;
  /** The name as it stands in the box, which is the draft rather than the stored one. */
  name: string;
  /** What the box is called to somebody who cannot see the heading above it. */
  nameLabel: string;
  onName: (name: string) => void;
  /** The swatches, drawn by the page: a workspace picks a theme, a type a colour. */
  palette: React.ReactNode;
  /** What that row of swatches is, said once as its group's name. */
  paletteLabel: string;
  /** Why the last Save did not happen, if it did not. */
  refusal?: string | null;
  /** That a Save is in flight, which closes both halves and the two buttons. */
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  /** The control the form was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null;
}) {
  // Nothing to save, and nothing this app will store: a name is required and
  // stored trimmed, so a box holding only blanks is an empty name.
  const canSave = !saving && name.trim().length > 0;

  return (
    <Dialog.Root
      open
      onOpenChange={(stillOpen) => {
        // Escape, the close control and a press outside all land here, and all
        // three discard. Save is what writes, and it is sitting in the form
        // unpressed. Not while one is in flight, though: what is being sent was
        // worked out before the round trip.
        if (!stillOpen && !saving) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          // The heading is the whole of what is being said about this form.
          // Radix asks for the attribute to be undefined rather than absent.
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="truncate text-base font-semibold">{title}</Dialog.Title>

          {/* A form, so Enter in the box saves - which is what a box with one
              line and a Save button beside it promises. */}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) onSave();
            }}
          >
            <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Name
              <input
                autoFocus
                disabled={saving}
                value={name}
                onChange={(event) => onName(event.target.value)}
                aria-label={nameLabel}
                maxLength={60}
                className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </label>

            {/* Captioned like the box above it, and a named group rather than
                a bare row of buttons: on its own a swatch is a coloured square,
                and what makes it a choice among others is being one of these.
                The caption is what a sighted reader gets, `aria-label` what a
                screen reader gets from the group itself. */}
            <div role="group" aria-label={paletteLabel} className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Colour
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">{palette}</div>
            </div>

            {refusal && (
              <p role="alert" className="pt-3 text-sm text-over">
                {refusal}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-5">
              <Dialog.Close
                type="button"
                disabled={saving}
                className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canSave}
                className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Whether a double-click on a row was on the row itself, rather than on a
 * control of its own or on something drawn over the page from inside it.
 *
 * The same two questions an Item row asks (components/ItemRow.tsx), because a
 * React event bubbles through the component tree rather than the DOM one: the
 * menu's entries are drawn in a portal on the body, so a double press on one
 * arrives here while sitting nowhere near the row - and the menu's own three
 * dots is a button inside the row, so containment alone would let a double
 * press on it open the form as well as the menu.
 */
export function wasOnTheRow(event: React.MouseEvent): boolean {
  const hit = event.target as Node;
  if (!event.currentTarget.contains(hit)) return false;
  return !(hit as Element).closest?.('button');
}
