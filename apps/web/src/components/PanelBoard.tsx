import { Fragment, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  GRID_COLUMNS,
  isPhoneWidth,
  MIN_ROW_HEIGHT,
  NO_CONDITIONS,
  panelGathers,
  panelHoldsText,
  uuidv7,
} from '@cockpit/shared';
import type {
  Dashboard,
  Filing,
  FilterCondition,
  FilterGrouping,
  FilterMatch,
  AgentRun,
  Attachment,
  Item,
  ItemType,
  Layout,
  LayoutRow,
  Panel,
  PanelSort,
} from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useCommand } from '../api/queries';
import { scrollWhileDragging } from '../dragScroll';
import { itemsOnPanel } from '../filing';
import { groupFilterRows } from '../filterGroups';
import { dayOf, filtersUsingPanel, isGrouped, itemsMatchingFilter, joinedBy } from '../filters';
import { browserStore } from '../lastVisited';
import { isFiltering, itemIdsWithAttachments, itemIdsWithRun, matchesDashboardFilter, useDashboardFilter } from '../dashboardFilter';
import { DashboardFilterBar } from './DashboardFilterBar';
import { DEFAULT_FILTER_SORT, inSortOrder, sortOf } from '../sorting';
import { useMeasuredWidth, useScreenWidth } from '../panels/useScreenWidth';
import {
  dividerMoved,
  drawnRows,
  layoutToDraw,
  movedBeside,
  sameArrangement,
  sharesOf,
  withRowHeight,
} from '../panels/arrangement';
import { dashboardTabAt } from '../panels/dashboardDrop';
import type { TabRect } from '../panels/dashboardDrop';
import { DeleteQuestion } from './DeleteQuestion';
import { anchored } from '../panels/anchoring';
import { arrangedWith, arrangedWithRow, placementFor, rowPlacementFor } from '../panels/dragging';
import type { DrawnRow } from '../panels/dragging';
import { MovePanelToDashboardPicker } from './MovePanelToDashboardPicker';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';
import { forgetPanelsCollapsed, usePanelsCollapsed } from '../panelsCollapsed';
import { PANEL_GAP, PanelCard } from './PanelCard';
import { publishPanelList, withdrawPanelList } from '../panelList';

/** How long a Panel stays outlined after the list jumps to it, in milliseconds. */
const JUMP_OUTLINE_MS = 1200;

/** How close two taps on a header are to be a double-tap, in milliseconds. */
const DOUBLE_TAP_MS = 350;

/**
 * A Filter's own question, fetched only once *Filter…* is chosen from a
 * Panel's menu - never on a cold open, the same boundary `PanelText.tsx`
 * draws around `RichDescription` and `DrawnText` (`FilterQuestion.tsx`'s own
 * doc comment).
 */
const FilterQuestion = lazy(() => import('./FilterQuestion'));

