import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { itemLabel, uuidv7, workspaceIsDecided, type Item } from '@cockpit/shared';
import {
  snapshotQuery,
  useCommand,
  useLatestSnapshot,
  useSendCommand,
  workspacesQuery,
} from '../api/queries';
import { CommandRefused } from '../api/client';
import { ITEM_BEING_DRAGGED, placeAfterMoving, placeAmongHeld, whereItWouldLand } from '../dropAt';
import {
  filedOrderOnPanel,
  itemsOnPanel,
  orderPuttingBack,
  ordersForFilingSeveral,
  orderWithItemAt,
} from '../filing';
import { useOpenItem } from '../itemForm';
import { browserStore } from '../lastVisited';
import { recentPanelsIn, rememberRecentPanel } from '../recentPanels';
import {
  afterClicking,
  NOTHING_PICKED,
  pickedInTheList,
  useOnlyOneListSelecting,
  type Selection,
} from '../selection';
import { useUndo } from '../undo';
import { ItemRow } from './ItemRow';
import { typeOf } from '../itemTypes';
import { MoveOrAddQuestion } from './MoveOrAddQuestion';
import { MoveToPicker } from './MoveToPicker';
import { SelectionBar } from './SelectionBar';

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
  /** What the list says when it holds nothing. */
  emptyMessage,
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
  emptyMessage: string;
}) {
  const { data } = useQuery(snapshotQuery(workspaceId));
  const openItem = useOpenItem();
  // Every workspace, for the Inboxes the picker offers an item that belongs to
  // none of them. The same cached read the tabs above are already doing.
  const { data: allWorkspaces } = useQuery(workspacesQuery);
  // `?? []` for the reason the filings elsewhere carry one: a stored snapshot
  // can predate the field, and a row with no type is drawn rather than hidden.
  const types = data?.itemTypes ?? [];
  const command = useCommand();
  const send = useSendCommand();
  const latestSnapshot = useLatestSnapshot();
  const offerToUndo = useUndo();
  const [moving, setMoving] = useState<Item | null>(null);
  /** The item being added to a second panel from its menu, if any. */
  const [adding, setAdding] = useState<Item | null>(null);
  const openedFrom = useRef<HTMLElement | null>(null);

  /** The rows picked out of this list ("Select several items…", issue 169). */
  const [selection, setSelection] = useState<Selection>(NOTHING_PICKED);
  /** That the picker was opened by the bar rather than by a row's own menu. */
  const [filingSeveral, setFilingSeveral] = useState(false);
  /** That a filing of several is still going, so it cannot be asked for twice. */
  const [filing, setFiling] = useState(false);
  /** Why a filing of several stopped, if it stopped. */
  const [filingRefusal, setFilingRefusal] = useState<string | null>(null);
  /** Everything a selection put on screen, gone together. */
  const stopSelecting = () => {
    setSelection(NOTHING_PICKED);
    setFilingSeveral(false);
    setFilingRefusal(null);
  };
  const emptyTheOtherLists = useOnlyOneListSelecting(stopSelecting);

  /** The picked rows this list shows, in the order it shows them. */
  const picked = pickedInTheList(selection, items);

  /**
   * A row that leaves the list is not picked any more - **dropped, not merely
   * hidden**.
   *
   * Reading the selection through what the list draws is enough for the count
   * and the ticks, and it is not enough for the selection itself: a row can
   * come *back*. Move one out from its own menu and undo that move, and it
   * returned already ticked, with the bar's count up by one and the next Move
   * to… quietly carrying an item nobody had picked.
   */
  useEffect(() => {
    setSelection((was) => {
      const shown = new Set(items.map((item) => item.id));
      if ([...was.picked].every((id) => shown.has(id))) return was;
      return {
        picked: new Set([...was.picked].filter((id) => shown.has(id))),
        // The row a shift-click reaches back to has to be one of these too.
        reachingFrom:
          was.reachingFrom && shown.has(was.reachingFrom) ? was.reachingFrom : null,
      };
    });
  }, [items]);

  /**
   * **A refusal belongs to the selection it was about, and goes when that does.**
   *
   * Tied to the emptying rather than to the ways of emptying, because there are
   * more of those than there look: Clear, unticking the last row, filing every
   * one of them, and the rows being taken out of the list by somebody else. It
   * was written into the handlers first and each one that got missed left an
   * old message waiting above the next, unrelated selection.
   */
  useEffect(() => {
    if (picked.length === 0) setFilingRefusal(null);
  }, [picked.length]);

  /**
   * A selection belongs to the list it was made in and to the workspace it was
   * made in. Changing dashboards draws different panels into the same board, so
   * without this a panel could inherit the ticks of the one it replaced.
   */
  useEffect(() => {
    setSelection(NOTHING_PICKED);
    setFilingSeveral(false);
    setFilingRefusal(null);
    // `stopSelecting` is remade every render and this must run on a change of
    // list, not on every one of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, panelId]);

  /**
   * Every panel the item is on, and the whole order of each - what putting it
   * back means ("Undo what just happened", issue 144). Read before the move,
   * because afterwards it is gone.
   *
   * A list rather than one panel, because an item can be on several ("Ask
   * whether to move an item to a panel or add it to one", issue 142) and a move
   * takes it off all of them: an inverse that named one would lose the rest.
   */
  const whereItIs = (item: Item): { panelId: string; order: string[] }[] => {
    const filings = data?.filings ?? [];
    const panels = [
      ...new Set(filings.filter((f) => f.itemId === item.id).map((f) => f.panelId)),
    ];
    return panels.map((panelId) => ({ panelId, order: filedOrderOnPanel(filings, panelId) }));
  };

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
  const move = (item: Item, panelId: string | null, atAmongDrawn = 0, intoWorkspace?: string) => {
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
        },
      },
      {
        onSuccess: () => {
          // Remembered only once it has happened: a panel a move was refused
          // for is not a panel you have been filing into.
          if (panelId) rememberRecentPanel(browserStore(), workspaceId, panelId);
          setMoving(null);
          setAsking(null);
          if (decides) return;
          offerToUndo({
            what: `“${itemLabel(item)}” moved to ${nameOf(panelId)}`,
            // Every panel it was on, not the first of them: a move takes an
            // item off all of them, so putting it back on one would lose the
            // rest - and an item can be on several since "Ask whether to move
            // an item to a panel or add it to one" (issue 142).
            undo: () => putItBackOn(item, before),
          });
        },
      },
    );
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

  /**
   * Files everything picked out of this list onto one panel, or back into the
   * Inbox ("Select several items, and file them all in one go", issue 169).
   *
   * **One filing at a time, in the order the list shows them.** Each carries
   * the panel's whole arrangement afterwards, so each has to be built on the
   * one before it (`ordersForFilingSeveral`) - which is also why this awaits
   * rather than sending them together.
   *
   * **It can stop part way, and that is a state rather than an accident.** A
   * refusal stops the rest: what did move is filed and leaves the selection,
   * what did not stays picked, so asking again files exactly the remainder. The
   * way back offers what happened rather than what was asked for.
   */
  const fileSeveral = async (target: string | null) => {
    const chosen = picked;
    if (filing || chosen.length === 0) return;

    // Read before anything moves, because afterwards it is gone - and read for
    // all of them at once, so every order below describes the same moment.
    const wasOn = new Map(chosen.map((item) => [item.id, whereItIs(item)] as const));
    const orders = target
      ? ordersForFilingSeveral(
          filedOrderOnPanel(data?.filings ?? [], target),
          chosen.map((item) => item.id),
        )
      : [];

    setFiling(true);
    setFilingRefusal(null);
    const moved: Item[] = [];
    try {
      for (const [at, item] of chosen.entries()) {
        await send({
          name: 'move_item_to_panel',
          payload: {
            commandId: uuidv7(),
            issuedAt: new Date().toISOString(),
            workspaceId,
            itemId: item.id,
            panelId: target,
            // The Inbox has no order - it is by age - so filing there sends none.
            order: target ? orders[at]! : [],
          },
        });
        moved.push(item);
      }
    } catch (error) {
      setFilingRefusal(
        error instanceof CommandRefused
          ? error.message
          : 'These could not all be moved. Try again.',
      );
    } finally {
      setFiling(false);
      // **The question is answered either way, so it closes either way.** A
      // picker left open over a refusal seemed friendlier - the reason where
      // the choice was, and the panels still there to try again - but it is a
      // modal dialog, so while it is up nothing outside it can be clicked: the
      // way back offered underneath it took one click to dismiss the dialog
      // and a second to press, with the offer expiring on its own meanwhile.
      // The bar says why instead, above the rows that are still picked.
      setFilingSeveral(false);
    }

    if (moved.length === 0) return;
    // Remembered only once something has happened, the way a single move does:
    // a panel everything was refused for is not one you have been filing into.
    if (target) rememberRecentPanel(browserStore(), workspaceId, target);
    // Only what moved leaves the selection, so a filing that stopped leaves the
    // remainder in front of you with the reason above it.
    const filed = new Set(moved.map((item) => item.id));
    setSelection((was) => ({
      picked: new Set([...was.picked].filter((id) => !filed.has(id))),
      reachingFrom: null,
    }));

    // **No way back once any of them belonged nowhere.** Filing an item that
    // belongs to no workspace is also what decides where it belongs, and that
    // question is asked once: undoing would take it off the panel and leave it
    // in *this* workspace's Inbox rather than in every workspace's, which is
    // not where it was. The single move withholds the offer for exactly this
    // (`decides`), and one offer covers a whole run here - so one undecided
    // item in the selection is enough to withhold it, rather than a bar that
    // puts some of them back and quietly settles the rest.
    if (moved.some((item) => !workspaceIsDecided(item))) return;
    offerToUndo({
      what: whatMoved(moved, chosen.length, nameOf(target)),
      undo: () => putSeveralBack(moved, wasOn),
    });
  };

  /**
   * Puts back everything a filing of several took, onto the panels each was on.
   *
   * **One order per filing, each read from what the panel holds by then.** An
   * order naming an item the panel does not hold is refused exactly as a stale
   * one is, and half-way through this a panel holds neither what it held before
   * nor what it will hold after - not least the panel everything was filed
   * onto, which is still holding every item waiting its turn. Computing what
   * that ought to be is how the overlap case was got wrong; asking is how it is
   * got right.
   */
  const putSeveralBack = async (
    moved: readonly Item[],
    wasOn: ReadonlyMap<string, { panelId: string; order: string[] }[]>,
  ) => {
    /** What a panel holds at this moment, which each order has to name. */
    const heldOn = async (panelId: string) =>
      filedOrderOnPanel((await latestSnapshot(workspaceId)).filings ?? [], panelId);
    const envelope = (itemId: string) => ({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId,
      itemId,
    });

    for (const item of moved) {
      const panels = wasOn.get(item.id) ?? [];
      // On no panel at all is the Inbox, which is the absence of a filing.
      if (panels.length === 0) {
        await send({
          name: 'move_item_to_panel',
          payload: { ...envelope(item.id), panelId: null, order: [] },
        });
        continue;
      }
      // The first is a move and the rest are adds, for the reason
      // `putItBackOn` gives: the move takes it off wherever it is now, and each
      // add puts it on one more without disturbing that.
      const [first, ...rest] = panels;
      await send({
        name: 'move_item_to_panel',
        payload: {
          ...envelope(item.id),
          panelId: first!.panelId,
          order: orderPuttingBack(first!.order, await heldOn(first!.panelId), item.id),
        },
      });
      for (const also of rest) {
        await send({
          name: 'add_item_to_panel',
          payload: {
            ...envelope(item.id),
            panelId: also.panelId,
            order: orderPuttingBack(also.order, await heldOn(also.panelId), item.id),
          },
        });
      }
    }
  };

  /** A tick clicked, which is a row picked or a span reached across. */
  const pick = (item: Item, withShift: boolean) => {
    // What this list *shows* as picked, not what it is holding: a selection
    // whose every row has left the list draws no bar, so a list in that state
    // is starting a selection rather than adding to one - and a list that did
    // not say so would leave two bars on screen.
    if (picked.length === 0) emptyTheOtherLists();
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
  const [asking, setAsking] = useState<{ item: Item; at: number } | null>(null);
  const rows = useRef<HTMLUListElement>(null);

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
    const gap = placeAfterMoving(gapUnder(event.clientY), wasAt === -1 ? null : wasAt);

    // Dropped exactly where it started changes nothing, and sending it would
    // put a change in the undo bar that undoes to the same place.
    if (panelId && wasAt !== -1 && gap === wasAt) return;
    // The same, in the Inbox: a row dragged about inside it is already filed
    // nowhere, so moving it to the Inbox is a change that changes nothing -
    // and it would still offer to be undone, which is worse than doing nothing
    // at all.
    if (!panelId && !(data?.filings ?? []).some((filing) => filing.itemId === itemId)) return;


    const moving = items.find((item) => item.id === itemId) ?? data?.items.find((i) => i.id === itemId);
    if (!moving) return;

    // **Asked only when both answers are possible.** A row already on this
    // panel is being reordered; a row that is on no panel at all came from the
    // Inbox, and there is no answer that leaves it there - the Inbox is what is
    // filed nowhere. What is left is a row arriving from another panel, where
    // moving it and adding it are two different things somebody has to mean.
    const onAPanelAlready = (data?.filings ?? []).some((filing) => filing.itemId === itemId);
    if (panelId && wasAt === -1 && onAPanelAlready) {
      command.reset();
      setAsking({ item: moving, at: gap });
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

  /** What a target is called, for the sentence the undo bar says. */
  const nameOf = (panelId: string | null) =>
    panelId ? (data?.panels.find((panel) => panel.id === panelId)?.name ?? 'a panel') : 'the Inbox';

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

  return (
    <>
      {/* A refusal from a gesture that opened nothing: a drop, or a step move.
          The picker says its own, so this is only for the changes made without
          one - which used to fail in silence. */}
      {refusal && !moving && !adding && !asking && (
        <p role="alert" className="px-4 py-2 text-sm text-over">
          {refusal}
        </p>
      )}

      <div
        // Tall enough to be dropped on. Without this the box is only as tall as
        // what is in it, so an empty panel's drop target was the one line of
        // text saying it is empty - and letting go anywhere in the space below
        // did nothing, which is most of the panel.
        className="min-h-full"
        onDragOver={(event) => {
          // Only a row of ours. A panel dragged by its header crosses lists on
          // its way to another panel, and a list that offered it a place would
          // file a panel into itself.
          if (!event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
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
          // from a panel means being taken off it.
          if (panelId) setLandingAt(gapUnder(event.clientY));
        }}
        // Only when the pointer has left this list rather than moved onto a row
        // inside it, which fires the same event.
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLandingAt(null);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
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
        ) : (
          <ul ref={rows}>
            {items.map((item, at) => (
              <Fragment key={item.id}>
                {landingAt === at && <Landing />}
                <ItemRow
                  item={item}
                  itemType={typeOf(types, item)}
                  workspaceId={workspaceId}
                  selecting={{
                    picked: selection.picked.has(item.id),
                    revealed: picked.length > 0,
                    onPick: (withShift) => pick(item, withShift),
                  }}
                  onMoveTo={(from) => {
                    openedFrom.current = from;
                    command.reset();
                    setMoving(item);
                  }}
                  onOpen={() => openItem(item.id)}
                  // The one you are looking at, which is the same move the
                  // picker makes with this workspace's Inbox chosen - the row
                  // decides whether to offer it at all.
                  onMoveHere={() => move(item, null, 0, workspaceId)}
                  {...(panelId
                    ? {
                        ordering: {
                          at,
                          of: items.length,
                          onMove: (places: number) => reorder(item, panelId, at + places),
                        },
                        onAddTo: (from: HTMLElement | null) => {
                          openedFrom.current = from;
                          command.reset();
                          setAdding(item);
                        },
                        onRemoveFromHere: () => removeFromHere(item, panelId),
                      }
                    : {})}
                />
              </Fragment>
            ))}
            {landingAt === items.length && <Landing />}
          </ul>
        )}
      </div>

      {picked.length > 0 && (
        <SelectionBar
          count={picked.length}
          filing={filing}
          refusal={filingRefusal}
          onMoveTo={() => {
            setFilingRefusal(null);
            setFilingSeveral(true);
          }}
          onClear={stopSelecting}
        />
      )}

      {/* Only while there is something to move. The rows picked are re-derived
          from what the list draws, so every one of them can leave while this is
          open - finished on another device, filed from a phone - and a question
          about no items has no answer: choosing a panel would send nothing and
          say nothing, leaving Cancel as the only way out. */}
      {filingSeveral && picked.length > 0 && (
        <MoveToPicker
          moving={{ several: picked.length }}
          dashboards={data?.dashboards ?? []}
          panels={data?.panels ?? []}
          openDashboardId={openDashboardId}
          recent={recentPanelsIn(browserStore(), workspaceId)}
          open
          workspaceId={workspaceId}
          // No other workspace's Inbox offered, where a single move offers them
          // for an item that belongs to none ("Capture something before you
          // know which workspace it belongs to", issue 165): a selection can
          // hold items that belong here and items that belong nowhere, and what
          // "move these to Home" should mean for the mixture is a question
          // nobody has been asked. So the Inbox here means this one.
          onPick={(target) => void fileSeveral('panel' in target ? target.panel : null)}
          onCancel={() => setFilingSeveral(false)}
          // No refusal here: this closes as soon as the filing answers, and the
          // bar says why over the rows that are still picked.
          busy={filing}
        />
      )}

      {asking && panelId && (
        <MoveOrAddQuestion
          open
          itemTitle={itemLabel(asking.item)}
          panelName={nameOf(panelId)}
          // Closed by the change landing, not by the press: a refused move
          // leaves the question up with the reason on it, which is what the
          // picker does and what makes the refusal worth showing there at all.
          onMove={() => move(asking.item, panelId, asking.at)}
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
      )}

      {adding && (
        <MoveToPicker
          moving={{ title: itemLabel(adding) }}
          adding
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
        />
      )}

      {moving && (
        <MoveToPicker
          moving={{ title: itemLabel(moving) }}
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
          openDashboardId={openDashboardId}
          recent={recentPanelsIn(browserStore(), workspaceId)}
          open
          onPick={(target) =>
            'panel' in target
              ? move(moving, target.panel)
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
 * What the way back says a filing of several did.
 *
 * **What happened, not what was asked for.** A filing that stopped part way
 * moved some of them, and a sentence saying six when four went would offer to
 * undo two things that never happened. One row keeps its own title, because
 * that is what a single move has always said and picking one row out is not a
 * different act from moving it.
 */
function whatMoved(moved: readonly Item[], asked: number, target: string): string {
  if (moved.length === 1 && asked === 1) {
    return `“${itemLabel(moved[0]!)}” moved to ${target}`;
  }
  const how = moved.length === asked ? `${asked} items` : `${moved.length} of ${asked} items`;
  return `${how} moved to ${target}`;
}

/**
 * The line showing where a dragged row would land.
 *
 * A row of the same list rather than something laid over it, because a list
 * holds rows - and `aria-hidden` because it says nothing a pointer user cannot
 * see and there is no drag for anyone else: Move up and Move down in the row's
 * own menu are what a keyboard has instead.
 */
function Landing() {
  return <li aria-hidden="true" className="h-0.5 list-none bg-accent" />;
}
