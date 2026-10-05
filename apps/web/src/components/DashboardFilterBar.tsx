import { DUE_WINDOWS, type DueWindow, type ItemStatus } from '@cockpit/shared';
import {
  NO_DASHBOARD_FILTER,
  isFiltering,
  useDashboardFilter,
  useFilterBarOpen,
  type AttachmentsChoice,
  type PriorityChoice,
} from '../dashboardFilter';
import { isAPeriod } from '../filters';
import { browserStore } from '../lastVisited';
import { PRIORITY_LABELS } from '../priority';
import { WINDOW_LABELS } from './FilterQuestion';

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

const ATTACHMENTS: { value: AttachmentsChoice; label: string }[] = [
  { value: 'any', label: 'Any' },
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
 * The bar under the dashboard bar that sets a Dashboard filter ("Filter a
 * dashboard by priority, due date, text and attachments", issue 633).
 *
 * **A filtered Dashboard always shows it**, whether it was opened or the
 * filter came back from a reload, so a filter is never on out of sight. **×**
 * clears the conditions and keeps the bar open - it is for starting over - and
 * the funnel on the open tab is what clears and closes (`DashboardBar`).
 */
export function DashboardFilterBar({
  dashboardId,
  withDone = false,
  panelsHidden = 0,
}: {
  /** How many Panels the filter hid, said beside the clear control; nothing at 0. */
  panelsHidden?: number;
  dashboardId: string;
  /** Whether to offer *Done*: a dashboard does not, since a finished item is on no dashboard. */
  withDone?: boolean;
}) {
  const [filter, setFilter] = useDashboardFilter(browserStore(), dashboardId);
  const [open, setOpen] = useFilterBarOpen(dashboardId);
  const filtering = isFiltering(filter);
  if (!open && !filtering) return null;

  const chip = (on: boolean) =>
    `rounded-full border px-2.5 py-0.5 text-xs ${
      on ? 'border-accent bg-accent-tint text-ink' : 'border-shade/15 text-ink-soft hover:bg-shade/5'
    }`;

  // One filter's chips are joined inside one outline, so where a filter ends is
  // plain without spending width on a label.
  const group = 'inline-flex items-center overflow-hidden rounded-full border border-shade/15';
  const segment = (on: boolean) =>
    `border-l border-shade/15 px-2.5 py-0.5 text-xs first:border-l-0 ${
      on ? 'bg-accent-tint text-ink' : 'text-ink-soft hover:bg-shade/5'
    }`;

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
        </fieldset>

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
        </fieldset>

        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-1.5">
            <span className="text-ink-soft">Due</span>
            <select
              className="rounded border border-shade/15 bg-transparent px-1 py-0.5 text-xs"
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
            <label className="flex items-center gap-1 text-xs text-ink-soft">
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
        </div>

        <label className="flex min-w-40 flex-1 items-center gap-1.5">
          <span className="sr-only">Containing</span>
          <input
            type="search"
            placeholder="Containing…"
            className="w-full rounded border border-shade/15 bg-transparent px-2 py-0.5 text-xs"
            value={filter.text}
            onChange={(event) => setFilter({ ...filter, text: event.target.value })}
          />
        </label>

        <fieldset className="flex items-center gap-1.5">
          <legend className="sr-only">Attachments</legend>
          <span className="text-ink-soft" aria-hidden="true">
            Attachments
          </span>
          <span className={group}>
            {ATTACHMENTS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter.attachments === value}
                className={segment(filter.attachments === value)}
                onClick={() => setFilter({ ...filter, attachments: value })}
              >
                {label}
              </button>
            ))}
          </span>
        </fieldset>

        <button
          type="button"
          aria-pressed={filter.agentRunning}
          title="Only Items with an agent started on them, a refused start included"
          className={chip(filter.agentRunning)}
          onClick={() => setFilter({ ...filter, agentRunning: !filter.agentRunning })}
        >
          Agent running
        </button>

        {panelsHidden > 0 && (
          <span className="ml-auto text-xs text-ink-soft">
            {panelsHidden === 1 ? '1 panel hidden' : `${panelsHidden} panels hidden`}
          </span>
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
