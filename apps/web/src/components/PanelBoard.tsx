import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GRID_COLUMNS, uuidv7 } from '@cockpit/shared';
import type { Dashboard, Filing, Item, Layout, Panel, PanelPlacement } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useCommand } from '../api/queries';
import { itemsOnPanel } from '../filing';
import { browserStore } from '../lastVisited';
import { useChosenLayout } from '../panels/chosenLayout';
import { useMeasuredWidth, useScreenWidth } from '../panels/useScreenWidth';
import {
  drawnArrangement,
  layoutLabel,
  layoutsOf,
  layoutToDraw,
  movedBefore,
  movedBy,
  nameForScreen,
  panelsAcross,
  resizedTo,
  sameArrangement,
  SAME_SCREEN_TOLERANCE,
} from '../panels/arrangement';
import { DeleteQuestion } from './DeleteQuestion';
import { PANEL_GAP, PANEL_ROW_HEIGHT, PanelCard } from './PanelCard';

/**
 * A dashboard's panels, on the grid one of its layouts arranges them on
 * ("Panels on a dashboard, with per-screen-size layouts", issue 33).
 *
 * **The grid is always the whole width of the page**, twelve columns of an
 * equal share of it, so the dashboard cannot scroll sideways on any screen and
 * a layout made for a wider one is squeezed rather than cut off - which is the
 * issue's last rule, expressed as the shape of the grid rather than as a case
 * anything has to remember. Nothing scales the type: a squeezed panel is a
 * narrower panel holding the same words.
 *
 * **Reordering happens here, not on a settings page**, and that is deliberate
 * rather than an inconsistency with workspaces and dashboards: dragging *is*
 * the editing, so it has to happen where the thing being edited is drawn. The
 * issue says so in as many words.
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
   * An arrangement that has been made but not yet stored - dragged or resized.
   * It is what the grid draws while it exists, so the panel really does move
   * under the hand that moved it, and it is dropped once the store has been
   * re-read and agrees.
   */
  const [draft, setDraft] = useState<PanelPlacement[] | null>(null);
  /**
   * The last arrangement actually sent, which is not the same as the last one
   * drawn: a corner still being dragged is drawn every pointer move and sent
   * only when the hand stops. Comparing a new gesture against what is *drawn*
   * would make the release of that drag look like no change at all and drop it.
   */
  const sent = useRef<PanelPlacement[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /** Which panel is being dragged. A ref: nothing on screen depends on it. */
  const dragging = useRef<string | null>(null);
  /** The control a question was opened from, so the focus can go back to it. */
  const askedFrom = useRef<HTMLElement | null>(null);

  const its = layoutsOf(layouts, dashboard.id);
  const drawnWith = layoutToDraw(layouts, dashboard.id, screenWidth, chosen);
  const stored = drawnArrangement(drawnWith, panels, acrossWidth);
  const shown = draft ?? stored;
  const sideBySide = panelsAcross(acrossWidth) > 1;
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
    placements: readonly PanelPlacement[],
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
          placements: placements.map((placement) => ({
            panelId: placement.panelId,
            columns: placement.columns,
            rows: placement.rows,
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
      },
    );
    sent.current = [...placements];
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
  const propose = (next: PanelPlacement[]) => {
    // Against what has been *sent* - or the store, where nothing has - rather
    // than against what is drawn. Three cases have to come out right, and only
    // this comparison gets all three: a corner drag is drawn on every pointer
    // move and sent once at the end, so measuring its release against what is
    // drawn would make it look like no change; a gesture that puts a panel back
    // where the snapshot has it still has to be sent when an earlier one moved
    // it; and a gesture that really changes nothing must send nothing.
    //
    // There used to be an exception for "Fit to this screen" on a dashboard
    // with no layout - what it computed was what such a dashboard is already
    // drawn with, so nothing moved and the point of the press, recording a
    // layout, had not happened. That button is gone ("Cockpit Shell
    // Explorations", artboard 2c) and with it the only gesture that meant
    // anything while changing nothing.
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
        // shell", issue 125). No control of its own - Add a panel is in the
        // strip right under it, and a second way to press the same thing is a
        // second thing to keep in step.
        <section className="well px-4 py-14 text-center">
          <p className="mx-auto max-w-md text-sm text-ink-faint">
            A dashboard holds the panels you want in view — a slice of your work, kept where you can
            see it. This one has none yet.
          </p>
        </section>
      ) : (
        <div
          // `minmax(0, 1fr)` rather than `1fr`, which is the whole of "never
          // scrolls sideways": a bare `1fr` is `minmax(auto, 1fr)`, so one long
          // unbroken word inside a panel would widen its column and take the
          // page with it.
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
            gridAutoRows: `${PANEL_ROW_HEIGHT}px`,
            gap: PANEL_GAP,
          }}
        >
          {shown.map((placement, at) => {
            const panel = panels.find((one) => one.id === placement.panelId);
            if (!panel) return null;
            return (
              <PanelCard
                key={panel.id}
                panel={panel}
                workspaceId={workspaceId}
                items={itemsOnPanel(items, filings, panel.id)}
                placement={placement}
                sideBySide={sideBySide}
                at={at}
                of={shown.length}
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
                onResize={(size) => propose(resizedTo(shown, panel.id, size))}
                // Drawn while the corner is still moving, and not sent: the
                // command goes when the hand stops.
                onResizing={(size) => setDraft(resizedTo(shown, panel.id, size))}
                onPickUp={() => {
                  dragging.current = panel.id;
                }}
                onDropOn={() => {
                  const picked = dragging.current;
                  dragging.current = null;
                  if (picked) propose(movedBefore(shown, picked, panel.id));
                }}
                refusal={refusalFor('rename_panel', panel.id) ?? refusalFor('delete_panel', panel.id)}
                busy={command.isPending}
              />
            );
          })}
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
