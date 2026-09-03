import { useRef, useState, type CSSProperties } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7, type Dashboard } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { snapshotQuery, useCommand } from '../api/queries';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { useRoomForTheInbox } from '../roomForTheInbox';
import { dashboardToSwitchTo } from '../switchWhileDragging';
import { MenuContent, MenuTrigger, menuItemClass } from './Menu';

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
   * class because it is the workspace's and only known at runtime, and it goes
   * through `.active` rather than through a comparison here so the router
   * stays the one thing that decides which tab is current.
   */
  /*
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
    'shrink-0 whitespace-nowrap rounded-t-md px-2.5 pt-1 pb-1.5 text-sm text-ink-soft hover:bg-black/5 [&.active]:bg-[var(--tab-on)] [&.active]:font-medium [&.active]:text-ink [&.active]:shadow-[inset_0_2px_0_0_var(--tab-mark)]';

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
      {/* The way to what a dashboard has beyond its name. This was three dots
          that navigated - a menu's glyph on a link, so pressing three dots
          sometimes opened a menu and sometimes left the page. It is a menu now
          ("Open every menu from the same control", issue 115).

          This is the bar's menu, and it holds what is true of the whole bar:
          one entry today, more later. Layouts were expected here and are not -
          they went into the dashboard's own header beside the panels they
          arrange ("Panels on a dashboard, with per-screen-size layouts", issue
          33), because this bar is also drawn on the Inbox, where there is no
          dashboard to have a layout. */}
      <DropdownMenu.Root>
        <MenuTrigger label="Dashboard actions" className="mb-1 ml-auto" />
        <MenuContent>
          <DropdownMenu.Item asChild>
            <Link
              to="/w/$workspaceId/settings/dashboards"
              params={{ workspaceId }}
              className={menuItemClass}
            >
              Manage dashboards
            </Link>
          </DropdownMenu.Item>
        </MenuContent>
      </DropdownMenu.Root>
    </nav>
  );
}

/**
 * The `+`, and the field it grows where the new tab will be. Adding a dashboard
 * is a one-gesture thing you do often, unlike making a workspace, so it asks
 * for the name in place rather than in a dialog.
 */
function AddDashboard({ workspaceId }: { workspaceId: string }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const command = useCommand();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
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
   * Closing the field forgets the refusal with it. `AddDashboard` stays
   * mounted either way - the `+` and the field are two renders of it - so a
   * refusal that is only hidden comes back the moment the field is opened
   * again, over a name nobody has typed yet.
   */
  const close = () => {
    setNaming(false);
    setName('');
    command.reset();
  };

  if (!naming) {
    return (
      <button
        type="button"
        onClick={() => setNaming(true)}
        aria-label="Add a dashboard"
        className="mb-1 shrink-0 rounded-md px-2.5 py-1 text-sm text-ink-faint hover:bg-black/5 hover:text-ink"
      >
        +
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      // Escape on the form rather than on the box: after a refusal the focus is
      // on Add, and a handler that only listened to the box would leave Escape
      // doing nothing exactly when there is something to cancel.
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
      className="mb-1 flex shrink-0 items-center gap-2"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Name of the new dashboard"
        placeholder="Research, Today…"
        maxLength={60}
        autoFocus
        className="w-40 rounded-md border border-black/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      />
      <button
        type="submit"
        disabled={command.isPending}
        className="milled shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-deep disabled:opacity-50"
      >
        Add
      </button>
      {refusal && (
        <p role="alert" className="text-xs text-over">
          {refusal}
        </p>
      )}
    </form>
  );
}
