import { Fragment, Suspense, lazy, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  agentsShownOnDashboard,
  itemLabel,
  uuidv7,
  workspaceIsDecided,
  type Agent,
  type Item,
} from '@cockpit/shared';
import {
  snapshotQuery,
  useCommand,
  useLatestSnapshot,
  useSendCommand,
  useStartAgent,
  workspacesQuery,
} from '../api/queries';
import { CommandRefused } from '../api/client';
import { itemsThatMayBeDuplicates, possibleDuplicatesOf } from '../duplicates';
import { ITEM_BEING_DRAGGED, placeAfterMoving, placeAmongHeld, whereItWouldLand } from '../dropAt';
import { itemInTheAir, panelLiftedFrom } from '../itemInTheAir';
import {
  filedOrderOnPanel,
  filingsThatFile,
  itemsOnPanel,
  orderPuttingBack,
  ordersForFilingSeveral,
  orderWithItemAt,
} from '../filing';
import { alsoShownOn, dayOf, panelAndFilterIdsByItem } from '../filters';
import type { FilterGroup } from '../filterGroups';
import { useFilteredDashboardIds } from '../dashboardFilter';
import { useOpenItem } from '../itemForm';
import { browserStore } from '../lastVisited';
import { recentPanelsIn, rememberRecentPanel } from '../recentPanels';
import {
  afterClicking,
  dashboardScope,
  endSelection,
  inboxScope,
  pickedInTheList,
  updateSelection,
  useHeldTo,
  useSelection,
  useShowing,
  type Selection,
} from '../selection';
import { useUndo } from '../undo';
import { ItemRow } from './ItemRow';
import { typeOf } from '../itemTypes';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';
import { SelectionBar } from './SelectionBar';
import { FetchedPicker } from './FetchedPicker';
import { useEditingSeveral } from './useEditingSeveral';
import { useFilingSeveral } from './useFilingSeveral';

/** Move or add, asked of a drop between panels - fetched only once a drop asks it, for the same reason. */
const MoveOrAddQuestion = lazy(() => import('./MoveOrAddQuestion'));

/**
 * A list of items, in the Inbox or on a panel, and the one way to move one out
 * of it ("Panels hold the items filed into them, and the Inbox holds the rest",
 * issue 36).
 *
 * **One picker per list rather than one per row.** Every row offers *Move to…*,
 * and a dialog mounted under each of them would be twelve dialogs in an Inbox
 * of twelve. Which row asked is state here; the dialog is one.
 *
 * **It reads the snapshot itself** for what the picker offers - the workspace's
 * dashboards, its panels, and what is already on the panel being moved to. That
 * is the same cached read the page around it is already doing (architecture,
 * "The read model: persisted snapshot, revalidate, push"), and asking for it
 * here rather than threading four more props through the board is what keeps a
 * panel able to draw a list without knowing about workspaces.
 *
 * **Where a moved item lands is decided here, not by the server**: at the top
 * of the panel it is moved to. A menu move says which panel and nothing about
 * where in it, and the top is where you can see what you just did. Dropping one
 * at a chosen place is a later gesture, and it is the same command with a
 * different order in it.
 */
