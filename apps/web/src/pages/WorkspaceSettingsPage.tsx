import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WORKSPACE_THEMES, uuidv7 } from '@cockpit/shared';
import type { Workspace, WorkspaceList, WorkspaceTheme } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { snapshotQuery, useCommand, workspacesQuery } from '../api/queries';
import { movedBy, movedTo } from '../reorder';
import { DeleteQuestion } from '../components/DeleteQuestion';
import { LoadFailure } from '../components/LoadFailure';
import { RowMenu } from '../components/Menu';

/**
 * Where workspaces are managed. It lists them, makes new ones, renames them,
 * colors them, puts them in the order they appear across the top of the screen,
 * and deletes them.
 *
 * **A row keeps its shape**, exactly as on the dashboard settings page: what
 * can be done to a workspace is in its own menu, renaming happens in the row,
 * and deleting asks in a dialog ("Ask before deleting in a dialog, from the
 * row's own menu", issue 116).
 *
 * **A workspace is moved two ways, and they are one change** ("Reorder
 * workspaces", issue 31). The grip at the left of a row drags it to a place;
 * Move up and Move down in the row's own menu do the same thing one step at a
 * time. The menu is not a lesser second path - it is the only one a keyboard
 * has, and the comfortable one on a phone, so the ends say why they cannot be
 * chosen rather than the entry disappearing. Both produce the same whole order
 * through `reorder.ts`, so the two cannot disagree about what a move is.
 *
 * A new workspace is still handed a color rather than asked for one, so it is
 * distinguishable in the tabs from the moment it exists; the swatches are for
 * changing it afterwards.
 *
 * One `useCommand` for the whole page rather than one per control, so a refusal
 * can only belong to the last thing asked for - and `variables` says which
 * control that was, which is how the refusal ends up next to the thing that was
 * refused instead of at the bottom of the page.
 */
