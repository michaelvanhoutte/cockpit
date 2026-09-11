import { hc } from 'hono/client';
import type { AppType } from '@cockpit/api';
import {
  accountHoldingsSchema,
  itemTypeListSchema,
  registeredUserListSchema,
  userDeletedSchema,
  type AccountHoldings,
  signedInSchema,
  workspaceListSchema,
  workspaceSnapshotSchema,
  userAddedSchema,
  userChangedSchema,
  type AddUser,
  type ChangeUser,
  type SetAccess,
  type UserChanged,
  type ClientCommandName,
  type CommandPayload,
  type CommandResult,
  type ItemTypeList,
  type RegisteredUserList,
  type UserAdded,
  type SignedIn,
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
 * the way back in. The message keeps the `failed: 401` shape every other
 * refusal has, so `diagnose` still reads it.
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

/** The account's live types, for the page that manages them. */
export async function fetchItemTypes(): Promise<ItemTypeList> {
  const res = await api.v1['item-types'].$get();
  if (!res.ok) throw refusal('types', res.status);
  return itemTypeListSchema.parse(await res.json());
}

/** Who Cockpit believes you are - and, when it refuses, that it believes you are nobody. */
export async function fetchMe(): Promise<SignedIn> {
  const res = await api.v1.me.$get();
  if (!res.ok) throw refusal('sign-in', res.status);
  return signedInSchema.parse(await res.json());
}

/**
 * Everyone this Cockpit knows, for the admin page ("See who can sign in, on a
 * page only an admin can open", issue 230).
 *
 * A 403 arrives here as an ordinary failure rather than as `NotSignedIn`, and
 * the difference matters: whoever gets one *is* signed in, so sending them to
 * the logon page would offer them the one thing that cannot help.
 */
export async function fetchRegisteredUsers(): Promise<RegisteredUserList> {
  const res = await api.v1.admin.users.$get();
  if (!res.ok) throw refusal('users', res.status);
  return registeredUserListSchema.parse(await res.json());
}

/**
 * Adds somebody ("Add a user on the admin page, so a second person no longer
 * needs SQL", issue 231).
 *
 * **A refusal keeps the server's own words**, because they name what is wrong
 * with what was typed - which address is already somebody's, what a name leaves
 * nothing of - and the page has nothing better to say than the reason. Anything
 * that is not a refusal is reported as a failure rather than pretending to be
 * one.
 */
export async function addUser(body: AddUser): Promise<UserAdded> {
  const res = await api.v1.admin.users.$post({ json: body });
  if (res.status === 409 || res.status === 400) {
    const { error } = (await res.json()) as { error: string };
    throw new UserRefused(error);
  }
  if (!res.ok) throw refusal('adding a user', res.status);
  return userAddedSchema.parse(await res.json());
}

/**
 * Renames somebody and sets their role ("Rename a user, and make somebody an
 * admin", issue 232).
 *
 * The refusals are the server's own words for the same reason adding keeps
 * them: they say which rule stopped it - the last admin, your own admin - and
 * the form has nothing better to put under itself than the reason. A 404 is one
 * of them, because somebody who is no longer in the register is a fact about
 * this page being out of date rather than a failure to report as one.
 */
export async function changeUser({
  userId,
  ...body
}: ChangeUser & { userId: string }): Promise<UserChanged> {
  const res = await api.v1.admin.users[':userId'].$patch({ param: { userId }, json: body });
  if (res.status === 409 || res.status === 404 || res.status === 400) {
    const { error } = (await res.json()) as { error: string };
    throw new UserRefused(error);
  }
  if (!res.ok) throw refusal('changing a user', res.status);
  return userChangedSchema.parse(await res.json());
}

/**
 * Takes somebody's access away, or gives it back ("Take somebody's access away
 * without taking their work", issue 233).
 *
 * Its own request rather than a field on the change, for the reason the route
 * is its own: it is done from the row's own menu and it ends the sign-ins that
 * person holds.
 */
export async function setAccess({
  userId,
  ...body
}: SetAccess & { userId: string }): Promise<UserChanged> {
  const res = await api.v1.admin.users[':userId'].access.$patch({ param: { userId }, json: body });
  if (res.status === 409 || res.status === 404 || res.status === 400) {
    const { error } = (await res.json()) as { error: string };
    throw new UserRefused(error);
  }
  if (!res.ok) throw refusal('changing access', res.status);
  return userChangedSchema.parse(await res.json());
}

/**
 * What somebody's account holds, for the question asked before deleting them
 * ("Delete a user, and the account they owned with them", issue 234).
 */
export async function fetchAccountHoldings(userId: string): Promise<AccountHoldings> {
  const res = await api.v1.admin.users[':userId'].account.$get({ param: { userId } });
  if (!res.ok) throw refusal('what their account holds', res.status);
  return accountHoldingsSchema.parse(await res.json());
}

/**
 * Deletes somebody and the account they owned (issue 234). A 404 is a refusal
 * in the server's words, as it is for a change: somebody already gone is this
 * page being out of date, not a failure.
 */
export async function deleteUser(userId: string): Promise<void> {
  const res = await api.v1.admin.users[':userId'].$delete({ param: { userId } });
  if (res.status === 409 || res.status === 404) {
    const { error } = (await res.json()) as { error: string };
    throw new UserRefused(error);
  }
  if (!res.ok) throw refusal('deleting a user', res.status);
  userDeletedSchema.parse(await res.json());
}

/**
 * Why somebody could not be added, changed or deleted, in the server's words,
 * for the box, the form or the question to show. One class for all three,
 * because each does the same thing with it: print the reason and keep what was
 * there.
 */
export class UserRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserRefused';
  }
}

