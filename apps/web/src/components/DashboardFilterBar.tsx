import * as Dialog from '@radix-ui/react-dialog';
import { DUE_WINDOWS, type DueWindow, type ItemStatus } from '@cockpit/shared';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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
import { whatTheSheetSwipeMeant } from '../swipe';
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

const hiddenWords = (panelsHidden: number) =>
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
  return room ? <FilterBar {...props} /> : <FilterSummary {...props} />;
}

/**
 * The controls, once, for the bar and the sheet to share: the sheet draws the
 * same buttons and fields with a label beside each in a fixed column.
 */
function FilterControls({
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
  const group = 'inline-flex items-center overflow-hidden rounded-full border border-shade/15';
  const segment = (on: boolean) =>
    `border-l border-shade/15 text-xs first:border-l-0 ${sheet ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-0.5'} ${
      on ? 'bg-accent text-on-accent' : 'text-ink-soft hover:bg-shade/5'
    }`;
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

/** Room kept at the end of the pills for "+n" when some do not fit. */
const ROOM_FOR_THE_MORE = 40;

/**
 * How many of the pills fit in `room` pixels, with the "+n" kept clear when not
 * all do. Zero width (no layout: jsdom, a hidden tab) answers "all", so nothing
 * is dropped where nothing was measured.
 */
function howManyFit(widths: number[], room: number, gap: number): number {
  if (room <= 0) return widths.length;
  const all = widths.reduce((sum, w, i) => sum + w + (i ? gap : 0), 0);
  if (all <= room) return widths.length;
  let used = ROOM_FOR_THE_MORE;
  let fit = 0;
  for (const w of widths) {
    used += w + gap;
    if (used > room) break;
    fit += 1;
  }
  return Math.max(fit, 1);
}

/**
 * The phone's stand-in for the bar: one pinned row, only while a filter is on,
 * and the sheet that sets it, opened by the line or by the funnel on the tab.
 */
function FilterSummary({
  dashboardId,
  withDone = false,
  panelsHidden = 0,
}: {
  panelsHidden?: number;
  dashboardId: string;
  withDone?: boolean;
}) {
  const [filter, setFilter] = useDashboardFilter(browserStore(), dashboardId);
  // The sheet is "the bar open": the funnel's press and the tab's own state
  // are the same whichever of the two draws.
  const [open, setOpen] = useFilterBarOpen(dashboardId);
  const filtering = isFiltering(filter);
  const pills = filterPills(filter);
  const summary = useRef<HTMLButtonElement>(null);

  // How many pills fit beside the rest of the line. Each pill's width is read
  // off the real pill the first time it is drawn (all of them are, until every
  // width is known) and kept, so a resize only does sums.
  const strip = useRef<HTMLSpanElement>(null);
  const widths = useRef(new Map<string, number>());
  const [fit, setFit] = useState(pills.length);
  const words = pills.join('\n');
  const measured = pills.every((pill) => widths.current.has(pill));
  useLayoutEffect(() => {
    const place = () => {
      const room = strip.current?.clientWidth ?? 0;
      setFit(howManyFit(pills.map((pill) => widths.current.get(pill) ?? 0), room, 6));
    };
    if (!measured) {
      const drawn = Array.from(strip.current?.querySelectorAll<HTMLElement>('[data-pill]') ?? []);
      for (const el of drawn) widths.current.set(el.dataset.pill!, el.getBoundingClientRect().width);
    }
    place();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (strip.current) watch?.observe(strip.current);
    return () => watch?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, panelsHidden, measured]);
  const shown = measured ? pills.slice(0, fit) : pills;

  return (
    <>
      {filtering && (
        <div className="sticky top-0 z-20 bg-[var(--ground,var(--color-ground))] pb-2">
          <div
            role="group"
            aria-label="Dashboard filter summary"
            className="flex items-center gap-1 rounded-md border border-shade/10 bg-shade/[0.03] pr-1 text-sm"
          >
            <button
              ref={summary}
              type="button"
              aria-haspopup="dialog"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 pl-3 text-left"
              onClick={() => setOpen(true)}
            >
              <span ref={strip} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                {shown.map((pill) => (
                  <span
                    key={pill}
                    data-pill={pill}
                    className="shrink-0 rounded-full border border-accent bg-accent px-2.5 py-0.5 text-xs text-on-accent"
                  >
                    {pill}
                  </span>
                ))}
                {shown.length < pills.length && (
                  <span className="shrink-0 text-xs text-ink-soft">+{pills.length - shown.length}</span>
                )}
              </span>
              {panelsHidden > 0 && (
                <span className="shrink-0 text-xs text-ink-soft">· {panelsHidden} hidden</span>
              )}
              <span className="shrink-0 pr-1 text-xs font-medium text-accent-deep">Edit</span>
            </button>
            <button
              type="button"
              aria-label="Clear the filter"
              title="Clear the filter"
              className="rounded px-2 py-1 text-ink-soft hover:bg-shade/5"
              onClick={() => setFilter(NO_DASHBOARD_FILTER)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      <Dialog.Root open={open} onOpenChange={(now) => !now && setOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-floating bg-shade/40" />
          <FilterSheet
            filter={filter}
            setFilter={setFilter}
            withDone={withDone}
            panelsHidden={panelsHidden}
            filtering={filtering}
            close={() => setOpen(false)}
            // Back on the summary where there is one; with nothing set there is
            // none, and focus goes back to where it came from.
            returnFocus={(event) => {
              if (!summary.current) return;
              event.preventDefault();
              summary.current.focus();
            }}
          />
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/** The sheet that slides up over the scrim: the controls, Clear and Done. */
function FilterSheet({
  filter,
  setFilter,
  withDone,
  panelsHidden,
  filtering,
  close,
  returnFocus,
}: {
  filter: DashboardFilter;
  setFilter: (next: DashboardFilter) => void;
  withDone: boolean;
  panelsHidden: number;
  filtering: boolean;
  close: () => void;
  returnFocus: (event: Event) => void;
}) {
  // A swipe down on the handle and header closes it, a touch gesture only: the
  // scrolling body below is left to scroll.
  const start = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState(0);
  const down = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'touch') return;
    start.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: ReactPointerEvent) => {
    if (!start.current) return;
    setDrag(Math.max(0, event.clientY - start.current.y));
  };
  const up = (event: ReactPointerEvent) => {
    const from = start.current;
    start.current = null;
    setDrag(0);
    if (from && whatTheSheetSwipeMeant(event.clientX - from.x, event.clientY - from.y)) close();
  };

  return (
    <Dialog.Content
      aria-describedby={undefined}
      onCloseAutoFocus={returnFocus}
      style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
      className="fixed inset-x-0 bottom-0 z-floating flex max-h-[85dvh] flex-col rounded-t-2xl border-t border-shade/10 bg-surface pb-[calc(1rem_+_var(--edge-bottom,0px))] shadow-lg"
    >
      <div
        className="touch-none"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          start.current = null;
          setDrag(0);
        }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-shade/20" aria-hidden="true" />
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
          <Dialog.Title className="text-base font-semibold">
            Filter
            {panelsHidden > 0 && (
              <span className="font-normal text-ink-soft"> · {hiddenWords(panelsHidden)}</span>
            )}
          </Dialog.Title>
          <button
            type="button"
            aria-label="Clear the filter"
            className="rounded px-2 py-1 text-sm font-medium text-accent-deep hover:bg-shade/5 disabled:opacity-40"
            disabled={!filtering}
            // The sheet stays: starting over is not leaving.
            onClick={() => setFilter(NO_DASHBOARD_FILTER)}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4 pt-1">
        <FilterControls filter={filter} setFilter={setFilter} withDone={withDone} sheet />
      </div>
      <div className="px-4">
        <button
          type="button"
          className="milled w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-on-accent"
          onClick={close}
        >
          Done
        </button>
      </div>
    </Dialog.Content>
  );
}
