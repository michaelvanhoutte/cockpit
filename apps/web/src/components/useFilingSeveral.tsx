import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { itemLabel, uuidv7, workspaceIsDecided, type Item } from '@cockpit/shared';
import { snapshotQuery, useLatestSnapshot, useSendCommand } from '../api/queries';
import { CommandRefused } from '../api/client';
import { filedOrderOnPanel, orderPuttingBack, ordersForFilingSeveral } from '../filing';
import { useFilteredDashboardIds } from '../dashboardFilter';
import { browserStore } from '../lastVisited';
import { recentPanelsIn, rememberRecentPanel } from '../recentPanels';
import { updateSelection } from '../selection';
import { askToShow } from '../showItem';
import { useUndo } from '../undo';
import { FetchedPicker } from './FetchedPicker';

/**
 * Filing everything a selection holds onto one panel, and the questions around
 * it ("Select several items, and file them all in one go", issue 169): Move
 * to…, and the undo bar's Show and Also show on….
 *
 * **A hook rather than a part of `ItemList`**, because a Dashboard's selection
 * spans every one of its Panels and has one bar of its own ("Select across
 * every panel of a dashboard", issue 863): the Inbox's list and the board's bar
 * file with the same code, handed the Items picked and the scope they are held
 * in. It also answers the few things a single move needs of the same snapshot -
 * where an Item is, what a panel is called, how to make one - so the two cannot
 * come to different answers.
 */
