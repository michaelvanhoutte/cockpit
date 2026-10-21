import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { uuidv7, type Filing, type Item } from '@cockpit/shared';
import { useLatestSnapshot, useSendCommand } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { filedOrderOnPanel } from '../filing';
import { useFilteredDashboardIds } from '../dashboardFilter';
import { browserStore } from '../lastVisited';
import { recentPanelsIn } from '../recentPanels';
import { askToShow } from '../showItem';
import { useUndo, type Undoable } from '../undo';
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
  const { data } = useSnapshot(workspaceId);
  const send = useSendCommand();
  const latestSnapshot = useLatestSnapshot();
  /** What `puttingBack.ts` sends and reads with. */
  const putting = { workspaceId, send, latest: latestSnapshot };
  const offerToUndo = useUndo();
  const navigate = useNavigate();

  /** That the picker was opened by the bar rather than by a row's own menu. */
  const [filingSeveral, setFilingSeveral] = useState(false);
  /** That a filing of several is still going, so it cannot be asked for twice. */
  const [filing, setFiling] = useState(false);
  /** Why a filing of several stopped, if it stopped. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The items a moved selection brought to a panel, being added to a second one from the undo bar's Also show on…. */
  const [addingSeveral, setAddingSeveral] = useState<readonly Item[] | null>(null);
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
  const whereItIs = (item: Item, filings: readonly Filing[] = data?.filings ?? []): { panelId: string; order: string[] }[] => {
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
   * Show and Also show on… for Items just filed on `panelId`, for the undo bar.
   * **For the ones that landed**: offered at the click with all of them, they
   * wait for the run to be answered, so an Item that was refused is not shown or
   * added anywhere.
   */
  const nextSteps = (
    moved: readonly Item[] | Promise<readonly Item[]>,
    panelId: string,
  ): Pick<Undoable, 'show' | 'alsoShowOn'> => ({
    show: () =>
      void Promise.resolve(moved).then((landed) =>
        showOnItsPanel(
          landed.map((item) => item.id),
          panelId,
        ),
      ),
    alsoShowOn: () => {
      setAddingRefusal(null);
      void Promise.resolve(moved).then(setAddingSeveral);
    },
  });
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

  // Fetched once there is a selection or a question to answer, so the first
  // press has the code already: the filing is drawn the moment it is made.
  const somethingToFile = picked.length > 0 || addingSeveral !== null;
  useEffect(() => {
    if (somethingToFile) void import('../filingSeveral');
  }, [somethingToFile]);

  /**
   * What `filingSeveral.ts`, fetched on the first gesture that files several,
   * is handed: the ways to read and send, say and offer, and close the question.
   */
  const filingSeveralDeps = () => ({
    workspaceId,
    openDashboardId,
    scope,
    send,
    latest: latestSnapshot,
    offerToUndo,
    nameOf,
    nextSteps,
    whereItIs,
    setFiling,
    setRefusal,
    closeQuestion: () => setFilingSeveral(false),
    closeAdding: () => setAddingSeveral(null),
    setAddingRefusal,
  });

  /**
   * Files everything picked onto one panel, or back into the Inbox: the work is
   * `fileOnto` in `filingSeveral.ts`, which a drop of a selection uses too (`dropOnto`),
   * so the two cannot come to different answers.
   */
  const fileOnto = async (
    chosen: readonly Item[],
    target: string | null,
    landing?: { at: number; alsoShow?: boolean; scope?: string },
  ) => {
    // Held back by the state, and by the module's own flag once it has loaded: a
    // drop is handled by the Panel it lands on, whose hook is not the one a run began in.
    if (filing || chosen.length === 0) return;
    await (await import('../filingSeveral')).fileOnto(filingSeveralDeps(), chosen, target, landing);
  };
  const fileSeveral = (target: string | null) => fileOnto(picked, target);

  /** Adds everything a selection moved to one more panel, from the undo bar's Also show on… (`addSeveral` in `filingSeveral.ts`). */
  const addSeveral = async (items: readonly Item[], panelId: string) => {
    if (filing) return;
    await (await import('../filingSeveral')).addSeveral(filingSeveralDeps(), items, panelId);
  };

  /**
   * Puts back everything a filing of several took, onto the panels each was on
   * (`puttingBack.ts`, fetched when Undo is pressed).
   */
  const putSeveralBack = async (
    moved: readonly Item[],
    wasOn: ReadonlyMap<string, { panelId: string; order: string[] }[]>,
  ) => (await import('../puttingBack')).putSeveralBack(putting, moved, wasOn);

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
    /** Files what a drop carried (`fileOnto`). */
    dropOnto: fileOnto,
    /** Opens the Move to… question for what is picked. */
    ask: () => {
      setRefusal(null);
      setFilingSeveral(true);
    },
    /** The questions, drawn wherever the hook is used. */
    pickers,
    putSeveralBack,
    whereItIs,
    nameOf,
    addPanelFor,
    showOnItsPanel,
    filteredDashboardIds,
    nextSteps,
  };
}

/** The ids found in every one of the lists. */
function inAll(lists: string[][]): string[] {
  const [first = [], ...rest] = lists;
  return first.filter((id) => rest.every((list) => list.includes(id)));
}
