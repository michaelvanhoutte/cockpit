import { useRef, useState, type CSSProperties } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7, type Dashboard, type PanelKind } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { snapshotQuery, useCommand } from '../api/queries';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { useRoomForTheInbox } from '../roomForTheInbox';
import { dashboardToSwitchTo } from '../switchWhileDragging';
import { layoutsOf } from '../panels/arrangement';
import { LayoutPicker } from './LayoutPicker';
import { ManageDashboards } from './ManageDashboards';
import { MenuContent, MenuTrigger, menuItemClass } from './Menu';
import { NameQuestion } from './NameQuestion';
import { WHAT_A_DASHBOARD_IS, WHAT_A_PANEL_HOLDS, WHAT_A_PANEL_IS } from '../whatThingsAre';

/**
 * The bar under the workspace tabs: the workspace's dashboards, a `+` that adds
 * one ("Add and switch dashboards", issue 32), and - on a screen too narrow for
 * the Inbox to sit beside them - the Inbox pinned at the left.
 *
 * **The Inbox is never a dashboard**, wherever it appears. It is always there,
 * it cannot be renamed, deleted or moved, and it is not a row of the dashboards
 * table at all - so nothing can address it to change it.
 *
 * The dashboards come from the workspace's snapshot, which the page below is
 * reading anyway (architecture, "The read model: persisted snapshot,
 * revalidate, push"), so switching workspace changes this bar without a second
 * call of its own to keep in step.
 */
