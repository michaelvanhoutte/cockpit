import { useRef } from 'react';
import { GRID_COLUMNS, MAX_PANEL_ROWS } from '@cockpit/shared';
import type { Panel, PanelPlacement } from '@cockpit/shared';
import { RowMenu } from './Menu';

/**
 * One panel on a dashboard: a titled box you can move, resize and rename in
 * place ("Panels on a dashboard, with per-screen-size layouts", issue 33).
 *
 * **What it shows comes later.** A panel is a saved, filtered view of items
 * (functional definition, "What a Panel shows"), and that configuration is
 * deliberately out of scope here - so every panel says the same thing inside,
 * the way every dashboard said the same thing before panels landed. The box,
 * its title, its place and its size are the whole of it today.
 *
 * **Everything a pointer can do here, the menu can do too.** Dragging the
 * header reorders and dragging the corner resizes, and neither exists for a
 * keyboard or on a phone - the browser's own drag-and-drop is a mouse gesture,
 * and a corner grip is a target no thumb wants. So the panel's own menu carries
 * the same four moves and the same four resizes, which is also what makes them
 * provable below the browser tier.
 */

/** The height of one grid row, in pixels, and the gap between panels. */
export const PANEL_ROW_HEIGHT = 80;
export const PANEL_GAP = 12;

export interface PanelCardProps {
  panel: Panel;
  placement: PanelPlacement;
  /** "Move left" on a screen with panels side by side, "Move up" on one without. */
  sideBySide: boolean;
  /** Where this panel is in the arrangement, so the ends can say they are ends. */
  at: number;
  of: number;
  /** True while this panel is the one being renamed, which happens in its own header. */
  renaming: string | null;
  onRenamingChange: (name: string) => void;
  onStartRenaming: () => void;
  onRename: () => void;
  onStopRenaming: () => void;
  onDelete: (openedFrom: HTMLElement | null) => void;
  onMove: (places: number) => void;
  /** One size, at the end of a gesture: what is kept. */
  onResize: (size: { columns?: number; rows?: number }) => void;
  /** The size as the corner is still moving: shown, not kept. */
  onResizing: (size: { columns?: number; rows?: number }) => void;
  /** The drag: which panel was picked up, and which one it was dropped in front of. */
  onPickUp: () => void;
  onDropOn: () => void;
  /** Why the last change to this panel did not happen, if it did not. */
  refusal: string | null;
  busy: boolean;
}

export function PanelCard({
  panel,
  placement,
  sideBySide,
  at,
  of,
  renaming,
  onRenamingChange,
  onStartRenaming,
  onRename,
  onStopRenaming,
  onDelete,
  onMove,
  onResize,
  onResizing,
  onPickUp,
  onDropOn,
  refusal,
  busy,
}: PanelCardProps) {
  const box = useRef<HTMLElement>(null);

  return (
    <section
      ref={box}
      aria-label={panel.name}
      style={{
        gridColumn: `span ${placement.columns}`,
        gridRow: `span ${placement.rows}`,
      }}
      // The whole panel is the drop target while only its header is the handle:
      // aiming at a two-line strip is a fiddly drop, and the thing being aimed
      // at is the place, not the grip.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropOn();
      }}
      className="relative flex min-w-0 flex-col rounded-lg bg-surface shadow-panel"
    >
      <header
        // `=== null` rather than falsy: an emptied rename box is still an open
        // rename box, and a draggable header takes the pointer away from the
        // input inside it - selecting what you typed would start a panel drag.
        draggable={renaming === null}
        onDragStart={(e) => {
          // Firefox starts no drag at all without data on the transfer, and the
          // panel being dragged is held in React state rather than read back
          // from here - so this is the minimum that makes the gesture happen.
          e.dataTransfer.setData('text/plain', panel.id);
          e.dataTransfer.effectAllowed = 'move';
          onPickUp();
        }}
        className="flex items-center gap-2 border-b border-black/5 px-3 py-2"
      >
        {renaming !== null ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onRename();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onStopRenaming();
            }}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <input
              value={renaming}
              onChange={(e) => onRenamingChange(e.target.value)}
              aria-label={`New name for ${panel.name}`}
              maxLength={60}
              autoFocus
              className="min-w-0 flex-1 rounded-md border border-black/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
            />
            <button
              type="submit"
              disabled={busy}
              className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-deep disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={onStopRenaming}
              className="shrink-0 rounded-md border border-black/10 px-2 py-1 text-xs hover:bg-accent-tint hover:text-accent-deep"
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{panel.name}</h3>
            <RowMenu
              label={`Actions for ${panel.name}`}
              entries={[
                { label: 'Rename', onSelect: onStartRenaming },
                ...movesFor({ at, of, sideBySide }, onMove),
                ...resizesFor(placement, onResize),
                { label: 'Delete', destructive: true, onSelect: onDelete },
              ]}
            />
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {refusal ? (
          <p role="alert" className="text-sm text-over">
            {refusal}
          </p>
        ) : (
          <p className="text-sm text-ink-faint">What this panel shows is set up later.</p>
        )}
      </div>

      <ResizeGrip
        panelName={panel.name}
        box={box}
        columns={placement.columns}
        onResizing={onResizing}
        onResize={onResize}
      />
    </section>
  );
}

