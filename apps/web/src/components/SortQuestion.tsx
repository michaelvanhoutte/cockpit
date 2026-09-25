import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  SORT_DIRECTIONS,
  SORT_FIELDS,
  type PanelSort,
  type SortCriterion,
  type SortDirection,
} from '@cockpit/shared';
import { MenuContent, menuItemClass } from './Menu';
import { Segmented } from './Segmented';
import { SORT_DIRECTION_MEANS, SORT_FIELD_LABELS, directionFor } from '../sorting';

/** Manual is the order you set; Sorted is the rows below. */
type Mode = 'manual' | 'sorted';

const MODE_LABELS: Record<Mode, string> = {
  manual: 'Manual',
  sorted: 'Sorted',
};

const DIRECTION_LABELS: Record<SortDirection, string> = {
  asc: 'Ascending',
  desc: 'Descending',
};

/**
 * How a Panel of items draws its rows, asked in a form of its own ("Sort a
 * panel of items by the fields you choose", issue 526).
 *
 * **The switch keeps the rows.** Flipping to Manual and back inside the
 * question leaves them as they were until Save, which writes Manual as no sort
 * at all; Cancel and Escape discard everything. Read once when it opens, and
 * keyed on the Panel by the board, for the reasons `FilterQuestion` is.
 *
 * **A Filter is asked without the switch** ("Choose how a Filter's rows are
 * sorted", issue 527): it is never Manual, and opens on what it goes by until
 * somebody chooses otherwise.
 *
 * **Sorted always has a row once it has one**: the last row offers no Remove,
 * since a sort by nothing is Manual and the switch is where that is said.
 *
 * Lazy-loaded from `PanelBoard.tsx`, for the reason `FilterQuestion` is.
 */
function SortQuestion({
  panelName,
  sort,
  open,
  onSave,
  onCancel,
  refusal,
  busy = false,
  canBeManual = true,
  returnFocusTo,
}: {
  panelName: string;
  /** What the Panel is sorted by now, or null for Manual - what the question opens on. */
  sort: PanelSort | null;
  open: boolean;
  onSave: (sort: PanelSort | null) => void;
  onCancel: () => void;
  refusal?: string | null;
  busy?: boolean;
  /** False for a Filter, whose rows are gathered rather than filed: there is no order of its own to go back to. */
  canBeManual?: boolean;
  returnFocusTo?: HTMLElement | null;
}) {
  const [mode, setMode] = useState<Mode>(sort === null ? 'manual' : 'sorted');
  const [rows, setRows] = useState<SortCriterion[]>(sort === null ? [] : [...sort]);

  /** The fields without a row yet - what *+ Then by…* offers, so none is offered twice. */
  const available = SORT_FIELDS.filter((field) => !rows.some((row) => row.field === field));
  const sorted = mode === 'sorted';
  // Sorted by nothing is not a sort; the switch is how Manual is said.
  const canSave = !busy && (!sorted || rows.length > 0);

  const change = (at: number, row: SortCriterion) =>
    setRows(rows.map((was, index) => (index === at ? row : was)));
  const swap = (at: number, with_: number) => {
    const next = [...rows];
    [next[at], next[with_]] = [next[with_]!, next[at]!];
    setRows(next);
  };

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
          // Wider than the Filter question's 28rem, so a row's name, its two
          // directions, ↑ ↓ and Remove fit on one line on a desktop.
          className="fixed left-1/2 top-[calc(1rem_+_var(--edge-top))] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">
            How is {panelName} sorted?
          </Dialog.Title>
          <Dialog.Description className="pt-2 text-sm text-ink-soft">
            {sorted
              ? `By the first of these, then the next wherever two tie, then ${canBeManual ? 'the order you set' : 'oldest first'}.`
              : 'In the order you set, by dragging.'}
          </Dialog.Description>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) onSave(sorted ? rows : null);
            }}
            className="pt-4"
          >
            {canBeManual && (
              <Segmented
                label="Manual or sorted"
                name="sort-mode"
                options={(['manual', 'sorted'] as const).map((value) => ({
                  value,
                  label: MODE_LABELS[value],
                }))}
                value={mode}
                onChange={setMode}
              />
            )}

            {sorted && (
              <>
                {rows.length === 0 ? (
                  <p className="pt-3 text-sm text-ink-faint">Choose what to sort by.</p>
                ) : (
                  <ol className="flex flex-col gap-1 pt-3">
                    {rows.map((row, at) => {
                      const label = SORT_FIELD_LABELS[row.field];
                      return (
                        <li
                          key={row.field}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-black/10 p-3"
                        >
                          <span className="min-w-20 text-sm text-ink-soft">
                            {at === 0 ? label : `then ${label}`}
                          </span>
                          <Segmented
                            label={`${label} direction`}
                            name={`sort-direction-${row.field}`}
                            options={SORT_DIRECTIONS.map((value) => ({
                              value,
                              label: DIRECTION_LABELS[value],
                              hint: SORT_DIRECTION_MEANS[row.field][value],
                            }))}
                            value={row.direction}
                            onChange={(direction) => change(at, { ...row, direction })}
                          />
                          <span className="ml-auto flex items-center">
                            <RowButton
                              label={`Move ${label} up`}
                              disabled={at === 0}
                              onClick={() => swap(at, at - 1)}
                            >
                              ↑
                            </RowButton>
                            <RowButton
                              label={`Move ${label} down`}
                              disabled={at === rows.length - 1}
                              onClick={() => swap(at, at + 1)}
                            >
                              ↓
                            </RowButton>
                            {rows.length > 1 && (
                              <RowButton
                                label={`Remove ${label}`}
                                onClick={() => setRows(rows.filter((_, index) => index !== at))}
                              >
                                Remove
                              </RowButton>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}

                {available.length > 0 && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger
                      type="button"
                      className="mt-3 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
                    >
                      {rows.length === 0 ? '+ Sort by…' : '+ Then by…'}
                    </DropdownMenu.Trigger>
                    <MenuContent>
                      {available.map((field) => (
                        <DropdownMenu.Item
                          key={field}
                          className={menuItemClass}
                          onSelect={() =>
                            setRows([...rows, { field, direction: directionFor(field) }])
                          }
                        >
                          {SORT_FIELD_LABELS[field]}
                        </DropdownMenu.Item>
                      ))}
                    </MenuContent>
                  </DropdownMenu.Root>
                )}
              </>
            )}

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
                disabled={!canSave}
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

function RowButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md px-2 py-1 text-sm text-ink-faint hover:bg-accent-tint hover:text-accent-deep disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export default SortQuestion;