/**
 * Signing in is a navigation, not a request: the browser leaves for Google and
 * comes back to a page, so there is nothing here to await and nothing to parse.
 *
 * `location.assign` rather than a router navigation for the same reason - the
 * destination is the Worker, not a route this application knows.
 */
export const SIGN_IN_PATH = '/v1/sign-in/google';

/**
 * The other way in, where the deployment offers one ("Sign in as a guest,
 * without a password", issue 354). A navigation for the same reason, even
 * though this one never leaves Cockpit: what it ends in is a page, not an
 * answer to parse.
 *
 * **Nothing here asks whether it is offered.** One build is served by every
 * deployment, and this page reads nothing, so the control is always drawn and
 * the Worker is what refuses where guest sign-in is not on.
 */
export const GUEST_SIGN_IN_PATH = '/v1/sign-in/guest';

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
  set_panel_text: (p: CommandPayload<'set_panel_text'>) =>
    api.v1.commands.set_panel_text.$post({ json: p }),
  set_panel_read_only: (p: CommandPayload<'set_panel_read_only'>) =>
    api.v1.commands.set_panel_read_only.$post({ json: p }),
  set_panel_format: (p: CommandPayload<'set_panel_format'>) =>
    api.v1.commands.set_panel_format.$post({ json: p }),
  save_layout: (p: CommandPayload<'save_layout'>) => api.v1.commands.save_layout.$post({ json: p }),
  delete_layout: (p: CommandPayload<'delete_layout'>) =>
    api.v1.commands.delete_layout.$post({ json: p }),
  create_screen_size: (p: CommandPayload<'create_screen_size'>) =>
    api.v1.commands.create_screen_size.$post({ json: p }),
  rename_screen_size: (p: CommandPayload<'rename_screen_size'>) =>
    api.v1.commands.rename_screen_size.$post({ json: p }),
  delete_screen_size: (p: CommandPayload<'delete_screen_size'>) =>
    api.v1.commands.delete_screen_size.$post({ json: p }),
  capture_item: (p: CommandPayload<'capture_item'>) => api.v1.commands.capture_item.$post({ json: p }),
  move_item_to_panel: (p: CommandPayload<'move_item_to_panel'>) =>
    api.v1.commands.move_item_to_panel.$post({ json: p }),
  add_item_to_panel: (p: CommandPayload<'add_item_to_panel'>) =>
    api.v1.commands.add_item_to_panel.$post({ json: p }),
  remove_item_from_panel: (p: CommandPayload<'remove_item_from_panel'>) =>
    api.v1.commands.remove_item_from_panel.$post({ json: p }),
  create_item_type: (p: CommandPayload<'create_item_type'>) =>
    api.v1.commands.create_item_type.$post({ json: p }),
  rename_item_type: (p: CommandPayload<'rename_item_type'>) =>
    api.v1.commands.rename_item_type.$post({ json: p }),
  set_item_type_color: (p: CommandPayload<'set_item_type_color'>) =>
    api.v1.commands.set_item_type_color.$post({ json: p }),
  delete_item_type: (p: CommandPayload<'delete_item_type'>) =>
    api.v1.commands.delete_item_type.$post({ json: p }),
  reorder_item_types: (p: CommandPayload<'reorder_item_types'>) =>
    api.v1.commands.reorder_item_types.$post({ json: p }),
  set_done: (p: CommandPayload<'set_done'>) => api.v1.commands.set_done.$post({ json: p }),
  set_dismissed: (p: CommandPayload<'set_dismissed'>) => api.v1.commands.set_dismissed.$post({ json: p }),
  associate: (p: CommandPayload<'associate'>) => api.v1.commands.associate.$post({ json: p }),
  set_next_action: (p: CommandPayload<'set_next_action'>) =>
    api.v1.commands.set_next_action.$post({ json: p }),
  set_priority: (p: CommandPayload<'set_priority'>) =>
    api.v1.commands.set_priority.$post({ json: p }),
  set_title: (p: CommandPayload<'set_title'>) => api.v1.commands.set_title.$post({ json: p }),
  set_description: (p: CommandPayload<'set_description'>) =>
    api.v1.commands.set_description.$post({ json: p }),
  set_routing_summary_correction: (p: CommandPayload<'set_routing_summary_correction'>) =>
    api.v1.commands.set_routing_summary_correction.$post({ json: p }),
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

/**
 * `ClientCommandName` rather than `CommandName`: the registry in
 * `packages/shared` also holds the commands Cockpit sends itself, which have no
 * endpoint and so no sender above ("Clean up a captured note into a clear title
 * and a fuller message", issue 296).
 */
export async function sendCommand<N extends ClientCommandName>(
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
