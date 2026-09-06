import { Fragment, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MIN_ROW_HEIGHT, uuidv7 } from '@cockpit/shared';
import type { Dashboard, Filing, Item, Layout, LayoutRow, Panel } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useCommand } from '../api/queries';
import { itemsOnPanel } from '../filing';
import { browserStore } from '../lastVisited';
import { useChosenLayout } from '../panels/chosenLayout';
import { useMeasuredWidth, useScreenWidth } from '../panels/useScreenWidth';
import {
  drawnRows,
  layoutLabel,
  layoutsOf,
  layoutToDraw,
  movedBeside,
  movedBy,
  movedToOwnRow,
  nameForScreen,
  sameArrangement,
  sharesOf,
  SAME_SCREEN_TOLERANCE,
} from '../panels/arrangement';
import { DeleteQuestion } from './DeleteQuestion';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { PANEL_GAP, PanelCard } from './PanelCard';

/**
 * A dashboard's panels, on the rows one of its layouts arranges them into
 * ("Rows of panels, not a grid that wraps").
 *
 * **A row is a grid of its own**, so its panels share one height and divide its
 * width between them - which is what makes a row a row rather than a line the
 * panels happen to have landed on. The board is the rows, stacked, and it
 * cannot scroll sideways on any screen: every row is the full width, and a
 * layout made for a wider one is squeezed rather than cut off. Nothing scales
 * the type: a squeezed panel is a narrower panel holding the same words.
 *
 * **Which panels share a line is what a person decided**, and it used to be
 * decided by CSS: panels flowed left to right and wrapped at twelve columns, so
 * a panel made wider pushed the next one onto a line of its own. Rows write the
 * decision down instead.
 *
 * **Reordering happens here, on the dashboard itself**, and that is deliberate
 * rather than an inconsistency with workspaces and dashboards, which are
 * reordered in a window opened from a menu: dragging *is* the editing, so it
 * has to happen where the thing being edited is drawn. The issue says so in as
 * many words.
 *
 * **One `useCommand` for the whole board** rather than one per control, so a
 * refusal can only belong to the last thing asked for - and `variables` says
 * which control that was, which is how a refused rename ends up inside the
 * panel it was refused for.
 *
 * State here is all about *this* dashboard, so the page mounts one of these per
 * dashboard with the dashboard's id as its key: switching dashboards drops the
 * half-typed name, the open question and the arrangement not yet saved, all of
 * which belong to the dashboard being left.
 */
