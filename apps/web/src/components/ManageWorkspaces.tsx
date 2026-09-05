import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WORKSPACE_THEMES, themeOf, uuidv7 } from '@cockpit/shared';
import type { Workspace, WorkspaceList, WorkspaceTheme } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { snapshotQuery, useCommand, useSendCommand, workspacesQuery } from '../api/queries';
import { movedBy, movedTo } from '../reorder';
import { DeleteQuestion } from './DeleteQuestion';
import { LoadFailure } from './LoadFailure';
import { CloseWindow, ManageWindow } from './ManageWindow';
import { RowMenu } from './Menu';
import { RowForm, wasOnTheRow } from './RowForm';

/**
 * Where workspaces are managed: listing them, making new ones, changing a
 * name and a colour, putting them in the order they appear across the top of
 * the screen, and deleting them.
 *
 * **A window over the workspace you are in, not a page of its own**
 * (`components/ManageWindow.tsx`, which is where that reason lives). It was a
 * page, and the page is what made the app's chrome degrade into a second,
 * worse header whenever you opened it.
 *
 * **A row keeps its shape**, exactly as in the list of dashboards: what can be
 * done to a workspace is in its own menu, and both the things that change one -
 * its name and its colour - happen on a form over the page rather than in the
 * row (`components/RowForm.tsx`). Deleting asks in a dialog ("Ask before
 * deleting in a dialog, from the row's own menu", issue 116).
 *
 * **A workspace is moved two ways, and they are one change** ("Reorder
 * workspaces", issue 31). The grip at the left of a row drags it to a place;
 * Move up and Move down in the row's own menu do the same thing one step at a
 * time. The menu is not a lesser second path - it is the only one a keyboard
 * has, and the comfortable one on a phone, so the ends say why they cannot be
 * chosen rather than the entry disappearing. Both produce the same whole order
 * through `reorder.ts`, so the two cannot disagree about what a move is.
 *
 * **The box for making one is above the list, not after it.** The list grows
 * without a ceiling and the box does not move with it, so how far down the page
 * the way to make a workspace sits stopped depending on how many you already
 * have. It also puts it where it is needed most: the account the empty-list
 * message is talking to is the one that has to reach it first.
 *
 * A new workspace is still handed a color rather than asked for one, so it is
 * distinguishable in the tabs from the moment it exists; the form is where it
 * is changed afterwards.
 *
 * One `useCommand` for the controls on the page rather than one per control, so
 * a refusal can only belong to the last thing asked for - and `variables` says
 * which control that was, which is how the refusal ends up next to the thing
 * that was refused instead of at the bottom of the page. The form keeps its own
 * (`saveForm`), because a Save is up to two changes rather than one.
 */
