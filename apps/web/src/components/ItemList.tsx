import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { uuidv7, type Item } from '@cockpit/shared';
import { snapshotQuery, useCommand, useSendCommand } from '../api/queries';
import { CommandRefused } from '../api/client';
import { filedOrderOnPanel, orderWithItemAt } from '../filing';
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
  /** What the list says when it holds nothing. */
  emptyMessage,
}: {
  workspaceId: string;
  items: readonly Item[];
  /** The dashboard being looked at, which the picker offers first. Null in the Inbox. */
  openDashboardId: string | null;
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
   * One panel, because nothing files an item onto two yet; the day *Add to…*
   * lands (#142) this becomes the list of them and the inverse becomes several
   * changes rather than one.
   */
  const whereItIs = (item: Item): { panelId: string | null; order: string[] } => {
    const filings = data?.filings ?? [];
    const panelId = filings.find((filing) => filing.itemId === item.id)?.panelId ?? null;
    return { panelId, order: panelId ? filedOrderOnPanel(filings, panelId) : [] };
  };

  const move = (item: Item, panelId: string | null) => {
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
        : orderWithItemAt(filedOrderOnPanel(data?.filings ?? [], panelId), item.id, 0);

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
      {items.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-faint">{emptyMessage}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              workspaceId={workspaceId}
              onMoveTo={(from) => {
                openedFrom.current = from;
                command.reset();
                setMoving(item);
              }}
            />
          ))}
        </ul>
      )}

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
