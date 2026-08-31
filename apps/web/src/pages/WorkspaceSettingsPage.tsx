import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useCommand, workspacesQuery } from '../api/queries';

/**
 * Where workspaces are managed. Today it lists them and makes new ones;
 * renaming and deleting arrive with "Rename and delete a workspace" (issue 77)
 * and reordering with "Reorder workspaces" (issue 31), both on this page.
 *
 * Colors are not offered: one is assigned from a fixed palette so a new
 * workspace is distinguishable in the tabs from the moment it exists. Picking
 * them is "Choose a workspace's colors from a palette" (issue 79).
 */
export function WorkspaceSettingsPage() {
  const { data } = useQuery(workspacesQuery);
  const [name, setName] = useState('');
  const command = useCommand();

  const workspaces = data?.workspaces ?? [];

  const submit = (e: React.FormEvent) => {
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

  // The server's words where it gave any ("a workspace called Personal already
  // exists"), and something plain where the request never got an answer.
  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>

      <section className="rounded-lg bg-surface shadow-panel">
        <ul>
          {workspaces.map((ws) => (
            <li
              key={ws.id}
              className="flex items-center gap-3 border-b border-black/5 px-4 py-3 last:border-b-0"
            >
              <span
                className="inline-block size-3 shrink-0 rounded-full"
                style={{ backgroundColor: ws.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{ws.name}</span>
            </li>
          ))}
        </ul>
        {workspaces.length === 0 && (
          <p className="px-4 py-4 text-sm text-ink-faint">No workspaces yet.</p>
        )}
      </section>

      <form onSubmit={submit} className="flex flex-col gap-2">
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
        {refusal && (
          <p role="alert" className="text-sm text-over">
            {refusal}
          </p>
        )}
      </form>
    </div>
  );
}
