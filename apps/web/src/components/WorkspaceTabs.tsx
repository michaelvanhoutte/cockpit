import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WORKSPACE_THEMES, themeOf, uuidv7 } from '@cockpit/shared';
import type { Workspace, WorkspaceList, WorkspaceTheme } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import {
  refusalFrom,
  snapshotQuery,
  useCommand,
  useSendCommand,
  workspacesQuery,
} from '../api/queries';
import { litForChrome } from '../chrome';
import { movedBy } from '../reorder';
import { useTabDrag } from '../tabDrag';
import { DeleteQuestion } from './DeleteQuestion';
import { TabMenu, opensOnPress } from './Menu';
import { RowForm } from './RowForm';

/**
 * The workspaces across the top, and everything that can be done to one
 * ("Change a workspace or a dashboard on the tab it is", issue 255): its name
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
 * One `useCommand` for the strip rather than one per tab, so a refusal can only
 * belong to the last thing asked for. The form keeps its own (`send`), because
 * a Save is up to two changes rather than one.
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
  const { data } = useQuery(workspacesQuery);
  const workspaces = data?.workspaces ?? [];
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const command = useCommand();
  const send = useSendCommand();

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
  const [saving, setSaving] = useState(false);
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);
  /** The workspace whose delete is waiting to be confirmed. */
  const [deleting, setDeleting] = useState<string | null>(null);
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
   * **Shown first, put back if it is refused**, which is correctness rather
   * than feel: the order a move is computed from is the order in hand, so a
   * second move made before the first came back would be computed from the list
   * *before* the first and would undo it. Writing the new order where the list
   * is held is what makes two moves in a row compose.
   *
   * Both answers to a refusal, and each covers what the other cannot. The copy
   * in hand goes back first, because it is the only answer available when the
   * request never reached the server at all. Then a re-read, because that copy
   * is only right when this was the one move in flight.
   */
  const move = (workspaceId: string, moved: string[]) => {
    const held = queryClient.getQueryData<WorkspaceList>(workspacesQuery.queryKey);
    if (held) {
      queryClient.setQueryData<WorkspaceList>(workspacesQuery.queryKey, {
        workspaces: moved.flatMap((id) => held.workspaces.filter((w) => w.id === id)),
      });
    }
    command.mutate(
      {
        name: 'reorder_workspaces',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          workspaceIds: moved,
        },
      },
      {
        onError: () => {
          if (held) queryClient.setQueryData(workspacesQuery.queryKey, held);
          void queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
        },
      },
    );
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
   * The name goes first and the colour second, so a refused colour leaves a
   * rename that already landed - which is what the form then shows, since it
   * compares against the list rather than against what it opened with.
   */
  const saveForm = async () => {
    if (!editing) return;
    const was = workspaces.find((w) => w.id === editing.id);
    const named = editing.name.trim();
    if (!was || !named) return;
    const envelope = () => ({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: editing.id,
    });

    setSaving(true);
    setSaveRefusal(null);
    try {
      if (named !== was.name) {
        await send({ name: 'rename_workspace', payload: { ...envelope(), name: named } });
      }
      if (editing.theme && editing.theme.tint !== was.color) {
        await send({
          name: 'set_workspace_theme',
          payload: {
            // All four, because all four are what a workspace stores. The
            // server still checks they are a theme from the palette.
            ...envelope(),
            color: editing.theme.tint,
            bar: editing.theme.bar,
            ground: editing.theme.ground,
            header: editing.theme.header,
          },
        });
      }
      closeForm();
    } catch (failure) {
      // The form stays open with what was typed still in it, so a name the
      // server would not take can be corrected rather than typed again.
      setSaveRefusal(
        failure instanceof CommandRefused
          ? failure.message
          : 'That did not reach the server. Try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  /**
   * What is in the workspace being deleted, so the question can say what goes
   * with it. The snapshot is the app's own answer to "what is in this
   * workspace" - the open items, which are exactly the ones that stop being
   * visible - so this asks that rather than adding a count to the workspace
   * list every page load would then pay for.
   */
  const contents = useQuery({ ...snapshotQuery(deleting ?? ''), enabled: deleting !== null });
  const counted = contents.data?.items.length;
  /**
   * The workspace each thing is about, read from the list rather than kept
   * beside the id: one deleted in another tab is gone from the next list, and a
   * question about a workspace nothing holds closes itself instead of asking
   * about a name that is no longer there.
   */
  const beingDeleted = workspaces.find((w) => w.id === deleting);
  const beingEdited = workspaces.find((w) => w.id === editing?.id);

  const confirmDelete = (workspaceId: string) => {
    command.mutate(
      {
        name: 'delete_workspace',
        payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId },
      },
      {
        onSuccess: async () => {
          setDeleting(null);
          focusOwedAfterDeleting.current = workspaceId;
          /*
           * Only where the screen behind the question stops working, which is
           * two cases rather than one. The one you are looking at is the
           * obvious one. **The last one is the other**, and it does not name a
           * workspace at all: capture is under the shell in no workspace, so
           * `params.workspaceId` is undefined there and a check for the one
           * behind you passes straight over it.
           *
           * `workspaces` is the list as it stands before the re-read below, and
           * it still holds the workspace just deleted - deleting is the one
           * change that does not invalidate the list on its own
           * (api/queries.ts, `afterChanging`) - so one row means it was the
           * last.
           */
          const wasTheOneBehind = params.workspaceId === workspaceId;
          const wasTheLast = workspaces.length === 1;
          if (!wasTheOneBehind && !wasTheLast) return;
          // Re-read before going anywhere: `/` decides where to land from the
          // list of workspaces, and the list in hand still holds the one just
          // deleted - so without this it lands you straight back on it, or
          // fails to notice the account is now empty.
          await queryClient.refetchQueries({ queryKey: ['workspaces'] });
          void navigate({ to: '/' });
        },
      },
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
    if (!deleted || beingDeleted || !here || here === deleted) return;
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
    command.reset();
    setSaveRefusal(null);
    askedFrom.current = openedFrom;
    setEditing({ id: ws.id, name: ws.name, theme: null });
  };
  const startDeleting = (ws: Workspace, openedFrom: HTMLElement | null) => {
    closeForm();
    command.reset();
    askedFrom.current = openedFrom;
    setDeleting(ws.id);
  };
  const closeForm = () => {
    setEditing(null);
    setSaveRefusal(null);
  };

  /**
   * What can be done to this workspace. Move up and Move down were the window's
   * words for a list; these are a strip, so they are left and right - and at
   * either end the entry stays, unavailable, saying why, rather than
   * disappearing: it is the only way a keyboard has to move a tab, and the
   * comfortable one on a phone.
   */
  const entriesFor = (ws: Workspace, at: number): MenuEntryList => [
    // One entry for changing a workspace rather than a Rename beside it: the
    // form is what renames, and two ways to reach the same box is one more
    // thing to choose between.
    { label: 'Edit…', onSelect: (from) => startEditing(ws, from) },
    {
      label: 'Move left',
      keepsFocus: true,
      unavailable: at === 0 ? 'It is already the first' : undefined,
      onSelect: () => move(ws.id, movedBy(order, ws.id, -1)),
    },
    {
      label: 'Move right',
      keepsFocus: true,
      unavailable: at === order.length - 1 ? 'It is already the last' : undefined,
      onSelect: () => move(ws.id, movedBy(order, ws.id, 1)),
    },
    { label: 'Delete', destructive: true, onSelect: (from) => startDeleting(ws, from) },
  ];

  return (
    <>
      {/* Scrolls within itself rather than widening the page: with enough
          workspaces a plain row pushed a 480px phone to 571px and took the
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
        {shown.map((ws, at) => {
          const here = ws.id === params.workspaceId;
          return (
            <TabMenu key={ws.id} label={`Actions for ${ws.name}`} entries={entriesFor(ws, at)}>
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
            </TabMenu>
          );
        })}
        {children}
      </nav>

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
                disabled={saving}
                aria-label={`${theme.name} for ${beingEdited.name}`}
                aria-pressed={pressed}
                title={theme.name}
                className={`flex size-8 flex-col justify-end overflow-hidden rounded-md border disabled:opacity-50 ${
                  pressed ? 'border-ink ring-2 ring-ink/20' : 'border-black/10 hover:border-black/30'
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
          refusal={saveRefusal}
          saving={saving}
          returnFocusTo={askedFrom.current}
          onCancel={closeForm}
          onSave={() => void saveForm()}
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
          canConfirm={!command.isPending && (counted !== undefined || contents.isError)}
          // The refusal belongs to the control that asked for it, and
          // `variables` is the last thing sent with only ever one in flight -
          // so a refused move cannot surface inside the delete question.
          refusal={command.variables?.name === 'delete_workspace' ? refusalFrom(command) : null}
          returnFocusTo={askedFrom.current}
          onCancel={() => {
            setDeleting(null);
            command.reset();
          }}
          onConfirm={() => confirmDelete(beingDeleted.id)}
        />
      )}
    </>
  );
}

type MenuEntryList = React.ComponentProps<typeof TabMenu>['entries'];

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
      ? 'font-medium text-chrome-ink shadow-[inset_0_2px_0_0_var(--tab-mark)]'
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
