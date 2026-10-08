import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  DUE_WINDOWS,
  FILTER_GROUPINGS,
  panelTakesItems,
  prioritySchema,
  statusValuesOf,
  type DueCondition,
  type DueWindow,
  type FilterCondition,
  type FilterGrouping,
  type FilterMatch,
  type ItemType,
  type Panel,
  type Priority,
} from '@cockpit/shared';
import { GROUPING_NAMES, WINDOW_LABELS, isAPeriod } from '../filters';
import { MenuContent, menuItemClass } from './Menu';
import { Segmented } from './Segmented';
import { NO_TYPES } from '../itemTypes';
import { PRIORITY_LABELS } from '../priority';

/** What a Panel condition's value picker says when the Workspace has no items Panel to offer at all. */
const NO_PANELS_TO_CHOOSE = 'No panels to choose from yet.';

/**
 * What a Filter shows, asked in a form of its own ("Add a Filter panel that
 * shows every filed item due in a window", issue 463; "Filter a Filter panel
 * by priority and type", issue 464).
 *
 * **One row per condition, and all of them have to hold** unless the second
 * row's joiner says *or* ("Let a Filter show items that meet any of its
 * conditions", issue 504; "Join a Filter's conditions with and/or beside each
 * row", issue 909). The rows are a list
 * rather than a sentence with clauses because that is what the question grows
 * into - Due date, Priority, Type and, since "Filter a Filter panel by panel,
 * and name the Filters a panel's deletion affects" (issue 465), Panel, each
 * its own row rather than another form.
 *
 * **Saved whole, including saved empty.** Taking the last row out and saving is
 * a real answer: the Filter goes back to saying it has nothing chosen, which is
 * the state a new one arrives in.
 *
 * It follows `NameQuestion` on the three things every dialog in this app
 * settles - near the top of a phone so the keyboard does not cover the answer, a
 * refusal keeping it open with what was typed still in it, and the focus going
 * back to the control it was opened from.
 *
 * **Exported as a default, and lazy-loaded from `PanelBoard.tsx`.** A Filter's
 * own question is opened by choosing *Filter…* from a Panel's menu, never on
 * a cold open, so its own code - the four rows, the add menu, the checkboxes
 * - is fetched only then rather than spent out of the 201KB an open dashboard
 * already pays for (`docs/architecture.md`, "Performance budgets"; the same
 * boundary `DescriptionBox.tsx`'s own `RichDescription` and `PanelText.tsx`'s
 * `DrawnText` already draw for the same reason).
 */
