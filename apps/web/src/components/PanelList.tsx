import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { PANEL_BEING_DRAGGED, PANEL_LIST_KEY } from '../panelList';
import type { PanelListing } from '../panelList';
import { movedBeside, movedToOwnRow, sameArrangement } from '../panels/arrangement';

const KEY_NAME = PANEL_LIST_KEY.toUpperCase();

/** The id the open column's heading carries, which names the column. */
const HEADING_ID = 'panel-list-heading';

/** Where the held entry would land: beside an entry, or on a line of its own at a gap. */
type Over = { kind: 'beside'; panelId: string; side: 'before' | 'after' } | { kind: 'row'; at: number };

const sameOver = (a: Over | null, b: Over | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    (a.kind === 'beside'
      ? b.kind === 'beside' && a.panelId === b.panelId && a.side === b.side
      : b.kind === 'row' && a.at === b.at));

/** Only an entry of this list: an Item, a file or a link dragged over it is none of its business. */
const isAPanel = (event: DragEvent) => event.dataTransfer.types.includes(PANEL_BEING_DRAGGED);

/**
 * The Dashboard's Panels, listed in a column at its right ("Show a Dashboard's
 * Panels in a collapsible column at its right, and jump to one", issue 803):
 * each entry is a Panel's title and the count its header shows, a row of the
 * Dashboard at a time with a hairline between rows, and pressing one brings
 * that Panel to the top.
 *
 * **A column of its own beside the Dashboard's scroller** (pages/Layout.tsx),
 * the Inbox's counterpart: it scrolls on its own and takes its width from the
 * Panels. What it draws is `listing`, published by the board that knows which
 * Panels are drawn; `null` is a board not yet on screen, which says nothing
 * rather than that there are none.
 *
 * **Dragging an entry rearranges the Dashboard** ("Rearrange a Dashboard by
 * dragging Panels in its panel list", issue 804), to the places the board's own
 * drag has: beside another entry, or on a line of its own at a gap or in the
 * *New row* box. Which arrangement a drop makes is worked out here, against
 * what the board published; what becomes of it is the board's (`arrange`).
 *
 * **The list never changes shape when an entry is picked up**: the gaps are
 * the height they always are and *New row* is added below everything, because
 * a source that moves from under the pointer ends the drag in Chrome. The held
 * state is set after the drag has started, for the same reason.
 */
