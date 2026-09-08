import { Fragment, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GRID_COLUMNS, MIN_ROW_HEIGHT, uuidv7 } from '@cockpit/shared';
import type { Dashboard, Filing, Item, Layout, LayoutRow, Panel } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useCommand } from '../api/queries';
import { itemsOnPanel } from '../filing';
import { browserStore } from '../lastVisited';
import { useChosenLayout } from '../panels/chosenLayout';
import { useMeasuredWidth, useScreenWidth } from '../panels/useScreenWidth';
import {
  dividerMoved,
  drawnRows,
  layoutLabel,
  layoutsOf,
  layoutToDraw,
  movedBeside,
  movedBy,
  nameForScreen,
  sameArrangement,
  sharesOf,
  withRowHeight,
  SAME_SCREEN_TOLERANCE,
} from '../panels/arrangement';
import { DeleteQuestion } from './DeleteQuestion';
import { arrangedWith, placementFor } from '../panels/dragging';
import type { DrawnRow } from '../panels/dragging';
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
  const [pick, choose] = useChosenLayout(browserStore(), dashboard.id);
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
   * The drag: which panel is in the air, the arrangement it was picked up
   * from, and the arrangement dropping it here would produce.
   *
   * **The preview is what the board draws**, which is the whole of this
   * change: the panels move as the pointer does, so the arrangement under the
   * hand is the one the drop will keep. Before this the gesture drew nothing -
   * the panel in the air was not marked, the side it would land on was not
   * shown, and the seams lit up in places where dropping did nothing at all.
   *
   * **`from` is the arrangement at pick-up, not the one being drawn.** Every
   * pointer move builds the preview afresh from it, so a drag that wanders
   * across four rows composes nothing: the panel is moved once, from where it
   * started, to wherever the pointer is now.
   */
  const [dragging, setDragging] = useState<{
    id: string;
    from: LayoutRow[];
    preview: LayoutRow[];
  } | null>(null);
  /**
   * The rows as drawn, so a drag can ask where they actually are. Measured
   * rather than computed: a row's height is its panels' and a panel's width
   * is its share of a row, so the only honest source is the page.
   */
  const rowsRef = useRef<HTMLDivElement>(null);
  /**
   * Which panel is in hand, known the instant it is picked up - or null.
   *
   * **A ref beside the state, and not a duplicate of it.** The state is what
   * the board draws with; this is what the pointer handler asks, and the two
   * are not the same question at the same time. Setting state schedules a
   * render, so the handler attached to the board is still the one from before
   * the pick-up for as long as that takes - and a move arriving in that window
   * reads `dragging` as null and is dropped. Under load every move of a quick
   * flick landed in it, and the drag did nothing at all.
   *
   * It holds the panel rather than a flag because the placement needs to know
   * which panel is in hand to answer "the pointer is where it already is" -
   * and reading that off the state instead left that answer disabled for
   * exactly the moves this ref exists to catch.
   */
  const draggingNow = useRef<string | null>(null);
  /** The control a question was opened from, so the focus can go back to it. */
  const askedFrom = useRef<HTMLElement | null>(null);
  /**
   * The arrangement a size being dragged is asking for, which is what the board
   * draws while the hand is down.
   *
   * Its own state rather than the draft, because a draft has been *sent*: this
   * one is redrawn on every pointer move and sent once, when the hand stops. A
   * command per pointer move would be a command per pixel.
   */
  const [sizing, setSizing] = useState<LayoutRow[] | null>(null);
  /**
   * What the size was when it was taken hold of, and what it is now.
   *
   * A ref beside the state for the reason `draggingNow` is one: the pointer
   * handler asks it in the same tick the gesture begins, before any render has
   * happened. **Measured once**, so a pointer that wanders composes nothing -
   * every move says where the line is now, from where the line started.
   */
  const sizingFrom = useRef<{
    rowIndex: number;
    /** Null for the line under a row; the cell left of the line between two panels otherwise. */
    dividerAt: number | null;
    at: number;
    startHeight: number;
    rowWidth: number;
    from: LayoutRow[];
    latest: LayoutRow[];
  } | null>(null);

  const its = layoutsOf(layouts, dashboard.id);
  const drawnWith = layoutToDraw(layouts, dashboard.id, screenWidth, pick);
  const stored = drawnRows(drawnWith, panels, acrossWidth);
  // The preview while a drag is on, then a draft that has been sent and is
  // waiting for the store to agree, then what the store holds.
  const shown = dragging?.preview ?? sizing ?? draft ?? stored;
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
  const refusalFor = (
    what:
      | 'rename_panel'
      | 'delete_panel'
      | 'save_layout'
      | 'set_panel_read_only'
      | 'set_panel_format',
    id?: string,
  ) => {
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
          // pick is already right - except where it names a layout that is not
          // there. Either half can go: another device deletes the layout you
          // picked, or the one your pick was overriding. Both are already inert
          // (arrangement.ts falls through to the nearest), so this only clears
          // the value out rather than changing what is drawn - and it is
          // cleared rather than repointed, because falling through is the
          // dashboard following the screen, which is what it should be doing.
          const alive = (id: string) => its.some((layout) => layout.id === id);
          if (pick && !(alive(pick.layoutId) && alive(pick.whileNearestIs))) choose(null);
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
   * The rows as they are on the page right now.
   *
   * Measured against the rows *as drawn*, which already show the preview - so
   * once the panel is under the pointer it stays there and the reading
   * settles, instead of flickering between two placements. The same thing the
   * list of workspaces does for the same reason (`ManageWorkspaces.tsx`).
   */
  const rowsOnScreen = (): DrawnRow[] => {
    const rows = rowsRef.current?.querySelectorAll('[data-panel-row]') ?? [];
    return [...rows].map((row) => {
      const box = row.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        cells: [...row.querySelectorAll('[data-panel-cell]')].map((cell) => {
          const at = cell.getBoundingClientRect();
          return {
            panelId: cell.getAttribute('data-panel-cell') ?? '',
            left: at.left,
            right: at.right,
          };
        }),
      };
    });
  };

  /**
   * Takes hold of one of the lines a row is drawn with. `dividerAt` is null for
   * the line under a row, which sets its height, and the index of the cell to
   * its left for the line between two panels, which moves columns across it.
   *
   * The row is measured now because a row without a height of its own has one
   * only on the page: it is as tall as what is in it, and the drag has to start
   * from that rather than from a number nothing holds.
   */
  const takeLine = (event: ReactPointerEvent, rowIndex: number, dividerAt: number | null) => {
    // The primary button only, for the reason a panel's header asks the same
    // question (`PanelCard`): a right-click opens a menu over the line, so no
    // release ever reaches this handler - and the gesture would go on sizing
    // the row under every mouse move until some later click ended it.
    if (event.button !== 0) return;
    const row = rowsRef.current?.querySelectorAll('[data-panel-row]')[rowIndex];
    if (!row || !shown[rowIndex]) return;
    // The board's own handlers would otherwise read this as a panel being
    // picked up off the row the line belongs to.
    event.preventDefault();
    event.stopPropagation();
    command.reset();
    setRenaming(null);
    setDeleting(null);
    const box = row.getBoundingClientRect();
    sizingFrom.current = {
      rowIndex,
      dividerAt,
      at: dividerAt === null ? event.clientY : event.clientX,
      startHeight: box.bottom - box.top,
      rowWidth: box.right - box.left,
      from: shown,
      latest: shown,
    };
    setSizing(shown);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Allowed to fail, as the panel drag's capture is: the moves still arrive
      // while the pointer is over the board, which is nearly all of the gesture.
    }
  };

  /** Where the line has got to, redrawn as the arrangement it is asking for. */
  const lineTo = (point: { x: number; y: number }) => {
    const held = sizingFrom.current;
    if (!held) return;
    if (held.dividerAt === null) {
      const moved = point.y - held.at;
      // A line that has not moved has not been dragged, and the difference is
      // not nothing: a row with no height of its own would be handed the
      // number it happens to be drawn at, which looks identical and is a size
      // somebody now has to undo. The divider says the same thing about a move
      // of no whole columns.
      held.latest = moved === 0 ? held.from : withRowHeight(held.from, held.rowIndex, held.startHeight + moved);
    } else {
      // A twelfth of the row is what one column measures, so the gesture lands
      // on the grid the spans are counted in rather than on the pixel - which
      // is what keeps a row adding up to a whole.
      const perColumn = held.rowWidth / GRID_COLUMNS;
      const columns = perColumn > 0 ? Math.round((point.x - held.at) / perColumn) : 0;
      // The arrangement itself back where no column has moved, not a copy of
      // it: the first half-column of every divider drag is dozens of pointer
      // moves, and a fresh array each time is a board redrawn for a size that
      // has not changed. The height above says the same thing the same way.
      held.latest =
        columns === 0 ? held.from : dividerMoved(held.from, held.rowIndex, held.dividerAt, columns);
    }
    setSizing(held.latest);
  };

  /** Let go: what is drawn is what is kept, and this is the only thing sent. */
  const letGoOfLine = () => {
    const held = sizingFrom.current;
    sizingFrom.current = null;
    setSizing(null);
    if (held) propose(held.latest);
  };

  /** The browser taking the gesture back, or Escape: the row goes back to its size. */
  const abandonLine = () => {
    sizingFrom.current = null;
    setSizing(null);
  };

  /**
   * A row put back to being as tall as what is in it, which is the only way
   * back: a drag always leaves a number behind, and the height a row has
   * without one is not a number anything could drag to.
   */
  const fitRowToContents = (rowIndex: number) => {
    abandonLine();
    command.reset();
    propose(withRowHeight(shown, rowIndex, null));
  };

  /**
   * Picks a panel up. Nothing is sent; the board just starts drawing it moved.
   *
   * **The board takes the pointer**, rather than the header the grab happened
   * on. A panel that joins another row is drawn under a different parent, so
   * React remounts it and a capture held on that header dies with the node -
   * the drag answered its first move and then went deaf. This element is the
   * one thing on screen that no rearrangement can unmount.
   */
  const pickUp = (panelId: string, pointerId: number) => {
    command.reset();
    setRenaming(null);
    setDeleting(null);
    draggingNow.current = panelId;
    setDragging({ id: panelId, from: shown, preview: shown });
    // **After the drag has begun, and allowed to fail.** Capture is what keeps
    // the moves coming once the pointer has left the board - over the Inbox, or
    // off the window - and it is worth having. It is not worth the gesture: the
    // browser refuses it for a pointer it does not consider active, and taken
    // first that refusal threw before the line above ever ran, so the drag
    // silently did not start at all. Without it the moves still arrive while
    // the pointer is over the board, which is nearly all of the drag.
    try {
      rowsRef.current?.setPointerCapture(pointerId);
    } catch {
      // Nothing to do about it, and nothing that needs saying: the gesture
      // works either way.
    }
  };

  /**
   * Where the pointer has got to, redrawn as the arrangement it is asking for.
   *
   * The page is measured out here rather than inside the update, because an
   * updater has to be pure - React is free to run it twice - and reading the
   * DOM is not. What goes in is a placement already decided.
   */
  const dragTo = (point: { x: number; y: number }) => {
    const inHand = draggingNow.current;
    if (!inHand) return;
    const placement = placementFor(point, rowsOnScreen(), inHand);
    if (!placement) return;
    setDragging((held) => {
      if (!held) return held;
      const preview = arrangedWith(held.from, held.id, placement);
      // Same arrangement, same object: React redraws on a new array whether or
      // not anything in it moved, and a pointer move fires many times a
      // second across a panel it is already inside.
      return sameArrangement(preview, held.preview) ? held : { ...held, preview };
    });
  };

  /** Dropped. A drag that ends where it started asks for nothing. */
  const letGo = () => {
    const held = dragging;
    draggingNow.current = null;
    setDragging(null);
    if (!held || sameArrangement(held.preview, held.from)) return;
    propose(held.preview);
  };

  /** A drag abandoned rather than dropped: the panels go back and nothing is sent. */
  const abandon = () => {
    draggingNow.current = null;
    setDragging(null);
  };

  /**
   * The two ends of a drag the board cannot hear on its own.
   *
   * **Let go somewhere else.** The pointer is captured, so a release reaches
   * the board wherever it happens - unless the capture was refused, which is
   * allowed to happen (`pickUp`). A release outside the board would then
   * arrive nowhere, and the panels would sit lifted around a drag that is
   * over, with the next press dropping one somewhere nobody aimed.
   *
   * **Escape**, which abandons the innermost open thing everywhere else in
   * the app and had nothing to abandon here.
   */
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') abandon();
    };
    window.addEventListener('pointerup', letGo);
    window.addEventListener('pointercancel', abandon);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerup', letGo);
      window.removeEventListener('pointercancel', abandon);
      window.removeEventListener('keydown', onKey);
    };
    // `letGo` and `abandon` are rebuilt every render; what decides whether
    // they are listening is the drag, and re-subscribing on every render of a
    // board holding a drag would be a listener swapped per pointer move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  /**
   * The same two ends, for a line being dragged. Worth having for the reason
   * the drag's are: where the capture was refused, a release outside the board
   * would leave the row sized with nothing sent, and the next press anywhere
   * would go on sizing it.
   */
  useEffect(() => {
    if (!sizing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') abandonLine();
    };
    const onMove = (event: PointerEvent) => lineTo({ x: event.clientX, y: event.clientY });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', letGoOfLine);
    window.addEventListener('pointercancel', abandonLine);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', letGoOfLine);
      window.removeEventListener('pointercancel', abandonLine);
      window.removeEventListener('keydown', onKey);
    };
    // On the size itself rather than on whether there is one, exactly as the
    // drag's is on `dragging`: these close over `propose`, which compares what
    // is being kept against what the store holds, and a listener captured once
    // at the start of the gesture would still be comparing against the
    // arrangement from before an update that arrived while the hand was down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizing]);

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

  /**
   * Lock a panel of text's prose, or hand it back.
   *
   * No `onSuccess`: nothing closes and nothing is emptied, so what the change
   * lands on is the re-read snapshot redrawing the panel - which is also what
   * makes the choice hold for everybody rather than for this tab.
   */
  const setReadOnly = (panelId: string, readOnly: boolean) => {
    command.mutate({
      name: 'set_panel_read_only',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        panelId,
        readOnly,
      },
    });
  };

  /**
   * What a panel of text's words are drawn as. Nothing is converted: the same
   * Markdown is stored either way, so this only changes how it is read.
   */
  const setFormat = (panelId: string, format: 'plain' | 'rich') => {
    command.mutate({
      name: 'set_panel_format',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        panelId,
        format,
      },
    });
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
        <div
          ref={rowsRef}
          // The whole gesture, because this is what holds the pointer.
          onPointerMove={(event) => {
            dragTo({ x: event.clientX, y: event.clientY });
          }}
          onPointerUp={letGo}
          // The browser taking it back - a touch that became a scroll, the
          // window losing focus. The panels go back where they were.
          onPointerCancel={abandon}
          className="flex min-w-0 flex-col"
        >
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
                <RowSeam
                  dragging={dragging !== null}
                  // A seam sets the height of the row *above* it, so every row
                  // has exactly one line under it to pull and the seam over the
                  // first row has none to set.
                  sizes={rowIndex === 0 ? null : rowIndex - 1}
                  onTake={takeLine}
                  onMove={lineTo}
                  onLetGo={letGoOfLine}
                  onFitToContents={fitRowToContents}
                />
                <div
                  // What a drag measures to work out which row the pointer is
                  // over (`panels/dragging.ts`). On the row rather than read
                  // off the children, because a row's band is the row's.
                  data-panel-row=""
                  // A row is a grid of its own, so its panels share one height
                  // without anything being told what that height is - which is
                  // what a row *is*. `minmax(0, …)` rather than a bare fraction
                  // is the whole of "never scrolls sideways": a bare `1fr` is
                  // `minmax(auto, 1fr)`, so one long unbroken word inside a
                  // panel would widen its column and take the page with it.
                  //
                  // **The height the row was given, where it has one**, set by
                  // dragging the line under it and dropped by double-clicking
                  // that line. A row nobody has ever sized carries none and is
                  // as tall as what is in it.
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
                    // The gap between two panels is a track of its own rather
                    // than a `gap`, so it is an element a hand can take hold
                    // of. Same four pixels either way: nothing about how a row
                    // is drawn changes, only whether the space between two
                    // panels is something or nothing.
                    gridTemplateColumns: shares
                      .map((share) => `minmax(0, ${share}fr)`)
                      .join(` ${PANEL_GAP}px `),
                    gap: 0,
                  }}
                >
                  {row.cells.map((cell, at) => {
                    const panel = panels.find((one) => one.id === cell.panelId);
                    if (!panel) return null;
                    return (
                      <Fragment key={panel.id}>
                        {at > 0 && (
                          <ColumnLine
                            dragging={dragging !== null}
                            onTake={(event) => takeLine(event, rowIndex, at - 1)}
                            onMove={lineTo}
                            onLetGo={letGoOfLine}
                          />
                        )}
                        <PanelCard
                          panel={panel}
                          workspaceId={workspaceId}
                          items={itemsOnPanel(items, filings, panel.id)}
                          nothingFiledYet={filings.length === 0}
                          sideBySide={row.cells.length > 1}
                          // Nowhere left to go, which is not the same as being
                          // at the end of a row: a panel at the end of a row it
                          // *shares* can still move onto a line of its own
                          // beyond it, and that is the only way a keyboard has
                          // of making a row. Only a panel alone on the first or
                          // last line has run out of places.
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
                          onReadOnlyChange={(readOnly) => setReadOnly(panel.id, readOnly)}
                          onFormatChange={(format) => setFormat(panel.id, format)}
                          lifted={dragging?.id === panel.id}
                          onPickUp={(pointerId) => pickUp(panel.id, pointerId)}
                          refusal={
                            refusalFor('rename_panel', panel.id) ??
                            refusalFor('delete_panel', panel.id) ??
                            refusalFor('set_panel_read_only', panel.id) ??
                            refusalFor('set_panel_format', panel.id)
                          }
                          busy={command.isPending}
                        />
                      </Fragment>
                    );
                  })}
                </div>
              </Fragment>
            );
          })}
          {/* The gap under the last row, so a panel can be dropped below
              everything rather than only between two things - and, being under
              a row, the line that sets that row's height. */}
          <RowSeam
            dragging={dragging !== null}
            sizes={shown.length ? shown.length - 1 : null}
            onTake={takeLine}
            onMove={lineTo}
            onLetGo={letGoOfLine}
            onFitToContents={fitRowToContents}
          />
        </div>
      )}

      {beingDeleted && (
        <DeleteQuestion
          open
          // What goes with it, which for a panel of text is the text: the
          // layouts are an arrangement anybody can make again, and the words
          // are not (the Deleting rule - "naming what is going and what goes
          // with it").
          question={`Delete ${beingDeleted.name}? ${
            beingDeleted.kind === 'text'
              ? 'The text in it goes too, and it goes from every layout of this dashboard.'
              : 'It goes from every layout of this dashboard.'
          }`}
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
 * The gap between two rows, which opens while a panel is in the air.
 *
 * **Four pixels is the gap, and four pixels is not a target.** The seam is the
 * space between rows at rest - a seam rather than a margin, which is what the
 * sheet is drawn as ("Cockpit Shell Explorations", artboard 2c) - and it opens
 * to something a hand can hit only while a panel is actually being dragged.
 * Nothing is added to the page the rest of the time.
 *
 * **It takes no drop and lights up for nothing**, which is what it did before.
 * A drag now moves the panels as it goes (`panels/dragging.ts`), so the seam
 * that a pointer is in has already become the row the panel is drawn on: the
 * arrangement is the feedback, and a highlight would be a second answer to a
 * question the board has already answered. It used to light under the pointer
 * wherever the pointer went - including the two seams either side of a panel
 * already alone on its line, where dropping did nothing and said nothing.
 */
function RowSeam({
  dragging,
  sizes,
  onTake,
  onMove,
  onLetGo,
  onFitToContents,
}: {
  dragging: boolean;
  /** The row whose height this seam sets, or null where there is no row above it. */
  sizes: number | null;
  onTake: (event: ReactPointerEvent, rowIndex: number, dividerAt: number | null) => void;
  onMove: (point: { x: number; y: number }) => void;
  onLetGo: () => void;
  onFitToContents: (rowIndex: number) => void;
}) {
  return (
    <div
      // The height is on the box rather than on a child so the rows either side
      // really do move apart, which is the affordance: a gap that opens is a
      // gap saying something can go in it.
      data-testid="row-seam"
      style={{ height: dragging ? 22 : PANEL_GAP, position: 'relative' }}
      className="shrink-0 transition-[height] duration-100"
    >
      {/* Four pixels is the seam and four pixels is not a target, so the line
          reaches past it - **upwards only**. Reaching down would put it over
          the top of the panels below, whose headers are what a drag is started
          from, and the first few pixels of a grab would silently size the row
          above instead of picking that panel up.

          Absent while a panel is in the air, where the seam is the drag's and
          means a place to drop rather than a size to set. */}
      {sizes !== null && !dragging && (
        <div
          data-testid="row-line"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Drag to set how tall this row is, double-click to fit its contents"
          onPointerDown={(event) => onTake(event, sizes, null)}
          onPointerMove={(event) => onMove({ x: event.clientX, y: event.clientY })}
          onPointerUp={onLetGo}
          onDoubleClick={() => onFitToContents(sizes)}
          style={{ top: -8, height: 8 + PANEL_GAP }}
          className="group absolute inset-x-0 z-10 cursor-row-resize touch-none"
        >
          {/* Nothing at rest: a line drawn permanently under every row would be
              chrome charged to every dashboard for a gesture used rarely. */}
          <div className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-60 group-active:opacity-100" />
        </div>
      )}
    </div>
  );
}

/**
 * The line between two panels of one row, which moves whole columns from one to
 * the other.
 *
 * It *is* the gap - the grid track between the two, rather than something drawn
 * over them - and it reaches four pixels either side so a hand has twelve to
 * aim at. Nothing either side of it is a gesture, so unlike the row's line this
 * one may overhang in both directions.
 */
function ColumnLine({
  dragging,
  onTake,
  onMove,
  onLetGo,
}: {
  dragging: boolean;
  onTake: (event: ReactPointerEvent) => void;
  onMove: (point: { x: number; y: number }) => void;
  onLetGo: () => void;
}) {
  if (dragging) return <div />;
  return (
    <div
      data-testid="column-line"
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to set how much of the row this panel takes"
      onPointerDown={onTake}
      onPointerMove={(event) => onMove({ x: event.clientX, y: event.clientY })}
      onPointerUp={onLetGo}
      className="group relative z-10 cursor-col-resize touch-none"
    >
      <div className="absolute inset-y-0 -left-[4px] -right-[4px]" />
      <div className="absolute inset-y-2 left-1/2 w-[2px] -translate-x-1/2 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-60 group-active:opacity-100" />
    </div>
  );
}