export function useFilingSeveral({
  workspaceId,
  openDashboardId,
  scope,
  picked,
}: {
  workspaceId: string;
  /** The dashboard being looked at, which the picker offers first. Null in the Inbox. */
  openDashboardId: string | null;
  /** Where the selection is held, which what moved leaves. */
  scope: string;
  /** The Items picked, in the order they are to be filed. */
  picked: readonly Item[];
}) {
  const { data } = useQuery(snapshotQuery(workspaceId));
  const send = useSendCommand();
  const latestSnapshot = useLatestSnapshot();
  const offerToUndo = useUndo();
  const navigate = useNavigate();

  /** That the picker was opened by the bar rather than by a row's own menu. */
  const [filingSeveral, setFilingSeveral] = useState(false);
  /** That a filing of several is still going, so it cannot be asked for twice. */
  const [filing, setFiling] = useState(false);
  /** Why a filing of several stopped, if it stopped. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The items a moved selection brought to a panel, being added to a second one from the undo bar's Also show on…. */
  const [addingSeveral, setAddingSeveral] = useState<Item[] | null>(null);
  /** Why adding several stopped with nothing added, if it did. */
  const [addingRefusal, setAddingRefusal] = useState<string | null>(null);

  /**
   * **A refusal belongs to the selection it was about, and goes when that does.**
   *
   * Tied to the emptying rather than to the ways of emptying, because there are
   * more of those than there look: Clear, unticking the last row, filing every
   * one of them, and the rows being taken out of the list by somebody else. It
   * was written into the handlers first and each one that got missed left an
   * old message waiting above the next, unrelated selection. The picker goes
   * with it: a question about no items has no answer.
   */
  useEffect(() => {
    if (picked.length === 0) {
      setRefusal(null);
      setFilingSeveral(false);
    }
  }, [picked.length]);

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
   * Show, on the undo bar after a move: the Dashboard holding the panel, which
   * the board then scrolls to and highlights the item on (`PanelBoard`).
   * Where the panel is read when pressed rather than when the move was made, so
   * a panel moved to another Dashboard meanwhile is where Show goes.
   */
  const showOnItsPanel = async (itemIds: readonly string[], panelId: string) => {
    const dashboardId = (await latestSnapshot(workspaceId)).panels.find((p) => p.id === panelId)?.dashboardId;
    if (!dashboardId) return;
    askToShow({ dashboardId, panelId, itemIds });
    await navigate({ to: '/w/$workspaceId/d/$dashboardId', params: { workspaceId, dashboardId } });
  };

  /** The names of the panels the picker made, by id. */
  const madeHere = useRef(new Map<string, string>());
  /**
   * What a target is called, for the sentence the undo bar says.
   *
   * A panel the picker has just made is not in `data` yet - the re-read after
   * it has not come back by the time the filing's sentence is written - so its
   * name is the one remembered from making it, never "a panel".
   */
  const nameOf = (panelId: string | null) =>
    panelId
      ? (data?.panels.find((panel) => panel.id === panelId)?.name ??
        madeHere.current.get(panelId) ??
        'a panel')
      : 'the Inbox';

  const filteredDashboardIds = useFilteredDashboardIds(
    browserStore(),
    (data?.dashboards ?? []).map((dashboard) => dashboard.id),
  );
  /**
   * Makes a panel of items for the picker, with the command + Panel sends, and
   * answers its id for the filing that follows ("Add a panel from the Move to
   * picker", issue 709). Rejects with the refusal, which the picker shows under
   * the name.
   */
  const addPanelFor = async (dashboardId: string, name: string): Promise<string> => {
    const panelId = uuidv7();
    await send({
      name: 'add_panel',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        dashboardId,
        panelId,
        name,
        kind: 'items',
      },
    });
    madeHere.current.set(panelId, name);
    return panelId;
  };

  /**
   * Files everything picked onto one panel, or back into the Inbox.
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
    setRefusal(null);
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
      setRefusal(
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
    updateSelection(scope, (was) => ({
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
    const decides = moved.some((item) => !workspaceIsDecided(item));
    // Onto a panel only, as a single move does: the Inbox has nowhere to show
    // and nothing to also show on. Show and Also show on… cover exactly what
    // moved, and an undecided item withholds Undo alone.
    if (decides && target === null) return;
    const single = moved.length === 1 && chosen.length === 1;
    offerToUndo({
      what: whatMoved(moved, chosen.length, nameOf(target)),
      ...(single
        ? { split: { title: `“${itemLabel(moved[0]!)}”`, rest: ` moved to ${nameOf(target)}` } }
        : {}),
      ...(decides ? {} : { undo: () => putSeveralBack(moved, wasOn) }),
      ...(target
        ? {
            show: () =>
              void showOnItsPanel(
                moved.map((item) => item.id),
                target,
              ),
            alsoShowOn: () => {
              setAddingRefusal(null);
              setAddingSeveral(moved);
            },
          }
        : {}),
    });
  };

  /**
   * Adds everything a selection moved to one more panel, from the undo bar's
   * Also show on… (`fileSeveral`), leaving each on the panels it is on.
   *
   * **Read when the picker answers, not when the bar was drawn**: those already
   * on the panel by then (a move made meanwhile in another tab) are left out,
   * and the one Undo takes off exactly those added. One add at a time, each
   * order built on the one before, as filing several is. It can stop part way:
   * what was added is offered back; with nothing added the picker stays up with
   * the reason.
   */
  const addSeveral = async (items: readonly Item[], panelId: string) => {
    if (filing) return;
    const filings = (await latestSnapshot(workspaceId)).filings ?? [];
    const toAdd = items.filter(
      (item) => !filings.some((f) => f.itemId === item.id && f.panelId === panelId),
    );
    if (toAdd.length === 0) {
      setAddingSeveral(null);
      return;
    }
    const orders = ordersForFilingSeveral(
      filedOrderOnPanel(filings, panelId),
      toAdd.map((item) => item.id),
    );
    setFiling(true);
    setAddingRefusal(null);
    const added: Item[] = [];
    let why: string | null = null;
    try {
      for (const [at, item] of toAdd.entries()) {
        await send({
          name: 'add_item_to_panel',
          payload: {
            commandId: uuidv7(),
            issuedAt: new Date().toISOString(),
            workspaceId,
            itemId: item.id,
            panelId,
            order: orders[at]!,
          },
        });
        added.push(item);
      }
    } catch (error) {
      why =
        error instanceof CommandRefused ? error.message : 'These could not all be added. Try again.';
    } finally {
      setFiling(false);
    }
    if (added.length === 0) {
      setAddingRefusal(why);
      return;
    }
    rememberRecentPanel(browserStore(), workspaceId, panelId);
    setAddingSeveral(null);
    const how =
      added.length === toAdd.length ? `${added.length} items` : `${added.length} of ${toAdd.length} items`;
    offerToUndo({
      what: `${how} added to ${nameOf(panelId)}`,
      undo: async () => {
        // Read when pressed: one taken off meanwhile (another tab) is already
        // what Undo wants, and its refusal must not leave the rest on.
        const now = (await latestSnapshot(workspaceId)).filings ?? [];
        for (const item of added) {
          if (!now.some((f) => f.itemId === item.id && f.panelId === panelId)) continue;
          await send({
            name: 'remove_item_from_panel',
            payload: {
              commandId: uuidv7(),
              issuedAt: new Date().toISOString(),
              workspaceId,
              itemId: item.id,
              panelId,
            },
          });
        }
      },
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

  const pickers = (
    <>
      {/* Only while there is something to move. The rows picked are re-derived
          from what the lists draw, so every one of them can leave while this is
          open - finished on another device, filed from a phone - and a question
          about no items has no answer: choosing a panel would send nothing and
          say nothing, leaving Cancel as the only way out. */}
      {filingSeveral && picked.length > 0 && (
        <FetchedPicker
          onFailure={() => setFilingSeveral(false)}
          moving={{ several: picked.length }}
          onAddPanel={addPanelFor}
          filteredDashboardIds={filteredDashboardIds}
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

      {addingSeveral && (
        <FetchedPicker
          onFailure={() => setAddingSeveral(null)}
          moving={{ several: addingSeveral.length }}
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
            if ('panel' in target) void addSeveral(addingSeveral, target.panel);
          }}
          onCancel={() => setAddingSeveral(null)}
          refusal={addingRefusal}
          busy={filing}
          // The panels every one of them is on, where adding would change nothing.
          alreadyOn={inAll(addingSeveral.map((item) => whereItIs(item).map((at) => at.panelId)))}
        />
      )}
    </>
  );

  return {
    /** That a filing is still going. */
    filing,
    /** Why the last filing stopped, if it did. */
    refusal,
    /** Opens the Move to… question for what is picked. */
    ask: () => {
      setRefusal(null);
      setFilingSeveral(true);
    },
    /** The questions, drawn wherever the hook is used. */
    pickers,
    whereItIs,
    nameOf,
    addPanelFor,
    showOnItsPanel,
    filteredDashboardIds,
  };
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

/** The ids found in every one of the lists. */
function inAll(lists: string[][]): string[] {
  const [first = [], ...rest] = lists;
  return first.filter((id) => rest.every((list) => list.includes(id)));
}
