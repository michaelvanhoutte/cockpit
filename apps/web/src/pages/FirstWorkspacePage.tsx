import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_WORKSPACE_THEME, uuidv7 } from '@cockpit/shared';
import { CommandRefused, NotSignedIn } from '../api/client';
import { meQuery, useCommand } from '../api/queries';

/**
 * What an account with no workspaces is shown: the one thing it can do.
 *
 * **It carries none of the app's chrome**, and that is the whole reason it
 * exists. Everything under the shell is drawn inside a workspace - the header
 * wears that workspace's colour, holds its Capture… control and marks its tab -
 * so an address reached without one had the shell painting a default theme over
 * a strip with nothing selected, which read as a different app. The workspaces
 * are managed in a window over a workspace now (`components/ManageWorkspaces
 * .tsx`), which leaves exactly one case that has no workspace to be over: not
 * having any. This is that case, and it is a screen rather than a page under
 * the shell.
 *
 * It is where the router sends you when the account holds none - a first visit,
 * or the last workspace deleted - and the invitation is the page: it says there
 * are none and the box to type a name into is right under it.
 */
export function FirstWorkspacePage() {
  const [name, setName] = useState('');
  const command = useCommand();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /**
   * A sign-in that has gone, noticed while you are sitting here.
   *
   * **The route's own check is not enough, and cannot be.** It runs once, on
   * the way in; the shell watches for this the whole time it is on screen
   * (`pages/Layout.tsx`), and this screen hangs off the root rather than the
   * shell, so nothing was watching. A session that ended while this was open
   * turned every press into a refusal printed under the box, with no way to
   * the logon page short of editing the address.
   */
  const { error: sessionFailure } = useQuery(meQuery);
  const signedOut = sessionFailure instanceof NotSignedIn;
  useEffect(() => {
    if (!signedOut) return;
    void navigate({ to: '/signin' });
  }, [signedOut, navigate]);


  const create = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // Made here rather than inside the payload, so the workspace to open is
    // known before the answer comes back.
    const workspaceId = uuidv7();
    command.mutate(
      {
        name: 'create_workspace',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          // The panel its first dashboard arrives with, made here for the
          // reason the workspace's own id is: the same id has to come back on a
          // replay, and nothing on the server can derive a uuid.
          panelId: uuidv7(),
          name: trimmed,
        },
      },
      {
        onSuccess: async () => {
          // Re-read the list before going there, for the reason adding a
          // dashboard does (components/DashboardBar.tsx): the workspace route
          // checks that the id is one of the account's, against the list in
          // hand - and the list in hand is the empty one that sent you here,
          // so without this it decides the workspace is not real and sends you
          // straight back. `useCommand` asks for the same re-read but does not
          // wait for it, and this is the caller that has to.
          await queryClient.refetchQueries({ queryKey: ['workspaces'] });

          // Straight into it: making your first workspace and then being left
          // on the screen that asked for it is two gestures for what reads as
          // one. A refusal leaves what was typed where it is, so the name can
          // be fixed rather than typed again.
          void navigate({ to: '/w/$workspaceId', params: { workspaceId } });
        },
      },
    );
  };

  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center px-4"
      style={{ backgroundColor: DEFAULT_WORKSPACE_THEME.ground }}
    >
      <main className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-panel">
        <h1 className="text-xl font-semibold tracking-tight">Cockpit</h1>
        <p className="mt-1 text-sm text-ink-soft">
          A workspace is what everything else goes in — work, personal, a customer. Make your
          first one.
        </p>
        <form onSubmit={create} className="flex flex-col gap-2 pt-5">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Work, Personal, a customer…"
            aria-label="Name of the new workspace"
            maxLength={60}
            autoFocus
            className="w-full rounded-md border border-black/10 bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
          />
          <button
            type="submit"
            disabled={command.isPending}
            className="milled rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
          >
            New workspace
          </button>
          {refusal && (
            <p role="alert" className="text-sm text-over">
              {refusal}
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
