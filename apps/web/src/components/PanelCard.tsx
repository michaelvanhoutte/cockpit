import type { Item, Panel } from '@cockpit/shared';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { ItemList } from './ItemList';
import { RowMenu } from './Menu';

/**
 * One panel on a dashboard: a titled box you can move, resize and rename in
 * place ("Panels on a dashboard, with per-screen-size layouts", issue 33).
 *
 * **It holds the items filed into it**, in the order they were filed into
 * ("Panels hold the items filed into them, and the Inbox holds the rest", issue
 * 36). What it shows is still only that - a rule for what *arrives* in a panel on
 * its own is configuration it does not have yet ("Panel configuration:
 * connections and free-text description", issue 35).
 *
 * **Moving is in the menu as well as under the pointer.** Dragging the header
 * onto another panel joins that panel's row, and into the gap between two rows
 * takes a row of its own; that gesture exists for neither a keyboard nor a
 * phone - the browser's own drag-and-drop is a mouse protocol - so the panel's
 * own menu carries the same path a step at a time, which is also what makes it
 * provable below the browser tier. **A panel has no size of its own**: it fills
 * its share of its row, and the row is what carries a height.
 */

/**
 * The gap between two panels, in pixels.
 *
 * **Four pixels, not twelve.** The gap used to be the air a floating card needs
 * around its shadow; a panel is now a header on the sheet with its list sunk
 * into it, so what is between two panels is a seam rather than a margin
 * ("Cockpit Shell Explorations", artboard 2c).
 */
export const PANEL_GAP = 4;

export interface PanelCardProps {
  panel: Panel;
  /** Which workspace's items these are, which every change to one has to name. */
  workspaceId: string;
  /** What is filed on this panel, in order. */
  items: readonly Item[];
  /** "Move left" while it shares its row, "Move up" while it has the row to itself. */
  sideBySide: boolean;
  /**
   * Whether there is anywhere left to move it, which with rows is not a
   * question about its place in one: a panel at the end of its row still has
   * somewhere to go - a line of its own below it - so the only panel with
   * nowhere left is the first cell of the first row, or the last of the last.
   */
  first: boolean;
  last: boolean;
  /** True while this panel is the one being renamed, which happens in its own header. */
  renaming: string | null;
  onRenamingChange: (name: string) => void;
  onStartRenaming: () => void;
  onRename: () => void;
  onStopRenaming: () => void;
  onDelete: (openedFrom: HTMLElement | null) => void;
  onMove: (places: number) => void;
  /** The drag: this panel was picked up, or something was dropped beside it. */
  onPickUp: () => void;
  /**
   * The drag ended, wherever it ended. A drop is not the only way one can:
   * letting go over the Inbox, off the window or on Escape all end it too, and
   * the board holds what is being dragged - so without this the seams stay open
   * after a drag nobody completed.
   */
  onLetGo: () => void;
  onDropOn: (side: 'before' | 'after') => void;
  /** Why the last change to this panel did not happen, if it did not. */
  refusal: string | null;
  busy: boolean;
}