export function PanelBoard({
  workspaceId,
  dashboard,
  panels,
  layouts,
  items,
  filings,
}: {
  workspaceId: string;
  dashboard: Dashboard;
  panels: readonly Panel[];
  layouts: readonly Layout[];
  /** Every open item of the workspace; each panel is handed the ones filed on it. */
  items: readonly Item[];
  filings: readonly Filing[];
}) {
  const screenWidth = useScreenWidth();
  /**
   * How wide the panels actually are, which is not the screen: the Inbox takes
   * about a fifth of it wherever there is room ("Show the Inbox beside the
   * dashboards instead of as a tab", issue 117). The screen's width is what a
   * layout is *recorded* against; this is what decides how many fit across.
   * Before anything has been measured the screen's width stands in, which is
   * the arrangement one paint early rather than every panel full width.
   */
  const [measure, measured] = useMeasuredWidth();
  const acrossWidth = measured ?? screenWidth;
  const command = useCommand();
  const queryClient = useQueryClient();

  /**
   * Which layout is being drawn, shared with the control in the bar that names
   * it (panels/chosenLayout.ts). The two are in different halves of the app -
   * this is the page, that is the shell - so what they share is a store rather
   * than a prop one would have to be handed through the router.
   */
  const [chosen, choose] = useChosenLayout(browserStore(), dashboard.id);
  /**
   * An arrangement that has been made but not yet stored. It is what the board
   * draws while it exists, so the panel really does move under the hand that
   * moved it, and it is dropped once the store has been re-read and agrees.
   */
  const [draft, setDraft] = useState<LayoutRow[] | null>(null);
  /**
   * The last arrangement actually sent, which is what a new gesture is compared
   * against.
   *
   * Not what is *drawn*, and the difference is a gesture that puts the panels
   * back where the store has them: after one move, that is a real second change
   * and has to be sent, but against the drawn arrangement it would look like
   * every panel already being where it was asked to go, and be dropped.
   */
  const sent = useRef<LayoutRow[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /**
   * Which panel is being dragged, or null.
   *
   * State rather than a ref, unlike before: the seams between rows are four
   * pixels of gap, which is not a target a hand can hit, so they open up while
   * a drag is on - and something on screen depending on it is exactly what a
   * ref cannot do. One redraw per pick-up, not one per pointer move.
   */
  const [dragging, setDragging] = useState<string | null>(null);
  /** The control a question was opened from, so the focus can go back to it. */
  const askedFrom = useRef<HTMLElement | null>(null);

  const its = layoutsOf(layouts, dashboard.id);
  const drawnWith = layoutToDraw(layouts, dashboard.id, screenWidth, chosen);
  const stored = drawnRows(drawnWith, panels, acrossWidth);
  const shown = draft ?? stored;
  /**
   * Read from the list rather than kept beside the id, for the reason the list
   * of dashboards does it: a panel deleted in another tab is gone
   * from the next snapshot, and a question about one that is no longer there
   * closes itself instead of asking about a name nothing holds.
   */
  const beingDeleted = panels.find((panel) => panel.id === deleting);

  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  /** The refusal belongs to the control that asked for it. */
  const refusalFor = (what: 'rename_panel' | 'delete_panel' | 'save_layout', id?: string) => {
    if (!refusal || command.variables?.name !== what) return null;
    if (!id) return refusal;
    const payload = command.variables.payload as { panelId?: string };
    return payload.panelId === id ? refusal : null;
  };

  /**
   * Re-read before letting go of the draft. The snapshot in hand is the one
   * from before this change, so dropping the draft first would put the panels
   * back where they were for as long as the refetch takes - the change would
   * visibly undo itself and then redo itself.
   */
  const settle = async () => {
    await queryClient.refetchQueries({ queryKey: ['snapshot', workspaceId] });
    setDraft(null);
    sent.current = null;
  };

  const saveArrangement = (
    layoutId: string,
    nameIfNew: string,
    screenWidthOfLayout: number,
    rows: readonly LayoutRow[],
  ) => {
    command.mutate(
      {
        name: 'save_layout',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          dashboardId: dashboard.id,
          layoutId,
          // Read by the server only where this save is the one creating the
          // layout, so a board holding a name from before a rename cannot put
          // the old one back.
          name: nameIfNew,
          screenWidth: screenWidthOfLayout,
          // Named field by field rather than sent as read, so a row that
          // arrived from a snapshot with something extra on it cannot carry
          // that back into a command the schema then refuses.
          rows: rows.map((row) => ({
            height: row.height,
            cells: row.cells.map((cell) => ({ panelId: cell.panelId, span: cell.span })),
          })),
        },
      },
      {
        onSuccess: () => {
          // The board only ever saves into the layout it is drawing, so the
          // choice is already right - except in one case: a choice naming a
          // layout another device deleted is drawn by falling through to the
          // closest remaining one (arrangement.ts), and this dashboard had
          // none, so what was just made is not what is stored as picked. The
          // dead id is cleared rather than repointed, because falling through
          // is what *Automatic* is, and that is what the control should say.
          if (chosen && !its.some((layout) => layout.id === chosen)) choose(null);
          void settle();
        },
        /**
         * A refused arrangement is put back, rather than left on screen under
         * the message saying it did not happen.
         *
         * The draft is what the grid draws while a change is in flight, and
         * with only `onSuccess` wired it outlived a refusal: the panels stayed
         * where the gesture put them, the notice above them said the change was
         * refused, and the two disagreed until the next snapshot arrived. That
         * is the same "looks like it worked" failure the questions elsewhere in
         * the app are shaped to avoid.
         *
         * **Reachable rather than theoretical.** Two tabs on a dashboard with
         * no layout, both on a screen of the same size, both dragging: the
         * first records *Wide* and the second is refused for the name, because
         * its own copy of the dashboard still has no layout to make the name
         * free against. Dropping `sent` with the draft is what lets the same
         * gesture be made again once the snapshot has caught up; `justMade` is
         * deliberately kept, so the retry changes the layout this board made
         * rather than defining a second one at the same width.
         */
        onError: () => {
          setDraft(null);
          sent.current = null;
        },
      },
    );
    sent.current = [...rows];
  };

  /**
   * The id of the layout this board made for this screen, kept until the
   * snapshot has it.
   *
   * Two gestures can both find the dashboard with no layout: the first sends
   * one and the second happens before the re-read lands. A fresh id each time
   * would define a second layout at the same width, and the layout menu would
   * list "Made for 1280 px" twice with nothing to tell them apart. Sending the
   * same id makes the second gesture change the layout the first one made,
   * which is what it meant.
   *
   * Kept per width, because a window resized between the two really is a
   * different screen asking for a layout of its own.
   */
  const justMade = useRef<{ id: string; screenWidth: number } | null>(null);
  const layoutForThisScreen = (): string => {
    const held = justMade.current;
    if (held && Math.abs(held.screenWidth - screenWidth) <= SAME_SCREEN_TOLERANCE) return held.id;
    const id = uuidv7();
    justMade.current = { id, screenWidth };
    return id;
  };

  /**
   * What every gesture that changes the arrangement ends in: keep it, in the
   * layout on screen.
   *
   * **It asks nothing, and that is the change** ("Pick the layout you are on,
   * by name"). Dragging on a screen the drawn layout was not made for used to
   * stop and ask whether to change that layout or make a new one, because
   * nothing in the gesture said which and the layout had been picked *for* you.
   * You pick it now, by name, so the gesture means what it says.
   *
   * A layout is still made silently when the dashboard has none, because there
   * is nothing to change and nothing worth interrupting a drag to ask.
   */
  const propose = (next: LayoutRow[]) => {
    // Against what has been *sent* - or the store, where nothing has - rather
    // than against what is drawn: a gesture that puts a panel back where the
    // snapshot has it still has to be sent when an earlier one moved
    // it; and a gesture that really changes nothing must send nothing.
    //
    if (sameArrangement(next, sent.current ?? stored)) return;
    command.reset();
    setDraft(next);
    if (drawnWith) {
      // The label rather than the stored name, and the difference is not
      // cosmetic: a name is required on the way in, and a layout can genuinely
      // have none. Every layout in a snapshot cached before names existed
      // parses with an empty one (`layoutSchema`), as does one old code wrote
      // during the deploy - so sending the stored name would have the first
      // drag after an upgrade refused for a field the person never typed. The
      // server ignores it on a layout that already exists either way.
      saveArrangement(drawnWith.id, layoutLabel(drawnWith), drawnWith.screenWidth, next);
      return;
    }
    // The first arrangement of a dashboard names its layout after the screen it
    // was made on - *Wide*, *Laptop*, *Phone*. Asking would be the question
    // this feature exists to remove, one gesture earlier.
    //
    // Nothing has to make that name free here, unlike in the picker: there is
    // no layout to draw only when the dashboard has none at all (`layoutToDraw`
    // returns the closest of whatever it is given), so there is nothing on this
    // dashboard for the name to collide with.
    saveArrangement(layoutForThisScreen(), nameForScreen(screenWidth), screenWidth, next);
  };

  /**
   * A panel let go in the gap at `at`, which gives it a row of its own there.
   * Every seam does the same thing, including the one under the last row, so
   * they share a handler rather than each carrying a copy of it.
   */
  const dropInSeam = (at: number) => {
    const picked = dragging;
    setDragging(null);
    if (picked) propose(movedToOwnRow(shown, picked, at));
  };

  const renamePanel = () => {
    if (!renaming) return;
    const trimmed = renaming.name.trim();
    if (!trimmed) return;
    command.mutate(
      {
        name: 'rename_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          panelId: renaming.id,
          name: trimmed,
        },
      },
      { onSuccess: () => setRenaming(null) },
    );
  };

  const deletePanel = (panelId: string) => {
    command.mutate(
      {
        name: 'delete_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          panelId,
        },
      },
      { onSuccess: () => setDeleting(null) },
    );
  };

  return (
    <div ref={measure} className="flex min-w-0 flex-col">
      {/* The name, for whoever is not looking at the screen. It used to be a
          heading here as well as the tab above, which said the same thing
          twice a centimetre apart ("Modernise the app shell", issue 125) -
          and the tab is the one that says *which of several*, so the tab is
          the one that stays. */}
      <h2 className="sr-only">{dashboard.name}</h2>

      {/* Only the arrangement's. A refused add or rename is said where the
          name still is - in the dialog, or in the panel's own header. */}
      {refusalFor('save_layout') && (
        <p role="alert" className="px-4 py-2 text-sm text-over">
          {refusalFor('save_layout')}
        </p>
      )}

      {panels.length === 0 ? (
        // An invitation rather than an apology: it says what a dashboard is for
        // instead of reporting that this one is empty ("Modernise the app
        // shell", issue 125). No control of its own - Add a panel is on the
        // dashboard's own bar, a centimetre above this ("Pick the layout you
        // are on, by name"), and a second way to press the same thing is a
        // second thing to keep in step.
        <section className="well px-4 py-14 text-center">
          <p className="mx-auto max-w-md text-sm text-ink-faint">
            A dashboard holds the panels you want in view — a slice of your work, kept where you can
            see it. This one has none yet.
          </p>
        </section>
      ) : (
        <div className="flex min-w-0 flex-col">
          {shown.map((row, rowIndex) => {
            const shares = sharesOf(row);
            return (
              // Keyed by where the row is, not by what is on it. A row has no
              // identity of its own - it is the line, and the panels are what
              // move between lines - so keying it by its cells would remount
              // every panel in a row the moment two of them swapped: the focus
              // would leave the menu somebody was pressing, a half-typed rename
              // would go, and a scrolled list would jump to the top.
              <Fragment key={rowIndex}>
                <RowSeam at={rowIndex} dragging={dragging !== null} onDrop={dropInSeam} />
                <div
                  // A row is a grid of its own, so its panels share one height
                  // without anything being told what that height is - which is
                  // what a row *is*. `minmax(0, …)` rather than a bare fraction
                  // is the whole of "never scrolls sideways": a bare `1fr` is
                  // `minmax(auto, 1fr)`, so one long unbroken word inside a
                  // panel would widen its column and take the page with it.
                  //
                  // **The height the row was given, where it has one.** A row
                  // converted from the arrangement that came before this
                  // carries the height its panels were drawn at
                  // (changes.ts, `0012-panel-rows`), and a row nobody has ever
                  // sized carries none - so drawing the stored one is what
                  // makes "nothing changes size on the day this lands" true.
                  // The *gesture* that sets one is the next slice; reading what
                  // is already there is not.
                  //
                  // Never shorter than a row may be set to, whichever it is.
                  // The floor is not decoration: a panel's list is its drop
                  // target and is sized to fill the panel, so a row that shrank
                  // to its contents left an empty panel a sliver with half of
                  // it header - and filing an item into it stopped working
                  // where there was nothing left to aim at.
                  style={{
                    height: row.height ?? undefined,
                    minHeight: MIN_ROW_HEIGHT,
                    display: 'grid',
                    gridTemplateColumns: shares
                      .map((share) => `minmax(0, ${share}fr)`)
                      .join(' '),
                    gap: PANEL_GAP,
                  }}
                >
                  {row.cells.map((cell, at) => {
                    const panel = panels.find((one) => one.id === cell.panelId);
                    if (!panel) return null;
                    return (
                      <PanelCard
                        key={panel.id}
                        panel={panel}
                        workspaceId={workspaceId}
                        items={itemsOnPanel(items, filings, panel.id)}
                        sideBySide={row.cells.length > 1}
                        // Nowhere left to go, which is not the same as being at
                        // the end of a row: a panel at the end of a row it
                        // *shares* can still move onto a line of its own beyond
                        // it, and that is the only way a keyboard has of making a
                        // row. Only a panel alone on the first or last line has
                        // run out of places.
                        first={rowIndex === 0 && at === 0 && row.cells.length === 1}
                        last={
                          rowIndex === shown.length - 1 &&
                          at === row.cells.length - 1 &&
                          row.cells.length === 1
                        }
                        renaming={renaming?.id === panel.id ? renaming.name : null}
                        onRenamingChange={(name) => setRenaming({ id: panel.id, name })}
                        onStartRenaming={() => {
                          command.reset();
                          setDeleting(null);
                          setRenaming({ id: panel.id, name: panel.name });
                        }}
                        onRename={renamePanel}
                        onStopRenaming={() => {
                          setRenaming(null);
                          command.reset();
                        }}
                        onDelete={(openedFrom) => {
                          command.reset();
                          setRenaming(null);
                          askedFrom.current = openedFrom;
                          setDeleting(panel.id);
                        }}
                        onMove={(places) => propose(movedBy(shown, panel.id, places))}
                        onPickUp={() => setDragging(panel.id)}
                        onLetGo={() => setDragging(null)}
                        onDropOn={(where) => {
                          const picked = dragging;
                          setDragging(null);
                          if (!picked) return;
                          propose(movedBeside(shown, picked, panel.id, where));
                        }}
                        refusal={
                          refusalFor('rename_panel', panel.id) ?? refusalFor('delete_panel', panel.id)
                        }
                        busy={command.isPending}
                      />
                    );
                  })}
                </div>
              </Fragment>
            );
          })}
          {/* The gap under the last row, so a panel can be dropped below
              everything rather than only between two things. */}
          <RowSeam at={shown.length} dragging={dragging !== null} onDrop={dropInSeam} />
        </div>
      )}

      {beingDeleted && (
        <DeleteQuestion
          open
          question={`Delete ${beingDeleted.name}? It goes from every layout of this dashboard.`}
          confirmLabel={`Yes, delete ${beingDeleted.name}`}
          canConfirm={!command.isPending}
          refusal={refusalFor('delete_panel', beingDeleted.id)}
          returnFocusTo={askedFrom.current}
          onCancel={() => {
            setDeleting(null);
            command.reset();
          }}
          onConfirm={() => deletePanel(beingDeleted.id)}
        />
      )}

    </div>
  );
}