export function DashboardBar({
  workspaceId,
  tint,
  ground,
  openDashboardId = null,
}: {
  workspaceId: string;
  /**
   * The dashboard being looked at, so resting a drag on its own tab is not a
   * switch ("Scroll while dragging, and switch dashboards by resting on one",
   * issue 143).
   */
  openDashboardId?: string | null;
  /** The workspace's saturated colour, marking the tab you are on. */
  tint: string;
  /** The page's color, which the tab you are on is filled with so it meets it. */
  ground: string;
}) {
  const { data } = useQuery(snapshotQuery(workspaceId));
  const dashboards = data?.dashboards ?? [];
  const roomForTheInbox = useRoomForTheInbox();
  const navigate = useNavigate();

  /**
   * Whether the list of dashboards is open over the workspace, and the control
   * it was opened from, which gets the focus back when it closes.
   *
   * The menu's own control is the only way in, so the dialog has no trigger to
   * return to and Radix would leave the focus at the top of the page - which,
   * from a bar you were half way along, is losing your place.
   */
  const [managing, setManaging] = useState(false);
  const barMenu = useRef<HTMLButtonElement>(null);
  /**
   * That the entry just chosen opens something, so the menu closing must not
   * pull the focus back onto its own control - it would take it straight off
   * the dialog that has just opened. `RowMenu` does this for the row menus; the
   * bar's menu is not a row's, and this is the whole of what it borrows.
   */
  const opening = useRef(false);

  /**
   * Which dashboard's name a drag is resting on, and since when.
   *
   * A ref: nothing on screen depends on it, and it changes on every `dragover`
   * - which fires several times a second - so holding it in state would redraw
   * the whole bar under a drag for nothing.
   */
  const restingOn = useRef<{ dashboardId: string; since: number } | null>(null);

  /**
   * A drag held over a dashboard's name switches to it, so a row can be
   * dropped on a panel that is not on the screen it started from ("Scroll while
   * dragging, and switch dashboards by resting on one", issue 143).
   *
   * **Decided on the drag events themselves rather than on a timer**, because
   * `dragover` keeps firing while a drag is held still - which is exactly the
   * gesture this is about - so a timer would be a second clock saying the same
   * thing.
   */
  const restOn = (event: React.DragEvent, dashboardId: string) => {
    // Only a row of ours. A panel is dragged between panels and never over this
    // bar on purpose.
    if (!event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
    // Which makes the bar somewhere a drag can be held at all: without it the
    // browser refuses the pointer and the drag reads as leaving the window.
    event.preventDefault();
    const now = Date.now();
    if (restingOn.current?.dashboardId !== dashboardId) {
      restingOn.current = { dashboardId, since: now };
      return;
    }
    const switchTo = dashboardToSwitchTo(restingOn.current, now, openDashboardId);
    if (!switchTo) return;
    restingOn.current = null;
    void navigate({
      to: '/w/$workspaceId/d/$dashboardId',
      params: { workspaceId, dashboardId: switchTo },
    });
  };

  /** Leaving a name starts the dwell over rather than counting the two together. */
  const leftIt = () => {
    restingOn.current = null;
  };

  /**
   * A row let go on a dashboard's name does nothing, and says so.
   *
   * `restOn` prevents the default on `dragover`, which is what makes a tab
   * somewhere a drag can be held at all - and that also makes it somewhere a
   * drop can *happen*. Without preventing the default here too, the browser
   * takes the drop itself and follows the text on the transfer as a link,
   * leaving the workspace. A tab is a place to pass over, not a place to land.
   */
  const droppedOnIt = (event: React.DragEvent) => {
    if (event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) event.preventDefault();
    restingOn.current = null;
  };

  /*
   * Rounded at the top only, and filled with the page's color when it is the
   * one you are on, so the tab runs into the page under it with no line
   * between them. The color arrives as a custom property rather than as a
   * class because it is the workspace's and only known at runtime, and it
   * goes through `.active` rather than through a comparison here so the
   * router stays the one thing that decides which tab is current.
   *
   * **The fill alone was not enough to say which one you are on.** The strip
   * and the page are one step apart by design, which is eight values of grey -
   * plenty to make a joined tab read as joined, and not nearly enough to make
   * it read as *selected* when you are looking for it. So the tab you are on
   * also carries the workspace's own colour along its top edge, which is the
   * one saturated thing on this bar and cannot be mistaken for a shade.
   *
   * It is an inset shadow rather than a border so the tab does not change
   * height when it becomes the current one, which would shuffle the whole
   * strip by two pixels on every switch.
   */
  const tabClass =
    'shrink-0 whitespace-nowrap rounded-t-md px-2.5 pt-1 pb-1.5 text-sm text-chrome-ink-soft hover:bg-white/8 hover:text-chrome-ink [&.active]:bg-[var(--tab-on)] [&.active]:font-medium [&.active]:text-ink [&.active]:shadow-[inset_0_2px_0_0_var(--tab-mark)]';

  return (
    <nav
      aria-label="Dashboards"
      // No background of its own: the band around it is the workspace's, and is
      // painted by the shell so the tabs can be inset from the left without a
      // seam showing where this element starts.
      className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto px-3 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ '--tab-on': ground, '--tab-mark': tint } as CSSProperties}
    >
      {/* Only where the Inbox is not already on screen. Where there is room it
          is a column beside the dashboards rather than one of them ("Show the
          Inbox beside the dashboards instead of as a tab", issue 117), and a
          tab that switched to something already in front of you is not a
          switch. */}
      {!roomForTheInbox && (
        <Link
          to="/w/$workspaceId/inbox"
          params={{ workspaceId }}
          className={tabClass}
        >
          Inbox
        </Link>
      )}
      {dashboards.map((dashboard: Dashboard) => (
        <Link
          key={dashboard.id}
          to="/w/$workspaceId/d/$dashboardId"
          params={{ workspaceId, dashboardId: dashboard.id }}
          onDragOver={(event) => restOn(event, dashboard.id)}
          onDragLeave={leftIt}
          onDrop={droppedOnIt}
          className={tabClass}
        >
          {dashboard.name}
        </Link>
      ))}
      <AddDashboard workspaceId={workspaceId} />

      {/* The open dashboard's own controls, at the right of its own bar: which
          arrangement you are looking at, and the way to put another panel on it
          ("Pick the layout you are on, by name").

          **Here rather than under the board**, which is where both used to be.
          Adding a panel was a hairline strip at the foot of the sheet, so on a
          dashboard whose panels did not fill the screen it was a rule across
          the middle of an empty page with a link at one end of it; the layouts
          menu sat beside it, which is the last place anybody looked for the
          thing that decides what the whole board is. This bar is the one strip
          on screen that is about *this dashboard*, and the tab whose
          arrangement these name is an inch to the left.

          **Only where a dashboard is open.** The bar is drawn on the Inbox as
          well, where there is neither a layout to pick nor a dashboard to put a
          panel on - which is exactly why these were kept off it before, and it
          is answered by mounting them rather than by moving them. */}
      {openDashboardId && (
        <div className="ml-auto flex shrink-0 items-end gap-1 pl-2">
          <LayoutPicker
            // Keyed by the dashboard, for the reason the board is keyed by it
            // (DashboardPage): the half-typed layout name and the open
            // question belong to the dashboard being left. This bar is the
            // shell's and stays mounted across a switch, so nothing else drops
            // them.
            key={openDashboardId}
            workspaceId={workspaceId}
            dashboardId={openDashboardId}
            layouts={layoutsOf(data?.layouts ?? [], openDashboardId)}
            panels={(data?.panels ?? []).filter((p) => p.dashboardId === openDashboardId)}
          />
          <AddPanel workspaceId={workspaceId} dashboardId={openDashboardId} />
        </div>
      )}

      {/* The way to what a dashboard has beyond its name. This was three dots
          that navigated - a menu's glyph on a link, so pressing three dots
          sometimes opened a menu and sometimes left the page. It is a menu now
          ("Open every menu from the same control", issue 115).

          This is the bar's menu, and it holds what is true of the whole bar:
          one entry today, more later. */}
      <DropdownMenu.Root>
        <MenuTrigger
          label="Dashboard actions"
          onChrome
          className={`mb-1${openDashboardId ? '' : ' ml-auto'}`}
          ref={barMenu}
        />
        <MenuContent
          onCloseAutoFocus={(event) => {
            const claimed = opening.current;
            opening.current = false;
            if (claimed) event.preventDefault();
          }}
        >
          {/* An entry rather than a link: the list opens over the workspace
              instead of replacing it, so renaming a dashboard is a detour and
              not a journey. */}
          <DropdownMenu.Item
            className={menuItemClass}
            onSelect={() => {
              opening.current = true;
              setManaging(true);
            }}
          >
            Manage dashboards
          </DropdownMenu.Item>
        </MenuContent>
      </DropdownMenu.Root>
      <ManageDashboards
        workspaceId={workspaceId}
        open={managing}
        onClose={() => setManaging(false)}
        returnFocusTo={barMenu.current}
      />
    </nav>
  );
}