function FilterQuestion({
  panelName,
  conditions,
  match: initialMatch,
  groupBy: initialGroupBy,
  itemTypes,
  panels,
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
  /** Whether the Filter needs all of them or any one, which the second row's joiner opens on. */
  match: FilterMatch;
  /** What the Filter's rows are grouped under, which the *Group by* choice opens on. */
  groupBy: FilterGrouping;
  /** The account's live Types, what a Type condition offers to choose from. */
  itemTypes: readonly ItemType[];
  /**
   * The Workspace's own Panels, what a Panel condition offers to choose from -
   * filtered here to the ones an Item can be filed onto (`panelTakesItems`),
   * so a Filter or a Panel of text never reaches the checkboxes: nothing is
   * ever filed onto either, and a Filter naming itself or another Filter
   * could never match anything (`panel.ts`, `panelConditionSchema`).
   */
  panels: readonly Panel[];
  open: boolean;
  onSave: (conditions: FilterCondition[], match: FilterMatch, groupBy: FilterGrouping) => void;
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
  /**
   * Whether an Item has to meet all of the rows or any one, read once like
   * them. **Kept when rows are removed down to one**, the way *or overdue* is
   * kept when the window changes: the joiner that sets it exists only from the
   * second row, but what was chosen is still what saves.
   */
  const [match, setMatch] = useState<FilterMatch>(initialMatch);
  /** What the rows are grouped under, saved with the conditions ("Group a Filter panel's items by the Dashboard or Panel they are filed on", issue 805). */
  const [groupBy, setGroupBy] = useState<FilterGrouping>(initialGroupBy);
  // With fewer than two rows the two answers are the same one, and the question
  // reads as it always did.
  const any = rows.length >= 2 && match === 'any';

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
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed z-floating left-1/2 top-[calc(1rem_+_var(--edge-top))] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-shade/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">
            What does {panelName} show?
          </Dialog.Title>
          <Dialog.Description className="pt-2 text-sm text-ink-soft">
            Every item filed on a panel of this workspace that meets {any ? 'any' : 'all'} of these.
          </Dialog.Description>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSave(rows, match, groupBy);
            }}
            className="pt-4"
          >
            {rows.length === 0 ? (
              <p className="text-sm text-ink-faint">Nothing chosen yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map((row, at) => (
                  <li key={row.field} className="flex items-start gap-2">
                    <Joiner at={at} match={match} onChange={setMatch} />
                    <div className="min-w-0 flex-1 rounded-md border border-shade/10 p-3">
                      <ConditionRow
                        at={at}
                        row={row}
                        itemTypes={itemTypes}
                        panels={panels}
                        onChange={(next) => change(at, next)}
                        onRemove={() => setRows(rows.filter((_, index) => index !== at))}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {available.length > 0 && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  type="button"
                  className="mt-3 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
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

            {/* How the list is drawn is its own section, apart from what it shows. */}
            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-shade/10 pt-4">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Display</span>
              {/* The words on screen are the choice's name, so a screen reader and
                  a voice command both find it by what is seen. */}
              <span aria-hidden="true" className="whitespace-nowrap text-sm text-ink-soft">Group by</span>
              <Segmented
                label="Group by"
                name="filter-group-by"
                options={FILTER_GROUPINGS.map((value) => ({ value, label: GROUPING_LABELS[value] }))}
                value={groupBy}
                onChange={setGroupBy}
              />
            </div>
            <p className="pt-1.5 text-xs text-ink-faint">{GROUPING_HINTS[groupBy]}</p>

            {refusal && (
              <p role="alert" className="pt-3 text-sm text-over-ink">
                {refusal}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-5">
              <Dialog.Close
                disabled={busy}
                className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={busy}
                className="milled shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
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

/** What each grouping is called on the *Group by* choice: the funnel's own names, and *None*. */
const GROUPING_LABELS: Record<FilterGrouping, string> = { none: 'None', ...GROUPING_NAMES };

/** What each grouping does, said under the choice so *Panel* need not be tried to be understood. */
const GROUPING_HINTS: Record<FilterGrouping, string> = {
  none: 'One list.',
  dashboard: 'A heading per Dashboard, its matching items under it.',
  panel: 'A heading per Panel, such as "Errands \u00b7 Day to day". An item on two Panels appears under each.',
};

/**
 * The word in the left gutter that joins a row to the ones above it: *Where*
 * on the first, then *and* or *or* ("Join a Filter's conditions with and/or
 * beside each row", issue 909).
 *
 * **The second row's joiner is the Filter's all-or-any, and the rows after it
 * only repeat it as text.** A Filter is all or any as a whole (mixes such as
 * *(A and B) or C* are not built), so a third row offering its own choice would
 * promise something the Filter cannot hold. A `select` rather than a segmented
 * control: two words in a gutter a few characters wide.
 */
function Joiner({
  at,
  match,
  onChange,
}: {
  at: number;
  match: FilterMatch;
  onChange: (match: FilterMatch) => void;
}) {
  return (
    <span className="w-14 shrink-0 pt-3 text-right text-sm text-ink-soft">
      {at === 0 ? (
        'Where'
      ) : at === 1 ? (
        <select
          value={match}
          aria-label="How the conditions combine"
          onChange={(event) => onChange(event.target.value as FilterMatch)}
          className="w-full rounded-md border border-shade/10 bg-surface px-1 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
        >
          <option value="all">and</option>
          <option value="any">or</option>
        </select>
      ) : match === 'any' ? (
        'or'
      ) : (
        'and'
      )}
    </span>
  );
}

/** The fields a condition can be about, in the order *+ Add a condition* offers them. */
const FIELD_ORDER: readonly FilterCondition['field'][] = ['dueDate', 'priority', 'type', 'panel', 'status'];

/** What each field is called on the add menu and beside its row. */
const FIELD_LABELS: Record<FilterCondition['field'], string> = {
  dueDate: 'Due date',
  priority: 'Priority',
  type: 'Type',
  panel: 'Panel',
  status: 'Status',
};

/** A fresh row for a field just added - nothing chosen yet, except Due date, which has always defaulted to *today*, and Status, which opens on In progress, the one answer it gave before it took values. Every values card opens on *is*: no `exclude` is written until *is not* is chosen. */
function defaultConditionFor(field: FilterCondition['field']): FilterCondition {
  if (field === 'dueDate') return { field: 'dueDate', window: 'today', orOverdue: true };
  if (field === 'priority') return { field: 'priority', values: [] };
  if (field === 'type') return { field: 'type', values: [] };
  if (field === 'panel') return { field: 'panel', values: [] };
  return { field: 'status', values: ['in_progress'] };
}

/** One row, dispatched to the control its field takes. */
function ConditionRow({
  at,
  row,
  itemTypes,
  panels,
  onChange,
  onRemove,
}: {
  at: number;
  row: FilterCondition;
  itemTypes: readonly ItemType[];
  panels: readonly Panel[];
  onChange: (row: FilterCondition) => void;
  onRemove: () => void;
}) {
  if (row.field === 'priority') {
    return (
      <ValuesCondition
        at={at}
        label={FIELD_LABELS.priority}
        exclude={row.exclude === true}
        onExclude={(exclude) => onChange(withExclusion(row, exclude))}
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
        exclude={row.exclude === true}
        onExclude={(exclude) => onChange(withExclusion(row, exclude))}
        values={row.values}
        options={itemTypes.map((type) => ({ id: type.id, label: type.name }))}
        empty={NO_TYPES}
        onChange={(values) => onChange({ ...row, values })}
        onRemove={onRemove}
      />
    );
  }
  if (row.field === 'panel') {
    return (
      <ValuesCondition
        at={at}
        label={FIELD_LABELS.panel}
        exclude={row.exclude === true}
        onExclude={(exclude) => onChange(withExclusion(row, exclude))}
        values={row.values}
        options={panels
          .filter(panelTakesItems)
          .map((panel) => ({ id: panel.id, label: panel.name }))}
        empty={NO_PANELS_TO_CHOOSE}
        onChange={(values) => onChange({ ...row, values })}
        onRemove={onRemove}
      />
    );
  }
  if (row.field === 'status') {
    return (
      <ValuesCondition
        at={at}
        label={FIELD_LABELS.status}
        exclude={row.exclude === true}
        onExclude={(exclude) => onChange(withExclusion(row, exclude))}
        values={statusValuesOf(row)}
        options={STATUS_OPTIONS}
        onChange={(values) => onChange({ ...row, values: values as ('to_do' | 'in_progress')[] })}
        onRemove={onRemove}
      />
    );
  }
  return <DueConditionRow at={at} row={row} onChange={onChange} onRemove={onRemove} />;
}

/** The two statuses a Status card offers - never Done, which a Filter panel does not draw. */
const STATUS_OPTIONS = [
  { id: 'to_do', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
];

/** A values condition with its *is* / *is not* set, writing no `exclude` at all for *is* so a card never saved as *is not* stays as it was stored. */
function withExclusion<T extends Exclude<FilterCondition, { field: 'dueDate' }>>(row: T, exclude: boolean): T {
  const { exclude: _was, ...rest } = row;
  return (exclude ? { ...rest, exclude: true } : rest) as T;
}

/**
 * Every condition is one grid of four columns - field, operator or window,
 * values, remove - so the columns line up from box to box and each box reads
 * as one sentence (*Priority* *is not* *Low*). Each box is its own grid rather
 * than one shared by all, so a row can still wrap its values onto lines of
 * their own; the fixed first two tracks are what keep the boxes aligned.
 */
const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 sm:grid-cols-[5rem_6.5rem_minmax(0,1fr)_auto]';
const FIELD = 'pt-1 text-sm font-semibold text-ink-strong max-sm:col-start-1';
/** On a phone the four tracks do not fit beside the gutter, so a box stacks: the field and its cross on the first line, then the operator, then the values, each across the full width. */
const ACROSS = 'max-sm:col-span-2';
const OPERATOR =
  'w-full rounded-md border border-shade/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40 max-sm:col-span-2';

/** The cross that removes a condition, named by its place so a screen reader can tell the boxes apart. */
function RemoveButton({ at, onRemove }: { at: number; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove condition ${at + 1}`}
      className="rounded-md px-2 py-1 text-base leading-none text-ink-faint hover:bg-accent-tint hover:text-accent-deep max-sm:col-start-2 max-sm:row-start-1"
    >
      {'\u00d7'}
    </button>
  );
}

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
    <div className={ROW}>
      <span className={FIELD}>Due date</span>
      <select
        value={row.window}
        aria-label={`Due date is, condition ${at + 1}`}
        onChange={(event) => onChange({ ...row, window: event.target.value as DueWindow })}
        className={OPERATOR}
      >
        {DUE_WINDOWS.map((window) => (
          <option key={window} value={window}>
            {WINDOW_LABELS[window]}
          </option>
        ))}
      </select>
      <span className={`pt-1 ${ACROSS}`}>
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
      </span>
      <RemoveButton at={at} onRemove={onRemove} />
    </div>
  );
}

/**
 * A Priority, a Type, a Panel or a Status row: an *is / is not* choice and a checkbox per value on offer, any of
 * which the condition matches ("Filter a Filter panel by priority and type",
 * issue 464; "Filter a Filter panel by panel, and name the Filters a panel's
 * deletion affects", issue 465).
 *
 * **One shape for all four.** *Is not* matches an Item holding none of the ticked values ("Include or exclude a Filter panel condition's values, and filter on To do as well as In progress", issue 908); a new card opens on *is*. Status's options are To do and In progress.
 * Priority's options are the three levels the
 * schema carries; a Type's are the account's live Types; a Panel's are the
 * Workspace's own items Panels - never a Filter or a Panel of text, nothing
 * being filed onto either. A value naming a Type or a Panel since deleted
 * stops being offered here the moment it is - which is also why nothing here
 * needs to know about a deleted one at all: `itemTypes` and `panels` already
 * carry only the live ones, so a value not among them simply draws no
 * checkbox, matching what it now means (`filters.ts`).
 *
 * **Checkboxes, not a `select`.** The question is which of several values
 * matches, so the answer is a set rather than one choice from a list - the
 * shape a `select` cannot hold at all.
 */
function ValuesCondition({
  at,
  label,
  exclude,
  onExclude,
  values,
  options,
  empty,
  onChange,
  onRemove,
}: {
  at: number;
  label: string;
  exclude: boolean;
  onExclude: (exclude: boolean) => void;
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
    <div className={ROW}>
      <span className={FIELD}>{label}</span>
      <select
        value={exclude ? 'not' : 'is'}
        aria-label={`${label} is or is not`}
        onChange={(event) => onExclude(event.target.value === 'not')}
        className={OPERATOR}
      >
        <option value="is">is</option>
        <option value="not">is not</option>
      </select>
      <fieldset className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-1 ${ACROSS}`}>
        <legend className="sr-only">{label}</legend>
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
      <RemoveButton at={at} onRemove={onRemove} />
    </div>
  );
}

export default FilterQuestion;