export function ItemList({
  workspaceId,
  items,
  openDashboardId,
  panelId = null,
  gathered = false,
  hidden = false,
  sorted = false,
  groups,
  /** What the list says when it holds nothing. */
  emptyMessage,
  fillsTheRestOfItsColumn = false,
}: {
  workspaceId: string;
  items: readonly Item[];
  /** The dashboard being looked at, which the picker offers first. Null in the Inbox. */
  openDashboardId: string | null;
  /**
   * The panel this list is the contents of, or null for the Inbox.
   *
   * It is what a row dropped here is filed onto, and what says whether the list
   * has an order at all: the Inbox is by age, so a drop there is a move with no
   * place in it.
   */
  panelId?: string | null;
  /**
   * That these rows were gathered by a rule rather than filed here, which is
   * what a Filter's list is ("Add a Filter panel that shows every filed item
   * due in a window", issue 463).
   *
   * Three things follow, and all three are about the rows not being this
   * panel's to arrange: nothing may be dropped here, no row is reordered, and
   * none offers *Remove from this panel* - a row's place on a Filter is a
   * consequence of the Item, not a filing anybody made.
   */
  gathered?: boolean;
  /**
   * That the list is mounted but not on screen - a Panel collapsed on a phone.
   * Its rows stay known to the selection, which keeps what was picked, but
   * *Select all items* does not pick them: the rows shown are what it picks.
   */
  hidden?: boolean;
  /**
   * That the Panel draws these rows by a sort rather than in the order you set
   * ("Sort a panel of items by the fields you choose", issue 526). A row of its
   * own cannot be dragged to a new place in it - the pointer says no and no
   * line is drawn - while an Item from elsewhere is still filed onto it, at the
   * top of the order you set, and drawn where the sort puts it.
   */
  sorted?: boolean;
  /**
   * A gathered list's rows under a heading each, in the order given ("Group a
   * Filter panel's items by the Dashboard or Panel they are filed on", issue
   * 805). `items` is still the one distinct list - what is picked, counted and
   * kept in step with the snapshot - and this is only how it is drawn, so an
   * Item under two headings is one row picked in both.
   */
  groups?: readonly FilterGroup[] | undefined;
  emptyMessage: string;
  /**
   * That this list sits under other things in a column, and is to be as tall as
   * what they leave rather than as the whole column - the Inbox, under its
   * capture form. A list that is a Panel's whole contents keeps the default,
   * which is the whole of the box it is in.
   */
  fillsTheRestOfItsColumn?: boolean;
}) {
  const { data } = useQuery(snapshotQuery(workspaceId));
  const openItem = useOpenItem();
  // Every workspace, for the Inboxes the picker offers an item that belongs to
  // none of them. The same cached read the tabs above are already doing.
  const { data: allWorkspaces } = useQuery(workspacesQuery);
  // `?? []` for the reason the filings elsewhere carry one: a stored snapshot
  // can predate the field, and a row with no type is drawn rather than hidden.
  // Memoized so it stays one reference across renders - otherwise every
  // render invalidates `alsoInByItem` below, since `?? []` makes a fresh
  // array whenever `itemTypes` itself is absent.
  const types = useMemo(() => data?.itemTypes ?? [], [data?.itemTypes]);
  /**
   * The filings that file - the one reading this list asks whenever it needs to
   * know whether an Item is in the Inbox, so the four places below cannot come
   * to different answers about the same row ("Add a Filter panel that shows
   * every filed item due in a window", issue 463).
   */
  const filed = useMemo(
    () => filingsThatFile(data?.filings ?? [], data?.panels ?? []),
    [data?.filings, data?.panels],
  );
  /** The day it is where this person is looking, for a Filter's own Due condition - read once for the whole list, the same reason `PanelBoard.tsx`'s own `today` is. */
  const today = dayOf(new Date());
  /**
   * Every live Panel or Filter each Item of the workspace shows on - what
   * "also in Today, Q3 goals" reads off, after a row's own title ("Say which
   * other panels an item is also in, after its title", issue 466).
   *
   * Memoized on the snapshot for the reason `flagged` below already is: a
   * dashboard draws one `ItemList` per Panel, and working this out per row
   * would mean scanning every Filter against every Item once for every row
   * that Filter's own Panel draws.
   */
  const alsoInByItem = useMemo(
    () =>
      panelAndFilterIdsByItem(data?.items ?? [], data?.filings ?? [], data?.panels ?? [], types, today),
    [data?.items, data?.filings, data?.panels, types, today],
  );
  /**
   * The Agents a row here can be started with ("Drop an agent on an item to
   * start a Claude Code session on it", issue 571): the ones the open
   * Dashboard shows, and none without a Claude Code connection to start them
   * through. Null in the Inbox, whose rows take no Agent at all.
   */
  const offeredAgents = useMemo(() => {
    if (panelId === null || openDashboardId === null) return null;
    if (!data?.hasClaudeCodeConnection) return [];
    return agentsShownOnDashboard({
      agents: data.agents,
      hiddenAgentIds: data.hiddenAgents
        .filter((hidden) => hidden.dashboardId === openDashboardId)
        .map((hidden) => hidden.agentId),
    });
  }, [panelId, openDashboardId, data?.hasClaudeCodeConnection, data?.agents, data?.hiddenAgents]);
  /** Each Item's open run, looked up once for the list rather than searched per row. */
  const runsByItem = useMemo(
    () => new Map((data?.agentRuns ?? []).map((run) => [run.itemId, run])),
    [data?.agentRuns],
  );
  const startAgent = useStartAgent(workspaceId);
  const command = useCommand();
  const send = useSendCommand();
  const latestSnapshot = useLatestSnapshot();
  const offerToUndo = useUndo();
  const navigate = useNavigate();
  const [moving, setMoving] = useState<Item | null>(null);
  /** The item being added to a second panel from its menu, if any. */
  const [adding, setAdding] = useState<Item | null>(null);
  const openedFrom = useRef<HTMLElement | null>(null);

  /**
   * The rows picked out of this list's scope ("Select several items…", issue
   * 169; "Select across every panel of a dashboard", issue 863): every Panel of
   * a Dashboard shares one, and the Inbox has one of its own.
   */
  const scope =
    panelId !== null && openDashboardId !== null
      ? dashboardScope(openDashboardId)
      : inboxScope(workspaceId);
  const onDashboard = panelId !== null && openDashboardId !== null;
  /** The Panel the rows here are filed on, which a move from one of them leaves: none in the Inbox or on a Filter. */
  const rowPanel = panelId !== null && !gathered ? panelId : null;
  const selection = useSelection(scope);
  const setSelection = (update: Selection | ((was: Selection) => Selection)) =>
    updateSelection(scope, typeof update === 'function' ? update : () => update);
  /** Everything a selection put on screen, gone together. */
  const stopSelecting = () => endSelection(scope);

  /** The picked rows this list shows, in the order it shows them. */
  const picked = pickedInTheList(selection, items);

  // Says what this list shows, so the scope can drop what none of its lists
  // show any more - **dropped, not merely hidden**, or a row moved out from its
  // own menu and put back by an undo would return already ticked, with the next
  // Move to… quietly carrying an item nobody had picked. A Dashboard's own bar
  // does the dropping across all its Panels; the Inbox's list is the only one
  // there is, so it does its own.
  const shownIds = useMemo(() => items.map((item) => item.id), [items]);
  useShowing(scope, shownIds, hidden);
  useHeldTo(onDashboard ? null : scope);

  const filingSeveral = useFilingSeveral({ workspaceId, openDashboardId, scope, picked });
  const editing = useEditingSeveral({ workspaceId, picked, filing: filingSeveral.filing });
  const { whereItIs, showOnItsPanel, nameOf, addPanelFor, filteredDashboardIds } = filingSeveral;

  /**
   * Puts an item back on every panel it was on, in the order each was in.
   *
   * **The first is a move and the rest are adds**, which is what makes this one
   * inverse rather than two: the move takes it off wherever it is now and puts
   * it on the first, and each add puts it on one more without disturbing that.
   * An item that was on no panel at all is moved to the Inbox, which is the
   * absence of a filing.
   */
  const putItBackOn = async (item: Item, panels: { panelId: string; order: string[] }[]) => {
    const envelope = () => ({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId,
      itemId: item.id,
    });
    const [first, ...rest] = panels;
    await send({
      name: 'move_item_to_panel',
      payload: { ...envelope(), panelId: first?.panelId ?? null, order: first?.order ?? [] },
    });
    for (const also of rest) {
      await send({
        name: 'add_item_to_panel',
        payload: { ...envelope(), panelId: also.panelId, order: also.order },
      });
    }
  };

  /**
   * Files an item, at a place counted among the rows the target panel *draws*.
   *
   * Drawn rather than held, because that is what every caller has: a menu move
   * knows which row it is, and a drop knows which gap it was let go over. The
   * mapping to the order the panel holds is `placeAmongHeld`, and it is not the
   * same list - a filing outlives its item being finished.
   */
  const move = (
    item: Item,
    panelId: string | null,
    atAmongDrawn = 0,
    intoWorkspace?: string,
    /**
     * The Panel it is moved from, the only one it comes off. Absent takes it off
     * every Panel, which is what a move from the Inbox and an undo mean
     * (issue 923).
     */
    leaving?: string,
  ) => {
    const before = whereItIs(item);
    // Which workspace the move is made in - this one, unless the picker chose
    // another workspace's Inbox for an item that belongs to none ("Capture
    // something before you know which workspace it belongs to", issue 165).
    const inWorkspace = intoWorkspace ?? workspaceId;
    /**
     * That this move is also what decides where the item belongs, which is what
     * makes it irreversible: an item belonging to no workspace is a question,
     * and once answered there is no putting the question back.
     *
     * **So no way back is offered for it**, rather than one that would quietly
     * do less than it says. Undoing the filing would take the item off the
     * panel and leave it in this workspace's Inbox alone, not back in every
     * workspace's - and an offer that restores something other than what was
     * there is worse than no offer ("Undo what just happened", issue 144).
     */
    const decides = !workspaceIsDecided(item);
    // The order the target panel is in afterwards, which is what the command
    // carries: a whole arrangement rather than a position, so two moves
    // arriving out of turn cannot compose into an order nobody asked for. The
    // Inbox has no order - it is by age - so moving there sends none.
    //
    // Built from what the panel *holds* rather than from what it draws: a
    // filing outlives its item being finished, and an order that left those out
    // would be refused by a panel that has ever held one.
    const order =
      panelId === null
        ? []
        : (() => {
            const held = filedOrderOnPanel(data?.filings ?? [], panelId);
            const drawn = itemsOnPanel(data?.items ?? [], data?.filings ?? [], panelId).map((i) => i.id);
            return orderWithItemAt(held, item.id, placeAmongHeld(held, drawn, item.id, atAmongDrawn));
          })();

    command.mutate(
      {
        name: 'move_item_to_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: inWorkspace,
          itemId: item.id,
          panelId,
          order,
          ...(leaving && panelId !== null ? { fromPanelIds: [leaving] } : {}),
        },
      },
      {
        onSuccess: () => {
          // Remembered only once it has happened: a panel a move was refused
          // for is not a panel you have been filing into.
          if (panelId) rememberRecentPanel(browserStore(), workspaceId, panelId);
          setMoving(null);
          setAsking(null);
          // An undecided item moved to a workspace's Inbox has nothing to
          // offer: nothing to put back, and nowhere to show.
          if (decides && panelId === null) return;
          offerToUndo({
            what: `“${itemLabel(item)}” moved to ${nameOf(panelId)}`,
            // The title is what the bar shortens, never where it went.
            split: { title: `“${itemLabel(item)}”`, rest: ` moved to ${nameOf(panelId)}` },
            // Every panel it was on, not the first of them: the move above may
            // have taken it off one, and the undo sends no Panel to leave, which
            // takes it off everything before putting it back on each (issue
            // 142, issue 923). **Withheld for
            // an undecided item**, whose move decides its workspace and cannot
            // be put back (`decides` above); it still gets the two below.
            ...(decides ? {} : { undo: () => putItBackOn(item, before) }),
            // Onto a panel only: a move to the Inbox has nowhere to show and
            // nothing to also show on ("Show and Also show on… in the undo
            // bar after moving an Item", issue 849).
            ...(panelId
              ? {
                  show: () => void showOnItsPanel([item.id], panelId),
                  alsoShowOn: () => {
                    openedFrom.current = null;
                    command.reset();
                    setAdding(item);
                  },
                }
              : {}),
          });
        },
      },
    );
  };

  /**
   * Which of this workspace's Items may be saying what another one already
   * said ("Flag a captured note that says what another one already said", issue
   * 407; extended in issue 410 to include filed Items). Every Panel's list needs
   * this now, not just the Inbox's, so it is memoized on the snapshot rather
   * than recomputed on every one of a dashboard's several `ItemList`s on every
   * render.
   */
  const flagged = useMemo(
    // Which items are in the Inbox is half of the rule a pair is offered by,
    // and a filing onto a Filter leaves an item there (`filed` above).
    () => itemsThatMayBeDuplicates(data?.items ?? [], filed, data?.duplicates ?? []),
    [data?.items, filed, data?.duplicates],
  );

  /**
   * The proposal an Item's row draws as a chip, resolved to the Panel's live
   * name and its Dashboard's - the display half of "Propose where a captured
   * note belongs, without filing it there" (issue 298).
   *
   * **One function, not two kept in step by convention.** `acceptRoutingFor`
   * below reads this rather than `item.proposedPanelId` directly, so there is
   * exactly one place that decides a proposal is still good - a chip that
   * would not be drawn can never be taken either.
   *
   * A proposed id the snapshot's own panels, or the Dashboard they sit on, no
   * longer hold - deleted since it was written - reads as no proposal here, the same way the store itself
   * would refuse to write it fresh; this is only the display catching up to a
   * `proposedPanelId` that has gone stale. A Panel flagged Never propose reads
   * the same way ("Keep a Panel out of proposals with Never propose", issue
   * 848): the stored proposal stays until the next refresh overwrites it, and
   * clearing the flag draws the chip again.
   */
  const routingProposalFor = (
    item: Item,
  ): { dashboardName: string; panelName: string; reason: string } | undefined => {
    if (!item.proposedPanelId) return undefined;
    const panel = data?.panels.find((p) => p.id === item.proposedPanelId && !p.neverPropose);
    const dashboard = data?.dashboards.find((d) => d.id === panel?.dashboardId);
    return panel && dashboard
      ? { dashboardName: dashboard.name, panelName: panel.name, reason: item.proposedPanelReason ?? '' }
      : undefined;
  };

  /**
   * Taking a proposal - the same filing `onMoveHere` above already makes for
   * "the one you are looking at": `move` directly, with the Panel proposed
   * rather than asked for, so accepting a chip and picking the same Panel by
   * hand are one call and land the Item the same way.
   */
  const acceptRoutingFor = (item: Item): (() => void) | undefined => {
    if (!routingProposalFor(item)) return undefined;
    const panelId = item.proposedPanelId!;
    return () => move(item, panelId, 0);
  };

  /**
   * Settles every pair this row is currently flagged in as not a duplicate,
   * in one go ("Say a flagged pair is not a duplicate", issue 408).
   *
   * **The row asks for all of it at once because it knows none of it** - which
   * pair, or how many, waits until the form is opened, exactly as the mark
   * itself does (`mayBeADuplicate`, ItemRow.tsx). The common case is one pair,
   * so this is ordinarily indistinguishable from settling the one; where there
   * is more than one, this is the quick way to clear the row, and the form is
   * still where a single pair among several is settled on its own.
   *
   * **`possibleDuplicatesOf`, not the raw pairs `data.duplicates` carries.**
   * The mark this menu entry is offered from is `mayBeADuplicate`, which comes
   * from `itemsThatMayBeDuplicates` - the same asymmetric rule, so this only
   * ever settles a pair the row actually showed. Settling one it never drew
   * would be settling something nobody was ever asked about.
   */
  const settleNotADuplicateFor = (item: Item): (() => void) | undefined => {
    const others = possibleDuplicatesOf(
      item.id,
      data?.items ?? [],
      // The same reading `flagged` above is built from, so this settles only
      // what that mark actually offered.
      filed,
      data?.duplicates ?? [],
    ).map((other) => other.id);
    if (others.length === 0) return undefined;
    return () => {
      const envelopeWith = (otherItemId: string, settled: boolean) => ({
        name: 'set_duplicate_settled' as const,
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          itemId: item.id,
          otherItemId,
          settled,
        },
      });
      // `allSettled`, not `all`: several pairs are independent commands, and
      // one being refused (the other note dismissed a moment earlier) must
      // not cost the offer to undo the ones that landed.
      Promise.allSettled(others.map((otherId) => send(envelopeWith(otherId, true)))).then(
        (results) => {
          const landed = others.filter((_, at) => results[at]!.status === 'fulfilled');
          for (const result of results) {
            if (result.status === 'rejected') console.error(result.reason);
          }
          if (landed.length === 0) return;
          offerToUndo({
            what:
              landed.length === 1
                ? `"${itemLabel(item)}" is not a duplicate`
                : `"${itemLabel(item)}" is not a duplicate of ${landed.length} notes`,
            undo: () => Promise.all(landed.map((otherId) => send(envelopeWith(otherId, false)))),
          });
        },
      );
    };
  };

  /** The order this panel would be in with the item at this place among its rows. */
  const orderFor = (panelId: string, item: Item, atAmongDrawn: number) => {
    const held = filedOrderOnPanel(data?.filings ?? [], panelId);
    const drawn = itemsOnPanel(data?.items ?? [], data?.filings ?? [], panelId).map((i) => i.id);
    return orderWithItemAt(held, item.id, placeAmongHeld(held, drawn, item.id, atAmongDrawn));
  };

  /**
   * Somewhere else in the same panel.
   *
   * **`add_item_to_panel`, not `move_item_to_panel`, and that is the fix rather
   * than a preference.** A move takes the item off every panel before writing
   * the target's order, which is what a move means — so sending one to reorder
   * a row inside *this* panel silently took it off every other panel showing
   * it. Adding it to a panel it is already on writes that panel's order and
   * touches nothing else, which is exactly what a reorder is.
   */
  const reorder = (item: Item, panelId: string, atAmongDrawn: number) => {
    const before = filedOrderOnPanel(data?.filings ?? [], panelId);
    const order = orderFor(panelId, item, atAmongDrawn);
    if (order.join() === before.join()) return;

    command.mutate(
      {
        name: 'add_item_to_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          itemId: item.id,
          panelId,
          order,
        },
      },
      {
        onSuccess: () =>
          offerToUndo({
            what: `“${itemLabel(item)}” moved in ${nameOf(panelId)}`,
            undo: () =>
              send({
                name: 'add_item_to_panel',
                payload: {
                  commandId: uuidv7(),
                  issuedAt: new Date().toISOString(),
                  workspaceId,
                  itemId: item.id,
                  panelId,
                  order: before,
                },
              }),
          }),
      },
    );
  };

  /**
   * The same item on one more panel, leaving the panels it is on alone.
   *
   * Everything except the command is what a move does, including the undo -
   * whose inverse is simply taking it off again, since nothing else changed.
   */
  const add = (item: Item, panelId: string, atAmongDrawn: number) => {
    // Adding it where it already is changes nothing — and the undo would take
    // it off a panel it was legitimately on, which is worse than doing nothing.
    if ((data?.filings ?? []).some((f) => f.itemId === item.id && f.panelId === panelId)) {
      setAdding(null);
      setAsking(null);
      return;
    }
    const order = orderFor(panelId, item, atAmongDrawn);

    command.mutate(
      {
        name: 'add_item_to_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          itemId: item.id,
          panelId,
          order,
        },
      },
      {
        onSuccess: () => {
          rememberRecentPanel(browserStore(), workspaceId, panelId);
          setAsking(null);
          setAdding(null);
          offerToUndo({
            what: `“${itemLabel(item)}” added to ${nameOf(panelId)}`,
            undo: () =>
              send({
                name: 'remove_item_from_panel',
                payload: {
                  commandId: uuidv7(),
                  issuedAt: new Date().toISOString(),
                  workspaceId,
                  itemId: item.id,
                  panelId,
                },
              }),
          });
        },
      },
    );
  };

  /**
   * This panel stops showing the item; every other panel holding it carries on,
   * and one that was its only panel leaves it back in the Inbox.
   */
  const removeFromHere = (item: Item, panelId: string) => {
    const before = filedOrderOnPanel(data?.filings ?? [], panelId);
    command.mutate(
      {
        name: 'remove_item_from_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          itemId: item.id,
          panelId,
        },
      },
      {
        onSuccess: () =>
          offerToUndo({
            what: `“${itemLabel(item)}” removed from ${nameOf(panelId)}`,
            // Back on, in the order the panel was in - which still names it,
            // because that order was read before it was taken off.
            undo: () =>
              send({
                name: 'add_item_to_panel',
                payload: {
                  commandId: uuidv7(),
                  issuedAt: new Date().toISOString(),
                  workspaceId,
                  itemId: item.id,
                  panelId,
                  order: before,
                },
              }),
          }),
      },
    );
  };

  /** A tick clicked, which is a row picked or a span reached across. */
  const pick = (item: Item, withShift: boolean) => {
    setSelection((was) =>
      afterClicking(
        items.map((row) => row.id),
        was,
        item.id,
        withShift,
      ),
    );
  };

  /**
   * Which gap a dragged row is currently over, or null when nothing is being
   * dragged across this list. Drawn as a line between two rows.
   */
  const [landingAt, setLandingAt] = useState<number | null>(null);
  /**
   * A row let go over this panel that is on a panel already, waiting for the
   * answer to which of the two was meant ("Ask whether to move an item to a
   * panel or add it to one", issue 142).
   */
  const [asking, setAsking] = useState<{ item: Item; at: number; from: string | null } | null>(null);
  const rows = useRef<HTMLUListElement>(null);
  /**
   * That a sorted Panel already holds the row in the air, from whichever list
   * it was picked up in - which it takes no drop of, having no new place to
   * put it. An Item from elsewhere is still filed onto it.
   */
  const alreadyHeldWhileSorted = () => {
    const carried = itemInTheAir();
    if (!sorted || carried === null || !items.some((item) => item.id === carried)) return false;
    // One lifted from another Panel is asked, move or add, so it is taken.
    const from = panelLiftedFrom(carried);
    return from === null || from === panelId;
  };

  /**
   * The gap under the pointer, measured from the rows as they are drawn.
   *
   * Measured here rather than from the item list, because what a person is
   * aiming at is a place on the screen: a row that has scrolled, or one drawn
   * shorter than its neighbours, is where it looks like it is and not where an
   * index would put it.
   */
  const gapUnder = (y: number): number => {
    // The rows themselves, not the line drawn between them: a landing line is
    // a child of the same list, and counting it would move the midpoints under
    // the pointer as the line follows it about.
    const drawn = [...(rows.current?.querySelectorAll('[data-item-row]') ?? [])].map((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    return whereItWouldLand(drawn, y);
  };

  /**
   * A row let go over this list.
   *
   * The order sent is the panel's whole arrangement with the item put in the
   * gap it was dropped in - and `placeAfterMoving` is what makes a row dragged
   * *downwards* land where it was let go rather than one short, because taking
   * it out of its old place shifts every gap below that place up by one.
   */
  const drop = (event: React.DragEvent) => {
    const itemId = event.dataTransfer.getData(ITEM_BEING_DRAGGED);
    setLandingAt(null);
    if (!itemId) return;

    // Counted among the rows on the screen, which is where the pointer was, and
    // compared against the row's place among those same rows. The mapping into
    // the order the panel *holds* happens inside `move`.
    const drawn = items.map((item) => item.id);
    const wasAt = drawn.indexOf(itemId);
    // A sorted Panel has no place to aim at: a row already on it stays where
    // the sort puts it, and one arriving goes to the top of the order you set,
    // where a menu filing puts it too.
    // The Panel it was picked up from, when that is another one than this: a
    // row dropped on a Panel it is already on, from a different Panel, is not a
    // reorder but a move or an add, so it is asked (issue 923).
    const cameFrom = panelLiftedFrom(itemId);
    const fromAnotherPanel = panelId !== null && cameFrom !== null && cameFrom !== panelId;
    if (sorted && wasAt !== -1 && !fromAnotherPanel) return;
    const gap = sorted ? 0 : placeAfterMoving(gapUnder(event.clientY), wasAt === -1 ? null : wasAt);

    // Dropped exactly where it started changes nothing, and sending it would
    // put a change in the undo bar that undoes to the same place.
    if (panelId && wasAt !== -1 && !fromAnotherPanel && gap === wasAt) return;
    // The same, in the Inbox: a row dragged about inside it is already filed
    // nowhere, so moving it to the Inbox is a change that changes nothing -
    // and it would still offer to be undone, which is worse than doing nothing
    // at all.
    if (!panelId && !filed.some((filing) => filing.itemId === itemId)) return;


    const moving = items.find((item) => item.id === itemId) ?? data?.items.find((i) => i.id === itemId);
    if (!moving) return;

    // **Asked only when both answers are possible.** A row already on this
    // panel is being reordered; a row that is on no panel at all came from the
    // Inbox, and there is no answer that leaves it there - the Inbox is what is
    // filed nowhere. What is left is a row arriving from another panel, where
    // moving it and adding it are two different things somebody has to mean.
    // `filed` rather than every filing: a row the Inbox is drawing came from
    // the Inbox, whatever a filing onto a Filter says about it, and there is no
    // answer to "move or add" that would leave it there.
    const onAPanelAlready = filed.some((filing) => filing.itemId === itemId);
    if (panelId && (wasAt === -1 || fromAnotherPanel) && onAPanelAlready) {
      command.reset();
      setAsking({ item: moving, at: gap, from: cameFrom });
      return;
    }
    // Already on this panel: somewhere else in it, which is a reorder and must
    // leave the panels it is also on alone.
    if (panelId && wasAt !== -1) {
      reorder(moving, panelId, gap);
      return;
    }
    move(moving, panelId, gap);
  };

  // Only this list's own refusal, and only for the item still being moved: one
  // `useCommand` is shared by every row here, so without the second half a
  // refusal from a row that has since closed would appear against the next one.
  /**
   * Why the last change this list made did not happen.
   *
   * Gated on the change having been about an *item*, because one `useCommand`
   * is not one mutation: a panel's rename is refused by the board's, and
   * without this a list drawn inside that panel would say so as well - the
   * same refusal, twice, in two places.
   */
  const refusal =
    command.error instanceof CommandRefused &&
    (command.variables as { payload?: { itemId?: string } } | undefined)?.payload?.itemId
      ? command.error.message
      : null;

  /**
   * One row of the list. `alsoNotIn` is the Panel a grouped Filter's heading is,
   * which the row has no need to say it is also in ("Group a Filter panel's items
   * by the Dashboard or Panel they are filed on", issue 805).
   */
  const rowFor = (item: Item, alsoNotIn: string | null = null) => (
    <ItemRow
      item={item}
      itemType={typeOf(types, item)}
      workspaceId={workspaceId}
      inInbox={panelId === null}
      {...(rowPanel ? { liftedFrom: rowPanel } : {})}
      selecting={{
        picked: selection.picked.has(item.id),
        revealed: selection.picked.size > 0,
        onPick: (withShift) => pick(item, withShift),
        onEndSelection: stopSelecting,
      }}
      // Not on a Filter panel's row: its place is a consequence of the Item, so
      // there is no Panel to move it from (it keeps Also show on…).
      {...(gathered
        ? {}
        : {
            onMoveTo: (from: HTMLElement | null) => {
              openedFrom.current = from;
              command.reset();
              setMoving(item);
            },
          })}
      onOpen={() => openItem(item.id)}
      // The one you are looking at, which is the same move the
      // picker makes with this workspace's Inbox chosen - the row
      // decides whether to offer it at all.
      onMoveHere={() => move(item, null, 0, workspaceId)}
      alsoIn={alsoShownOn(item.id, alsoInByItem, data?.panels ?? [], panelId, alsoNotIn)}
      mayBeADuplicate={flagged.has(item.id)}
      onSettleNotADuplicate={flagged.has(item.id)
        ? settleNotADuplicateFor(item)
        : undefined}
      {...(panelId
        ? {
            onAddTo: (from: HTMLElement | null) => {
              openedFrom.current = from;
              command.reset();
              setAdding(item);
            },
            // Nothing to remove from a panel the row was never
            // filed onto: what would take it off a Filter is the
            // Item ceasing to match, or leaving the panel it
            // really is filed on.
            ...(gathered ? {} : { onRemoveFromHere: () => removeFromHere(item, panelId) }),
            ...(offeredAgents && openDashboardId
              ? {
                  agentsHere: {
                    offered: offeredAgents,
                    run: runsByItem.get(item.id),
                    start: (agent: Agent,prompt?: string) =>
                      startAgent
                        .mutateAsync({
                          itemId: item.id,
                          start: {
                            commandId: uuidv7(),
                            issuedAt: new Date().toISOString(),
                            runId: uuidv7(),
                            agentId: agent.id,
                            dashboardId: openDashboardId,
                            ...(prompt ? { prompt } : {}),
                          },
                        })
                        .then(() => undefined),
                  },
                }
              : {}),
          }
        : {
            // A proposal is only ever drawn in the Inbox: it is what a
            // filed Item's routing already answered, and there is
            // nothing left here for one to be a proposal *for*.
            routingProposal: routingProposalFor(item),
            onAcceptRouting: acceptRoutingFor(item),
          })}
    />
  );

  return (
    <>
      {/* A refusal from a gesture that opened nothing: a drop, or a step move.
          The picker says its own, so this is only for the changes made without
          one - which used to fail in silence. */}
      {refusal && !moving && !adding && !asking && (
        <p role="alert" className="px-4 py-2 text-sm text-over-ink">
          {refusal}
        </p>
      )}

      <div
        // Tall enough to be dropped on. Without this the box is only as tall as
        // what is in it, so an empty panel's drop target was the one line of
        // text saying it is empty - and letting go anywhere in the space below
        // did nothing, which is most of the panel.
        className={fillsTheRestOfItsColumn ? 'flex-1' : 'min-h-full'}
        onDragOver={(event) => {
          // Only a row of ours. A panel dragged by its header crosses lists on
          // its way to another panel, and a list that offered it a place would
          // file a panel into itself.
          if (!event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
          // A gathered list takes no drop, so it must not say it would: no
          // `preventDefault` here is what makes the pointer read "no" over it
          // rather than promising a filing the drop would decline. A sorted
          // list says the same to a row it holds, which has nowhere new to go.
          if (gathered || alreadyHeldWhileSorted()) return;
          // Both, and both are load-bearing: preventing the default is what
          // makes this a place a drop can happen at all, and stopping the
          // propagation is what keeps the panel underneath from taking the drop
          // as a panel being reordered.
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'move';
          // **No line in the Inbox.** It is by age and has no order, so there
          // is no gap to land in - drawing one would promise a reorder that
          // cannot happen. A drop is still accepted here, because arriving
          // from a panel means being taken off it. None on a sorted Panel
          // either, for the same reason.
          if (panelId && !sorted) setLandingAt(gapUnder(event.clientY));
        }}
        // Only when the pointer has left this list rather than moved onto a row
        // inside it, which fires the same event.
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLandingAt(null);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
          if (gathered || alreadyHeldWhileSorted()) return;
          event.preventDefault();
          event.stopPropagation();
          drop(event);
        }}
      >
        {items.length === 0 ? (
          // The line is a row, so an empty list still needs a list to put it
          // in: an `li` inside the `p` is markup the browser rewrites, closing
          // the paragraph before it and drawing the line somewhere else.
          <>
            <p className="px-4 py-4 text-sm text-ink-faint">{emptyMessage}</p>
            {landingAt !== null && (
              <ul>
                <Landing />
              </ul>
            )}
          </>
        ) : groups && groups.length > 0 ? (
          // Rows that land under no heading still draw, flat, rather than
          // leaving a well empty under a count saying there are some.
          <ul ref={rows}>
            {groups.map((group) => (
              <li key={group.key}>
                {/* Sticks to the top of the Panel while its own rows scroll under
                    it, and goes when the next heading arrives: the heading is
                    inside the group it belongs to, so it is bounded by it. */}
                <h4 className="sticky top-0 z-[1] flex items-baseline justify-between gap-2 border-b border-shade/10 bg-surface px-4 pb-1 pt-2.5 text-xs font-medium tracking-wide text-ink-faint">
                  <span className="min-w-0 truncate">
                    <span className="font-semibold uppercase text-ink-soft">{group.name}</span>
                    {group.dashboardName !== null && <span> · {group.dashboardName}</span>}
                  </span>
                  <span className="shrink-0 tabular-nums">{group.items.length}</span>
                </h4>
                <ul>
                  {group.items.map((item) => (
                    <Fragment key={item.id}>{rowFor(item, group.panelId)}</Fragment>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <ul ref={rows}>
            {items.map((item, at) => (
              <Fragment key={item.id}>
                {landingAt === at && <Landing />}
                {rowFor(item)}
              </Fragment>
            ))}
            {landingAt === items.length && <Landing />}
          </ul>
        )}
      </div>

      {/* A Dashboard's selection has one bar, drawn by its board
          (`DashboardSelection`), so a Panel draws none. */}
      {!onDashboard && picked.length > 0 && (
        <SelectionBar
          count={picked.length}
          filing={filingSeveral.filing}
          refusal={[filingSeveral.refusal, editing.refusal].filter(Boolean).join(' ') || null}
          saving={editing.saving}
          editMenu={editing.menu}
          dateField={editing.dateField}
          onMoveTo={filingSeveral.ask}
          onClear={stopSelecting}
        />
      )}

      {filingSeveral.pickers}

      {asking && panelId && (
        <WhateverTheQuestionDoes onFailure={() => setAsking(null)}>
          <Suspense fallback={null}>
            <MoveOrAddQuestion
              open
              itemTitle={itemLabel(asking.item)}
              panelName={nameOf(panelId)}
              // Closed by the change landing, not by the press: a refused move
              // leaves the question up with the reason on it, which is what the
              // picker does and what makes the refusal worth showing there at all.
              onMove={() => move(asking.item, panelId, asking.at, undefined, asking.from ?? undefined)}
              {...(asking.from ? { leaves: nameOf(asking.from) } : {})}
              onAdd={() => add(asking.item, panelId, asking.at)}
              onCancel={() => {
                // Reset as well as close, for the reason the picker below does: a
                // refusal outlives the dialog it was shown in, and the list says
                // one of its own.
                command.reset();
                setAsking(null);
              }}
              refusal={command.error instanceof CommandRefused ? command.error.message : null}
              busy={command.isPending}
            />
          </Suspense>
        </WhateverTheQuestionDoes>
      )}

      {adding && (
        <FetchedPicker
          onFailure={() => setAdding(null)}
          moving={{ title: itemLabel(adding) }}
          adding
          onAddPanel={addPanelFor}
          filteredDashboardIds={filteredDashboardIds}
          dashboards={data?.dashboards ?? []}
          panels={data?.panels ?? []}
          openDashboardId={openDashboardId}
          recent={recentPanelsIn(browserStore(), workspaceId)}
          open
          workspaceId={workspaceId}
          onPick={(target) => {
            if ('panel' in target) add(adding, target.panel, 0);
          }}
          onCancel={() => {
            command.reset();
            setAdding(null);
          }}
          refusal={refusal}
          busy={command.isPending}
          returnFocusTo={openedFrom.current}
          alreadyOn={whereItIs(adding).map((at) => at.panelId)}
        />
      )}

      {moving && (
        <FetchedPicker
          onFailure={() => setMoving(null)}
          moving={{ title: itemLabel(moving) }}
          onAddPanel={addPanelFor}
          filteredDashboardIds={filteredDashboardIds}
          dashboards={data?.dashboards ?? []}
          panels={data?.panels ?? []}
          workspaceId={workspaceId}
          // Only for an item that belongs to no workspace: for any other, which
          // workspace it is in is settled and the one Inbox is this one.
          //
          // **And only when there is a workspace to offer.** An empty list is
          // still a list, so handing one over gave the picker a Workspaces
          // heading with nothing under it *and* took the plain Inbox away -
          // opened before the query settled, an item that belongs nowhere
          // could be put nowhere. Falling back to the plain Inbox is not a
          // lie: it is this workspace's, which is one of the right answers.
          {...(workspaceIsDecided(moving) || !allWorkspaces?.workspaces.length
            ? {}
            : { inboxesOf: allWorkspaces.workspaces })}
          // Left out for an item that belongs to no workspace: it is on no
          // panel, but this workspace's Inbox is still a place it can go, the
          // one that decides which workspace it belongs to.
          {...(workspaceIsDecided(moving)
            ? { alreadyOn: whereItIs(moving).map((at) => at.panelId) }
            : {})}
          openDashboardId={openDashboardId}
          recent={recentPanelsIn(browserStore(), workspaceId)}
          open
          onPick={(target) =>
            'panel' in target
              ? move(moving, target.panel, 0, undefined, rowPanel ?? undefined)
              : move(moving, null, 0, target.inboxOf)
          }
          onCancel={() => {
            // Reset as well as close: a refusal outlives the dialog it was
            // shown in, and the list says one of its own now - so cancelling
            // after a refused move used to leave the message stuck above the
            // rows with nothing to explain it.
            command.reset();
            setMoving(null);
          }}
          refusal={refusal}
          busy={command.isPending}
          returnFocusTo={openedFrom.current}
        />
      )}
    </>
  );
}

/**
 * The line showing where a dragged row would land.
 *
 * A row of the same list rather than something laid over it, because a list
 * holds rows - and `aria-hidden` because it says nothing a pointer user
 * cannot already see, and there is no drag for anyone else to see it with.
 */
function Landing() {
  return <li aria-hidden="true" className="h-0.5 list-none bg-accent" />;
}
