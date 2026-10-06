import * as Dialog from '@radix-ui/react-dialog';
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  NO_DASHBOARD_FILTER,
  isFiltering,
  useDashboardFilter,
  useFilterBarOpen,
  type DashboardFilter,
} from '../dashboardFilter';
import { browserStore } from '../lastVisited';
import { whatTheSheetSwipeMeant } from '../swipe';
import { DUE_WINDOWS, type DueWindow } from '@cockpit/shared';
import { isAPeriod } from '../filters';
import { WINDOW_LABELS } from './FilterQuestion';
import { ATTACHMENTS, PRIORITIES, STATUSES } from './DashboardFilterBar';

// The phone's half of the filter, apart from the bar so a desk never fetches it.

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
export default function FilterSummary({
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
  // A re-draw once the widths are read: `fit` can come out as it was, which
  // alone would leave the render before the reading showing every pill.
  const [, read] = useState(0);
  const words = pills.join('\n');
  const measured = pills.every((pill) => widths.current.has(pill));
  useLayoutEffect(() => {
    const place = () => {
      const room = strip.current?.clientWidth ?? 0;
      setFit(howManyFit(pills.map((pill) => widths.current.get(pill) ?? 0), room, 6));
    };
    if (!measured) {
      const drawn = Array.from(strip.current?.querySelectorAll<HTMLElement>('[data-pill]') ?? []);
      // A pill with no layout (a hidden tab) reads 0: left unknown, so it is read again.
      for (const el of drawn) {
        const width = el.getBoundingClientRect().width;
        if (width > 0) widths.current.set(el.dataset.pill!, width);
      }
      // Only the pills now on show are kept, so typing in Containing does not grow the map.
      for (const key of widths.current.keys()) if (!pills.includes(key)) widths.current.delete(key);
      if (pills.every((pill) => widths.current.has(pill))) read((n) => n + 1);
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
              onClick={() => {
                setOpen(false);
                setFilter(NO_DASHBOARD_FILTER);
              }}
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
    // Not from a button: capturing would retarget its click, and Clear would never fire.
    if ((event.target as Element).closest('button')) return;
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
              <span className="font-normal text-ink-soft">{' '}· {panelsHidden === 1 ? '1 panel hidden' : `${panelsHidden} panels hidden`}</span>
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
        <SheetControls filter={filter} setFilter={setFilter} withDone={withDone} />
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

/** The conditions as rows, each with its label in a fixed column and its options wrapping. */
function SheetControls({
  filter,
  setFilter,
  withDone,
}: {
  filter: DashboardFilter;
  setFilter: (next: DashboardFilter) => void;
  withDone: boolean;
}) {
  const row = (label: string, control: React.ReactNode) => (
    <div className="flex items-start gap-3">
      <span className="w-24 shrink-0 pt-1.5 text-sm text-ink-soft" aria-hidden="true">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{control}</div>
    </div>
  );
  const option = (on: boolean) =>
    `whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${
      on ? 'border-accent bg-accent text-on-accent' : 'border-shade/15 text-ink-soft hover:bg-shade/5'
    }`;
  // A field that holds a value wears a 2px accent border, as the bar's does.
  const field = (on: boolean) =>
    `rounded bg-transparent border px-2 py-1.5 text-sm ${
      on ? 'border-accent ring-1 ring-inset ring-accent' : 'border-shade/15'
    }`;
  const toggle = <T extends string>(
    legend: string,
    options: { value: T; label: string }[],
    chosen: (value: T) => boolean,
    press: (value: T) => void,
  ) =>
    row(
      legend,
      <fieldset className="flex flex-wrap items-center gap-1.5">
        <legend className="sr-only">{legend}</legend>
        {options.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={chosen(value)}
            className={option(chosen(value))}
            onClick={() => press(value)}
          >
            {label}
          </button>
        ))}
      </fieldset>,
    );
  const without = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  return (
    <>
      {toggle(
        'Status',
        STATUSES.filter(({ value }) => withDone || value !== 'done'),
        (v) => filter.statuses.includes(v),
        (v) => setFilter({ ...filter, statuses: without(filter.statuses, v) }),
      )}
      {toggle(
        'Priority',
        PRIORITIES,
        (v) => filter.priorities.includes(v),
        (v) => setFilter({ ...filter, priorities: without(filter.priorities, v) }),
      )}
      {row(
        'Due',
        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-1.5">
            <span className="sr-only">Due</span>
            <select
              className={field(filter.due !== null)}
              value={filter.due?.window ?? ''}
              onChange={(event) =>
                setFilter({
                  ...filter,
                  due: event.target.value
                    ? { window: event.target.value as DueWindow, orOverdue: filter.due?.orOverdue ?? true }
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
            <label className="flex items-center gap-1 text-sm text-ink-soft">
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
      )}
      {row(
        'Containing',
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="sr-only">Containing</span>
          <input
            type="search"
            placeholder="Containing…"
            className={`w-full ${field(filter.text.trim() !== '')}`}
            value={filter.text}
            onChange={(event) => setFilter({ ...filter, text: event.target.value })}
          />
        </label>,
      )}
      {toggle(
        'Attachments',
        ATTACHMENTS,
        (v) => filter.attachments === v,
        (v) => setFilter({ ...filter, attachments: filter.attachments === v ? 'any' : v }),
      )}
      {row(
        'Agent',
        <button
          type="button"
          aria-pressed={filter.agentRunning}
          title="Only Items with an agent started on them, a refused start included"
          className={option(filter.agentRunning)}
          onClick={() => setFilter({ ...filter, agentRunning: !filter.agentRunning })}
        >
          Agent running
        </button>,
      )}
    </>
  );
}