export function ManageWorkspaces({
  open,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  /** The control it was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const { data, error, refetch } = useQuery(workspacesQuery);
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
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
     * same as the theme the workspace is wearing.
     *
     * A workspace can wear a tint the palette does not have, so the swatch the
     * form shows pressed is looked up (`themeOf` falls back to the first) and
     * is *not* what the workspace stores. Filling this in with that lookup
     * would make every such workspace's name-only Save also repaint it, to a
     * colour nobody chose.
     */
    theme: WorkspaceTheme | null;
  } | null>(null);
  /** That a Save is in flight, and why the last one did not happen. */
  const [saving, setSaving] = useState(false);
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);
  /** The workspace whose delete is waiting to be confirmed. */
  const [deleting, setDeleting] = useState<string | null>(null);
  /**
   * The workspace being dragged and the place in the list it is currently being
   * shown in. The list is painted in that order while the drag lasts, so what
   * you are looking at is what dropping it would produce.
   */
  const [dragging, setDragging] = useState<{ id: string; to: number } | null>(null);
  /**
   * The list itself, so a drag can ask where the rows actually are. Measured
   * rather than divided out of a total, so a row that is not the height of
   * every other row - a long name wrapping on a narrow screen - is still found
   * where it actually is.
   */
  const listRef = useRef<HTMLUListElement>(null);
  /**
   * The control the question or the form was opened from, so the focus can go
   * back to it. A ref rather than state: nothing on screen depends on it, and
   * it is read only as the thing it opened closes.
   */
  const askedFrom = useRef<HTMLElement | null>(null);
  /**
   * The window itself, which the focus goes back to when a delete has
   * happened: the row's menu it was asked from went with the row, and the
   * question closes by ceasing to exist rather than by being dismissed, so
   * nothing else puts it anywhere. Left alone it falls to the workspace
   * behind the window, and the next Tab starts from the top of a screen you
   * cannot see - the same hole the dashboards' list records.
   */
  const list = useRef<HTMLDivElement>(null);
  /** That a delete has happened, so the focus is owed to the window. */
  const focusTheList = useRef(false);
  const command = useCommand();
  const navigate = useNavigate();
  /** Which workspace you are looking at behind this, which a delete may take. */
  const params = useParams({ strict: false });
  /**
   * The form sends its two changes one after the other and reads what came
   * back, so it holds its own pending and refusal rather than the page's one
   * mutation: `useCommand` has room for one change in flight, and a Save that
   * moved both the name and the colour is two.
   */
  const send = useSendCommand();

  const workspaces = data?.workspaces ?? [];
  /**
   * Saying "no workspaces yet" is a claim about what this account holds, so it
   * needs an answer to have arrived. `data` is undefined while the list is
   * still being fetched, while it is being retried, and when it failed for
   * good - and `?? []` collapses all three into the same empty array as an
   * account that really has none.
   *
   * That is the lie that made a signed-out session on staging read as an empty
   * account. Keying the message on `error` instead is not enough either, and
   * the app said so when it was tried: a query that is still retrying has no
   * error yet, so the page went on claiming the account was empty for as long
   * as the retries lasted.
   */
  const answered = data !== undefined;
  const listFailed = Boolean(error) && !answered;

  /**
   * What is in the workspace being deleted, so the confirmation can say what
   * goes with it. The snapshot is the app's own answer to "what is in this
   * workspace" - the open items, which are exactly the ones that stop being
   * visible - so this asks that rather than adding a count to the workspace
   * list every page load would then pay for.
   */
  const contents = useQuery({ ...snapshotQuery(deleting ?? ''), enabled: deleting !== null });
  const counted = contents.data?.items.length;
  /**
   * The workspace the question is about, read from the list rather than kept
   * beside the id: one deleted in another tab is gone from the next list, and
   * a question about a workspace that is no longer there closes itself instead
   * of asking about a name nothing holds.
   */
  const beingDeleted = workspaces.find((w) => w.id === deleting);
  /** The workspace the form is open on, read from the list for the same reason. */
  const beingEdited = workspaces.find((w) => w.id === editing?.id);

  /**
   * The focus, once a delete has taken the question away with the row.
   *
   * A frame later rather than in the answer itself: the question does not
   * close so much as cease to exist, and its own focus scope puts the focus
   * back as it unmounts - onto a row that is no longer there.
   */
  useEffect(() => {
    if (!focusTheList.current || beingDeleted) return;
    focusTheList.current = false;
    const frame = requestAnimationFrame(() => list.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [beingDeleted]);

  /**
   * The order the rows are painted in: what the account holds, or - while a
   * drag is in progress - where that drag would leave it. Nothing is sent until
   * the drag is dropped, so this is a preview and not a change.
   */
  const order = workspaces.map((w) => w.id);
  const shownOrder = dragging ? movedTo(order, dragging.id, dragging.to) : order;
  const shown = shownOrder.flatMap((id) => workspaces.filter((w) => w.id === id));

  /**
   * Moves a workspace, and shows it moved before the server has agreed.
   *
   * **Shown first, put back if it is refused**, which is the one control on
   * this page that does not wait. Two reasons, and the first is correctness
   * rather than feel: the order a move is computed from is the order in hand,
   * so a second move made before the first has come back would be computed from
   * the list *before* the first move and would undo it. Writing the new order
   * where the list is held is what makes two moves in a row compose. The second
   * is that this list and the tabs across the top read the same list, so a drop
   * that snapped back for the length of a round trip would take the header with
   * it.
   *
   * `onSuccess` is not needed: `useCommand` re-reads the list after every
   * change that moves it, which is what confirms this or corrects it.
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
        // Both, and each covers what the other cannot. The copy in hand goes
        // back first, because it is the only answer available when the request
        // never reached the server at all - a re-read would fail the same way
        // and leave the order showing a move that did not happen. Then a
        // re-read, because that copy is only right when this was the one move
        // in flight: two moves made inside one round trip each hold a snapshot
        // from before themselves, and whichever refusal lands last would
        // otherwise decide the order. The server is what actually knows.
        onError: () => {
          if (held) queryClient.setQueryData(workspacesQuery.queryKey, held);
          void queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
        },
      },
    );
  };

  /**
   * Picks a row up. The pointer is captured so the whole drag arrives here even
   * once the pointer has left the grip, which it does the moment the row moves
   * out from under it.
   */
  const startDragging = (workspaceId: string, from: number) => (event: React.PointerEvent) => {
    // The primary button only: a right-click opens a menu, and dragging a row
    // out from under it would be nobody's intention.
    if (event.button !== 0) return;
    // Otherwise the browser starts a text selection across the rows the drag
    // passes over.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Starting one leaves the others, exactly as editing and deleting do.
    closeForm();
    setDeleting(null);
    command.reset();
    setDragging({ id: workspaceId, to: from });
  };

  /**
   * Where the drag currently is: the row the pointer is inside, clamped to the
   * list at either end so dragging past the top or the bottom means first or
   * last rather than nothing.
   *
   * Measured against the rows *as painted*, which already show the preview - so
   * once the dragged row is under the pointer it stays there, and the reading
   * settles instead of flickering between two places.
   */
  const dragTo = (event: React.PointerEvent) => {
    if (!dragging) return;
    const rows = listRef.current?.children;
    if (!rows || rows.length === 0) return;
    let to = rows.length - 1;
    for (let i = 0; i < rows.length; i += 1) {
      if (event.clientY <= rows[i]!.getBoundingClientRect().bottom) {
        to = i;
        break;
      }
    }
    if (to !== dragging.to) setDragging({ id: dragging.id, to });
  };

  /** Drops it. A drag that ends where it started asks for nothing. */
  const stopDragging = () => {
    if (!dragging) return;
    const moved = movedTo(order, dragging.id, dragging.to);
    setDragging(null);
    if (moved.some((id, i) => id !== order[i])) move(dragging.id, moved);
  };

  /** Starting one leaves the other, so at most one row is ever asking something. */
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
  /** The form goes, and the refusal it was showing goes with it. */
  const closeForm = () => {
    setEditing(null);
    setSaveRefusal(null);
  };
  const stopAsking = () => {
    closeForm();
    setDeleting(null);
    command.reset();
  };

  /**
   * Closing it forgets what was half-typed and what was refused, for the
   * reason the dashboards' window gives: this stays mounted between openings,
   * so a refusal that is merely hidden comes back the next time over a name
   * nobody has touched.
   */
  const close = () => {
    stopAsking();
    setName('');
    onClose();
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    command.mutate(
      {
        name: 'create_workspace',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: uuidv7(),
          name: trimmed,
        },
      },
      // Cleared only once it worked. A refusal leaves what was typed where it
      // is, so the name can be fixed rather than typed again.
      { onSuccess: () => setName('') },
    );
  };

  /**
   * What the form has to send: the halves that actually moved, and nothing
   * else. An untouched box must send no change at all, or it would carry the
   * value the form was opened with over an edit made somewhere else in the
   * meantime - and a colour nobody touched would bump the workspace's theme on
   * every rename.
   */
  const saveForm = async () => {
    if (!editing) return;
    const was = workspaces.find((w) => w.id === editing.id);
    if (!was) return;
    const named = editing.name.trim();
    if (!named) return;
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
            ...envelope(),
            // All four, because all four are what a workspace stores. The
            // server still checks they are a theme from the palette.
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
      //
      // The name goes first and the colour second, so a refused colour leaves a
      // rename that already landed - which is what the form now shows, since it
      // compares against the list rather than against what it opened with.
      setSaveRefusal(
        failure instanceof CommandRefused
          ? failure.message
          : 'That did not reach the server. Try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (workspaceId: string) => {
    command.mutate(
      {
        name: 'delete_workspace',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
        },
      },
      {
        onSuccess: async () => {
          setDeleting(null);
          focusTheList.current = true;
          // Only the one you are looking at. Deleting any other leaves the
          // screen behind this window exactly where it was.
          if (params.workspaceId !== workspaceId) return;
          // Re-read before going anywhere: `/` decides where to land from
          // the list of workspaces, and the list in hand still holds the one
          // just deleted - so without this it lands you straight back on it.
          // Deleting is the one change that does not invalidate that list on
          // its own (api/queries.ts, `afterChanging`), because a deleted
          // workspace's snapshot is a 404 for good.
          await queryClient.refetchQueries({ queryKey: ['workspaces'] });
          // **The window stays open behind that**, minus the row: the row
          // going is the confirmation, and a second delete should not cost
          // opening this again. The workspace decides where to land, which is
          // whichever one is left - or the screen that makes one, when none
          // is (router.tsx, `somewhereThatWorks`).
          void navigate({ to: '/' });

        },
      },
    );
  };

  // The server's words where it gave any ("a workspace called Personal already
  // exists"), and something plain where the request never got an answer.
  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  /**
   * The refusal belongs to the control that asked for it. `variables` is the
   * last thing sent, and there is only ever one in flight, so this is exact
   * rather than a guess.
   */
  const refusalFor = (
    what: 'create_workspace' | 'delete_workspace' | 'reorder_workspaces',
    id?: string,
  ) =>
    refusal && command.variables?.name === what && (!id || command.variables.payload.workspaceId === id)
      ? refusal
      : null;

  return (
    <ManageWindow
      title="Manage workspaces"
      open={open}
      onClose={close}
      // Not while a change is in flight, or the refusal it might come back
      // with would have nowhere left to appear.
      canClose={!command.isPending && !saving}
      returnFocusTo={returnFocusTo}
      ref={list}
    >
      {/* Above the list, not after it. The list has no ceiling - it is every
          workspace the account has ever made - so a box below it is a control
          whose reachability depends on how much you already own, and it is the
          one control on this page an account with nothing needs most. It sat
          below until a 480px screen with ten workspaces put it 1001px down a
          1040px viewport: on screen by 39 pixels, which is under half a row.
          Nothing about that was visible in what the page renders, only in where
          it ended up. */}
      <form onSubmit={create} className="mt-4 flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Work, Personal, a customer…"
            aria-label="Name of the new workspace"
            maxLength={60}
            className="flex-1 rounded-md border border-black/10 bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
          />
          <button
            type="submit"
            disabled={command.isPending}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
          >
            New workspace
          </button>
        </div>
        {refusalFor('create_workspace') && (
          <p role="alert" className="text-sm text-over">
            {refusalFor('create_workspace')}
          </p>
        )}
      </form>

      <section className="-mx-2 mt-4 min-h-0 flex-1 overflow-y-auto">
        <ul ref={listRef}>
          {shown.map((ws, index) => (
            <li
              key={ws.id}
              // A double-click opens the form, exactly as it does on an Item's
              // row. Not a single click: a row here is dragged, and every drag
              // begins with a press.
              onDoubleClick={(event) => {
                if (wasOnTheRow(event)) startEditing(ws, null);
              }}
              className={`border-b border-black/5 px-4 py-2 last:border-b-0 ${
                dragging?.id === ws.id
                  ? 'rounded-md bg-accent-tint shadow-panel'
                  : dragging
                    ? 'opacity-60'
                    : ''
              }`}
            >
              <div className="flex items-center gap-3">
                {/*
                  The grip, and deliberately not a button. It has no keyboard
                  behaviour to offer - a drag is a pointer gesture - and a
                  control that announces itself and then does nothing when it is
                  activated is worse than one that is not announced at all. What
                  a screen reader and a keyboard get instead is Move up and Move
                  down in the row's own menu, which do the same thing and are
                  the reason this can be hidden from them with a clear
                  conscience.

                  `touch-none` on the grip alone: it is what lets a finger drag
                  the row instead of scrolling the page, and confining it here
                  is what keeps the rest of the list scrollable.
                */}
                <span
                  aria-hidden="true"
                  title={`Drag to reorder ${ws.name}`}
                  onPointerDown={startDragging(ws.id, index)}
                  onPointerMove={dragTo}
                  onPointerUp={stopDragging}
                  onPointerCancel={() => setDragging(null)}
                  className="-my-2 -ml-2 shrink-0 cursor-grab touch-none py-2 pr-1 pl-2 text-ink-faint active:cursor-grabbing"
                >
                  <svg viewBox="0 0 10 16" className="size-4" fill="currentColor">
                    <circle cx="3" cy="3.5" r="1.3" />
                    <circle cx="7" cy="3.5" r="1.3" />
                    <circle cx="3" cy="8" r="1.3" />
                    <circle cx="7" cy="8" r="1.3" />
                    <circle cx="3" cy="12.5" r="1.3" />
                    <circle cx="7" cy="12.5" r="1.3" />
                  </svg>
                </span>
                <span
                  className="inline-block size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: ws.color }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{ws.name}</span>
                <RowMenu
                  label={`Actions for ${ws.name}`}
                  entries={[
                    // The name and the colour together, on a form of its own.
                    // The only way in from a keyboard, and the comfortable one
                    // on a phone, where a double-tap is already spent on
                    // zooming - so it is not a lesser second path.
                    {
                      label: 'Edit…',
                      onSelect: (openedFrom) => startEditing(ws, openedFrom),
                    },
                    // The keyboard's and the phone's way of moving a
                    // workspace, and the ends say so rather than going
                    // quiet: an entry that vanishes on the first row leaves
                    // somebody hunting for a control that was there a moment
                    // ago. `keepsFocus` because neither opens anything, and
                    // this is the entry most likely to be wanted twice in a
                    // row.
                    {
                      label: 'Move up',
                      keepsFocus: true,
                      unavailable: index === 0 ? 'It is already the first' : undefined,
                      onSelect: () => move(ws.id, movedBy(order, ws.id, -1)),
                    },
                    {
                      label: 'Move down',
                      keepsFocus: true,
                      unavailable:
                        index === shown.length - 1 ? 'It is already the last' : undefined,
                      onSelect: () => move(ws.id, movedBy(order, ws.id, 1)),
                    },
                    {
                      label: 'Delete',
                      destructive: true,
                      onSelect: (openedFrom) => startDeleting(ws, openedFrom),
                    },
                  ]}
                />
              </div>
              {/* A refused delete says so in the dialog that asked for it, and
                  a refused rename or colour on the form that asked - both are
                  still open. A refused move is the one left to say here, and
                  the one that has to be read: the row has already gone back to
                  where it was, and without a word for it that reads as the drag
                  having missed. */}
              {refusalFor('reorder_workspaces', ws.id) && (
                <p role="alert" className="pt-2 text-sm text-over">
                  {refusalFor('reorder_workspaces', ws.id)}
                </p>
              )}
            </li>
          ))}
        </ul>
        {/* One form for the page: at most one row can be being edited, and it
            covers the page while it is.

            Drawn only while the workspace is still in the list, which is read
            from the list rather than kept beside the draft: one deleted in
            another tab is gone from the next list, and a form open on a name
            nothing holds would save into nothing. */}
        {beingEdited && editing && (
          <RowForm
            title={`Edit ${beingEdited.name}`}
            name={editing.name}
            nameLabel={`Name of ${beingEdited.name}`}
            onName={(named) => setEditing({ ...editing, name: named })}
            paletteLabel={`Colour of ${beingEdited.name}`}
            palette={WORKSPACE_THEMES.map((theme) => (
              /* Each swatch shows the whole theme rather than a dot, and shows
                 it stacked the way the screen stacks it: the header across the
                 top, the bar the dashboard tabs sit on under it, and the ground
                 filling the rest, with the tint on the ground. So what you are
                 choosing looks like what you will get, including which way up
                 it goes. */
              <button
                key={theme.name}
                type="button"
                onClick={() => setEditing({ ...editing, theme })}
                disabled={saving}
                aria-label={`${theme.name} for ${beingEdited.name}`}
                aria-pressed={pressed(editing.theme, beingEdited.color) === theme.tint}
                title={theme.name}
                className={`flex size-8 flex-col justify-end overflow-hidden rounded-md border disabled:opacity-50 ${
                  pressed(editing.theme, beingEdited.color) === theme.tint
                    ? 'border-ink ring-2 ring-ink/20'
                    : 'border-black/10 hover:border-black/30'
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
            ))}
            refusal={saveRefusal}
            saving={saving}
            returnFocusTo={askedFrom.current}
            onCancel={closeForm}
            onSave={() => void saveForm()}
          />
        )}
        {/* One question for the page: at most one row can be asking, and the
            dialog covers the page while it is. */}
        {beingDeleted && (
          <DeleteQuestion
            open
            question={deleteQuestion(beingDeleted.name, counted)}
            confirmLabel={`Yes, delete ${beingDeleted.name}`}
            // Nothing is deleted before the question has an answer in it: an
            // empty workspace reads as harmless and a full one does not, so
            // "how many" is part of what is being asked. A count that could
            // not be read is not a reason to trap someone in the dialog, so a
            // failed read lets it through.
            canConfirm={!command.isPending && (counted !== undefined || contents.isError)}
            refusal={refusalFor('delete_workspace', beingDeleted.id)}
            returnFocusTo={askedFrom.current}
            onCancel={stopAsking}
            onConfirm={() => confirmDelete(beingDeleted.id)}
          />
        )}
        {listFailed && (
          <div className="px-4 py-4">
            {/*
              The box above still works - making a workspace is how an account
              with none gets its first - so the message sits in the list rather
              than replacing the page.
            */}
            <LoadFailure error={error} onRetry={() => void refetch()} />
          </div>
        )}
        {answered && workspaces.length === 0 && (
          <p className="px-4 py-4 text-sm text-ink-faint">
            No workspaces yet. Make your first one above.
          </p>
        )}
      </section>
      <CloseWindow disabled={command.isPending || saving} />
    </ManageWindow>
  );
}

/**
 * Which swatch the form shows pressed: the one picked, or - until one is -
 * the theme the workspace's tint belongs to. Looked up rather than compared
 * against the four fields it stores, so a workspace carrying surfaces from an
 * older palette still has a swatch pressed rather than none; it is the same
 * lookup the shell paints from (`pages/Layout.tsx`).
 */
function pressed(picked: WorkspaceTheme | null, wearing: string): string {
  return (picked ?? themeOf(wearing)).tint;
}

/**
 * What deleting this workspace takes with it, said before it happens. The
 * items are hidden rather than erased, and the wording says so: they stay
 * attached to the workspace that was deleted.
 */
function deleteQuestion(name: string, items: number | undefined): string {
  if (items === undefined) return `Delete ${name}?`;
  if (items === 0) return `Delete ${name}? There is nothing in it.`;
  return `Delete ${name} and hide its ${items} item${items === 1 ? '' : 's'}?`;
}
