import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WORKSPACE_THEMES, themeOf, uuidv7 } from '@cockpit/shared';
import type { Workspace, WorkspaceTheme } from '@cockpit/shared';
import { changes } from '../api/changes';
import { snapshotQuery, useSendCommand, whyNotDone as whyNot } from '../api/queries';
import { useWorkspaces } from '../api/useWorkspaces';
import { setAllItemsTab, useAllItemsOnScreen, useAllItemsTabs } from '../allItemsTab';
import { litForChrome } from '../chrome';
import { keepingTheOpenItem } from '../itemForm';
import { survivingWorkspace } from '../landing';
import { useTabDrag } from '../tabDrag';
import { useUndo } from '../undo';
import { DeleteQuestion } from './DeleteQuestion';
import { RowMenu, SurfaceMenu, opensOnPress, type MenuEntry } from './Menu';
import { RowForm } from './RowForm';
import { takeRecurringRequest, useRecurringRequest } from '../recurringModal';

// The Recurring items modal, fetched only once it has been asked for.
const RecurringModal = lazy(() => import('./RecurringModal'));

/**
 * The workspaces across the top, and everything that can be done to one
 * ("Change a workspace or a dashboard on the tab it is", issue 267): its name
 * and colour on a form, its place in the strip, and deleting it.
 *
 * **It was a window opened from the header's menu**, and the window was two
 * presses away from a strip you are looking at - so renaming the workspace in
 * front of you meant finding a list of every workspace, finding this one in it,
 * and opening its row's menu. The tab already names the thing and already sits
 * under the pointer; the menu it carries is the whole of what that list was
 * for. What went with the window: the box that made one, which the `+` at the
 * end of the strip had already replaced, and the grip that dragged a row, which
 * is the tab itself now.
 *
 * **The Capture tab has no menu.** It is a screen rather than a workspace
 * (functional definition, "Container hierarchy"), so there is nothing on it to
 * rename, move or delete - and it stays in the shell rather than here.
 *
 * **Every change is shown the moment it is made** ("Show a Workspace rename,
 * colour, delete or reorder the moment you make it", issue 1365): drawn over
 * the list of Workspaces (`drawnAhead.ts`), the form and the question closing at
 * the click. A refusal that arrives later puts the tab back and says why in the
 * undo bar.
 */
