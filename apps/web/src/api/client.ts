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
  // Getting an answer proves the sign-in is good, so a later expiry in this
  // same tab is handled automatically again rather than hitting the guard.
  clearSignInAttempt();
  return workspaceListSchema.parse(await res.json());
}

export async function fetchSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
  const res = await api.v1.workspaces[':workspaceId'].snapshot.$get({
    param: { workspaceId },
  });
  if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
  return workspaceSnapshotSchema.parse(await res.json());
}

/** One sender per command; adding a command extends this map and nothing else. */
const commandSenders = {
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

export async function sendCommand<N extends CommandName>(
  name: N,
  payload: CommandPayload<N>,
): Promise<CommandResult> {
  const res = await commandSenders[name](payload as never);
  if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
  return (await res.json()) as CommandResult;
}
