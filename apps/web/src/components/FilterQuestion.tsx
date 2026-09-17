import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { DUE_WINDOWS, type DueWindow, type FilterCondition } from '@cockpit/shared';
import { isAPeriod } from '../filters';

/**
 * What a Filter shows, asked in a form of its own ("Add a Filter panel that
 * shows every filed item due in a window", issue 463).
 *
 * **One row per condition, and all of them have to hold.** The rows are a list
 * rather than a sentence with clauses because that is what the question grows
 * into - a Priority, a Type and a Panel are conditions of their own in the
 * sibling issues, and each is another row here rather than another form.
 *
 * **Saved whole, including saved empty.** Taking the last row out and saving is
 * a real answer: the Filter goes back to saying it has nothing chosen, which is
 * the state a new one arrives in.
 *
 * It follows `NameQuestion` on the three things every dialog in this app
 * settles - near the top of a phone so the keyboard does not cover the answer, a
 * refusal keeping it open with what was typed still in it, and the focus going
 * back to the control it was opened from.
 */
export function FilterQuestion({
  panelName,
  conditions,
  open,
  onSave,
  onCancel,
  refusal,
  busy = false,
  returnFocusTo,
}: {
  panelName: string;
  /** What the Filter shows now, which the rows open on. */
  conditions: readonly FilterCondition[];
  open: boolean;
  onSave: (conditions: FilterCondition[]) => void;
  onCancel: () => void;
  refusal?: string | null;
  busy?: boolean;
  returnFocusTo?: HTMLElement | null;
}) {
  /**
   * The rows as they are being edited, which the caller does not hold.
   *
   * Keyed on the Panel and on whether the dialog is open, so reopening it starts
   * from what is stored rather than from what was abandoned last time - a
   * question you cancelled out of has to be cancelled, not remembered.
   */
  const [rows, setRows] = useState<FilterCondition[]>([...conditions]);
  const [openedOn, setOpenedOn] = useState<readonly FilterCondition[]>(conditions);
  if (openedOn !== conditions) {
    setOpenedOn(conditions);
    setRows([...conditions]);
  }

  const change = (at: number, row: FilterCondition) =>
    setRows(rows.map((was, index) => (index === at ? row : was)));

  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-[calc(1rem_+_var(--edge-top))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">
            What does {panelName} show?
          </Dialog.Title>
          <Dialog.Description className="pt-2 text-sm text-ink-soft">
            Every item filed on a panel of this workspace that meets all of these.
          </Dialog.Description>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSave(rows);
            }}
            className="pt-4"
          >
            {rows.length === 0 ? (
              <p className="text-sm text-ink-faint">Nothing chosen yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {rows.map((row, at) => (
                  <li key={at} className="rounded-md border border-black/10 p-3">
                    <DueCondition
                      at={at}
                      row={row}
                      onChange={(next) => change(at, next)}
                      onRemove={() => setRows(rows.filter((_, index) => index !== at))}
                    />
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={() =>
                // A Due date, because it is the only condition there is. The
                // choice of which kind arrives with the second one.
                setRows([...rows, { field: 'dueDate', window: 'today', orOverdue: true }])
              }
              className="mt-3 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
            >
              + Add a condition
            </button>

            {refusal && (
              <p role="alert" className="pt-3 text-sm text-over">
                {refusal}
              </p>
            )}

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
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What each window is called on the form, in the order the question offers them. */
const WINDOW_LABELS: Record<DueWindow, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
  none: 'Not set',
};

/**
 * One Due date row: which window, and whether it also takes in what is already
 * past.
 *
 * **Or overdue is drawn only beside the four periods.** On *Overdue* it would
 * be asking the same question twice, and on *Not set* it is about a date an
 * Item does not have - an entry that means nothing where it is offered is worse
 * than one that is not there.
 *
 * A `select` rather than six radios: six exclusive answers in a dialog that
 * grows a row per condition is a list, and the keyboard and the phone both
 * already know what to do with one.
 */
function DueCondition({
  at,
  row,
  onChange,
  onRemove,
}: {
  at: number;
  row: FilterCondition;
  onChange: (row: FilterCondition) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-ink-soft">Due date</span>
      <select
        value={row.window}
        aria-label={`Due date is, condition ${at + 1}`}
        onChange={(event) => onChange({ ...row, window: event.target.value as DueWindow })}
        className="rounded-md border border-black/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      >
        {DUE_WINDOWS.map((window) => (
          <option key={window} value={window}>
            {WINDOW_LABELS[window]}
          </option>
        ))}
      </select>
      {isAPeriod(row.window) && (
        <label className="flex items-center gap-1.5 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={row.orOverdue}
            onChange={(event) => onChange({ ...row, orOverdue: event.target.checked })}
          />
          or overdue
        </label>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove condition ${at + 1}`}
        className="ml-auto rounded-md px-2 py-1 text-sm text-ink-faint hover:bg-accent-tint hover:text-accent-deep"
      >
        Remove
      </button>
    </div>
  );
}
