import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { usePageGround } from '../appearance';
import { NotSignedIn } from '../api/client';
import { meQuery } from '../api/queries';
import { useAddWorkspace } from '../components/AddWorkspace';

/**
 * What an account with no workspaces is shown: the one thing it can do.
 *
 * **It carries none of the app's chrome**, and that is the whole reason it
 * exists. Everything under the shell is drawn inside a workspace - the header
 * wears that workspace's colour, holds its Capture… control and marks its tab -
 * so an address reached without one had the shell painting a default theme over
 * a strip with nothing selected, which read as a different app. A workspace is changed on
 * its own tab now (`components/WorkspaceTabs.tsx`), which leaves exactly one
 * case with no workspace and so no tab: not having any. This is that case, and it is a screen rather than a page under
 * the shell.
 *
 * It is where the router sends you when the account holds none - a first visit,
 * or the last workspace deleted - and the invitation is the page: it says there
 * are none and the box to type a name into is right under it.
 */
export function FirstWorkspacePage() {
  const ground = usePageGround();
  const [name, setName] = useState('');
  const add = useAddWorkspace(null);
  const navigate = useNavigate();

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
    // Straight into it: making your first workspace and then being left on the
    // screen that asked for it is two gestures for what reads as one. It opens
    // before the server has answered; a refusal brings you back here, and says
    // why in the undo bar (components/AddWorkspace.tsx).
    add(trimmed);
    // Emptied, so a second press before the page has gone sends nothing.
    setName('');
  };

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center px-4"
      style={{ backgroundColor: ground }}
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
            className="w-full rounded-md border border-shade/10 bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
          />
          <button
            type="submit"
            className="milled rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            New workspace
          </button>
        </form>
      </main>
    </div>
  );
}