/**
 * Moving, in the words the screen makes true. Panels flow left to right and
 * wrap, so on a screen only one panel wide they are stacked and "Move left"
 * would name a direction nothing goes in.
 *
 * The ends are said out loud rather than silently doing nothing, exactly as the
 * ends of a resize are: an entry that can be chosen and changes nothing is
 * indistinguishable from one that is broken. It also keeps a no-op out of the
 * board, where a change that moves nothing would still record a layout for this
 * screen out of a gesture that did not arrange anything.
 *
 * `keepsFocus`, because these open nothing and are the entries most likely to
 * be chosen several times in a row - dropping the focus to the top of the page
 * between two presses of "Move left" is losing your place in the dashboard.
 */
function movesFor(
  where: { at: number; of: number; sideBySide: boolean },
  onMove: (places: number) => void,
) {
  const first = where.at === 0;
  const last = where.at === where.of - 1;
  return [
    {
      label: where.sideBySide ? 'Move left' : 'Move up',
      places: -1,
      unavailable: first ? `This panel is already ${where.sideBySide ? 'first' : 'at the top'}` : undefined,
    },
    {
      label: where.sideBySide ? 'Move right' : 'Move down',
      places: 1,
      unavailable: last ? `This panel is already ${where.sideBySide ? 'last' : 'at the bottom'}` : undefined,
    },
  ].map(({ label, places, unavailable }) => ({
    label,
    unavailable,
    keepsFocus: true,
    onSelect: () => onMove(places),
  }));
}

/**
 * Resizing in whole grid steps, with the ends said out loud rather than
 * silently doing nothing: an entry that can be chosen and changes nothing is
 * indistinguishable from one that is broken ("Ask before deleting in a dialog,
 * from the row's own menu", issue 116, which is where the unavailable-with-a-
 * reason entry comes from).
 *
 * `keepsFocus` for the reason moving carries it: a resize opens nothing, and
 * these are entries somebody presses three times in a row to get a panel to the
 * size they want.
 */