/**
 * The `+`, and the dialog it opens.
 *
 * **It grew a field at the end of the bar instead, until this.** The argument
 * was that the field belonged where the tab it names would appear, and it held
 * right up until the question had something to say: pressing `+` is the moment
 * somebody is asking what a dashboard *is*, and a strip has room for a box and
 * a button and nothing else. Adding a panel had been asked in a dialog all
 * along, so the two are one question in two places now rather than two shapes.
 *
 * **The `+` stays where it is while the question is open**, where the field
 * replaced it - so the controls to its right no longer move by the width of a
 * box every time somebody adds a dashboard.
 */
function AddDashboard({ workspaceId }: { workspaceId: string }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const command = useCommand();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // The id is made here rather than inside the payload so that the dashboard
    // to switch to is known before the answer comes back.
    const dashboardId = uuidv7();
    command.mutate(
      {
        name: 'add_dashboard',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          dashboardId,
          // The panel it arrives with, made here for the reason the dashboard's
          // own id is.
          panelId: uuidv7(),
          name: trimmed,
        },
      },
      // Closed, emptied, and switched to only once it worked. A refusal leaves
      // the field open with what was typed still in it, so the name can be
      // fixed rather than typed again.
      {
        onSuccess: async () => {
          close();
          // Re-read before going there. The dashboard's own route checks that
          // it is one of the workspace's, against the snapshot in hand - and
          // the snapshot in hand is the one from before this dashboard
          // existed, so without this it decides the new dashboard is not real
          // and sends you back to the one you were already on: adding one
          // would look like doing nothing.
          //
          // Here rather than in the route because this is where it is known to
          // be needed, and where the network is known to be working: the add
          // has just come back.
          await queryClient.refetchQueries({ queryKey: ['snapshot', workspaceId] });
          // You are put on the dashboard you just made: adding one and then
          // having to find it in the bar is two gestures for what reads as one.
          void navigate({
            to: '/w/$workspaceId/d/$dashboardId',
            params: { workspaceId, dashboardId },
          });
        },
      },
    );
  };

  // The server's words where it gave any ("a dashboard called Research already
  // exists in this workspace"), and something plain where the request never got
  // an answer.
  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  /**
   * Closing forgets the refusal with it. `AddDashboard` stays mounted either
   * way, so a refusal that is only hidden would come back the moment the dialog
   * is opened again, over a name nobody has typed yet.
   */
  const close = () => {
    setNaming(false);
    setName('');
    command.reset();
  };

  return (
    <>
      <button
        type="button"
        ref={button}
        onClick={() => setNaming(true)}
        aria-label="Add a dashboard"
        className="mb-1 shrink-0 rounded-md px-2.5 py-1 text-sm text-chrome-ink-faint hover:bg-white/10 hover:text-chrome-ink"
      >
        +
      </button>
      <NameQuestion
        open={naming}
        question="What is the new dashboard called?"
        explains={WHAT_A_DASHBOARD_IS}
        fieldLabel="Name of the new dashboard"
        placeholder="Project Falcon, Research, Today…"
        submitLabel="Add"
        name={name}
        onNameChange={setName}
        onSubmit={submit}
        onCancel={close}
        refusal={refusal}
        busy={command.isPending}
        returnFocusTo={button.current}
      />
    </>
  );
}