/** A Panel's Sort question, fetched only once *Sort…* is chosen, for the reason the Filter question is. */
const SortQuestion = lazy(() => import('./SortQuestion'));

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
  dashboards,
  panels,
  panelsInWorkspace,
  layouts,
  items,
  filings,
  itemTypes,
  attachments = [],
  agentRuns = [],
}: {
  workspaceId: string;
  dashboard: Dashboard;
  /** Every dashboard of the workspace, in tab order - what "Move to another dashboard" offers. */
  dashboards: readonly Dashboard[];
  /** This dashboard's panels - what is drawn, arranged and dragged about. */
  panels: readonly Panel[];
  /**
   * Every panel of the workspace, which is a different question from the one
   * above and is asked only about filings.
   *
   * **Whether a filing files is a fact about the Panel it names, not about the
   * dashboard on screen** (`filingsThatFile`): a Filter on another dashboard
   * still gathers rather than holds, so a board given this dashboard's panels
   * alone would count a filing onto it as real - and the Item would sit in the
   * Inbox, which reads the workspace-wide list, while a Filter here gathered it
   * as though it had been filed. Found by the review on "Add a Filter panel
   * that shows every filed item due in a window" (issue 463).
   */
  panelsInWorkspace: readonly Panel[];
  layouts: readonly Layout[];
  /** Every open item of the workspace; each panel is handed the ones filed on it. */
  items: readonly Item[];
  filings: readonly Filing[];
  /**
   * The account's live Types - what a Filter's Type condition offers to
   * choose from and reads its values against ("Filter a Filter panel by
   * priority and type", issue 464).
   */
  itemTypes: readonly ItemType[];
  /** Every attachment of the workspace's items, which is all a Dashboard filter's Attachments condition reads. */
  attachments?: readonly Attachment[];
  /** The workspace's open runs, which is all a Dashboard filter's Agent running condition reads. */
  agentRuns?: readonly AgentRun[];
}) {
  const screenWidth = useScreenWidth();
  /**
   * How wide the panels actually are, which is not the screen: the Inbox takes
   * about a fifth of it wherever there is room ("Show the Inbox beside the
   * dashboards instead of as a tab", issue 117). The screen's width decides
   * whether this is a phone; this is what decides how many fit across.
   * Before anything has been measured the screen's width stands in, which is
   * the arrangement one paint early rather than every panel full width.
   */
  const [measure, measured] = useMeasuredWidth();
  const acrossWidth = measured ?? screenWidth;
  /**
   * Whether anything on this board can be rearranged. Not on a phone, which is
   * drawn one panel across whatever Layouts exist and has no surface to change
   * one through: no drag, no row line, no divider (`isPhoneWidth`).
   */
  const [dashboardFilter] = useDashboardFilter(browserStore(), dashboard.id);
  /**
   * **A filtered board is never rearranged**, whichever way: its rows are fitted
   * to what is left rather than to the sizes stored, so a drag or a divider
   * would write the shrunken one back as if it were the person's.
   */
  const filteringOn = isFiltering(dashboardFilter);
  const phone = isPhoneWidth(screenWidth);
  const arrangeable = !phone && !filteringOn;
  const command = useCommand();
  const queryClient = useQueryClient();

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
  /** The panel a "Move to another dashboard" picker is open for. */
  const [movingPanel, setMovingPanel] = useState<string | null>(null);
  /** Which Filter's conditions are being edited, if any. */
  const [filtering, setFiltering] = useState<string | null>(null);
  /** Which Panel of items' sort is being asked, if any. */
  const [sorting, setSorting] = useState<string | null>(null);
  /**
   * Every dashboard the panel could move to: the workspace's, minus the one
   * it is already on - in tab order, which is the order `dashboards` already
   * arrives in ("a dashboard shows the panels put on it", repo.ts).
   */
  const otherDashboards = dashboards.filter((one) => one.id !== dashboard.id);
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
    /** True where the whole row holding `id` is in hand, taken by its grip. */
    row: boolean;
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
  /** Whether what is in hand is the whole row `draggingNow` is on, for the same reason `draggingNow` is a ref. */
  const draggingRowNow = useRef(false);
  /**
   * **And on a phone, every Panel is its header alone for as long as the person
   * asks** - a double-tap on a header, or *Collapse panels* on the Dashboard's
   * "…" ("Collapse every Panel to its header on a phone", issue 784), so a
   * Panel near the bottom can be seen and jumped to without scrolling past
   * every Item above it. The same drawing, a second reason for it. Never
   * remembered (`panelsCollapsed.ts`), and never on a wider screen.
   */
  const asked = usePanelsCollapsed(dashboard.id);
  const collapsedOnPhone = phone && asked.collapsed;
  /**
   * **Every Panel is its header alone while one is in the air**, so the whole
   * arrangement is in view at once and a Panel can be taken to any row without
   * riding the edge-scroll past screens of Items. Only a Panel drag does it: a
   * size is set against what is in the Panels, so a line being dragged
   * collapses nothing.
   */
  const collapsed = dragging !== null || collapsedOnPhone;
  // Widening past the phone line opens every Panel, rather than leaving it
  // remembered for the next time the window narrows; leaving the board
  // forgets it, so coming back to this Dashboard opens every Panel too.
  const { open: openPanels } = asked;
  useEffect(() => {
    if (!phone) openPanels();
  }, [phone, openPanels]);
  useEffect(() => () => forgetPanelsCollapsed(dashboard.id), [dashboard.id]);
  /** The last tap on a header, so a second one close behind it is a double-tap. */
  const lastTap = useRef<{ at: number; opened: boolean; panelId: string } | null>(null);
  /** Whether the last layout had the Panels collapsed by the person, so an opening of any kind can be told from a drag ending. */
  const wasCollapsedOnPhone = useRef(false);
  /**
   * The header that must stay where it is while the board changes shape: the
   * Panel and where its top was the moment before - grabbed when the board
   * collapses, dropped when it opens.
   */
  const anchor = useRef<{ panelId: string; top: number; toTop?: boolean } | null>(null);
  /**
   * What the Dashboard could not scroll to keep the anchor: room above the
   * board where positive, the board pulled up where negative. It outlives the
   * drag, since taking it away on the drop would move the dropped Panel; the
   * next anchoring takes back what scrolling can now hold.
   */
  const [room, setRoom] = useState(0);
  /** Where the pointer last was during a panel drag, for the scroll that moves the page under a still hand. */
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
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
   * **An Item is being dragged to be filed** (the browser's own drag, not a
   * Panel's). The row grip lies over the left edge of a row's first Panel, so
   * while an Item is in the air it is left out rather than becoming the thing
   * under the pointer that no drop target answers.
   */
  const [itemInHand, setItemInHand] = useState(false);
  useEffect(() => {
    const begun = () => setItemInHand(true);
    const over = () => setItemInHand(false);
    window.addEventListener('dragstart', begun);
    window.addEventListener('dragend', over);
    window.addEventListener('drop', over);
    return () => {
      window.removeEventListener('dragstart', begun);
      window.removeEventListener('dragend', over);
      window.removeEventListener('drop', over);
    };
  }, []);
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

  const drawnWith = layoutToDraw(layouts, dashboard.id, screenWidth);
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
  const beingMoved = panels.find((panel) => panel.id === movingPanel);
  const beingFiltered = panels.find((panel) => panel.id === filtering);
  const beingSorted = panels.find((panel) => panel.id === sorting);

  /**
   * The day it is where this person is looking, read once for the whole board
   * so two Filters drawn side by side cannot land either side of midnight.
   *
   * Read at render rather than held in state: nothing here redraws on its own
   * at midnight, and a Filter showing yesterday's *today* until the next change
   * is a page that has been open all night rather than a bug to schedule a
   * timer for.
   */
  const today = dayOf(new Date());
  const withAttachments = itemIdsWithAttachments(attachments);
  const withRun = itemIdsWithRun(agentRuns);
  const narrowed = (list: Item[]): Item[] =>
    filteringOn
      ? list.filter((item) => matchesDashboardFilter(dashboardFilter, item, withAttachments, today, withRun))
      : list;

  /** What a Panel shows: its own Items, or what its Filter gathers, narrowed by the Dashboard filter. */
  const itemsOf = (panel: Panel): Item[] =>
    narrowed(
      panelGathers(panel)
        ? itemsMatchingFilter(
            items,
            filings,
            panelsInWorkspace,
            itemTypes,
            panel.filter ?? NO_CONDITIONS,
            today,
            sortOf(panel) ?? DEFAULT_FILTER_SORT,
          )
        : inSortOrder(itemsOnPanel(items, filings, panel.id), sortOf(panel), itemTypes),
    );
  /**
   * **While a Dashboard filter is on, a Panel with no matching Item is not
   * drawn**, a Panel of text included, which has no Item to match. The cells
   * keep the layout's own spans, so the Panels left share a row in their
   * proportions; nothing is stored, so clearing the filter brings every Panel
   * back.
   */
  const shows = new Map(panels.map((panel) => [panel.id, itemsOf(panel)]));
  /**
   * A Filter's rows under a heading each, where it is grouped ("Group a Filter
   * panel's items by the Dashboard or Panel they are filed on", issue 805):
   * worked out from what the Filter shows, so the Dashboard filter has already
   * narrowed every group and one it empties is not drawn.
   */
  const groupsOf = (panel: Panel) => {
    const groupBy = panelGathers(panel) ? (panel.filter ?? NO_CONDITIONS).groupBy : 'none';
    return isGrouped(groupBy)
      ? groupFilterRows(shows.get(panel.id)!, groupBy, filings, panelsInWorkspace, dashboards, layouts)
      : undefined;
  };
  const hidden = filteringOn
    ? new Set(panels.filter((panel) => shows.get(panel.id)!.length === 0).map((panel) => panel.id))
    : null;
  // Each row keeps the place it has in `shown`, which is what it is keyed by:
  // a row hidden above would otherwise move every row under it to a new key
  // and remount the panels on them.
  const drawn = shown
    .map((row, place) => ({
      place,
      row: hidden ? { ...row, cells: row.cells.filter((cell) => !hidden.has(cell.panelId)) } : row,
    }))
    .filter(({ row }) => !hidden || row.cells.length > 0);
  const hiddenCount = hidden ? hidden.size : 0;

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
      | 'set_panel_format'
      | 'set_panel_filter'
      | 'set_panel_sort'
      | 'move_panel_to_dashboard',
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

  const saveArrangement = (layoutId: string, rows: readonly LayoutRow[]) => {
    command.mutate(
      {
        name: 'save_layout',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          dashboardId: dashboard.id,
          layoutId,
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
         * Dropping `sent` with the draft is what lets the same gesture be made
         * again once the snapshot has caught up.
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
   * The id of the layout this board made, kept until the snapshot has it.
   *
   * Two gestures can both find the dashboard with no layout: the first sends
   * one and the second happens before the re-read lands. Sending the same id
   * keeps the second gesture plainly about the layout the first one made; the
   * server would put a save naming any other id into that one anyway.
   */
  const justMade = useRef<string | null>(null);
  const firstLayoutId = (): string => {
    if (justMade.current) return justMade.current;
    justMade.current = uuidv7();
    return justMade.current;
  };

  /**
   * What every gesture that changes the arrangement ends in: keep it, in the
   * layout on screen.
   *
   * **It asks nothing**: the layout drawn is the Dashboard's one, so there is
   * nothing to choose between (`layoutToDraw`).
   *
   * A layout is still made silently when the dashboard has none, because there
   * is nothing to change and nothing worth interrupting a drag to ask.
   */
  const propose = (next: LayoutRow[]) => {
    // A gesture already in the air when the window shrank past the phone line
    // has nothing to keep: a phone is never arranged, and sending it would
    // replace the one Layout every wider screen draws.
    if (!arrangeable) return;
    // Against what has been *sent* - or the store, where nothing has - rather
    // than against what is drawn: a gesture that puts a panel back where the
    // snapshot has it still has to be sent when an earlier one moved
    // it; and a gesture that really changes nothing must send nothing.
    //
    if (sameArrangement(next, sent.current ?? stored)) return;
    command.reset();
    setDraft(next);
    // A dashboard nobody has arranged gets its one layout from this first
    // move, under an id made here (`save_layout`).
    saveArrangement(drawnWith?.id ?? firstLayoutId(), next);
  };

  /**
   * The rows as they are on the page right now.
   *
   * Measured against the rows *as drawn*, which already show the preview - so
   * once the panel is under the pointer it stays there and the reading
   * settles, instead of flickering between two placements. The same thing the
   * strip of workspace tabs does for the same reason (`tabDrag.ts`).
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
    setMovingPanel(null);
    setFiltering(null);
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

  /** The scrolling box the Dashboard is drawn in, which the board's own scrolling is done on. */
  const dashboardScroller = () =>
    rowsRef.current?.closest<HTMLElement>('[data-drag-scroll="dashboard"]') ?? null;

  /** Where a Panel's header is on the page, or null where it is not drawn. */
  const headerTop = (panelId: string): number | null => {
    const header = rowsRef.current?.querySelector(`[data-panel-cell="${panelId}"] header`);
    return header ? header.getBoundingClientRect().top : null;
  };

  /**
   * The Panel list's jump ("Show a Dashboard's Panels in a collapsible column
   * at its right, and jump to one", issue 803): this Panel's header to the top
   * of the Dashboard, and the Panel outlined for a moment so the eye finds it.
   * Held through a ref so what is published is one function for the board's
   * whole life, and a republish never looks like a change.
   */
  const jumpRef = useRef<(panelId: string) => void>(() => undefined);
  const outlined = useRef<{ cell: HTMLElement; timer: number } | null>(null);
  jumpRef.current = (panelId) => {
    const cell = rowsRef.current?.querySelector<HTMLElement>(`[data-panel-cell="${panelId}"]`);
    if (!cell) return;
    const scroller = dashboardScroller();
    const top = headerTop(panelId);
    if (scroller && top !== null) {
      // The Dashboard filter bar sticks to the top of the scroller, so the
      // header lands just below it rather than under it.
      // Panels have sticky headers of their own inside the rows; those are not it.
      const bar = [...scroller.querySelectorAll<HTMLElement>('.sticky.top-0')].find(
        (one) => !rowsRef.current?.contains(one),
      );
      const barHeight = bar ? bar.getBoundingClientRect().height : 0;
      scroller.scrollTo({
        top: scroller.scrollTop + top - scroller.getBoundingClientRect().top - barHeight,
        behavior: 'smooth',
      });
    }
    if (outlined.current) {
      window.clearTimeout(outlined.current.timer);
      outlined.current.cell.removeAttribute('data-jumped-to');
    }
    cell.setAttribute('data-jumped-to', '');
    outlined.current = {
      cell,
      timer: window.setTimeout(() => cell.removeAttribute('data-jumped-to'), JUMP_OUTLINE_MS),
    };
  };
  const [jumpTo] = useState(() => (panelId: string) => jumpRef.current(panelId));
  const listed = drawn.map(({ row }) =>
    row.cells.map((cell) => {
      const panel = panels.find((one) => one.id === cell.panelId);
      return {
        panelId: cell.panelId,
        title: panel?.name ?? '',
        count: panel && panelHoldsText(panel) ? null : (shows.get(cell.panelId)?.length ?? 0),
      };
    }),
  );
  // A drop in the list goes through the board's own send, so it is compared
  // with what was last sent and saved into the Layout on screen like a board
  // drag ("Rearrange a Dashboard by dragging Panels in its panel list", issue
  // 804). Held through a ref for the same reason as `jumpTo`.
  const arrangeRef = useRef<(next: LayoutRow[]) => void>(() => undefined);
  arrangeRef.current = propose;
  const [arrange] = useState(() => (next: LayoutRow[]) => arrangeRef.current(next));
  // After every render, which the publication itself drops when nothing it
  // says has changed; withdrawn only when the board leaves.
  useEffect(() => {
    publishPanelList({
      dashboardId: dashboard.id,
      rows: listed,
      jumpTo,
      arrangeable,
      arrangement: shown,
      arrange,
    });
  });
  useEffect(() => () => withdrawPanelList(jumpTo), [jumpTo]);
  useEffect(
    () => () => {
      if (outlined.current) window.clearTimeout(outlined.current.timer);
    },
    [],
  );

  /** Notes where the header is now, for the board about to change shape around it. */
  const anchorOn = (panelId: string) => {
    const top = headerTop(panelId);
    anchor.current = top === null ? null : { panelId, top };
  };

  /**
   * Notes the top of the screen as where this header is wanted once the board
   * opens: scrolled there as far as the page can be, which for a short last
   * Panel is short of the top.
   */
  const anchorAtTop = (panelId: string) => {
    anchor.current = {
      panelId,
      top: dashboardScroller()?.getBoundingClientRect().top ?? 0,
      toTop: true,
    };
  };

  /**
   * A tap on a header, which collapsed or open means two different things:
   * open, a second tap close behind the first collapses the board; collapsed,
   * any tap opens it with that Panel's header at the top, and the second tap of
   * a double-tap - the first having opened it already - is let go by rather
   * than collapsing it again.
   */
  const tappedHeader = (panelId: string, at: number) => {
    const before = lastTap.current;
    const close = before !== null && at - before.at < DOUBLE_TAP_MS;
    // A double-tap is two taps on one header, close together.
    const second = close && before.panelId === panelId;
    if (collapsedOnPhone) {
      lastTap.current = { at, opened: true, panelId };
      anchorAtTop(panelId);
      asked.open();
      return;
    }
    // The second half of the double-tap that just opened the board, on
    // whichever header it lands: the first tap moved the page under the finger.
    if (close && before.opened) {
      lastTap.current = null;
      return;
    }
    if (second) {
      lastTap.current = null;
      // The header tapped stays where it is as the rest of the board folds.
      anchorOn(panelId);
      asked.collapse();
      return;
    }
    lastTap.current = { at, opened: false, panelId };
  };

  /**
   * Puts the anchored header back under the pointer once the board has
   * collapsed or opened: the Dashboard scrolls by the difference, and what it
   * cannot scroll becomes room above the board or the board pulled up
   * (`panels/anchoring.ts`). A header that has gone (deleted in another tab)
   * leaves everything as it fell.
   */
  useLayoutEffect(() => {
    const held = anchor.current;
    anchor.current = null;
    // **Opened by the person, by any route**: the room above the board was
    // only there to hold a header in place while it was collapsed, so it goes.
    // A drag ending keeps it, which is what holds the dropped Panel.
    const openedByPerson = wasCollapsedOnPhone.current && !collapsedOnPhone;
    wasCollapsedOnPhone.current = collapsedOnPhone;
    const scroller = dashboardScroller();
    if (openedByPerson && scroller && rowsRef.current) {
      // The room goes now, in the page itself, so what is measured and scrolled
      // next already reflects it; the scroll takes back what it moved, so what
      // was on screen stays put unless a header is wanted at the top.
      const was = scroller.scrollTop;
      rowsRef.current.style.marginTop = '';
      setRoom(0);
      scroller.scrollTop = was - room;
      const top = held?.toTop ? headerTop(held.panelId) : null;
      if (held && top !== null) {
        scroller.scrollTop = anchored({
          wanted: held.top,
          now: top,
          scrollTop: scroller.scrollTop,
          maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
        }).scrollTop;
      }
      return;
    }
    const now = held ? headerTop(held.panelId) : null;
    if (!held || now === null) return;
    const next = anchored({
      wanted: held.top,
      now,
      scrollTop: scroller?.scrollTop ?? 0,
      maxScrollTop: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
    });
    if (scroller) scroller.scrollTop = next.scrollTop;
    // Added to what is already there, and so taken back where a header that
    // had to be held down by room can now be held by scrolling.
    setRoom((room) => (Math.abs(room + next.shift) < 0.5 ? 0 : room + next.shift));
    // Once per collapse and once per opening, which is what `collapsed` changes
    // with; the room it reads is whatever the last of them left.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  /**
   * Picks a panel up. Nothing is sent; the board just starts drawing it moved.
   *
   * **The board takes the pointer**, rather than the header the grab happened
   * on. A panel that joins another row is drawn under a different parent, so
   * React remounts it and a capture held on that header dies with the node -
   * the drag answered its first move and then went deaf. This element is the
   * one thing on screen that no rearrangement can unmount.
   */
  const pickUp = (panelId: string, pointerId: number, whole = false) => {
    anchorOn(panelId);
    command.reset();
    setRenaming(null);
    setDeleting(null);
    setMovingPanel(null);
    setFiltering(null);
    draggingNow.current = panelId;
    draggingRowNow.current = whole;
    setDragging({ id: panelId, row: whole, from: shown, preview: shown });
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
    pointerAt.current = point;
    if (draggingRowNow.current) {
      // A row is placed by the pointer's height alone, among the rows as drawn.
      const place = rowPlacementFor(point.y, rowsOnScreen(), inHand);
      if (place === null) return;
      setDragging((held) => {
        if (!held) return held;
        const preview = arrangedWithRow(held.from, held.id, place);
        return sameArrangement(preview, held.preview) ? held : { ...held, preview };
      });
      return;
    }
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

  /**
   * Dropped. A drag that ends where it started asks for nothing - unless it
   * ends on another dashboard's tab, which asks for a move instead of an
   * arrangement ("Move a panel to another dashboard, from its menu or by
   * dragging it onto a tab", issue 439). Checked before the arrangement below,
   * so the panel is not also asked to rearrange the board it is leaving on
   * its way out.
   *
   * **Guarded by the ref, checked and cleared first.** The pointer is
   * captured on the board itself (`pickUp`), which is also listening for
   * `pointerup` on `window` for a release outside it (below) - so a release
   * *inside* the board reaches both listeners for the one event, and without
   * this a single drop would ask for the move twice. The arrangement path
   * below already happened to swallow a second call through `propose`'s own
   * dedup against `sent.current`; the move does not have an equivalent, so a
   * duplicate here would send two commands rather than silently repeat one.
   */
  const letGo = (point: { x: number; y: number }) => {
    if (!draggingNow.current) return;
    draggingNow.current = null;
    const held = dragging;
    if (held) anchorOn(held.id);
    setDragging(null);
    if (!held) return;
    // A row has no other dashboard to be sent to: only a Panel does.
    const droppedOnDashboard = held.row ? null : dashboardTabAt(point, tabsOnScreen(), dashboard.id);
    if (droppedOnDashboard) {
      movePanelToDashboard(held.id, droppedOnDashboard);
      return;
    }
    if (sameArrangement(held.preview, held.from)) return;
    propose(held.preview);
  };

  /** A drag abandoned rather than dropped: the panels go back and nothing is sent. */
  const abandon = () => {
    if (draggingNow.current) anchorOn(draggingNow.current);
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
    const onUp = (event: PointerEvent) => letGo({ x: event.clientX, y: event.clientY });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', abandon);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', abandon);
      window.removeEventListener('keydown', onKey);
    };
    // `letGo` and `abandon` are rebuilt every render; what decides whether
    // they are listening is the drag, and re-subscribing on every render of a
    // board holding a drag would be a listener swapped per pointer move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  /**
   * **The dashboard scrolls under a panel drag held near its edge** ("Scroll
   * the dashboard or a panel while dragging near its edge", issue 524), and the
   * drawing follows: a still pointer fires no move, so each scroll re-reads the
   * arrangement at the same point over the page as it now is.
   */
  useEffect(() => {
    if (!dragging) return;
    pointerAt.current = null;
    return scrollWhileDragging({
      dragging: 'panel',
      point: () => pointerAt.current,
      afterScroll: () => {
        if (pointerAt.current) dragTo(pointerAt.current);
      },
    });
    // Once per drag: `dragTo` is rebuilt every render and reads only refs and
    // the setter form of the drag's state, so an older one still answers right.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging === null]);

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

  /**
   * What a Filter shows, saved whole ("Add a Filter panel that shows every
   * filed item due in a window", issue 463).
   *
   * Closed only once it lands, the way the rename is: a refusal leaves the
   * question up with the rows still in it rather than losing what was chosen.
   */
  const setFilter = (
    panelId: string,
    conditions: FilterCondition[],
    match: FilterMatch,
    groupBy: FilterGrouping,
  ) => {
    command.mutate(
      {
        name: 'set_panel_filter',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          panelId,
          conditions,
          match,
          groupBy,
        },
      },
      { onSuccess: () => setFiltering(null) },
    );
  };

  /**
   * How a Panel of items is sorted, saved whole, or null for Manual ("Sort a
   * panel of items by the fields you choose", issue 526). Closed only once it
   * lands, for the reason the Filter's is.
   */
  const setSort = (panelId: string, sort: PanelSort | null) => {
    command.mutate(
      {
        name: 'set_panel_sort',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          panelId,
          sort,
        },
      },
      { onSuccess: () => setSorting(null) },
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

  /**
   * Sends a panel to another dashboard - from the picker, or from a drag
   * dropped on that dashboard's tab. The server puts it into every layout of
   * the target itself and renames it if the target already has one going by
   * its name (command-service.ts), so this asks nothing but where it is
   * going.
   */
  const movePanelToDashboard = (panelId: string, targetDashboardId: string) => {
    command.mutate(
      {
        name: 'move_panel_to_dashboard',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          panelId,
          dashboardId: targetDashboardId,
        },
      },
      { onSuccess: () => setMovingPanel(null) },
    );
  };

  /**
   * The dashboard tabs on the page right now, so a drop can ask which one the
   * pointer let go over. Global rather than scoped to this board's own
   * subtree, because the tabs are the shell's (`DashboardBar.tsx`) and this
   * board's DOM does not contain them - the same reason `rowsOnScreen`
   * measures the board's own rows off `data-panel-row` rather than off state.
   */
  const tabsOnScreen = (): TabRect[] =>
    [...document.querySelectorAll<HTMLElement>('[data-dashboard-tab-id]')].map((tab) => {
      const box = tab.getBoundingClientRect();
      return {
        dashboardId: tab.getAttribute('data-dashboard-tab-id') ?? '',
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      };
    });

  return (
    <div ref={measure} className="flex min-w-0 flex-col">
      {/* The name, for whoever is not looking at the screen. It used to be a
          heading here as well as the tab above, which said the same thing
          twice a centimetre apart ("Modernise the app shell", issue 125) -
          and the tab is the one that says *which of several*, so the tab is
          the one that stays. */}
      <h2 className="sr-only">{dashboard.name}</h2>
      <DashboardFilterBar dashboardId={dashboard.id} panelsHidden={hiddenCount} />
      {filteringOn && (
        <p className="sr-only" role="status">
          This dashboard is filtered
          {hiddenCount > 0 && `, ${hiddenCount === 1 ? '1 panel' : `${hiddenCount} panels`} hidden`}
        </p>
      )}

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
          onPointerUp={(event) => letGo({ x: event.clientX, y: event.clientY })}
          // The browser taking it back - a touch that became a scroll, the
          // window losing focus. The panels go back where they were.
          onPointerCancel={abandon}
          style={room !== 0 ? { marginTop: room } : undefined}
          className="flex min-w-0 flex-col"
        >
          {drawn.map(({ row, place: rowIndex }) => {
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
                  sizes={!arrangeable || rowIndex === 0 ? null : rowIndex - 1}
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
                    height: filteringOn || collapsed ? undefined : (row.height ?? undefined),
                    minHeight: filteringOn || collapsed ? undefined : MIN_ROW_HEIGHT,
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
                    position: 'relative',
                  }}
                >
                  {arrangeable && dragging === null && !itemInHand && row.cells[0] && (
                    <RowGrip onPickUp={(pointerId) => pickUp(row.cells[0]!.panelId, pointerId, true)} />
                  )}
                  {row.cells.map((cell, at) => {
                    const panel = panels.find((one) => one.id === cell.panelId);
                    if (!panel) return null;
                    return (
                      <Fragment key={panel.id}>
                        {at > 0 && !arrangeable && <div aria-hidden="true" />}
                        {at > 0 && arrangeable && (
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
                          dashboardFiltered={filteringOn}
                          items={shows.get(panel.id) ?? []}
                          groups={groupsOf(panel)}
                          itemTypes={itemTypes}
                          panelsInWorkspace={panelsInWorkspace}
                          renaming={renaming?.id === panel.id ? renaming.name : null}
                          onRenamingChange={(name) => setRenaming({ id: panel.id, name })}
                          onStartRenaming={() => {
                            command.reset();
                            setDeleting(null);
                            setMovingPanel(null);
                            setFiltering(null);
                            setSorting(null);
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
                            setMovingPanel(null);
                            setFiltering(null);
                            setSorting(null);
                            askedFrom.current = openedFrom;
                            setDeleting(panel.id);
                          }}
                          canMoveToAnotherDashboard={otherDashboards.length > 0}
                          onMoveToAnotherDashboard={(openedFrom) => {
                            command.reset();
                            setRenaming(null);
                            setDeleting(null);
                            setFiltering(null);
                            setSorting(null);
                            askedFrom.current = openedFrom;
                            setMovingPanel(panel.id);
                          }}
                          onReadOnlyChange={(readOnly) => setReadOnly(panel.id, readOnly)}
                          onFormatChange={(format) => setFormat(panel.id, format)}
                          onFilter={(openedFrom) => {
                            command.reset();
                            setRenaming(null);
                            setDeleting(null);
                            setMovingPanel(null);
                            setSorting(null);
                            askedFrom.current = openedFrom;
                            setFiltering(panel.id);
                          }}
                          onSort={(openedFrom) => {
                            command.reset();
                            setRenaming(null);
                            setDeleting(null);
                            setMovingPanel(null);
                            setFiltering(null);
                            askedFrom.current = openedFrom;
                            setSorting(panel.id);
                          }}
                          lifted={
                            dragging?.row
                              ? row.cells.some((one) => one.panelId === dragging.id)
                              : dragging?.id === panel.id
                          }
                          collapsed={collapsed}
                          onTap={phone ? (at) => tappedHeader(panel.id, at) : null}
                          onPickUp={arrangeable ? (pointerId) => pickUp(panel.id, pointerId) : null}
                          refusal={
                            refusalFor('rename_panel', panel.id) ??
                            refusalFor('delete_panel', panel.id) ??
                            refusalFor('set_panel_read_only', panel.id) ??
                            refusalFor('set_panel_format', panel.id) ??
                            refusalFor('move_panel_to_dashboard', panel.id) ??
                            // Only where the question is shut: while it is
                            // open it says its own, which is where somebody
                            // looking at it would read it.
                            (filtering === panel.id
                              ? null
                              : refusalFor('set_panel_filter', panel.id)) ??
                            (sorting === panel.id ? null : refusalFor('set_panel_sort', panel.id))
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
          {filteringOn && drawn.length === 0 && (
            <section className="well px-4 py-14 text-center">
              <p className="mx-auto max-w-md text-sm text-ink-faint">
                No panel has an item matching the filter.
              </p>
            </section>
          )}
          {/* The gap under the last row, so a panel can be dropped below
              everything rather than only between two things - and, being under
              a row, the line that sets that row's height. */}
          <RowSeam
            dragging={dragging !== null}
            sizes={arrangeable && shown.length ? shown.length - 1 : null}
            onTake={takeLine}
            onMove={lineTo}
            onLetGo={letGoOfLine}
            onFitToContents={fitRowToContents}
          />
        </div>
      )}

      {beingFiltered && (
        // No fallback: the chunk is small, and there is nothing on screen yet
        // for a placeholder to stand in for - the dialog itself is the first
        // thing this ever draws, the same reason DescriptionBox.tsx's own
        // `Arriving` has no counterpart here.
        <WhateverTheQuestionDoes onFailure={() => setFiltering(null)}>
          <Suspense fallback={null}>
            <FilterQuestion
              // Keyed on the Panel, so the rows it opens on are that Panel's: the
              // question reads what is stored once and is the person's from then
              // on (`FilterQuestion`), which only holds while one Filter cannot
              // hand its half-finished rows to the next.
              key={beingFiltered.id}
              open
              panelName={beingFiltered.name}
              conditions={(beingFiltered.filter ?? NO_CONDITIONS).conditions}
              match={(beingFiltered.filter ?? NO_CONDITIONS).match}
              groupBy={(beingFiltered.filter ?? NO_CONDITIONS).groupBy}
              itemTypes={itemTypes}
              panels={panelsInWorkspace}
              onSave={(conditions, match, groupBy) => setFilter(beingFiltered.id, conditions, match, groupBy)}
              onCancel={() => {
                setFiltering(null);
                command.reset();
              }}
              refusal={refusalFor('set_panel_filter', beingFiltered.id)}
              busy={command.isPending}
              returnFocusTo={askedFrom.current}
            />
          </Suspense>
        </WhateverTheQuestionDoes>
      )}

      {beingSorted && (
        <WhateverTheQuestionDoes onFailure={() => setSorting(null)}>
          <Suspense fallback={null}>
            <SortQuestion
              // Keyed on the Panel, for the reason the Filter question is.
              key={beingSorted.id}
              open
              panelName={beingSorted.name}
              // A Filter nobody has sorted opens on what it goes by, and has no
              // Manual to go back to.
              sort={
                panelGathers(beingSorted)
                  ? (sortOf(beingSorted) ?? DEFAULT_FILTER_SORT)
                  : sortOf(beingSorted)
              }
              canBeManual={!panelGathers(beingSorted)}
              onSave={(sort) => setSort(beingSorted.id, sort)}
              onCancel={() => {
                setSorting(null);
                command.reset();
              }}
              refusal={refusalFor('set_panel_sort', beingSorted.id)}
              busy={command.isPending}
              returnFocusTo={askedFrom.current}
            />
          </Suspense>
        </WhateverTheQuestionDoes>
      )}

      {beingDeleted && (
        <DeleteQuestion
          open
          // What goes with it, which for a panel of text is the text and for
          // every panel is any live Filter that would be left showing less
          // (the Deleting rule - "naming what is going and what goes with
          // it"; "Filter a Filter panel by panel, and name the Filters a
          // panel's deletion affects", issue 465).
          question={deletePanelQuestion(beingDeleted, panelsInWorkspace)}
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

      {beingMoved && (
        <MovePanelToDashboardPicker
          open

          panelName={beingMoved.name}
          dashboards={otherDashboards}
          refusal={refusalFor('move_panel_to_dashboard', beingMoved.id)}
          busy={command.isPending}
          returnFocusTo={askedFrom.current}
          onCancel={() => {
            setMovingPanel(null);
            command.reset();
          }}
          onPick={(dashboardId) => movePanelToDashboard(beingMoved.id, dashboardId)}
        />
      )}
    </div>
  );
}

/**
 * What deleting this Panel takes with it, said before it happens - the text in
 * it, for a panel of text ("Ask before deleting in a dialog, from the row's
 * own menu", issue 116's own "naming what is going and what goes with it"
 * rule), and every live Filter of the Workspace that looks at it ("Filter a
 * Filter panel by panel, and name the Filters a panel's deletion affects",
 * issue 465).
 *
 * **Named rather than counted**, unlike `ManageTypes.tsx`'s own delete
 * question: a Filter is a handful at most, kept on a dashboard somebody
 * built, and "2 filters" gives nobody enough to decide whether deleting is
 * fine. **Which will be left showing nothing is said explicitly** - a Filter
 * still holding another live Panel goes on working, and one left with none is
 * about to go quiet, which is the one distinction that matters here.
 */
function deletePanelQuestion(panel: Panel, panelsInWorkspace: readonly Panel[]): string {
  const goesWith = panelHoldsText(panel)
    ? 'The text in it goes too, and it goes from every layout of this dashboard.'
    : 'It goes from every layout of this dashboard.';
  const affected = filtersUsingPanel(panel.id, panelsInWorkspace);
  if (affected.length === 0) return `Delete ${panel.name}? ${goesWith}`;
  const uses = affected.length === 1 ? 'uses' : 'use';
  const names = joinedBy(
    affected.map((one) => one.filter.name),
    'and',
  );
  const emptied = affected.filter((one) => one.leftEmpty).map((one) => one.filter.name);
  const emptyClause =
    emptied.length > 0 ? ` ${joinedBy(emptied, 'and')} will then show nothing.` : '';
  return `Delete ${panel.name}? ${goesWith} ${names} ${uses} it as a Panel condition.${emptyClause}`;
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
      // No transition on the height: the board anchors the grabbed header the
      // moment it collapses (`anchored`), and a seam still growing then would
      // carry it away from the pointer by the growth after it was placed.
      className="shrink-0"
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
 * The strip at a row's left edge that takes the whole row by hand.
 *
 * **Drawn only while the pointer is on the strip itself**: a row that lit up
 * under the pointer anywhere would be a highlight charged to every glance at
 * the board, for a gesture used rarely. Mouse and primary button only, as a
 * Panel's header is - a touch has no drag to start here, and a right-click is
 * the menu's.
 */
function RowGrip({ onPickUp }: { onPickUp: (pointerId: number) => void }) {
  return (
    <div
      data-testid="row-grip"
      aria-hidden="true"
      onPointerDown={(event) => {
        if (event.button !== 0 || event.pointerType !== 'mouse') return;
        // Otherwise the browser starts a text selection across whatever the
        // drag passes over.
        event.preventDefault();
        onPickUp(event.pointerId);
      }}
      className="group absolute inset-y-0 left-0 z-10 w-3 cursor-grab touch-none active:cursor-grabbing"
    >
      <div className="absolute inset-y-1 left-0.5 w-1 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-60 group-active:opacity-100" />
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
