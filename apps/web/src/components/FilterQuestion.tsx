import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  DUE_WINDOWS,
  prioritySchema,
  type DueCondition,
  type DueWindow,
  type FilterCondition,
  type ItemType,
  type Priority,
} from '@cockpit/shared';
import { isAPeriod } from '../filters';
import { MenuContent, menuItemClass } from './Menu';
import { NO_TYPES } from '../itemTypes';
import { PRIORITY_LABELS } from '../priority';

/**
 * What a Filter shows, asked in a form of its own ("Add a Filter panel that
 * shows every filed item due in a window", issue 463; "Filter a Filter panel
 * by priority and type", issue 464).
 *
 * **One row per condition, and all of them have to hold.** The rows are a list
 * rather than a sentence with clauses because that is what the question grows
 * into - a Panel condition is one more row in a sibling issue (465), and each
 * is another row here rather than another form.
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
  itemTypes,
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
  /** The account's live Types, what a Type condition offers to choose from. */
  itemTypes: readonly ItemType[];
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
   * **Read once, when the question opens.** The board draws this only while a
   * Filter is being edited and keys it on that Panel, so it is mounted fresh
   * each time and a question you cancelled out of is cancelled rather than
   * remembered. Not re-read from `conditions` afterwards either: the same
   * Filter saved from another device would otherwise take the rows somebody is
   * halfway through adding out from under them, where the rule everywhere else
   * here is that the later save stands - and a refusal leaves what was chosen
   * on the form.
   */
  const [rows, setRows] = useState<FilterCondition[]>([...conditions]);

  const change = (at: number, row: FilterCondition) =>
    setRows(rows.map((was, index) => (index === at ? row : was)));

  /**
   * The fields the question does not already have a row for - what
   * *+ Add a condition* offers, and the whole of how "a field already on the
   * filter is not offered a second time" (issue 464) is kept on this side: a
   * field with a row already is left off the menu rather than shown and
   * refused.
   */
  const available = FIELD_ORDER.filter((field) => !rows.some((row) => row.field === field));

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
                  <li key={row.field} className="rounded-md border border-black/10 p-3">
                    <ConditionRow
                      at={at}
                      row={row}
                      itemTypes={itemTypes}
                      onChange={(next) => change(at, next)}
                      onRemove={() => setRows(rows.filter((_, index) => index !== at))}
                    />
                  </li>
                ))}
              </ul>
            )}

            {available.length > 0 && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  type="button"
                  className="mt-3 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
                >
                  + Add a condition
                </DropdownMenu.Trigger>
                <MenuContent>
                  {available.map((field) => (
                    <DropdownMenu.Item
                      key={field}
                      className={menuItemClass}
                      onSelect={() => setRows([...rows, defaultConditionFor(field)])}
                    >
                      {FIELD_LABELS[field]}
                    </DropdownMenu.Item>
                  ))}
                </MenuContent>
              </DropdownMenu.Root>
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

/** The fields a condition can be about, in the order *+ Add a condition* offers them. */
const FIELD_ORDER: readonly FilterCondition['field'][] = ['dueDate', 'priority', 'type'];

/** What each field is called on the add menu and beside its row. */
const FIELD_LABELS: Record<FilterCondition['field'], string> = {
  dueDate: 'Due date',
  priority: 'Priority',
  type: 'Type',
};

/** A fresh row for a field just added - nothing chosen yet, except Due date, which has always defaulted to *today*. */
function defaultConditionFor(field: FilterCondition['field']): FilterCondition {
  if (field === 'dueDate') return { field: 'dueDate', window: 'today', orOverdue: true };
  if (field === 'priority') return { field: 'priority', values: [] };
  return { field: 'type', values: [] };
}

/** One row, dispatched to the control its field takes. */
function ConditionRow({
  at,
  row,
  itemTypes,
  onChange,
  onRemove,
}: {
  at: number;
  row: FilterCondition;
  itemTypes: readonly ItemType[];
  onChange: (row: FilterCondition) => void;
  onRemove: () => void;
}) {
  if (row.field === 'priority') {
    return (
      <ValuesCondition
        at={at}
        label={FIELD_LABELS.priority}
        values={row.values}
        options={prioritySchema.options.map((value) => ({ id: value, label: PRIORITY_LABELS[value] }))}
        onChange={(values) => onChange({ ...row, values: values as Priority[] })}
        onRemove={onRemove}
      />
    );
  }
  if (row.field === 'type') {
    return (
      <ValuesCondition
        at={at}
        label={FIELD_LABELS.type}
        values={row.values}
        options={itemTypes.map((type) => ({ id: type.id, label: type.name }))}
        empty={NO_TYPES}
        onChange={(values) => onChange({ ...row, values })}
        onRemove={onRemove}
      />
    );
  }
  return <DueConditionRow at={at} row={row} onChange={onChange} onRemove={onRemove} />;
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
function DueConditionRow({
  at,
  row,
  onChange,
  onRemove,
}: {
  at: number;
  row: DueCondition;
  onChange: (row: DueCondition) => void;
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

/**
 * A Priority or a Type row: a checkbox per value on offer, any of which the
 * condition matches ("Filter a Filter panel by priority and type", issue 464).
 *
 * **One shape for both.** Priority's options are the three levels the schema
 * carries; a Type's are the account's live Types, and a value naming one since
 * deleted stops being offered here the moment it is - which is also why
 * nothing here needs to know about a deleted Type at all: `itemTypes` already
 * carries only the live ones, so a value not among them simply draws no
 * checkbox, matching what it now means (`filters.ts`).
 *
 * **Checkboxes, not a `select`.** The question is which of several values
 * matches, so the answer is a set rather than one choice from a list - the
 * shape a `select` cannot hold at all.
 */
function ValuesCondition({
  at,
  label,
  values,
  options,
  empty,
  onChange,
  onRemove,
}: {
  at: number;
  label: string;
  values: readonly string[];
  options: readonly { id: string; label: string }[];
  /** What to say instead of any checkboxes where there is nothing to offer - a Type condition where the account has no Types at all. */
  empty?: string;
  onChange: (values: string[]) => void;
  onRemove: () => void;
}) {
  const toggle = (id: string) =>
    onChange(values.includes(id) ? values.filter((held) => held !== id) : [...values, id]);

  return (
    <div className="flex flex-wrap items-start gap-3">
      <fieldset className="flex min-w-0 flex-wrap items-center gap-3">
        <legend className="text-sm text-ink-soft">{label}</legend>
        {options.length === 0 && empty ? (
          <span className="text-sm text-ink-faint">{empty}</span>
        ) : (
          options.map((option) => (
            <label key={option.id} className="flex items-center gap-1.5 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={values.includes(option.id)}
                onChange={() => toggle(option.id)}
              />
              {option.label}
            </label>
          ))
        )}
      </fieldset>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove condition ${at + 1}`}
        className="ml-auto shrink-0 rounded-md px-2 py-1 text-sm text-ink-faint hover:bg-accent-tint hover:text-accent-deep"
      >
        Remove
      </button>
    </div>
  );
}
