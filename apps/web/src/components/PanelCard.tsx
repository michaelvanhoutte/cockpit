import type { Item, Panel } from '@cockpit/shared';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { ItemList } from './ItemList';
import { PanelText } from '../panels/PanelText';
import { RowMenu } from './Menu';
import { NOTHING_FILED_HERE, NOTHING_FILED_HERE_YET_AND_HOW } from '../whatThingsAre';

/**
 * One panel on a dashboard: a titled box you can move, resize and rename in
 * place ("Panels on a dashboard, with per-screen-size layouts", issue 33).
 *
 * **It holds either the items filed into it or the text written in it** ("Put a
 * panel of text on a dashboard, and write in it", issue 250), and which of the
 * two is settled when the panel is made. Items come in the order they were
 * filed ("Panels hold the items filed into them, and the Inbox holds the rest",
 * issue 36); a rule for what *arrives* in a panel on its own is configuration
 * it does not have yet ("Panel configuration: connections and free-text
 * description", issue 35).
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
  /**
   * Lock a panel of text's prose, or hand it back. Never called for a panel of
   * items, which is not offered the choice.
   */
  onReadOnlyChange: (readOnly: boolean) => void;
  /** Draw a panel of text's words as what they mean, or as the characters typed. */
  onFormatChange: (format: 'plain' | 'rich') => void;
  /**
   * That this is the panel in the air, so it can say so. The board knows
   * which one it is; the card is what draws it.
   */
  lifted: boolean;
  /**
   * The grab, and the whole of what this reports.
   *
   * **The board takes the gesture from here**, pointer and all. A panel that
   * moves to another row is drawn under a different parent, so React unmounts
   * and remounts it - and a capture taken on this header goes with the node
   * it was taken on. The drag would then answer the first move and die. The
   * board's own element outlives every rearrangement, which is why it is the
   * one that holds the pointer.
   */
  onPickUp: (pointerId: number) => void;
  /**
   * That nothing has been filed anywhere in this workspace, which is what makes
   * an empty panel worth explaining rather than merely reporting: until the
   * gesture has been done once, "Nothing filed here yet." is a true sentence
   * that says nothing about how anything gets here.
   *
   * The workspace's rather than this panel's, because an empty panel beside a
   * full one is empty on purpose and needs no lesson.
   */
  nothingFiledYet: boolean;
  /** Why the last change to this panel did not happen, if it did not. */
  refusal: string | null;
  busy: boolean;
}

