import { Fragment, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { uuidv7, type Item } from '@cockpit/shared';
import { snapshotQuery, useCommand, useSendCommand } from '../api/queries';
import { CommandRefused } from '../api/client';
import { ITEM_BEING_DRAGGED, placeAfterMoving, placeAmongHeld, whereItWouldLand } from '../dropAt';
import { filedOrderOnPanel, itemsOnPanel, orderWithItemAt } from '../filing';
import { browserStore } from '../lastVisited';
import { recentPanelsIn, rememberRecentPanel } from '../recentPanels';
import { useUndo } from '../undo';
import { ItemRow } from './ItemRow';
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
  const command = useCommand();
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const [moving, setMoving] = useState<Item | null>(null);
  const openedFrom = useRef<HTMLElement | null>(null);

  /**
   * Where the item is now, and the whole order of the panel holding it - what
   * putting it back means ("Undo what just happened", issue 144). Read before
   * the move, because afterwards it is gone.
   *
   * One panel, because nothing files an item onto two yet; the day "Ask whether
   * to move an item to a panel or add it to one" (issue 142) lands, this becomes
   * the list of them and the inverse becomes several changes rather than one.
   */
  const whereItIs = (item: Item): { panelId: string | null; order: string[] } => {
    const filings = data?.filings ?? [];
    const panelId = filings.find((filing) => filing.itemId === item.id)?.panelId ?? null;
    return { panelId, order: panelId ? filedOrderOnPanel(filings, panelId) : [] };
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
          offerToUndo({
            what: `“${item.nextAction ?? item.title}” moved to ${nameOf(panelId)}`,
            // The same command, with the panel and the order it was in before.
            // The order named the item then and does again, so the panel it is
            // put back on is exactly the panel it left.
            undo: () =>
              send({
                name: 'move_item_to_panel',
                payload: {
                  commandId: uuidv7(),
                  issuedAt: new Date().toISOString(),
                  workspaceId,
                  itemId: item.id,
                  panelId: before.panelId,
                  order: before.order,
                },
              }),
          });
        },
      },
    );
  };

  /**
   * Which gap a dragged row is currently over, or null when nothing is being
   * dragged across this list. Drawn as a line between two rows.
   */
  const [landingAt, setLandingAt] = useState<number | null>(null);
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
    if (wasAt !== -1 && gap === wasAt) return;

    const moving = items.find((item) => item.id === itemId) ?? data?.items.find((i) => i.id === itemId);
    if (moving) move(moving, panelId, gap);
  };

  /** What a target is called, for the sentence the undo bar says. */
  const nameOf = (panelId: string | null) =>
    panelId ? (data?.panels.find((panel) => panel.id === panelId)?.name ?? 'a panel') : 'the Inbox';

  // Only this list's own refusal, and only for the item still being moved: one
  // `useCommand` is shared by every row here, so without the second half a
  // refusal from a row that has since closed would appear against the next one.
  const refusal =
    command.error instanceof CommandRefused && moving ? command.error.message : null;

  return (
    <>
      <div
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
          setLandingAt(gapUnder(event.clientY));
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
                  {...(panelId
                    ? {
                        ordering: {
                          at,
                          of: items.length,
                          onMove: (places: number) => move(item, panelId, at + places),
                        },
                      }
                    : {})}
                />
              </Fragment>
            ))}
            {landingAt === items.length && <Landing />}
          </ul>
        )}
      </div>

      {moving && (
        <MoveToPicker
          itemTitle={moving.nextAction ?? moving.title}
          dashboards={data?.dashboards ?? []}
          panels={data?.panels ?? []}
          openDashboardId={openDashboardId}
          recent={recentPanelsIn(browserStore(), workspaceId)}
          open
          onPick={(panelId) => move(moving, panelId)}
          onCancel={() => setMoving(null)}
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