export function WorkspaceTabs({
  /** The `+` at the end of the strip, which makes a workspace rather than changing one. */
  children,
  /** The colour of the band the strip sits in, which the tab you are on is filled with. */
  bar,
  /** The tab you are on, brought into view by the shell that knows when to. */
  bringIntoView,
}: {
  children: React.ReactNode;
  bar: string;
  bringIntoView: (tab: HTMLAnchorElement) => void;
}) {
  const { data } = useWorkspaces();
  const workspaces = data?.workspaces ?? [];
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const allItemsTabOn = useAllItemsTabs();

  /**
   * The workspace whose form is open, and the draft in it: the name typed so
   * far and the theme picked so far. Nothing here has been sent - Save is what
   * sends it, and Cancel discards both halves together.
   */
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    /**
     * The theme picked, or null for one nobody has touched - which is not the
     * same as the theme the workspace is wearing. A workspace can wear a tint
     * the palette does not have, so the swatch shown pressed is looked up
     * (`themeOf` falls back to the first) and is *not* what the workspace
     * stores: filling this in with that lookup would make every such
     * workspace's name-only Save also repaint it, to a colour nobody chose.
     */
    theme: WorkspaceTheme | null;
  } | null>(null);
  /** The workspace whose delete is waiting to be confirmed. */
  const [deleting, setDeleting] = useState<string | null>(null);
  // The Workspace whose Recurring items modal is open, if any.
  const [recurring, setRecurring] = useState<{ workspaceId: string; seriesId?: string } | null>(null);
  // A copy's *From recurring item* line asks for the modal open on its recurring item's form.
  const asked = useRecurringRequest();
  useEffect(() => {
    if (!asked) return;
    const request = takeRecurringRequest();
    if (!request) return;
    // Asked from an Item's form, which has closed: not the menu or tab an earlier open came from.
    askedFrom.current = null;
    setRecurring(request);
  }, [asked]);
  /**
   * The tab the form or the question was opened from, so the focus can go back
   * to it. A ref rather than state: nothing on screen depends on it, and it is
   * read only as the thing it opened closes.
   */
  const askedFrom = useRef<HTMLElement | null>(null);
  /**
   * The workspace just deleted, while the focus is still owed to the strip.
   * Null once it has been given somewhere.
   *
   * Which one it was is the whole of what this has to remember: the tab is
   * still drawn for as long as the list in hand holds it, so "is there a tab
   * to focus" would put the focus on the one about to be taken away.
   */
  const focusOwedAfterDeleting = useRef<string | null>(null);

  const order = workspaces.map((w) => w.id);

  /**
   * Moves a workspace, and shows it moved before the server has agreed.
   *
   * **Drawn over the list, put back if it is refused**, which is correctness
   * rather than feel: the order a move is computed from is the order in hand, so
   * a second move made before the first came back would be computed from the
   * list *before* the first and would undo it. The order is drawn where the
   * list is read (`drawnAhead.ts`), which is what makes two moves in a row
   * compose. A refusal puts the tabs back and says why in the undo bar.
   */
  const move = (workspaceId: string, moved: string[]) => {
    send({
      name: 'reorder_workspaces',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        workspaceIds: moved,
      },
    }).catch((failure: unknown) => {
      offerToUndo({ what: `The workspaces were not put in that order. ${whyNot(failure)}` });
    });
  };

  const drag = useTabDrag({ order, onDrop: move });
  const shown = drag.shown.flatMap((id) => workspaces.filter((w) => w.id === id));

  /**
   * What the form has to send: the halves that actually moved, and nothing
   * else. An untouched box must send no change at all, or it would carry the
   * value the form was opened with over an edit made somewhere else in the
   * meantime - and a colour nobody touched would bump the theme on every
   * rename.
   *
   * **The form closes at the click.** The tab shows the new name and colour at
   * once, and each half is its own change, so a name the server refuses puts the
   * old name back and says why in the undo bar without undoing the colour.
   */
  const saveForm = () => {
    if (!editing) return;
    const was = workspaces.find((w) => w.id === editing.id);
    const named = editing.name.trim();
    if (!was || !named) return;
    const envelope = () => ({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: editing.id,
    });

    if (named !== was.name) {
      send({ name: 'rename_workspace', payload: { ...envelope(), name: named } }).catch((failure: unknown) => {
        offerToUndo({ what: `“${was.name}” was not renamed to “${named}”. ${whyNot(failure)}` });
      });
    }
    if (editing.theme && editing.theme.tint !== was.color) {
      send({
        name: 'set_workspace_theme',
        payload: {
          // All four, because the command still carries them. The server
          // checks only the tint is a palette accent, and stores its theme.
          ...envelope(),
          color: editing.theme.tint,
          bar: editing.theme.bar,
          ground: editing.theme.ground,
          header: editing.theme.header,
        },
      }).catch((failure: unknown) => {
        offerToUndo({ what: `“${was.name}” was not recoloured. ${whyNot(failure)}` });
      });
    }
    setEditing(null);
  };

  /**
   * What is in the workspace being deleted, so the question can say what goes
   * with it. The snapshot is the app's own answer to "what is in this
   * workspace" - the Items it carries, and how many finished ones it leaves out
   * ("Open a Workspace without its finished Items", issue 1435), every one of
   * which stops being visible - so this asks that rather than adding a count to
   * the workspace list every page load would then pay for.
   */
  const contents = useQuery({ ...snapshotQuery(deleting ?? ''), enabled: deleting !== null });
  const counted = contents.data && contents.data.items.length + (contents.data.finishedItemsLeftOut ?? 0);
  /**
   * The workspace each thing is about, read from the list rather than kept
   * beside the id: one deleted in another tab is gone from the next list, and a
   * question about a workspace nothing holds closes itself instead of asking
   * about a name that is no longer there.
   */
  const beingDeleted = workspaces.find((w) => w.id === deleting);
  const beingEdited = workspaces.find((w) => w.id === editing?.id);
  /**
   * The workspace you are in, whose own actions the header's visible "…"
   * offers - the same entries the tab's own menu offers, since a right-click
   * said nothing was there ("Give the open workspace and dashboard their own
   * "…", and split the header's menu into settings and you", issue 567).
   */
  const openWorkspace = workspaces.find((w) => w.id === params.workspaceId);

  /**
   * Deletes at the click: the tab is gone at once, and deleting the one you are
   * on lands on the next in the list as drawn, or on the screen that makes one
   * when it was the last. A refusal brings the tab back and says why in the
   * undo bar.
   *
   * Not `/`, which opens on Capture on a phone: you were deleting a workspace,
   * not jotting something down (`landing.ts`). **Only where the screen behind
   * the question stops working**, which is two cases: the one you are looking
   * at, and the last one, which names no workspace at all (capture is under the
   * shell in no workspace, so `params.workspaceId` is undefined there).
   */
  const confirmDelete = (workspaceId: string) => {
    const was = workspaces.find((w) => w.id === workspaceId)?.name ?? 'The workspace';
    // Before the question closes, which is what the focus effect below runs after.
    focusOwedAfterDeleting.current = workspaceId;
    send({
      name: 'delete_workspace',
      payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId },
    }).catch((failure: unknown) => {
      if (focusOwedAfterDeleting.current === workspaceId) focusOwedAfterDeleting.current = null;
      offerToUndo({ what: `“${was}” was not deleted. ${whyNot(failure)}` });
    });
    setDeleting(null);
    const left = workspaces.filter((w) => w.id !== workspaceId);
    if (params.workspaceId !== workspaceId && left.length > 0) return;
    const next = survivingWorkspace(left);
    void navigate(
      next.to === 'start' ? { to: '/start' } : { to: '/w/$workspaceId', params: { workspaceId: next.workspaceId } },
    );
  };

  /**
   * The focus, once a delete has taken the tab it was asked from.
   *
   * It goes to the tab you are on, which is the nearest thing to where you
   * were: the question closes by ceasing to exist rather than by being
   * dismissed, so nothing else puts the focus anywhere and it falls to the top
   * of the page. A frame later, because the question's own focus scope is
   * still restoring as it unmounts - onto a tab that is no longer there.
   */
  const here = params.workspaceId;
  useEffect(() => {
    const deleted = focusOwedAfterDeleting.current;
    if (!deleted || beingDeleted) return;
    // Nowhere to put it: capture is under the shell in no workspace, so there
    // is no tab to land on. Forgotten rather than kept, or the next workspace
    // opened by hand would have the focus taken to its tab by a delete made
    // minutes ago.
    if (!here) {
      focusOwedAfterDeleting.current = null;
      return;
    }
    if (here === deleted) return;
    const tab = drag.strip.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(here)}"]`,
    );
    // Deleting the workspace you were looking at moves the app to another one,
    // and until that lands the address still names the workspace that has just
    // gone - whose tab is also still drawn, from the list in hand. So this
    // waits for an address that is not the deleted one, and runs again on the
    // workspace it lands on: what makes the focus survive rather than being
    // put on a tab about to be taken away.
    if (!tab) return;
    focusOwedAfterDeleting.current = null;
    // A frame later, because the question's own focus scope is still restoring
    // as it unmounts - onto a tab that is no longer there.
    const frame = requestAnimationFrame(() => tab.focus());
    return () => cancelAnimationFrame(frame);
  }, [beingDeleted, drag.strip, here]);

  /** Starting one leaves the others, so at most one tab is ever asking something. */
  const startEditing = (ws: Workspace, openedFrom: HTMLElement | null) => {
    setDeleting(null);
    askedFrom.current = openedFrom;
    setEditing({ id: ws.id, name: ws.name, theme: null });
  };
  const openRecurring = (workspaceId: string, openedFrom: HTMLElement | null) => {
    askedFrom.current = openedFrom;
    setRecurring({ workspaceId });
  };
  const startDeleting = (ws: Workspace, openedFrom: HTMLElement | null) => {
    setEditing(null);
    askedFrom.current = openedFrom;
    setDeleting(ws.id);
  };

  /**
   * Switches a workspace's *All items* tab on or off. Hiding it leaves for the
   * workspace's first dashboard when that workspace's *All items* is the page on
   * screen - a page that is not in the bar is not somewhere to stay - and never
   * moves you for another workspace's tab. The first dashboard is read from the
   * snapshot the page on screen already holds, since its route loaded it, as
   * drawn: a Dashboard deleted or moved first a moment ago counts as done.
   */
  const onItemsOf = useAllItemsOnScreen();
  const switchAllItemsTab = (workspaceId: string, on: boolean) => {
    setAllItemsTab(workspaceId, on);
    if (on || onItemsOf !== workspaceId) return;
    const held = queryClient.getQueryData(snapshotQuery(workspaceId).queryKey);
    const first = held ? changes.drawnOver(held).dashboards[0] : undefined;
    if (first) {
      void navigate({
        to: '/w/$workspaceId/d/$dashboardId',
        params: { workspaceId, dashboardId: first.id },
        search: keepingTheOpenItem,
      });
    }
  };

  /** What can be done to this workspace. */
  const entriesFor = (ws: Workspace): MenuEntry[] => [
    // One entry for changing a workspace rather than a Rename beside it: the
    // form is what renames, and two ways to reach the same box is one more
    // thing to choose between.
    { label: 'Edit…', onSelect: (from) => startEditing(ws, from) },
    // A group of its own: it switches a tab of the workspace, and is no edit to it.
    {
      label: allItemsTabOn(ws.id) ? 'Hide All items tab' : 'Show All items tab',
      separatorBefore: true,
      keepsFocus: true,
      onSelect: () => switchAllItemsTab(ws.id, !allItemsTabOn(ws.id)),
    },
    // The one way to make a recurring item, and the list of this Workspace's ("Make, change
    // and delete recurring items from the Recurring items modal", issue 1449).
    { label: 'Recurring items', onSelect: (from) => openRecurring(ws.id, from) },
    // Apart from the way in, since it is the one that cannot be put back.
    { label: 'Delete', destructive: true, separatorBefore: true, onSelect: (from) => startDeleting(ws, from) },
  ];

  return (
    <>
      {recurring && (
        <Suspense>
          <RecurringModal
            key={recurring.seriesId ?? recurring.workspaceId}
            workspaceId={recurring.workspaceId}
            {...(recurring.seriesId ? { openOn: recurring.seriesId } : {})}
            returnFocusTo={askedFrom.current}
            onClose={() => setRecurring(null)}
          />
        </Suspense>
      )}
      {/* The strip and its own trailing button share this row's width, at the
          tighter of the two gaps the header uses: the wide `gap-4` between
          the header's own sections left too little of a 480px screen for the
          strip once this button and the header's own split joined it, and a
          single long tab name could no longer be scrolled wholly into view
          ("Give the open workspace and dashboard their own "…", and split
          the header's menu into settings and you", issue 567). */}
      <div className="flex min-w-0 flex-1 items-end gap-1">
        {/* Scrolls within itself rather than widening the page: with enough
            workspaces a plain row pushed a 480px screen to 571px and took the
            whole page sideways with it. The scrollbar is hidden, the way a tab
            strip's is everywhere - drag, trackpad and keyboard focus all still
            move it, and a strip cut off at the edge already says there is more.

            Named, because it is not the only bar of links in this header: the
            dashboards of the workspace you are in sit under it, and two unnamed
            navigations are two identical landmarks to choose between. */}
        <nav
          ref={drag.strip}
          aria-label="Workspaces"
          className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {shown.map((ws) => {
            const here = ws.id === params.workspaceId;
            return (
              <SurfaceMenu key={ws.id} label={`Actions for ${ws.name}`} entries={entriesFor(ws)}>
                <Link
                  ref={here ? bringIntoView : undefined}
                  to="/w/$workspaceId"
                  params={{ workspaceId: ws.id }}
                  onClick={opensOnPress(here)}
                  {...drag.tabProps(ws.id)}
                  className={`${stripTabClass(here)} px-3${
                    drag.inTheAir === ws.id ? ' opacity-60' : ''
                  }`}
                  style={
                    {
                      // The band's own colour rather than the workspace's stored
                      // one, so the tab you are on and the strip it runs into are
                      // the same fill even when the stored copy is from an older
                      // palette (`paint`, pages/Layout.tsx).
                      ...(here ? { backgroundColor: bar } : undefined),
                      // Lifted towards white before it is drawn on the chrome
                      // (`chrome.ts`), which is where the reason is.
                      '--tab-mark': litForChrome(ws.color),
                    } as React.CSSProperties
                  }
                >
                  <span
                    className="mr-1.5 inline-block size-2 rounded-full align-middle bg-[var(--tab-mark)]"
                    // Only the one you are in glows. It is the cheapest way to
                    // say *this* workspace with a mark this small, and a bar of
                    // glowing dots would say nothing at all.
                    style={here ? { boxShadow: `0 0 8px ${ws.color}` } : undefined}
                  />
                  {ws.name}
                </Link>
              </SurfaceMenu>
            );
          })}
          {children}
        </nav>

        {/* The open workspace's own actions, at the right of this row rather
            than inside the strip above: the strip scrolls within itself,
            which would carry a fixed button off screen along with the tabs.
            The same entries the tab's own menu offers, from the same list,
            then the account's - which no tab's menu carries.

            **Gone below `sm`, the same width the wordmark already gives way
            at.** A touchscreen already has this menu a press away with no
            button at all - pressing the tab you are already on opens it,
            "the only way in that needs no gesture at all" (`Menu.tsx`,
            `SurfaceMenu`) - so the width this costs is spent only where a
            pointer has no such press to reach for. A 480px strip crowded with
            enough workspaces had no room left for it once this joined the
            header's own split: the current tab could no longer be scrolled
            wholly into view (found in review, `workspace-management.test.ts`,
            "the tab strip stays inside the screen however many workspaces
            there are"). */}
        {openWorkspace && (
          <div className="hidden shrink-0 sm:block">
            <RowMenu
              label={`Actions for ${openWorkspace.name}`}
              entries={entriesFor(openWorkspace)}
              onChrome
            />
          </div>
        )}
      </div>

      {/* Read from the list, so a form left open on a workspace deleted in
          another tab closes rather than saving into nothing. */}
      {beingEdited && editing && (
        <RowForm
          title={`Edit ${beingEdited.name}`}
          name={editing.name}
          nameLabel={`Name of ${beingEdited.name}`}
          onName={(named) => setEditing({ ...editing, name: named })}
          choicesHeading="Colour"
          choicesLabel={`Colour of ${beingEdited.name}`}
          choices={WORKSPACE_THEMES.map((theme) => {
            /* Each swatch shows the whole theme rather than a dot, and shows it
               stacked the way the screen stacks it: the header across the top,
               the bar the dashboard tabs sit on under it, and the ground
               filling the rest, with the tint on the ground. So what you are
               choosing looks like what you will get, including which way up it
               goes. */
            const pressed = (editing.theme ?? themeOf(beingEdited.color)).tint === theme.tint;
            return (
              <button
                key={theme.name}
                type="button"
                onClick={() => setEditing({ ...editing, theme })}
                aria-label={`${theme.name} for ${beingEdited.name}`}
                aria-pressed={pressed}
                title={theme.name}
                className={`flex size-8 flex-col justify-end overflow-hidden rounded-md border ${
                  pressed ? 'border-ink ring-2 ring-ink/20' : 'border-shade/10 hover:border-shade/30'
                }`}
                style={{
                  backgroundImage: `linear-gradient(${theme.header} 0 30%, ${theme.bar} 30% 50%, ${theme.ground} 50% 100%)`,
                }}
              >
                <span
                  className="mx-auto mb-1 block size-2.5 rounded-full"
                  style={{ backgroundColor: theme.tint }}
                />
              </button>
            );
          })}
          saving={false}
          returnFocusTo={askedFrom.current}
          onCancel={() => setEditing(null)}
          onSave={saveForm}
        />
      )}

      {beingDeleted && (
        <DeleteQuestion
          open
          question={deleteQuestion(beingDeleted.name, counted)}
          confirmLabel={`Yes, delete ${beingDeleted.name}`}
          // Nothing is deleted before the question has an answer in it: an
          // empty workspace reads as harmless and a full one does not, so "how
          // many" is part of what is being asked. A count that could not be
          // read is not a reason to trap someone in the dialog, so a failed
          // read lets it through.
          canConfirm={counted !== undefined || contents.isError}
          returnFocusTo={askedFrom.current}
          onCancel={() => setDeleting(null)}
          onConfirm={() => confirmDelete(beingDeleted.id)}
        />
      )}
    </>
  );
}