export function PanelCard({
  panel,
  workspaceId,
  items,
  nothingFiledYet,
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
  onReadOnlyChange,
  onFormatChange,
  lifted,
  onPickUp,
  refusal,
  busy,
}: PanelCardProps) {
  // What this panel is made of, and so what its well holds, what its header
  // says beside its name and what its menu offers.
  const text = panel.kind === 'text';

  return (
    <section
      aria-label={panel.name}
      // Where a panel lands is measured off the rows rather than caught by a
      // drop target of its own: a drag moves the panels as it goes
      // (`panels/dragging.ts`), so the board reads the arrangement it is
      // drawing and there is nothing here to hit. What is still dropped *on* a
      // panel is an item, and that is the list's own target, further in.
      data-panel-cell={panel.id}
      // No fill and no edge of its own: the panel is the sheet, and only the
      // list inside it goes down into it ("Cockpit Shell Explorations",
      // artboard 2c).
      //
      // `@container` so what is inside can be drawn to the panel's own width
      // rather than the screen's - the header does, below. It has to be here
      // rather than on the header, because a container query asks about an
      // *ancestor*: on the header it would size the header's contents and not
      // the header itself.
      // Lifted, and saying so: the panel in the air is drawn back and outlined
      // in its slot while the board moves it about. Without it the gesture had
      // no sign at all that anything had been picked up.
      className={`@container flex min-w-0 flex-col ${
        lifted ? 'rounded-lg opacity-40 outline-2 outline-dashed outline-accent' : ''
      }`}
    >
      <header
        // The handle, and a pointer gesture rather than the browser's own
        // drag-and-drop.
        //
        // **The browser's drag gives a frozen picture of the panel**, which is
        // the one thing this gesture must not do: the panels move as the
        // pointer does, so what is under the hand has to be the board itself.
        // It also drew the two gestures on this screen from one mechanism -
        // an item being filed onto a panel is a drag too - and every target
        // had to ask which of them was in the air. Items keep the browser's
        // drag; a panel is moved with the pointer, and the two can no longer
        // be mistaken for each other.
        onPointerDown={(event) => {
          // The primary button only: a right-click opens a menu, and dragging
          // the panel out from under it would be nobody's intention.
          if (event.button !== 0) return;
          // Not while it is being renamed, and not on the menu: an emptied
          // rename box is still an open one, and selecting what you typed must
          // not carry the panel off. `closest` rather than a check on the
          // target, because the menu's glyph is an SVG inside the button.
          if (renaming !== null) return;
          if ((event.target as Element).closest?.('button, input, form')) return;
          // **And only for a press that really landed in this header.** The
          // menu's entries are drawn in a portal on the body, but a React event
          // bubbles through the component tree rather than the DOM one - so
          // pressing Move left arrives here, nowhere near the header, and the
          // `preventDefault` below took the press away from the menu. The menu
          // then sat open over a modal overlay with nothing else on the page
          // reachable. `contains` is what tells the two apart; an Item's row
          // asks the same question for the same reason (`RowForm.tsx`,
          // `wasOnTheRow`).
          if (!event.currentTarget.contains(event.target as Node)) return;
          // Otherwise the browser starts a text selection across whatever the
          // drag passes over.
          event.preventDefault();
          onPickUp(event.pointerId);
        }}
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
        // `cursor-grab` because the header is the handle and nothing else says
        // so; `touch-none` is deliberately absent, so a finger still scrolls
        // the page and the drag stays the pointer gesture the menu is the
        // alternative to.
        className={`flex items-center gap-2 px-4 pt-3 pb-2 @max-[200px]:px-2 ${
          renaming === null ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
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
              {/* How much is on it, which a panel of text has no answer to:
                  it holds no items, and drawing a nought beside its name would
                  be reporting on something it is not. */}
              {!text && (
                <span className="shrink-0 text-xs tabular-nums text-ink-faint @max-[200px]:hidden">
                  {items.length}
                </span>
              )}
              {/* That the text is read rather than written in, said out loud
                  because nothing else on the panel says it: a box with no
                  cursor in it looks exactly like one nobody has clicked yet.

                  **It stays at every width, where the count goes.** The count
                  may go because the list underneath spells it out; nothing
                  repeats this. A panel squeezed under two hundred pixels that
                  dropped it would show prose, no cursor and no reason - and
                  the name being truncated to keep it is the better trade,
                  a truncated name still being recognisable. */}
              {text && panel.readOnly && (
                <span className="shrink-0 text-xs font-normal normal-case tracking-normal text-ink-faint">
                  read-only
                </span>
              )}
            </div>
            <RowMenu
              label={`Actions for ${panel.name}`}
              entries={[
                { label: 'Rename', onSelect: onStartRenaming },
                // Only on a panel of text. A panel of items has no text to
                // lock, and an entry that means nothing where it is offered is
                // worse than one that is not there - the menu's own rule keeps
                // an *unavailable* entry visible, and this one is not
                // unavailable, it is about something else entirely.
                //
                // Named for what choosing it gives you rather than for the
                // state it leaves behind, which is how every other entry here
                // reads.
                ...(text
                  ? [
                      {
                        label: panel.readOnly ? 'Allow editing' : 'Make read-only',
                        keepsFocus: true,
                        onSelect: () => onReadOnlyChange(!panel.readOnly),
                      },
                      {
                        // What the same characters are drawn as. Named for what
                        // choosing it gives you, like the entry above it.
                        label: panel.format === 'rich' ? 'Use plain text' : 'Use rich text',
                        keepsFocus: true,
                        onSelect: () => onFormatChange(panel.format === 'rich' ? 'plain' : 'rich'),
                      },
                    ]
                  : []),
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
      {/* A panel of text fills its well with one box and lets that box scroll,
          rather than scrolling the well around it: a textarea that grew past
          the panel would put a second scrollbar inside the first. */}
      <div
        className={`well min-h-0 flex-1 ${text ? 'flex flex-col overflow-hidden' : 'overflow-auto'}`}
      >
        {/* Above the list rather than instead of it. Refusing a rename says
            nothing about what the panel holds, and hiding the items while
            somebody decides what else to call it takes away the thing they are
            naming. */}
        {refusal && (
          <p role="alert" className="px-3 py-3 text-sm text-over">
            {refusal}
          </p>
        )}
        {text ? (
          <PanelText panel={panel} workspaceId={workspaceId} />
        ) : (
          <ItemList
            workspaceId={workspaceId}
            items={items}
            openDashboardId={panel.dashboardId}
            panelId={panel.id}
            emptyMessage={nothingFiledYet ? NOTHING_FILED_HERE_YET_AND_HOW : NOTHING_FILED_HERE}
          />
        )}
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
