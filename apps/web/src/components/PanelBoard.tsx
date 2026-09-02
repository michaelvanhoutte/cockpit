import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { GRID_COLUMNS, uuidv7 } from '@cockpit/shared';
import type { Dashboard, Layout, Panel, PanelPlacement } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useCommand } from '../api/queries';
import { browserStore } from '../lastVisited';
import { chooseLayout, chosenFor } from '../panels/chosenLayout';
import { useMeasuredWidth, useScreenWidth } from '../panels/useScreenWidth';
import {
  drawnArrangement,
  fittedToScreen,
  layoutToDraw,
  madeForThisScreen,
  movedBefore,
  movedBy,
  panelsAcross,
  resizedTo,
  sameArrangement,
  SAME_SCREEN_TOLERANCE,
} from '../panels/arrangement';
import { DeleteQuestion } from './DeleteQuestion';
import { LayoutQuestion } from './LayoutQuestion';
import { MenuContent, MenuTrigger, menuItemClass } from './Menu';
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
}: {
  workspaceId: string;
  dashboard: Dashboard;
  panels: readonly Panel[];
  layouts: readonly Layout[];
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

  const [chosen, setChosen] = useState<string | null>(() =>
    chosenFor(browserStore(), dashboard.id),
  );
  /**
   * An arrangement that has been made but not yet stored - dragged, resized or
   * fitted. It is what the grid draws while it exists, so the panel really does
   * move under the hand that moved it, and it is dropped once the store has
   * been re-read and agrees.
   */
  const [draft, setDraft] = useState<PanelPlacement[] | null>(null);
  /** The arrangement waiting on the question of which layout to keep it in. */
  const [asking, setAsking] = useState<PanelPlacement[] | null>(null);
  /**
   * The last arrangement actually sent, which is not the same as the last one
   * drawn: a corner still being dragged is drawn every pointer move and sent
   * only when the hand stops. Comparing a new gesture against what is *drawn*
   * would make the release of that drag look like no change at all and drop it.
   */
  const sent = useRef<PanelPlacement[] | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /** Which panel is being dragged. A ref: nothing on screen depends on it. */
  const dragging = useRef<string | null>(null);
  /** The control a question was opened from, so the focus can go back to it. */
  const askedFrom = useRef<HTMLElement | null>(null);

  const its = layouts.filter((layout) => layout.dashboardId === dashboard.id);
  const drawnWith = layoutToDraw(layouts, dashboard.id, screenWidth, chosen);
  const stored = drawnArrangement(drawnWith, panels, acrossWidth);
  const shown = draft ?? stored;
  const sideBySide = panelsAcross(acrossWidth) > 1;
  /**
   * Read from the list rather than kept beside the id, for the reason the
   * dashboard settings page does it: a panel deleted in another tab is gone
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
  const refusalFor = (what: 'rename_panel' | 'delete_panel' | 'add_panel' | 'save_layout', id?: string) => {
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
    setAsking(null);
    sent.current = null;
  };

  const saveArrangement = (
    layoutId: string,
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
          // A layout picked by hand is drawn ahead of the closest one, so a
          // new layout made while one is picked would be saved and then not
          // drawn: the board would go back to the old one and the change would
          // read as having reverted. Repointed rather than cleared, because
          // "make a layout for this screen" is a request to be on it - and
          // `deleteLayout` below does the same bookkeeping the other way.
          if (chosen && chosen !== layoutId) chooseFor(layoutId);
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
   * would define a second layout at the same width, and the Layouts menu would
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
   * What every gesture that changes the arrangement ends in: keep it if there
   * is only one place it could go, and otherwise ask.
   *
   * A new layout is made silently when there is none, because "change the
   * layout you are on" is not an answer when you are not on one.
   */
  const propose = (
    next: PanelPlacement[],
    { from = null, record = false }: { from?: HTMLElement | null; record?: boolean } = {},
  ) => {
    // Against what has been *sent* - or the store, where nothing has - rather
    // than against what is drawn. Three cases have to come out right, and only
    // this comparison gets all three: a corner drag is drawn on every pointer
    // move and sent once at the end, so measuring its release against what is
    // drawn would make it look like no change; a gesture that puts a panel back
    // where the snapshot has it still has to be sent when an earlier one moved
    // it; and a gesture that really changes nothing must send nothing.
    //
    // `record` is the exception, and it is "Fit to this screen" on a dashboard
    // that has no layout: what it computes is exactly what such a dashboard is
    // already drawn with (arrangement.ts), so nothing moves - and the point of
    // pressing it, recording a layout for this screen, has still not happened.
    if (!record && sameArrangement(next, sent.current ?? stored)) return;
    command.reset();
    setDraft(next);
    askedFrom.current = from;
    if (!drawnWith) {
      saveArrangement(layoutForThisScreen(), screenWidth, next);
      return;
    }
    if (madeForThisScreen(drawnWith, screenWidth)) {
      saveArrangement(drawnWith.id, drawnWith.screenWidth, next);
      return;
    }
    setAsking(next);
  };

  const addPanel = (name: string) => {
    command.mutate(
      {
        name: 'add_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          dashboardId: dashboard.id,
          panelId: uuidv7(),
          name,
        },
      },
      // Closed and emptied only once it worked, so a refused title is still
      // there to be corrected rather than typed again.
      { onSuccess: () => setNaming(null) },
    );
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

  const chooseFor = (layoutId: string | null) => {
    chooseLayout(browserStore(), dashboard.id, layoutId);
    setChosen(layoutId);
  };

  const deleteLayout = (layoutId: string) => {
    command.mutate(
      {
        name: 'delete_layout',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          layoutId,
        },
      },
      {
        onSuccess: () => {
          // The choice goes with the layout. Leaving it would only fall through
          // to the closest remaining one anyway (arrangement.ts), but a stored
          // id naming nothing is a thing to explain later rather than now.
          if (chosen === layoutId) chooseFor(null);
        },
      },
    );
  };

  return (
    <div ref={measure} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto min-w-0 truncate text-base font-semibold">{dashboard.name}</h2>

        {naming === null ? (
          <button
            type="button"
            onClick={() => {
              command.reset();
              setNaming('');
            }}
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-deep"
          >
            Add a panel
          </button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = naming.trim();
              if (trimmed) addPanel(trimmed);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setNaming(null);
                command.reset();
              }
            }}
            className="flex shrink-0 items-center gap-2"
          >
            <input
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              aria-label="Name of the new panel"
              placeholder="Project Falcon, To read…"
              maxLength={60}
              autoFocus
              className="w-44 rounded-md border border-black/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
            />
            <button
              type="submit"
              disabled={command.isPending}
              className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-deep disabled:opacity-50"
            >
              Add
            </button>
          </form>
        )}

        {/* The button the issue asks for: rearrange what is here for the screen
            it is on now, keeping the order and filling rows left to right. It
            goes through the same question as a drag, because it changes the
            arrangement in exactly the same way. */}
        <button
          type="button"
          disabled={shown.length === 0}
          onClick={(e) =>
            propose(fittedToScreen(shown, acrossWidth), {
              from: e.currentTarget,
              record: !drawnWith,
            })
          }
          className="shrink-0 rounded-md border border-black/10 px-2.5 py-1 text-xs hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
        >
          Fit to this screen
        </button>

        <DropdownMenu.Root>
          <MenuTrigger label="Layouts" />
          <MenuContent>
            <DropdownMenu.Label className="px-2 py-1 text-xs text-ink-faint">
              Layout for this dashboard
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={chosen ?? AUTOMATIC}
              onValueChange={(value) => chooseFor(value === AUTOMATIC ? null : value)}
            >
              <DropdownMenu.RadioItem value={AUTOMATIC} className={menuItemClass}>
                Whichever fits this screen
              </DropdownMenu.RadioItem>
              {its.map((layout) => (
                <DropdownMenu.RadioItem
                  key={layout.id}
                  value={layout.id}
                  className={menuItemClass}
                >
                  {`Made for ${layout.screenWidth} px`}
                  {layout.id === drawnWith?.id && (
                    <span className="block text-xs text-ink-faint">in use</span>
                  )}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            {drawnWith && (
              <DropdownMenu.Item
                className={`${menuItemClass} text-over data-[highlighted]:bg-over/10 data-[highlighted]:text-over`}
                onSelect={() => deleteLayout(drawnWith.id)}
              >
                {`Delete the ${drawnWith.screenWidth} px layout`}
              </DropdownMenu.Item>
            )}
          </MenuContent>
        </DropdownMenu.Root>
      </div>

      {(refusalFor('add_panel') ?? refusalFor('save_layout')) && !asking && (
        <p role="alert" className="text-sm text-over">
          {refusalFor('add_panel') ?? refusalFor('save_layout')}
        </p>
      )}

      {panels.length === 0 ? (
        <section className="rounded-lg bg-surface px-4 py-10 text-center shadow-panel">
          <p className="text-sm text-ink-faint">
            Nothing on this dashboard yet. Panels are what go here.
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

      {asking && drawnWith && (
        <LayoutQuestion
          open
          madeFor={drawnWith.screenWidth}
          screenWidth={screenWidth}
          canAnswer={!command.isPending}
          refusal={refusalFor('save_layout')}
          returnFocusTo={askedFrom.current}
          onCancel={() => {
            // The change goes back with the question: what was asked was where
            // to keep it, and "nowhere" is an answer.
            setAsking(null);
            setDraft(null);
            command.reset();
          }}
          onChangeThisLayout={() =>
            saveArrangement(drawnWith.id, drawnWith.screenWidth, asking)
          }
          onMakeANewLayout={() => saveArrangement(layoutForThisScreen(), screenWidth, asking)}
        />
      )}
    </div>
  );
}

/** The radio value standing for "no layout chosen by hand", which is the default. */
const AUTOMATIC = 'automatic';
