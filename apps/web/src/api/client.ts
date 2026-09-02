import { hc } from 'hono/client';
import { clearSignInAttempt } from './loadFailure';
import type { AppType } from '@cockpit/api';
import {
  signedInSchema,
  userListSchema,
  workspaceListSchema,
  workspaceSnapshotSchema,
  type CommandName,
  type CommandPayload,
  type CommandResult,
  type SignedIn,
  type User,
  type WorkspaceList,
  type WorkspaceSnapshot,
} from '@cockpit/shared';

/**
 * The typed client (architecture, "How the client talks to the backend"):
 * Hono's `hc` infers the whole surface
 * from the API's route chain, and responses are additionally runtime-validated
 * with the same shared Zod schemas the server serializes from.
 */
export const api = hc<AppType>('/');

/**
 * Cockpit itself refused the request because this browser is not signed in.
 *
 * A separate type rather than a status to read off the message, because two
 * different things have to react to it: the router, which sends you to the
 * logon page instead of to a failed read, and the failure screen, which offers
 * Cockpit's own sign-in rather than the perimeter's. The message keeps the
 * `failed: 401` shape every other refusal has, so `diagnose` still reads it.
 */
export class NotSignedIn extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotSignedIn';
  }
}

/** Every read's refusal, in one place, so 401 cannot be handled in only some of them. */
function refusal(what: string, status: number): Error {
  const message = `${what} failed: ${status}`;
  return status === 401 ? new NotSignedIn(message) : new Error(message);
}

export async function fetchWorkspaces(): Promise<WorkspaceList> {
  const res = await api.v1.workspaces.$get();
  if (!res.ok) throw refusal('workspaces', res.status);
  return workspaceListSchema.parse(await res.json());
}

/**
 * The people you can sign in as. The one read that answers before you are
 * anybody, so it is the one read that never has to handle being refused for
 * not being signed in.
 */
export async function fetchUsers(): Promise<User[]> {
  const res = await api.v1.users.$get();
  if (!res.ok) throw refusal('users', res.status);
  return userListSchema.parse(await res.json()).users;
}

/** Who Cockpit believes you are - and, when it refuses, that it believes you are nobody. */
export async function fetchMe(): Promise<SignedIn> {
  const res = await api.v1.me.$get();
  if (!res.ok) throw refusal('sign-in', res.status);
  return signedInSchema.parse(await res.json());
}

export async function signIn(userId: string): Promise<SignedIn> {
  const res = await api.v1['sign-in'].$post({ json: { userId } });
  if (!res.ok) throw refusal('sign-in', res.status);
  return signedInSchema.parse(await res.json());
}

export async function signOut(): Promise<void> {
  // Read before branching, and as a plain number: the typed client narrows the
  // response away entirely once `ok` is ruled out, which leaves nothing to ask
  // the status of.
  const status: number = (await api.v1['sign-out'].$post()).status;
  // A sign-out the server has already forgotten is a sign-out: being refused
  // for not being signed in is the outcome asked for, not a failure to report.
  if (status !== 200 && status !== 401) throw refusal('sign-out', status);
}

export async function fetchSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
  const res = await api.v1.workspaces[':workspaceId'].snapshot.$get({
    param: { workspaceId },
  });
  if (!res.ok) throw refusal('snapshot', res.status);
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
  rename_workspace: (p: CommandPayload<'rename_workspace'>) =>
    api.v1.commands.rename_workspace.$post({ json: p }),
  delete_workspace: (p: CommandPayload<'delete_workspace'>) =>
    api.v1.commands.delete_workspace.$post({ json: p }),
  reorder_workspaces: (p: CommandPayload<'reorder_workspaces'>) =>
    api.v1.commands.reorder_workspaces.$post({ json: p }),
  set_workspace_theme: (p: CommandPayload<'set_workspace_theme'>) =>
    api.v1.commands.set_workspace_theme.$post({ json: p }),
  add_dashboard: (p: CommandPayload<'add_dashboard'>) =>
    api.v1.commands.add_dashboard.$post({ json: p }),
  rename_dashboard: (p: CommandPayload<'rename_dashboard'>) =>
    api.v1.commands.rename_dashboard.$post({ json: p }),
  delete_dashboard: (p: CommandPayload<'delete_dashboard'>) =>
    api.v1.commands.delete_dashboard.$post({ json: p }),
  add_panel: (p: CommandPayload<'add_panel'>) => api.v1.commands.add_panel.$post({ json: p }),
  rename_panel: (p: CommandPayload<'rename_panel'>) =>
    api.v1.commands.rename_panel.$post({ json: p }),
  delete_panel: (p: CommandPayload<'delete_panel'>) =>
    api.v1.commands.delete_panel.$post({ json: p }),
  save_layout: (p: CommandPayload<'save_layout'>) => api.v1.commands.save_layout.$post({ json: p }),
  delete_layout: (p: CommandPayload<'delete_layout'>) =>
    api.v1.commands.delete_layout.$post({ json: p }),
  capture_item: (p: CommandPayload<'capture_item'>) => api.v1.commands.capture_item.$post({ json: p }),
  move_item_to_panel: (p: CommandPayload<'move_item_to_panel'>) =>
    api.v1.commands.move_item_to_panel.$post({ json: p }),
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
