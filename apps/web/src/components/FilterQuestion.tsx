import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import {
  DUE_WINDOWS,
  FILTER_GROUPINGS,
  panelTakesItems,
  prioritySchema,
  statusValuesOf,
  type Dashboard,
  type DueCondition,
  type DueWindow,
  type FilterCondition,
  type FilterGrouping,
  type Layout,
  type Panel,
  type Priority,
} from '@cockpit/shared';
import { GROUPING_NAMES, WINDOW_LABELS, isAPeriod } from '../filters';
import { orderedAsDrawn } from '../filterGroups';
import { MenuContent, menuItemClass } from './Menu';
import { Segmented } from './Segmented';
import { PRIORITY_LABELS } from '../priority';

/** What a Panel condition's value picker says when the Workspace has no items Panel to offer at all. */
const NO_PANELS_TO_CHOOSE = 'No panels to choose from yet.';

/**
 * What a Filter shows, asked in a form of its own ("Add a Filter panel that
 * shows every filed item due in a window", issue 463; "Filter a Filter panel
 * by priority and type", issue 464).
 *
 * **Rows joined by *and*, each holding one or more conditions joined by *or***
 * ("Edit a Filter as rows joined by and, each holding alternatives joined by
 * or", issue 1082). A row of one condition is a plain card; a row of several is
 * a tinted box with *or* between its cards. The rows are a list rather than a
 * sentence with clauses because that is what the question grows into - Due
 * date, Priority, Panel and the rest, each its own card rather than another
 * form.
 *
 * **A field is offered once per row**, in any number of rows: *Priority is
 * High or due today, and Priority is not Low* is two rows using Priority.
 *
 * **Saved whole, including saved empty.** Taking the last card out and saving is
 * a real answer: the Filter goes back to saying it has nothing chosen, which is
 * the state a new one arrives in.
 *
 * It follows `NameQuestion` on the two things every dialog in this app
 * settles - near the top of a phone so the keyboard does not cover the answer,
 * and the focus going back to the control it was opened from.
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
  rows: initialRows,
  groupBy: initialGroupBy,
  panels,
  dashboards,
  layouts,
  open,
  onSave,
  onCancel,
  returnFocusTo,
}: {
  panelName: string;
  /** What the Filter shows now, which the question opens on. */
  rows: readonly (readonly FilterCondition[])[];
  /** What the Filter's rows are grouped under, which the *Group by* choice opens on. */
  groupBy: FilterGrouping;
  /**
   * The Workspace's own Panels, what a Panel condition offers to choose from -
   * filtered here to the ones an Item can be filed onto (`panelTakesItems`),
   * so a Filter or a Panel of text never reaches the checkboxes: nothing is
   * ever filed onto either, and a Filter naming itself or another Filter
   * could never match anything (`panel.ts`, `panelConditionSchema`).
   */
  panels: readonly Panel[];
  /** The Workspace's Dashboards in tab order, whose names head the Panels a Panel condition lists. */
  dashboards: readonly Dashboard[];
  /** Their Layouts, which put each Dashboard's Panels in the order its board draws them. */
  layouts: readonly Layout[];
  open: boolean;
  onSave: (rows: FilterCondition[][], groupBy: FilterGrouping) => void;
  onCancel: () => void;
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
   * here is that the later save stands.
   */
  const [rows, setRows] = useState<FilterCondition[][]>(() => initialRows.map((row) => [...row]));
  /** What the rows are grouped under, saved with the conditions ("Group a Filter panel's items by the Dashboard or Panel they are filed on", issue 805). */
  const [groupBy, setGroupBy] = useState<FilterGrouping>(initialGroupBy);

  /** Puts `next` in place of one condition, or takes it out for `null`; a row left with nothing goes with it. */
  const replace = (row: number, at: number, next: FilterCondition | null) =>
    setRows(
      rows
        .map((was, index) =>
          index !== row ? was : next ? was.map((c, i) => (i === at ? next : c)) : was.filter((_, i) => i !== at),
        )
        .filter((was) => was.length > 0),
    );

  /** Adds a condition to a row as an alternative, or as a row of its own where `row` is null. */
  const add = (row: number | null, field: FilterCondition['field']) =>
    setRows(
      row === null
        ? [...rows, [defaultConditionFor(field)]]
        : rows.map((was, index) => (index === row ? [...was, defaultConditionFor(field)] : was)),
    );

  /** The number a condition goes by in reading order across every row, which names its controls. */
  const numberOf = (row: number, at: number) => rows.slice(0, row).reduce((n, was) => n + was.length, 0) + at;

  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && onCancel()}>
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
            Every item filed on a panel of this workspace that meets every row, a row being met by any one of its
            conditions.
          </Dialog.Description>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSave(rows, groupBy);
            }}
            className="pt-4"
          >
            {rows.length === 0 ? (
              <p className="text-sm text-ink-faint">Nothing chosen yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map((row, rowAt) => (
                  <li key={rowAt} className="flex items-start gap-2">
                    {/* Fixed words, not a choice: rows are always joined by and. */}
                    <span className="w-14 shrink-0 pt-3 text-right text-sm text-ink-soft">
                      {rowAt === 0 ? 'Where' : 'and'}
                    </span>
                    <div
                      className={
                        row.length > 1
                          ? 'flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-accent-soft/40 bg-accent-tint/40 p-2'
                          : 'flex min-w-0 flex-1 flex-col gap-1'
                      }
                    >
                      {row.map((condition, at) => (
                        <div key={condition.field} className="flex flex-col gap-1">
                          {at > 0 && <span className="px-1 text-xs font-semibold text-ink-soft">or</span>}
                          <div className="rounded-md border border-shade/10 bg-surface p-3">
                            <ConditionRow
                              at={numberOf(rowAt, at)}
                              row={condition}
                              panels={panels}
                              dashboards={dashboards}
                              layouts={layouts}
                              onChange={(next) => replace(rowAt, at, next)}
                              onRemove={() => replace(rowAt, at, null)}
                            />
                          </div>
                        </div>
                      ))}
                      <AddMenu
                        label="+ Or…"
                        name={`+ Or… to row ${rowAt + 1}`}
                        fields={FIELD_ORDER.filter((field) => !row.some((condition) => condition.field === field))}
                        onAdd={(field) => add(rowAt, field)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <AddMenu label="+ And…" name="+ And…" fields={FIELD_ORDER} onAdd={(field) => add(null, field)} />

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


            <div className="flex justify-end gap-2 pt-5">
              <Dialog.Close
                className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
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
 * *+ Or…* at the end of a row and *+ And…* under the rows: the same menu of
 * fields, offering a row's alternatives only the fields it does not already
 * hold ("a field once per row") and a new row every field. Absent where there
 * is nothing left to offer.
 */
function AddMenu({
  label,
  name,
  fields,
  onAdd,
}: {
  label: string;
  /** What a screen reader calls the button, so the several *+ Or…* can be told apart. */
  name: string;
  fields: readonly FilterCondition['field'][];
  onAdd: (field: FilterCondition['field']) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        type="button"
        aria-label={name}
        className="mt-1 self-start rounded-md border border-shade/10 bg-surface px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
      >
        {label}
      </DropdownMenu.Trigger>
      <MenuContent>
        {fields.map((field) => (
          <DropdownMenu.Item key={field} className={menuItemClass} onSelect={() => onAdd(field)}>
            {FIELD_LABELS[field]}
          </DropdownMenu.Item>
        ))}
      </MenuContent>
    </DropdownMenu.Root>
  );
}

/** The fields a condition can be about, in the order the add menus offer them. */
const FIELD_ORDER: readonly FilterCondition['field'][] = ['dueDate', 'priority', 'panel', 'dashboard', 'status', 'agent'];

/** What each field is called on the add menus and beside its row. */
const FIELD_LABELS: Record<FilterCondition['field'], string> = {
  dueDate: 'Due date',
  priority: 'Priority',
  panel: 'Panel',
  dashboard: 'Dashboard',
  status: 'Status',
  agent: 'Agent running',
};

/** A fresh row for a field just added - nothing chosen yet, except Due date, which has always defaulted to *today*, and Status, which opens on In progress, the one answer it gave before it took values. Every values card opens on *is*: no `exclude` is written until *is not* is chosen. */
function defaultConditionFor(field: FilterCondition['field']): FilterCondition {
  if (field === 'dueDate') return { field: 'dueDate', window: 'today', orOverdue: true };
  if (field === 'priority') return { field: 'priority', values: [] };
  if (field === 'panel') return { field: 'panel', values: [] };
  if (field === 'dashboard') return { field: 'dashboard', values: [] };
  if (field === 'agent') return { field: 'agent' };
  return { field: 'status', values: ['in_progress'] };
}

/** One row, dispatched to the control its field takes. */
function ConditionRow({
  at,
  row,
  panels,
  dashboards,
  layouts,
  onChange,
  onRemove,
}: {
  at: number;
  row: FilterCondition;
  panels: readonly Panel[];
  dashboards: readonly Dashboard[];
  layouts: readonly Layout[];
  onChange: (row: FilterCondition) => void;
  onRemove: () => void;
}) {
  if (row.field === 'agent') return <AgentConditionRow at={at} onRemove={onRemove} />;
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
  if (row.field === 'panel') {
    return (
      <ValuesCondition
        at={at}
        label={FIELD_LABELS.panel}
        exclude={row.exclude === true}
        onExclude={(exclude) => onChange(withExclusion(row, exclude))}
        values={row.values}
        options={panelOptions(panels, dashboards, layouts)}
        empty={NO_PANELS_TO_CHOOSE}
        onChange={(values) => onChange({ ...row, values })}
        onRemove={onRemove}
      />
    );
  }
  if (row.field === 'dashboard') {
    return (
      <ValuesCondition
        at={at}
        label={FIELD_LABELS.dashboard}
        exclude={row.exclude === true}
        onExclude={(exclude) => onChange(withExclusion(row, exclude))}
        values={row.values}
        options={dashboards.map((dashboard) => ({ id: dashboard.id, label: dashboard.name }))}
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

/**
 * The Panels a Panel condition offers, each carrying its Dashboard: Dashboards
 * in tab order and a Dashboard's Panels as its Layout draws them ("Choose a
 * Filter condition's values from a searchable list, with Panels under their
 * Dashboard", issue 910).
 *
 * **The order Group by *Panel* and Go to panel already use** (`orderedAsDrawn`),
 * not the order the Panels were made in, so the list reads as the board does.
 * A Filter or a Panel of text is left out (`panelTakesItems`), and so is a
 * Panel whose Dashboard is not among those handed in: it has no heading to sit
 * under.
 */
function panelOptions(
  panels: readonly Panel[],
  dashboards: readonly Dashboard[],
  layouts: readonly Layout[],
): ValueOption[] {
  return dashboards.flatMap((dashboard) =>
    orderedAsDrawn(
      panels.filter((panel) => panel.dashboardId === dashboard.id && panelTakesItems(panel)),
      layouts.find((layout) => layout.dashboardId === dashboard.id) ?? null,
    ).map((panel) => ({ id: panel.id, label: panel.name, group: dashboard.name })),
  );
}

/** The two statuses a Status card offers - never Done, which a Filter panel does not draw. */
const STATUS_OPTIONS = [
  { id: 'to_do', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
];

/** A values condition with its *is* / *is not* set, writing no `exclude` at all for *is* so a card never saved as *is not* stays as it was stored. */
function withExclusion<T extends Exclude<FilterCondition, { field: 'dueDate' | 'agent' }>>(row: T, exclude: boolean): T {
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
      <span className={`pt-1 ${ACROSS}${isAPeriod(row.window) ? '' : ' max-sm:hidden'}`}>
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

/** An Agent running row: the field name and its cross alone, since it has no operator and no values ("Gather the Items an agent is running on into a Filter panel", issue 1153). */
function AgentConditionRow({ at, onRemove }: { at: number; onRemove: () => void }) {
  return (
    <div className={ROW}>
      <span className={`${FIELD} sm:col-span-3`}>{FIELD_LABELS.agent}</span>
      <RemoveButton at={at} onRemove={onRemove} />
    </div>
  );
}

/** One thing a values card can hold; `group` is the heading it is listed under, and is said after its name on its chip. */
type ValueOption = { id: string; label: string; group?: string };

/**
 * A Priority, a Panel, a Dashboard or a Status row: an *is / is not* choice, the
 * chosen values as chips, and a list to choose them from ("Filter a Filter
 * panel by priority and type", issue 464; "Filter a Filter panel by panel, and
 * name the Filters a panel's deletion affects", issue 465; "Choose a Filter
 * condition's values from a searchable list, with Panels under their
 * Dashboard", issue 910).
 *
 * **One shape for all four.** *Is not* matches an Item holding none of the
 * chosen values ("Include or exclude a Filter panel condition's values, and
 * filter on To do as well as In progress", issue 908); a new card opens on
 * *is*. Status's options are To do and In progress. Priority's are the three
 * levels the schema carries; a Panel's
 * are the Workspace's own items Panels - never a Filter or a Panel of text,
 * nothing being filed onto either.
 *
 * **Chips are drawn from the options, not from the stored values.** A value
 * naming a Panel since deleted is not among them, so it shows no
 * chip and the list does not offer it - matching what it now means
 * (`filters.ts`) with nothing here needing to know about a deleted one.
 *
 * **Chips rather than a row of checkboxes** because a Workspace holds dozens of
 * Panels and a row of names stops being something to read: the chips are what
 * the card holds, and the list is only where that is changed.
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
  options: readonly ValueOption[];
  /** What to say instead of any chips and list where there is nothing to offer - a Panel condition where the Workspace has no Panels to choose from. */
  empty?: string;
  onChange: (values: string[]) => void;
  onRemove: () => void;
}) {
  const toggle = (id: string) =>
    onChange(values.includes(id) ? values.filter((held) => held !== id) : [...values, id]);
  const chosen = values
    .map((id) => options.find((option) => option.id === id))
    .filter((option): option is ValueOption => option !== undefined);

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
      <div role="group" aria-label={label} className={`flex min-w-0 flex-wrap items-center gap-1.5 ${ACROSS}`}>
        {options.length === 0 && empty ? (
          <span className="pt-1 text-sm text-ink-faint">{empty}</span>
        ) : (
          <>
            {chosen.map((option) => (
              <span
                key={option.id}
                className={`inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-sm ${
                  exclude
                    ? 'border-over-ink/40 bg-over-ink/10 text-over-ink'
                    : 'border-accent bg-accent-tint text-accent-deep'
                }`}
              >
                {/* Struck through under *is not*, so the chip says what the card does without the operator being read. */}
                <span className={`truncate${exclude ? ' line-through' : ''}`}>{option.label}</span>
                {option.group && (
                  <span className="shrink-0 text-xs opacity-70">
                    {'·'} {option.group}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => toggle(option.id)}
                  aria-label={`Take ${option.label} out`}
                  className="rounded-full px-1 leading-none hover:bg-shade/10"
                >
                  {'×'}
                </button>
              </span>
            ))}
            <ValuePicker label={label} options={options} values={values} onToggle={toggle} />
          </>
        )}
      </div>
      <RemoveButton at={at} onRemove={onRemove} />
    </div>
  );
}

/** How many options a list holds before it gets a search box. */
const SEARCHABLE_ABOVE = 6;

/**
 * The *+ …* button and the checkbox list it opens: ticking adds the value's
 * chip and unticking takes it away, so the list and the chips are one choice
 * seen twice.
 *
 * **A search box only past six options**, where scanning stops being quicker
 * than typing; it matches an option's name and its heading's, so naming a
 * Dashboard keeps all of its Panels. Headings stick to the top while their
 * options scroll under them. The search is forgotten when the list closes.
 */
function ValuePicker({
  label,
  options,
  values,
  onToggle,
}: {
  label: string;
  options: readonly ValueOption[];
  values: readonly string[];
  onToggle: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const shown = options.filter(
    (option) =>
      needle === '' ||
      option.label.toLowerCase().includes(needle) ||
      (option.group ?? '').toLowerCase().includes(needle),
  );
  // Options arrive already in heading order, so a heading is a run of them.
  const runs: { heading: string | undefined; options: ValueOption[] }[] = [];
  for (const option of shown) {
    const last = runs[runs.length - 1];
    if (last && last.heading === option.group) last.options.push(option);
    else runs.push({ heading: option.group, options: [option] });
  }

  return (
    <Popover.Root onOpenChange={(opened) => !opened && setSearch('')}>
      <Popover.Trigger
        type="button"
        className="rounded-full border border-dashed border-shade/20 px-2.5 py-0.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
      >
        + {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          // Kept off the edge of a phone, where the list opens beside a chip that may sit far to the right.
          collisionPadding={8}
          aria-label={label}
          className="z-floating w-64 max-w-[calc(100vw-2rem)] rounded-md border border-shade/10 bg-surface p-1 shadow-lg"
        >
          {options.length > SEARCHABLE_ABOVE && (
            <input
              type="search"
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={`Search ${label.toLowerCase()} values`}
              placeholder={`Search ${label.toLowerCase()} values`}
              className="mb-1 w-full rounded-md border border-shade/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent"
            />
          )}
          <div className="max-h-64 overflow-y-auto">
            {shown.length === 0 && <p className="px-2 py-1.5 text-sm text-ink-faint">No match.</p>}
            {runs.map((run, at) => (
              <div key={`${run.heading ?? ''}-${at}`}>
                {run.heading && (
                  <p className="sticky top-0 bg-surface px-2 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    {run.heading}
                  </p>
                )}
                {run.options.map((option) => (
                  <label
                    key={option.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-ink hover:bg-accent-tint"
                  >
                    <input
                      type="checkbox"
                      checked={values.includes(option.id)}
                      onChange={() => onToggle(option.id)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default FilterQuestion;