/**
 * The gap between two rows, and the place a panel is dropped to get a row of
 * its own.
 *
 * **Four pixels is the gap, and four pixels is not a target.** The seam is the
 * space between rows at rest - a seam rather than a margin, which is what the
 * sheet is drawn as ("Cockpit Shell Explorations", artboard 2c) - and it opens
 * to something a hand can hit only while a panel is actually being dragged.
 * Nothing is added to the page the rest of the time.
 *
 * It lights up under the pointer rather than only accepting the drop, because a
 * drop target that gives no sign is a gesture you find out about afterwards.
 */
function RowSeam({
  at,
  dragging,
  onDrop,
}: {
  /** Which gap this is: 0 above the first row, `rows.length` below the last. */
  at: number;
  /** Whether a panel is in the air, which is when this is worth hitting. */
  dragging: boolean;
  onDrop: (at: number) => void;
}) {
  const [under, setUnder] = useState(false);
  return (
    <div
      // `PANEL_GAP` at rest, and room for a hand while a drag is on. The height
      // is on the box rather than on a child so the rows either side really do
      // move apart, which is the affordance: a gap that opens is a gap saying
      // something can go in it.
      data-testid="row-seam"
      style={{ height: dragging ? 22 : PANEL_GAP }}
      className="shrink-0 transition-[height] duration-100"
      onDragOver={(event) => {
        // A row of a panel's list crosses this on its way in, and is not a
        // panel being moved between rows.
        if (event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
        event.preventDefault();
        setUnder(true);
      }}
      onDragLeave={() => setUnder(false)}
      onDrop={(event) => {
        if (event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
        event.preventDefault();
        setUnder(false);
        onDrop(at);
      }}
    >
      {dragging && (
        <div
          className={`mx-1 h-full rounded-full transition-colors ${
            under ? 'bg-accent' : 'bg-accent/15'
          }`}
        />
      )}
    </div>
  );
}
