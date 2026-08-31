import { hc } from 'hono/client';
import { clearSignInAttempt } from './loadFailure';
import type { AppType } from '@cockpit/api';
import {
  workspaceListSchema,
  workspaceSnapshotSchema,
  type CommandName,
  type CommandPayload,
  type CommandResult,
  type WorkspaceList,
  type WorkspaceSnapshot,
} from '@cockpit/shared';

/**
 * The typed client (architecture §5.5): Hono's `hc` infers the whole surface
 * from the API's route chain, and responses are additionally runtime-validated
 * with the same shared Zod schemas the server serializes from.
 */
export const api = hc<AppType>('/');

export async function fetchWorkspaces(): Promise<WorkspaceList> {
  const res = await api.v1.workspaces.$get();
  if (!res.ok) throw new Error(`workspaces failed: ${res.status}`);
  return workspaceListSchema.parse(await res.json());
}

export async function fetchSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
  const res = await api.v1.workspaces[':workspaceId'].snapshot.$get({
    param: { workspaceId },
  });
  if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
  // Reaching a workspace is what proves we are back in, so this is where the
  // one-attempt-per-tab guard is forgotten. Deliberately not on the workspace
  // list: Layout reads that on every route and it succeeds even while the
  // snapshot is being refused, which would clear the guard immediately before
  // it is consulted and turn one sign-in attempt into an endless round trip.
  clearSignInAttempt();
  return workspaceSnapshotSchema.parse(await res.json());
}

/** One sender per command; adding a command extends this map and nothing else. */
const commandSenders = {
  create_workspace: (p: CommandPayload<'create_workspace'>) =>
    api.v1.commands.create_workspace.$post({ json: p }),
  capture_item: (p: CommandPayload<'capture_item'>) => api.v1.commands.capture_item.$post({ json: p }),
  set_status: (p: CommandPayload<'set_status'>) => api.v1.commands.set_status.$post({ json: p }),
  snooze_until: (p: CommandPayload<'snooze_until'>) => api.v1.commands.snooze_until.$post({ json: p }),
  associate: (p: CommandPayload<'associate'>) => api.v1.commands.associate.$post({ json: p }),
  set_focus: (p: CommandPayload<'set_focus'>) => api.v1.commands.set_focus.$post({ json: p }),
  set_next_action: (p: CommandPayload<'set_next_action'>) =>
    api.v1.commands.set_next_action.$post({ json: p }),
  set_priority: (p: CommandPayload<'set_priority'>) =>
    api.v1.commands.set_priority.$post({ json: p }),
} as const;

/**
 * A change the server refused for a reason worth repeating to the person who
 * made it - a name already in use, something that is no longer there. Carries
 * the status so a screen can tell "you cannot do that" apart from "we could not
 * reach the server", which want different words.
 */
export class CommandRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CommandRefused';
  }
}

export async function sendCommand<N extends CommandName>(
  name: N,
  payload: CommandPayload<N>,
): Promise<CommandResult> {
  const res = await commandSenders[name](payload as never);
  if (!res.ok) {
    // The server's own words where there are any. A body that is missing or
    // not JSON (a gateway's error page, a redirect to sign in) must not turn
    // a refusal into a parse failure, so it falls back to the status.
    let said: string | undefined;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        said = body.error;
      }
    } catch {
      said = undefined;
    }
    throw new CommandRefused(res.status, said ?? `${name} failed: ${res.status}`);
  }
  return (await res.json()) as CommandResult;
}