export function WorkspaceSettingsPage() {
  const { data, error, refetch } = useQuery(workspacesQuery);
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  /** The workspace being renamed and the name typed for it so far. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** The workspace whose delete is waiting to be confirmed. */
  const [deleting, setDeleting] = useState<string | null>(null);
  /**
   * The workspace being dragged and the place in the list it is currently being
   * shown in. The list is painted in that order while the drag lasts, so what
   * you are looking at is what dropping it would produce.
   */
  const [dragging, setDragging] = useState<{ id: string; to: number } | null>(null);
  /**
   * The list itself, so a drag can ask where the rows actually are. Their
   * heights differ - a row of swatches wraps on a narrow screen - so the place
   * the pointer is over is measured rather than divided out of a total.
   */
  const listRef = useRef<HTMLUListElement>(null);
  /**
   * The control the question was opened from, so the focus can go back to it.
   * A ref rather than state: nothing on screen depends on it, and it is read
   * only as the question closes.
   */
  const askedFrom = useRef<HTMLElement | null>(null);
  const command = useCommand();

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
    // Starting one leaves the others, exactly as renaming and deleting do.
    setRenaming(null);
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
  const startRenaming = (ws: Workspace) => {
    setDeleting(null);
    command.reset();
    setRenaming({ id: ws.id, name: ws.name });
  };
  const startDeleting = (ws: Workspace, openedFrom: HTMLElement | null) => {
    setRenaming(null);
    command.reset();
    askedFrom.current = openedFrom;
    setDeleting(ws.id);
  };
  const stopAsking = () => {
    setRenaming(null);
    setDeleting(null);
    command.reset();
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

  const rename = (e: React.FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const trimmed = renaming.name.trim();
    if (!trimmed) return;
    command.mutate(
      {
        name: 'rename_workspace',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: renaming.id,
          name: trimmed,
        },
      },
      // Same as creating: the box closes only once the new name is really the
      // workspace's, so a refused one is still there to be corrected.
      { onSuccess: () => setRenaming(null) },
    );
  };

  const chooseTheme = (workspaceId: string, theme: WorkspaceTheme) => {
    command.mutate({
      name: 'set_workspace_theme',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        // All three, because all three are what a workspace stores. The server
        // still checks they are a theme from the palette.
        color: theme.tint,
        ground: theme.ground,
        header: theme.header,
      },
    });
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
      { onSuccess: () => setDeleting(null) },
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
    what:
      | 'create_workspace'
      | 'rename_workspace'
      | 'delete_workspace'
      | 'reorder_workspaces'
      | 'set_workspace_theme',
    id?: string,
  ) =>
    refusal && command.variables?.name === what && (!id || command.variables.payload.workspaceId === id)
      ? refusal
      : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>

      <section className="rounded-lg bg-surface shadow-panel">
        <ul ref={listRef}>
          {shown.map((ws, index) => (
            <li
              key={ws.id}
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
                {renaming?.id === ws.id ? (
                  <form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: ws.id, name: e.target.value })}
                      aria-label={`New name for ${ws.name}`}
                      maxLength={60}
                      autoFocus
                      className="min-w-0 flex-1 rounded-md border border-black/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                    />
                    <button type="submit" disabled={command.isPending} className={primaryButton}>
                      Save
                    </button>
                    <button type="button" onClick={stopAsking} className={quietButton}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">{ws.name}</span>
                    <RowMenu
                      label={`Actions for ${ws.name}`}
                      entries={[
                        { label: 'Rename', onSelect: () => startRenaming(ws) },
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
                  </>
                )}
              </div>
              {/* The palette, as a row of swatches. Each one shows the whole
                  theme rather than a dot: the ground it paints the page in,
                  with the tint sitting on it, so what you are choosing is what
                  you will see. Hidden while the row is being renamed, because
                  that is the one thing that takes the row over; the question
                  before a delete no longer does. */}
              {renaming?.id !== ws.id && (
                <div className="flex flex-wrap gap-1.5 pt-2 pl-6">
                  {WORKSPACE_THEMES.map((theme) => (
                    <button
                      key={theme.name}
                      type="button"
                      onClick={() => chooseTheme(ws.id, theme)}
                      disabled={command.isPending}
                      aria-label={`${theme.name} for ${ws.name}`}
                      aria-pressed={ws.color === theme.tint}
                      title={theme.name}
                      className={`size-6 rounded-md border disabled:opacity-50 ${
                        ws.color === theme.tint
                          ? 'border-ink ring-2 ring-ink/20'
                          : 'border-black/10 hover:border-black/30'
                      }`}
                      style={{ backgroundColor: theme.ground }}
                    >
                      <span
                        className="mx-auto block size-2.5 rounded-full"
                        style={{ backgroundColor: theme.tint }}
                      />
                    </button>
                  ))}
                </div>
              )}
              {/* A refused delete says so in the dialog that asked for it,
                  which is still open; these three are asked for in the row. A
                  refused move is the one that has to be read: the row has
                  already gone back to where it was, and without a word for it
                  that reads as the drag having missed. */}
              {(refusalFor('rename_workspace', ws.id) ??
                refusalFor('reorder_workspaces', ws.id) ??
                refusalFor('set_workspace_theme', ws.id)) && (
                <p role="alert" className="pt-2 text-sm text-over">
                  {refusalFor('rename_workspace', ws.id) ??
                    refusalFor('reorder_workspaces', ws.id) ??
                    refusalFor('set_workspace_theme', ws.id)}
                </p>
              )}
            </li>
          ))}
        </ul>
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
              `canTakeOver`: there is no stored copy of this list behind the
              message, so this may own the view and send the browser through
              sign-in. The page below it still works - making a workspace is
              how an account with none gets its first - so the message sits in
              the list rather than replacing the page.
            */}
            <LoadFailure error={error} onRetry={() => void refetch()} canTakeOver />
          </div>
        )}
        {answered && workspaces.length === 0 && (
          <p className="px-4 py-4 text-sm text-ink-faint">
            No workspaces yet. Make your first one below.
          </p>
        )}
      </section>

      <form onSubmit={create} className="flex flex-col gap-2">
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
    </div>
  );
}

const primaryButton =
  'shrink-0 rounded-md bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50';
const quietButton =
  'shrink-0 rounded-md border border-black/10 px-3 py-1 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep';

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
