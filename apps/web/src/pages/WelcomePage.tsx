import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_WORKSPACE_THEME, uuidv7 } from '@cockpit/shared';
import { refusalFrom, useCommand, workspacesQuery } from '../api/queries';
import { WHAT_A_WORKSPACE_IS } from '../whatThingsAre';
import { rememberWelcomed } from '../welcoming';

/**
 * The one question a new account is asked before it is shown the app: what its
 * workspace is.
 *
 * **Only the workspace, and that is the rule this screen is an instance of:
 * ask up front only what has to be decided up front, and teach the rest at
 * first use.** A workspace is a decision - it is the privacy boundary, there
 * are few of them, and anybody can answer *work*, *personal* or a customer's
 * name on the day they arrive. A dashboard and a panel are not: nobody knows
 * when they want a second dashboard until they have used the first for a while,
 * so asking here would demand a decision in the one moment it cannot be made.
 * Those two explain themselves in the questions that make them
 * (`components/DashboardBar.tsx`), and the panel's own gesture is shown on the
 * empty panel and in the Inbox.
 *
 * **It creates nothing.** The workspace is already there - an account arrives
 * with one (apps/api/src/accounts/changes.ts) - so this renames it, and every
 * way out leaves an app that works: *Skip* and an empty box both open a
 * workspace still called *Workspace 1*, which is one double-click from being
 * renamed whenever somebody would rather.
 */
export function WelcomePage() {
  const navigate = useNavigate();
  const { data } = useQuery(workspacesQuery);
  const workspace = data?.workspaces[0];

  const [name, setName] = useState('');
  const command = useCommand();

  const intoTheApp = () => {
    rememberWelcomed();
    if (!workspace) return;
    void navigate({ to: '/w/$workspaceId', params: { workspaceId: workspace.id } });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !workspace) {
      intoTheApp();
      return;
    }
    command.mutate(
      {
        name: 'rename_workspace',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: workspace.id,
          name: trimmed,
        },
      },
      { onSuccess: intoTheApp },
    );
  };

  const refusal = refusalFrom(command);

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center px-4"
      style={{ backgroundColor: DEFAULT_WORKSPACE_THEME.ground }}
    >
      <main className="w-full max-w-md rounded-lg bg-surface p-6 shadow-panel">
        <h1 className="text-xl font-semibold tracking-tight">
          What are you going to use Cockpit for?
        </h1>
        {/* The same sentence the `+` on the tab strip says (`whatThingsAre.ts`).
            This screen is the workspace's *first* use - an account arrives
            holding one - and that `+` is every use after it. */}
        <p className="mt-3 text-sm text-ink-soft">
          Everything in Cockpit lives in a workspace. {WHAT_A_WORKSPACE_IS}
        </p>

        <form onSubmit={submit} className="flex flex-col gap-3 pt-5">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Work, Personal, a customer…"
            aria-label="Name of the workspace"
            maxLength={60}
            autoFocus
            className="w-full rounded-md border border-black/10 bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
          />
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={intoTheApp}
              className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              Skip
            </button>
            <button
              type="submit"
              disabled={command.isPending || !workspace}
              className="milled rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
            >
              Open Cockpit
            </button>
          </div>
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