export function PanelList({
  listing,
  collapsed,
  onCollapse,
}: {
  listing: PanelListing | null;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
}) {
  const [held, setHeld] = useState<string | null>(null);
  const [over, setOver] = useState<Over | null>(null);
  const pickedUp = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(pickedUp.current ?? undefined), []);
  // A drag whose source was redrawn out from under it (another tab moved a
  // Panel, or the window shrank past the phone line) never sends dragend, so
  // what was held would stay held; the board changing is the other way to know.
  const board = listing
    ? `${listing.dashboardId}|${listing.arrangeable}|${JSON.stringify(listing.arrangement)}`
    : null;
  useEffect(() => {
    window.clearTimeout(pickedUp.current ?? undefined);
    setHeld(null);
    setOver(null);
  }, [board]);

  const rows = listing?.rows ?? [];
  const count = listing ? rows.reduce((sum, row) => sum + row.length, 0) : null;
  const arrangeable = listing?.arrangeable ?? false;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => onCollapse(false)}
        title={`Open the Panel list (${KEY_NAME})`}
        aria-label="Open the Panel list"
        data-shortcut-tip="panels"
        className="well flex w-8 shrink-0 flex-col items-center gap-3 py-3 pb-[calc(0.75rem+var(--edge-bottom))] hover:bg-accent-tint/40"
      >
        <span aria-hidden="true" className="text-xs text-ink-faint">
          «
        </span>
        <span
          className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
          style={{ writingMode: 'vertical-rl' }}
        >
          Panels
        </span>
        {count !== null && <span className="text-xs tabular-nums text-ink-faint">{count}</span>}
      </button>
    );
  }

  const mark = (next: Over | null) => setOver((now) => (sameOver(now, next) ? now : next));
  const end = () => {
    window.clearTimeout(pickedUp.current ?? undefined);
    setHeld(null);
    setOver(null);
  };
  /** Sends what dropping the entry on `target` makes; the board sends nothing for a move that changes nothing. */
  const dropOn = (event: DragEvent, target: Over) => {
    if (!listing || !arrangeable || !isAPanel(event)) return;
    event.preventDefault();
    const panelId = event.dataTransfer.getData(PANEL_BEING_DRAGGED);
    end();
    if (!panelId) return;
    const next =
      target.kind === 'beside'
        ? movedBeside(listing.arrangement, panelId, target.panelId, target.side)
        : movedToOwnRow(listing.arrangement, panelId, target.at);
    if (!sameArrangement(next, listing.arrangement)) listing.arrange(next);
  };
  /** The handlers of a place to drop; none where the board cannot be rearranged. */
  const place = (target: (event: DragEvent) => Over) =>
    arrangeable
      ? {
          onDragOver: (event: DragEvent) => {
            if (!isAPanel(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            mark(target(event));
          },
          onDrop: (event: DragEvent) => dropOn(event, target(event)),
        }
      : {};

  /**
   * The line between two rows, the hairline the list always had, which is also
   * where a Panel can be dropped to take a line of its own. Always `h-3`: it
   * is the height it is whether or not something is held.
   */
  const gapAt = (at: number, hairline: boolean): ReactNode => (
    <div
      key={`gap-${at}`}
      data-panel-list-gap={at}
      className="relative h-3"
      {...place(() => ({ kind: 'row', at }))}
    >
      {over?.kind === 'row' && over.at === at ? (
        <div className="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-accent" />
      ) : (
        hairline && <div className="absolute inset-x-0 top-1/2 border-t border-shade/10" />
      )}
    </div>
  );

  return (
    <aside
      aria-labelledby={HEADING_ID}
      className="well w-56 shrink-0 overflow-y-auto pb-[var(--edge-bottom)]"
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
      }}
    >
      <div className="flex min-h-9 items-center gap-2 px-4 pt-2 pb-1.5">
        <h2
          id={HEADING_ID}
          className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
        >
          Panels
        </h2>
        {count !== null && <span className="text-xs tabular-nums text-ink-faint">{count}</span>}
        <button
          type="button"
          onClick={() => onCollapse(true)}
          title={`Collapse the Panel list (${KEY_NAME})`}
          aria-label="Collapse the Panel list"
          data-shortcut-tip="panels"
          className="-mr-1 ml-auto rounded px-1 text-xs text-ink-faint hover:text-ink"
        >
          »
        </button>
      </div>
      {listing && rows.length === 0 && (
        <p className="px-4 py-1.5 text-sm text-ink-faint">No Panels on this Dashboard.</p>
      )}
      {arrangeable && rows.length > 0 && gapAt(0, false)}
      {rows.map((row, at) => (
        // Rows have no identity of their own; the Panels in them do.
        <div key={row.map((entry) => entry.panelId).join()}>
          <ul>
            {row.map((entry) => {
              const marked = over?.kind === 'beside' && over.panelId === entry.panelId ? over.side : null;
              return (
                <li
                  key={entry.panelId}
                  draggable={arrangeable}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(PANEL_BEING_DRAGGED, entry.panelId);
                    event.dataTransfer.effectAllowed = 'move';
                    // After the drag has started: changing the list inside
                    // dragstart can move the source from under the pointer.
                    pickedUp.current = window.setTimeout(() => setHeld(entry.panelId), 0);
                  }}
                  onDragEnd={end}
                  style={{
                    boxShadow:
                      marked === 'before'
                        ? 'inset 0 2px 0 var(--color-accent)'
                        : marked === 'after'
                          ? 'inset 0 -2px 0 var(--color-accent)'
                          : undefined,
                    opacity: held === entry.panelId ? 0.4 : undefined,
                  }}
                  {...place((event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    return {
                      kind: 'beside',
                      panelId: entry.panelId,
                      side: event.clientY < box.top + box.height / 2 ? 'before' : 'after',
                    };
                  })}
                >
                  <button
                    type="button"
                    onClick={() => listing?.jumpTo(entry.panelId)}
                    className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm text-ink hover:bg-accent-tint/40 ${arrangeable ? 'cursor-grab active:cursor-grabbing' : ''}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                    {entry.count !== null && (
                      <span className="text-xs tabular-nums text-ink-faint">{entry.count}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {at < rows.length - 1 && gapAt(at + 1, true)}
        </div>
      ))}
      {held !== null && arrangeable && (
        <div
          data-panel-list-new-row
          className={`mx-2 mt-1 mb-1 flex min-h-10 items-center justify-center border border-dashed text-xs ${
            over?.kind === 'row' && over.at === rows.length
              ? 'border-accent bg-accent-tint/40 text-accent-deep'
              : 'border-shade/20 text-ink-faint'
          }`}
          {...place(() => ({ kind: 'row', at: rows.length }))}
        >
          New row
        </div>
      )}
    </aside>
  );
}