export function PanelCard({
  panel,
  workspaceId,
  items,
  sideBySide,
  first,
  last,
  renaming,
  onRenamingChange,
  onStartRenaming,
  onRename,
  onStopRenaming,
  onDelete,
  onMove,
  onPickUp,
  onLetGo,
  onDropOn,
  refusal,
  busy,
}: PanelCardProps) {

  return (
    <section
      aria-label={panel.name}
      // The whole panel is the drop target while only its header is the handle:
      // aiming at a two-line strip is a fiddly drop, and the thing being aimed
      // at is the place, not the grip.
      //
      // **Panels only.** A row of the list inside crosses this on its way in,
      // and without the check it would arrive as a panel being dropped on a
      // panel - which does nothing while no panel is being dragged, and
      // reorders the dashboard when one was picked up and abandoned earlier.
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
        e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
        e.preventDefault();
        // Which side of this panel it was let go on, so dropping onto the left
        // half puts it before and the right half after. The whole panel is one
        // target rather than two: a half is still a comfortable thing to aim
        // at, and a seam between two panels would be four pixels.
        const box = e.currentTarget.getBoundingClientRect();
        onDropOn(e.clientX < box.left + box.width / 2 ? 'before' : 'after');
      }}
      // No fill and no edge of its own: the panel is the sheet, and only the
      // list inside it goes down into it ("Cockpit Shell Explorations",
      // artboard 2c).
      //
      // `@container` so what is inside can be drawn to the panel's own width
      // rather than the screen's - the header does, below. It has to be here
      // rather than on the header, because a container query asks about an
      // *ancestor*: on the header it would size the header's contents and not
      // the header itself.
      className="@container flex min-w-0 flex-col"
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
        // Whatever became of it. `dragend` fires on the panel that was picked
        // up however the drag finished - dropped somewhere that takes it,
        // dropped on the Inbox, let go off the window, cancelled with Escape -
        // and it is the only one of those the board hears about.
        onDragEnd={onLetGo}
        // On the sheet rather than on the list: no fill, no rule under it, and
        // the space above it is what separates one panel from the one above.
        //
        // Drawn to the panel's own width rather than the screen's, because that
        // is what it has to fit in: three panels across a laptop's dashboard are
        // narrower than one panel on a phone, and a layout made for a wide screen
        // is squeezed rather than cut off - so the app's tightest headers are on
        // its widest screens.
        //
        // The margin closes with the count (below), at the same width and for
        // the same reason: a panel this narrow is spending forty percent of
        // itself on padding and a menu, and it is spending it on its own name.
        // It stops matching the rows underneath there, which carry `px-4` of
        // their own - a fair trade at a width where those rows are showing two
        // characters of a title.
        className="flex items-center gap-2 px-4 pt-3 pb-2 @max-[200px]:px-2"
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
            {/* The name and the count travel together, so the menu sits at the
                panel's edge whether or not the count is drawn. */}
            <div className="mr-auto flex min-w-0 items-center gap-2">
              {/* The same heading the Inbox's carries in the band above it
                  (components/InboxPanel.tsx): small, uppercase and in the accent,
                  because a header on the sheet has no fill or rule to say it is a
                  header and the letterform has to do it alone. */}
              <h3 className="min-w-0 truncate text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep">
                {panel.name}
              </h3>
              {/* How much is on it, said the way the Inbox says it - until the
                  panel is too narrow to say all three things, and then this is
                  the one that goes. Everything else in the header is either the
                  panel's name or the only way to rename, move or delete it; the
                  count is the one thing the list underneath already shows.

                  Two hundred pixels because that is where it stops paying for
                  itself: the padding, the menu and the two gaps already take
                  seventy-six of them, and the count another seventeen, so below
                  this the name is being truncated to make room for a number the
                  list underneath spells out. */}
              <span className="shrink-0 text-xs tabular-nums text-ink-faint @max-[200px]:hidden">
                {items.length}
              </span>
            </div>
            <RowMenu
              label={`Actions for ${panel.name}`}
              entries={[
                { label: 'Rename', onSelect: onStartRenaming },
                ...movesFor({ first, last, sideBySide }, onMove),
                { label: 'Delete', destructive: true, onSelect: onDelete },
              ]}
            />
          </>
        )}
      </header>

      {/* No padding of its own: a row carries its own, so a list inside a panel
          reads exactly as it does in the Inbox.

          The hollow in the sheet is here rather than on the panel, which is the
          whole of the treatment: the header sits up on the sheet and the list
          sits down in it, and a panel holding nothing is still a panel because
          the hollow is what draws it. */}
      <div className="well min-h-0 flex-1 overflow-auto">
        {/* Above the list rather than instead of it. Refusing a rename says
            nothing about what the panel holds, and hiding the items while
            somebody decides what else to call it takes away the thing they are
            naming. */}
        {refusal && (
          <p role="alert" className="px-3 py-3 text-sm text-over">
            {refusal}
          </p>
        )}
        <ItemList
          workspaceId={workspaceId}
          items={items}
          openDashboardId={panel.dashboardId}
          panelId={panel.id}
          emptyMessage="Nothing filed here yet."
        />
      </div>

    </section>
  );
}

/**
 * Moving, in the words the screen makes true. Panels flow left to right and
 * wrap, so on a screen only one panel wide they are stacked and "Move left"
 * would name a direction nothing goes in.
 *
 * The ends are said out loud rather than silently doing nothing: an entry that
 * can be chosen and changes nothing is indistinguishable from one that is
 * broken. It also keeps a no-op out of the board, where a change that moves
 * nothing would still record a layout for this screen out of a gesture that
 * did not arrange anything.
 *
 * `keepsFocus`, because these open nothing and are the entries most likely to
 * be chosen several times in a row - dropping the focus to the top of the page
 * between two presses of "Move left" is losing your place in the dashboard.
 */
function movesFor(
  where: { first: boolean; last: boolean; sideBySide: boolean },
  onMove: (places: number) => void,
) {
  return [
    {
      label: where.sideBySide ? 'Move left' : 'Move up',
      places: -1,
      unavailable: where.first
        ? `This panel is already ${where.sideBySide ? 'first' : 'at the top'}`
        : undefined,
    },
    {
      label: where.sideBySide ? 'Move right' : 'Move down',
      places: 1,
      unavailable: where.last
        ? `This panel is already ${where.sideBySide ? 'last' : 'at the bottom'}`
        : undefined,
    },
  ].map(({ label, places, unavailable }) => ({
    label,
    unavailable,
    keepsFocus: true,
    onSelect: () => onMove(places),
  }));
}