/**
 * The look every tab in the strip wears - the workspaces, and Capture ahead of
 * them - said once because two tabs side by side in one strip cannot each carry
 * their own copy of what "the one you are on" looks like.
 *
 * The band's tabs below wear the same shape the other way up (`components/
 * DashboardBar.tsx`, `tabClass`), and the reasoning for it is there: rounded at
 * the top only so the tab and the surface it is filled with are one, the tint
 * along the top edge because a joined tab does not by itself read as selected,
 * and an inset shadow rather than a border so becoming current does not change
 * the tab's height. What differs here is the ink - the strip is filled with the
 * near-black bar, so a selected tab takes the chrome's light ink where the
 * band's takes the app's dark one - and that the fill comes from the shell
 * inline, since it is the band's colour rather than the tab's own.
 *
 * Horizontal padding is the caller's, and the only thing that differs between
 * the two: Capture is set a little wider than a workspace.
 */
export function stripTabClass(here: boolean): string {
  return `shrink-0 whitespace-nowrap rounded-t-lg pt-1.5 pb-2 text-sm ${
    here
      ? 'font-medium text-chrome-ink shadow-tab-mark'
      : 'text-chrome-ink-soft hover:bg-white/8 hover:text-chrome-ink'
  }`;
}

/**
 * What deleting this workspace takes with it, said before it happens. The items
 * are hidden rather than erased, and the wording says so: they stay attached to
 * the workspace that was deleted.
 */
function deleteQuestion(name: string, items: number | undefined): string {
  if (items === undefined) return `Delete ${name}?`;
  if (items === 0) return `Delete ${name}? There is nothing in it.`;
  return `Delete ${name} and hide its ${items} item${items === 1 ? '' : 's'}?`;
}