/**
 * The way to put another panel on the dashboard you are looking at.
 *
 * **In the bar rather than at the foot of the board** ("Pick the layout you are
 * on, by name"). It was a hairline strip under the panels, which could say that
 * a panel would appear but not where - and on a dashboard whose panels did not
 * fill the screen it read as a rule drawn across the middle of an empty page.
 *
 * **The name is asked for in a dialog** (NameQuestion), not in a field grown
 * here, unlike the `+` that adds a dashboard a few controls to the left. The
 * difference is where the field would go: that one grows at the end of a bar,
 * where the tab it is naming will be, while this one would grow between two
 * controls and push the menu beside it out from under the pointer.
 *
 * The command is here rather than on the board because this is all it needs -
 * the workspace and the dashboard - and the server puts the new panel into
 * every layout of that dashboard itself (command-service.ts).
 */
function AddPanel({ workspaceId, dashboardId }: { workspaceId: string; dashboardId: string }) {
  const [naming, setNaming] = useState<string | null>(null);
  /**
   * What the new panel holds, asked here because here is the only place it can
   * be: it is settled when the panel is made and never after
   * (`panelKindSchema`), so a panel added without being asked would be a panel
   * of items nobody chose.
   */
  const [kind, setKind] = useState<PanelKind>('items');
  const command = useCommand();
  const button = useRef<HTMLButtonElement>(null);

  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  const add = () => {
    const trimmed = (naming ?? '').trim();
    if (!trimmed) return;
    command.mutate(
      {
        name: 'add_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          dashboardId,
          panelId: uuidv7(),
          name: trimmed,
          kind,
        },
      },
      // Closed and emptied only once it worked, so a refused title is still
      // there to be corrected rather than typed again.
      { onSuccess: () => setNaming(null) },
    );
  };

  return (
    <>
      <button
        type="button"
        ref={button}
        onClick={() => {
          command.reset();
          // Back to Items every time it opens. The kind is not a preference -
          // it is a question about the panel being made now, and carrying the
          // last answer into it would decide it for somebody who never looked.
          setKind('items');
          setNaming('');
        }}
        className="mb-1 shrink-0 rounded-md border border-white/15 bg-white/6 px-2 py-1 text-xs text-chrome-ink hover:bg-white/12 focus-visible:outline-2 focus-visible:outline-chrome-ink-soft"
      >
        + Panel
      </button>
      <NameQuestion
        open={naming !== null}
        question="What is the new panel called?"
        explains={WHAT_A_PANEL_IS}
        alsoAsks={<WhatItHolds kind={kind} onKindChange={setKind} />}
        fieldLabel="Name of the new panel"
        placeholder="One-on-ones, Waiting on…"
        submitLabel="Add"
        name={naming ?? ''}
        onNameChange={setNaming}
        onSubmit={add}
        onCancel={() => {
          setNaming(null);
          command.reset();
        }}
        refusal={refusal}
        busy={command.isPending}
        returnFocusTo={button.current}
      />
    </>
  );
}

/**
 * What the new panel holds, asked in the same breath as its name.
 *
 * **Two choices in the naming question rather than two controls on the bar.**
 * The bar already carries the dashboards, a `+`, the layout picker and a menu,
 * and a fifth control would push one of them off a laptop. It is also the
 * honest shape: this is one decision with two answers, made at the only moment
 * it can be made.
 *
 * Radios rather than buttons, because that is what a choice between two
 * exclusive answers is - and what gives a keyboard the arrow keys and a screen
 * reader "one of two". The circles are hidden and the whole card is the target,
 * which is why the label carries the focus ring.
 */
function WhatItHolds({
  kind,
  onKindChange,
}: {
  kind: PanelKind;
  onKindChange: (kind: PanelKind) => void;
}) {
  return (
    <fieldset className="mt-6">
      {/* `block` and a margin, not padding: a legend is laid out in the
          fieldset's top border rather than in its content box, so padding on
          either moves everything except the words. */}
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
        What it holds
      </legend>
      <div className="flex gap-2">
        {WHAT_A_PANEL_HOLDS.map((choice) => (
          <label
            key={choice.kind}
            className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
              kind === choice.kind
                ? 'border-accent bg-accent-tint text-accent-deep'
                : 'border-black/10 hover:bg-accent-tint/50'
            }`}
          >
            <input
              type="radio"
              name="panel-kind"
              value={choice.kind}
              className="sr-only"
              checked={kind === choice.kind}
              onChange={() => onKindChange(choice.kind)}
            />
            <span className="block font-medium">{choice.label}</span>
            <span className="block pt-0.5 text-xs text-ink-soft">{choice.says}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
