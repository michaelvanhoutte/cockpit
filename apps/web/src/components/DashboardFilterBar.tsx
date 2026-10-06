import { DUE_WINDOWS, type DueWindow, type ItemStatus } from '@cockpit/shared';
import { lazy, Suspense, useEffect, useRef } from 'react';
import {
  NO_DASHBOARD_FILTER,
  isFiltering,
  useDashboardFilter,
  useFilterBarOpen,
  type AttachmentsChoice,
  type DashboardFilter,
  type PriorityChoice,
} from '../dashboardFilter';
import { isAPeriod } from '../filters';
import { browserStore } from '../lastVisited';
import { PRIORITY_LABELS } from '../priority';
import { useRoomForTheInbox } from '../roomForTheInbox';
import { WINDOW_LABELS } from './FilterQuestion';

const FilterSummary = lazy(() => import('./FilterSummary'));

const PRIORITIES: { value: PriorityChoice; label: string }[] = [
  { value: 'high', label: PRIORITY_LABELS.high },
  { value: 'normal', label: PRIORITY_LABELS.normal },
  { value: 'low', label: PRIORITY_LABELS.low },
  { value: 'none', label: 'No priority' },
];

const STATUSES: { value: ItemStatus; label: string }[] = [
  { value: 'to_do', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

// Neither pressed is no attachments condition (stored as 'any'), so no button says "Any".
const ATTACHMENTS: { value: Exclude<AttachmentsChoice, 'any'>; label: string }[] = [
  { value: 'with', label: 'With' },
  { value: 'without', label: 'Without' },
];

/** The funnel a tab carries and the bar's own heading draws; filled where a filter is on. */
export function FunnelGlyph({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M1 1.5h10L7.2 6.1v4.2L4.8 11V6.1z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One pill's words per condition set, in the bar's order: Status, Priority,
 * Due, Containing, Attachments, Agent running. What the phone's summary line
 * says in place of the bar.
 */
export function filterPills(filter: DashboardFilter): string[] {
  const pills: string[] = [];
  for (const { value, label } of STATUSES) if (filter.statuses.includes(value)) pills.push(label);
  for (const { value, label } of PRIORITIES) if (filter.priorities.includes(value)) pills.push(label);
  if (filter.due) {
    const { window, orOverdue } = filter.due;
    if (window === 'overdue') pills.push('Overdue');
    else if (window === 'none') pills.push('No due date');
    else pills.push(`Due ${WINDOW_LABELS[window].toLowerCase()}${orOverdue ? ' or overdue' : ''}`);
  }
  if (filter.text.trim() !== '') pills.push(`"${filter.text.trim()}"`);
  if (filter.attachments === 'with') pills.push('With attachments');
  if (filter.attachments === 'without') pills.push('Without attachments');
  if (filter.agentRunning) pills.push('Agent running');
  return pills;
}

export const hiddenWords = (panelsHidden: number) =>
  panelsHidden === 1 ? '1 panel hidden' : `${panelsHidden} panels hidden`;

/**
 * Where the Dashboard filter is set ("Filter a dashboard by priority, due date,
 * text and attachments", issue 633).
 *
 * **From 768px (`ROOM_FOR_THE_INBOX`) a bar**; below it a one-line summary and
 * a bottom sheet holding the same controls (issue 792). Which one draws is the
 * width and nothing else; the filter, and whether the funnel on the tab has
 * opened it, are the same.
 *
 * **A filtered Dashboard always shows it** - the bar, or the summary - whether
 * it was opened or the filter came back from a reload, so a filter is never on
 * out of sight.
 */
export function DashboardFilterBar(props: {
  /** How many Panels the filter hid, said beside the clear control; nothing at 0. */
  panelsHidden?: number;
  dashboardId: string;
  /** Whether to offer *Done*: a dashboard does not, since a finished item is on no dashboard. */
  withDone?: boolean;
}) {
  const room = useRoomForTheInbox();
  const [, setOpen] = useFilterBarOpen(props.dashboardId);
  // Crossing the breakpoint keeps the filter and drops what was open: a sheet
  // has no business surviving as a bar, and a bar not as a sheet.
  const was = useRef(room);
  useEffect(() => {
    if (was.current === room) return;
    was.current = room;
    setOpen(false);
  }, [room, setOpen]);
  return room ? <FilterBar {...props} /> : (
    <Suspense fallback={null}>
      <FilterSummary {...props} />
    </Suspense>
  );
}

/**
 * The controls, once, for the bar and the sheet to share: the sheet draws the
 * same buttons and fields with a label beside each in a fixed column.
 */
export function FilterControls({
  filter,
  setFilter,
  withDone,
  sheet,
}: {
  filter: DashboardFilter;
  setFilter: (next: DashboardFilter) => void;
  withDone: boolean;
  sheet: boolean;
}) {
  const chip = (on: boolean) =>
    `rounded-full border text-xs ${sheet ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-0.5'} ${
      on ? 'border-accent bg-accent text-on-accent' : 'border-shade/15 text-ink-soft hover:bg-shade/5'
    }`;

  // A field that holds a value wears a 2px accent border (the 1px border plus an inset ring, so
  // the field keeps its size) where an empty one has the plain 1px.
  const set = (on: boolean) =>
    `bg-transparent border ${on ? 'border-accent ring-1 ring-inset ring-accent' : 'border-shade/15'}`;

  // One filter's chips are joined inside one outline, so where a filter ends is
  // plain without spending width on a label.
  // In the sheet the options wrap between one another, each its own outline, so none breaks
  // across two lines at phone width.
  const group = sheet
    ? 'flex flex-wrap items-center gap-1.5'
    : 'inline-flex items-center overflow-hidden rounded-full border border-shade/15';
  const segment = (on: boolean) =>
    `whitespace-nowrap text-xs ${
      sheet
        ? `rounded-full border px-3 py-1.5 text-sm ${on ? 'border-accent' : 'border-shade/15'}`
        : 'border-l border-shade/15 first:border-l-0 px-2.5 py-0.5'
    } ${on ? 'bg-accent text-on-accent' : 'text-ink-soft hover:bg-shade/5'}`;
  const field = sheet ? 'px-2 py-1.5 text-sm' : 'px-1 py-0.5 text-xs';

  // In the sheet, each condition is a row with its label in a fixed column; in
  // the bar the control stands alone, with the labels it always had inline.
  const row = (label: string, control: React.ReactNode, key: string) =>
    sheet ? (
      <div key={key} className="flex items-start gap-3">
        <span className="w-24 shrink-0 pt-1.5 text-sm text-ink-soft" aria-hidden="true">
          {label}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{control}</div>
      </div>
    ) : (
      control
    );

  return (
    <>
      {row(
        'Status',
        <fieldset className={group}>
          <legend className="sr-only">Status</legend>
          {STATUSES.filter(({ value }) => withDone || value !== 'done').map(({ value, label }) => {
            const on = filter.statuses.includes(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={on}
                className={segment(on)}
                onClick={() =>
                  setFilter({
                    ...filter,
                    statuses: on
                      ? filter.statuses.filter((s) => s !== value)
                      : [...filter.statuses, value],
                  })
                }
              >
                {label}
              </button>
            );
          })}
        </fieldset>,
        'status',
      )}

      {row(
        'Priority',
        <fieldset className={group}>
          <legend className="sr-only">Priority</legend>
          {PRIORITIES.map(({ value, label }) => {
            const on = filter.priorities.includes(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={on}
                className={segment(on)}
                onClick={() =>
                  setFilter({
                    ...filter,
                    priorities: on
                      ? filter.priorities.filter((p) => p !== value)
                      : [...filter.priorities, value],
                  })
                }
              >
                {label}
              </button>
            );
          })}
        </fieldset>,
        'priority',
      )}

      {row(
        'Due',
        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-1.5">
            {sheet ? (
              <span className="sr-only">Due</span>
            ) : (
              <span className="text-ink-soft">Due</span>
            )}
            <select
              className={`rounded ${field} ${set(filter.due !== null)}`}
              value={filter.due?.window ?? ''}
              onChange={(event) =>
                setFilter({
                  ...filter,
                  due: event.target.value
                    ? {
                        window: event.target.value as DueWindow,
                        orOverdue: filter.due?.orOverdue ?? true,
                      }
                    : null,
                })
              }
            >
              <option value="">Any time</option>
              {DUE_WINDOWS.map((window) => (
                <option key={window} value={window}>
                  {WINDOW_LABELS[window]}
                </option>
              ))}
            </select>
          </label>
          {filter.due && isAPeriod(filter.due.window) && (
            <label className={`flex items-center gap-1 text-ink-soft ${sheet ? 'text-sm' : 'text-xs'}`}>
              <input
                type="checkbox"
                checked={filter.due.orOverdue}
                onChange={(event) =>
                  filter.due &&
                  setFilter({ ...filter, due: { ...filter.due, orOverdue: event.target.checked } })
                }
              />
              or overdue
            </label>
          )}
        </div>,
        'due',
      )}

      {row(
        'Containing',
        <label className={`flex flex-1 items-center gap-1.5 ${sheet ? 'min-w-0' : 'min-w-40'}`}>
          <span className="sr-only">Containing</span>
          <input
            type="search"
            placeholder="Containing…"
            className={`w-full rounded ${sheet ? 'px-2 py-1.5 text-sm' : 'px-2 py-0.5 text-xs'} ${set(filter.text.trim() !== '')}`}
            value={filter.text}
            onChange={(event) => setFilter({ ...filter, text: event.target.value })}
          />
        </label>,
        'text',
      )}

      {row(
        'Attachments',
        <fieldset className="flex items-center gap-1.5">
          <legend className="sr-only">Attachments</legend>
          {!sheet && (
            <span className="text-ink-soft" aria-hidden="true">
              Attachments
            </span>
          )}
          <span className={group}>
            {ATTACHMENTS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter.attachments === value}
                className={segment(filter.attachments === value)}
                onClick={() =>
                  setFilter({ ...filter, attachments: filter.attachments === value ? 'any' : value })
                }
              >
                {label}
              </button>
            ))}
          </span>
        </fieldset>,
        'attachments',
      )}

      {row(
        'Agent',
        <button
          type="button"
          aria-pressed={filter.agentRunning}
          title="Only Items with an agent started on them, a refused start included"
          className={chip(filter.agentRunning)}
          onClick={() => setFilter({ ...filter, agentRunning: !filter.agentRunning })}
        >
          Agent running
        </button>,
        'agent',
      )}
    </>
  );
}

/**
 * The bar under the dashboard bar that sets a Dashboard filter, from 768px.
 *
 * **×** clears the conditions and keeps the bar open - it is for starting over
 * - and the funnel on the open tab is what clears and closes (`DashboardBar`).
 */
function FilterBar({
  dashboardId,
  withDone = false,
  panelsHidden = 0,
}: {
  panelsHidden?: number;
  dashboardId: string;
  withDone?: boolean;
}) {
  const [filter, setFilter] = useDashboardFilter(browserStore(), dashboardId);
  const [open, setOpen] = useFilterBarOpen(dashboardId);
  const filtering = isFiltering(filter);
  if (!open && !filtering) return null;

  return (
    // Pinned to the top of the scrolling Dashboard, directly under the dashboard
    // bar (which sits outside it), so a filter is in view however far the Panels
    // have scrolled. The wrapper paints the ground so Panels do not show through
    // the bar's own translucent fill.
    <div className="sticky top-0 z-20 bg-[var(--ground,var(--color-ground))] pb-2">
      <div
        role="search"
        aria-label="Dashboard filter"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-shade/10 bg-shade/[0.03] px-3 py-2 text-sm"
      >
        <span className="flex items-center gap-1.5 text-ink-soft">
          <FunnelGlyph filled={filtering} />
          <span className="font-medium">Filter</span>
        </span>

        <FilterControls filter={filter} setFilter={setFilter} withDone={withDone} sheet={false} />

        {panelsHidden > 0 && (
          <span className="ml-auto text-xs text-ink-soft">{hiddenWords(panelsHidden)}</span>
        )}

        <button
          type="button"
          aria-label="Clear the filter"
          title="Clear the filter"
          className={`${panelsHidden > 0 ? "" : "ml-auto "}rounded px-1.5 py-0.5 text-ink-soft hover:bg-shade/5 disabled:opacity-40`}
          disabled={!filtering}
          onClick={() => {
            // Kept open even where it was up only because it was filtered, as
            // after a reload: starting over is not leaving.
            setOpen(true);
            setFilter(NO_DASHBOARD_FILTER);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

