import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WORKSPACE_THEMES, uuidv7 } from '@cockpit/shared';
import type { Workspace, WorkspaceTheme } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { snapshotQuery, useCommand, workspacesQuery } from '../api/queries';
import { LoadFailure } from '../components/LoadFailure';

/**
 * Where workspaces are managed. It lists them, makes new ones, renames them,
 * colors them and deletes them; reordering arrives with "Reorder workspaces"
 * (issue 31), on this page too.
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
  const [name, setName] = useState('');
  /** The workspace being renamed and the name typed for it so far. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** The workspace whose delete is waiting to be confirmed. */
  const [deleting, setDeleting] = useState<string | null>(null);
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

  /** Starting one leaves the other, so at most one row is ever asking something. */
  const startRenaming = (ws: Workspace) => {
    setDeleting(null);
    command.reset();
    setRenaming({ id: ws.id, name: ws.name });
  };
  const startDeleting = (ws: Workspace) => {
    setRenaming(null);
    command.reset();
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
    what: 'create_workspace' | 'rename_workspace' | 'delete_workspace' | 'set_workspace_theme',
    id?: string,
  ) =>
    refusal && command.variables?.name === what && (!id || command.variables.payload.workspaceId === id)
      ? refusal
      : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>

      <section className="rounded-lg bg-surface shadow-panel">
        <ul>
          {workspaces.map((ws) => (
            <li key={ws.id} className="border-b border-black/5 px-4 py-3 last:border-b-0">
              <div className="flex items-center gap-3">
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
                ) : deleting === ws.id ? (
                  <>
                    <span className="min-w-0 flex-1 text-sm">{deleteQuestion(ws.name, counted)}</span>
                    <button
                      type="button"
                      // Nothing is deleted before the question has an answer in
                      // it: an empty workspace reads as harmless and a full one
                      // does not, so "how many" is part of what is being asked.
                      // A count that could not be read is not a reason to trap
                      // someone on this row, so a failed read lets it through.
                      disabled={command.isPending || (counted === undefined && !contents.isError)}
                      onClick={() => confirmDelete(ws.id)}
                      aria-label={`Yes, delete ${ws.name}`}
                      className="shrink-0 rounded-md bg-over px-3 py-1 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      Delete
                    </button>
                    <button type="button" onClick={stopAsking} className={quietButton}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">{ws.name}</span>
                    <button
                      type="button"
                      onClick={() => startRenaming(ws)}
                      aria-label={`Rename ${ws.name}`}
                      className={quietButton}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => startDeleting(ws)}
                      aria-label={`Delete ${ws.name}`}
                      className={quietButton}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
              {/* The palette, as a row of swatches. Each one shows the whole
                  theme rather than a dot: the ground it paints the page in,
                  with the tint sitting on it, so what you are choosing is what
                  you will see. Hidden while the row is asking something else,
                  so a row is only ever doing one thing. */}
              {renaming?.id !== ws.id && deleting !== ws.id && (
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
              {(refusalFor('rename_workspace', ws.id) ??
                refusalFor('delete_workspace', ws.id) ??
                refusalFor('set_workspace_theme', ws.id)) && (
                <p role="alert" className="pt-2 text-sm text-over">
                  {refusalFor('rename_workspace', ws.id) ??
                    refusalFor('delete_workspace', ws.id) ??
                    refusalFor('set_workspace_theme', ws.id)}
                </p>
              )}
            </li>
          ))}
        </ul>
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
