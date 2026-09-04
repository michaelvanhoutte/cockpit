import { Fragment, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { itemLabel, uuidv7, type Item } from '@cockpit/shared';
import { snapshotQuery, useCommand, useSendCommand } from '../api/queries';
import { CommandRefused } from '../api/client';
import { ITEM_BEING_DRAGGED, placeAfterMoving, placeAmongHeld, whereItWouldLand } from '../dropAt';
import { filedOrderOnPanel, itemsOnPanel, orderWithItemAt } from '../filing';
import { useOpenItem } from '../itemForm';
import { browserStore } from '../lastVisited';
import { recentPanelsIn, rememberRecentPanel } from '../recentPanels';
import { useUndo } from '../undo';
import { ItemRow } from './ItemRow';
import { MoveOrAddQuestion } from './MoveOrAddQuestion';
import { MoveToPicker } from './MoveToPicker';

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
  const command = useCommand();
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const [moving, setMoving] = useState<Item | null>(null);
  /** The item being added to a second panel from its menu, if any. */
  const [adding, setAdding] = useState<Item | null>(null);
  const openedFrom = useRef<HTMLElement | null>(null);

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
  const move = (item: Item, panelId: string | null, atAmongDrawn = 0) => {
    const before = whereItIs(item);
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
          workspaceId,
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
                  workspaceId={workspaceId}
                  onMoveTo={(from) => {
                    openedFrom.current = from;
                    command.reset();
                    setMoving(item);
                  }}
                  onOpen={() => openItem(item.id)}
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
          itemTitle={itemLabel(adding)}
          adding
          dashboards={data?.dashboards ?? []}
          panels={data?.panels ?? []}
          openDashboardId={openDashboardId}
          recent={recentPanelsIn(browserStore(), workspaceId)}
          open
          onPick={(pickedPanelId) => {
            if (pickedPanelId) add(adding, pickedPanelId, 0);
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
          itemTitle={itemLabel(moving)}
          dashboards={data?.dashboards ?? []}
          panels={data?.panels ?? []}
          openDashboardId={openDashboardId}
          recent={recentPanelsIn(browserStore(), workspaceId)}
          open
          onPick={(panelId) => move(moving, panelId)}
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
 * holds rows - and `aria-hidden` because it says nothing a pointer user cannot
 * see and there is no drag for anyone else: Move up and Move down in the row's
 * own menu are what a keyboard has instead.
 */
function Landing() {
  return <li aria-hidden="true" className="h-0.5 list-none bg-accent" />;
}