function resizesFor(placement: PanelPlacement, onResize: (size: { columns?: number; rows?: number }) => void) {
  return [
    {
      label: 'Wider',
      keepsFocus: true,
      unavailable:
        placement.columns >= GRID_COLUMNS ? 'This panel is already the full width' : undefined,
      onSelect: () => onResize({ columns: placement.columns + 1 }),
    },
    {
      label: 'Narrower',
      keepsFocus: true,
      unavailable: placement.columns <= 1 ? 'This panel is already as narrow as it goes' : undefined,
      onSelect: () => onResize({ columns: placement.columns - 1 }),
    },
    {
      label: 'Taller',
      keepsFocus: true,
      unavailable: placement.rows >= MAX_PANEL_ROWS ? 'This panel is already as tall as it goes' : undefined,
      onSelect: () => onResize({ rows: placement.rows + 1 }),
    },
    {
      label: 'Shorter',
      keepsFocus: true,
      unavailable: placement.rows <= 1 ? 'This panel is already as short as it goes' : undefined,
      onSelect: () => onResize({ rows: placement.rows - 1 }),
    },
  ];
}

/**
 * The corner you drag to resize.
 *
 * **Pointer events rather than mouse events**, so the same handler is the whole
 * gesture on a trackpad and on a touchscreen, and `setPointerCapture` is what
 * keeps the drag alive when the pointer leaves the corner - which it does
 * immediately, that being the point of dragging.
 *
 * **The panel measures itself.** One grid column is the panel's own width
 * divided by the columns it spans, so nothing has to be told how wide the grid
 * is or how much padding the page has; a row is a fixed height, so that one is
 * a constant. Both include the gap, which is why it is added on either side of
 * the division rather than ignored.
 *
 * **Hidden from anything that is not a pointer**, deliberately: it is a grip
 * with no keyboard gesture behind it, and the four resizes in the panel's own
 * menu are the reachable version of exactly this. A control announced to a
 * screen reader that it cannot then operate is worse than one that is not
 * announced.
 */
function ResizeGrip({
  panelName,
  box,
  columns,
  onResizing,
  onResize,
}: {
  panelName: string;
  box: React.RefObject<HTMLElement | null>;
  columns: number;
  onResizing: (size: { columns?: number; rows?: number }) => void;
  onResize: (size: { columns?: number; rows?: number }) => void;
}) {
  /**
   * The size the corner is currently over, kept here so that letting go can
   * send it. A ref rather than state: what is on screen is already being
   * redrawn by `onResizing`, and this only has to survive until the pointer is
   * released.
   */
  const dragged = useRef<{ columns: number; rows: number } | null>(null);

  /** Where the corner is now, in whole grid steps, or null if nothing can be measured. */
  const sizeUnder = (clientX: number, clientY: number) => {
    const measured = box.current?.getBoundingClientRect();
    if (!measured || measured.width === 0) return null;
    // One column is the panel's own width divided by the columns it spans, so
    // nothing has to be told how wide the grid is; a row is a fixed height, so
    // that one is a constant. The gap sits between them, which is why it is
    // added on either side of the division rather than ignored.
    const columnUnit = (measured.width + PANEL_GAP) / columns;
    return {
      columns: Math.round((clientX - measured.left + PANEL_GAP) / columnUnit),
      rows: Math.round((clientY - measured.top + PANEL_GAP) / (PANEL_ROW_HEIGHT + PANEL_GAP)),
    };
  };

  return (
    <div
      aria-hidden="true"
      data-resize-grip={panelName}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        // Nothing carried over from a gesture that ended without a release - a
        // cancelled drag leaves its size behind, and a later press with no
        // movement would send it as a resize nobody just made.
        dragged.current = null;
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const size = sizeUnder(e.clientX, e.clientY);
        if (!size) return;
        // Shown, not kept. A command per pointer move would be a dozen writes
        // for one gesture, each one racing the re-read that follows it - and
        // the one that lands last decides what the panel ends up as, which is
        // not necessarily where the hand stopped.
        dragged.current = size;
        onResizing(size);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        const size = dragged.current;
        dragged.current = null;
        // Where the hand stopped, sent once. A gesture is one answer to "how
        // big is this panel now", so it is one command.
        if (size) onResize(size);
      }}
      className="absolute bottom-0 right-0 size-5 cursor-nwse-resize touch-none rounded-br-lg border-b-2 border-r-2 border-black/15"
    />
  );
}
