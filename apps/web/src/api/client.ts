import { hc, type ClientRequestOptions } from 'hono/client';
import type { AppType } from '@cockpit/api';
import {
  accountHoldingsSchema,
  attachmentAddress,
  checkedNowSchema,
  usageSchema,
  rewriteHistoryResponseSchema,
  type AccountHoldings,
  type CheckedNow,
  signedInSchema,
  workspaceListSchema,
  workspaceSnapshotSchema,
  type ClientCommandName,
  type WindowCommandName,
  type CommandPayload,
  type CommandResult,
  type Usage,
  type RewriteHistoryResponse,
  type SignedIn,
  type WorkspaceList,
  type WorkspaceSnapshot,
} from '@cockpit/shared';
import { deviceTimeZone } from '../deviceTimeZone';

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

/**
 * Every read's refusal, in one place, so 401 cannot be handled in only some
 * of them. Exported for `ManageConnections.tsx`'s own fetch, kept out of this
 * module for the reason its doc comment gives.
 */
export function refusal(what: string, status: number): Error {
  const message = `${what} failed: ${status}`;
  return status === 401 ? new NotSignedIn(message) : new Error(message);
}

export async function fetchWorkspaces(): Promise<WorkspaceList> {
  const res = await api.v1.workspaces.$get();
  if (!res.ok) throw refusal('workspaces', res.status);
  return workspaceListSchema.parse(await res.json());
}

/** Who Cockpit believes you are - and, when it refuses, that it believes you are nobody. */
export async function fetchMe(): Promise<SignedIn> {
  const res = await api.v1.me.$get();
  if (!res.ok) throw refusal('sign-in', res.status);
  return signedInSchema.parse(await res.json());
}

/**
 * What the admin's Usage window reads ("Add an admin Usage window for sign-ins
 * and guest sessions", issue 654). A 403 arrives as an ordinary failure rather
 * than as `NotSignedIn`, and the difference matters: whoever gets one *is*
 * signed in, so sending them to the logon page would offer them the one thing
 * that cannot help.
 *
 * **It carries the device's time zone**, so the server cuts the window and its
 * days on the calendar of wherever the admin is ("Count Settings › Usage's days
 * on your own calendar", issue 1428).
 */
export async function fetchUsage(days: number): Promise<Usage> {
  const timeZone = deviceTimeZone();
  const res = await api.v1.admin.usage.$get({ query: { days: String(days), ...(timeZone ? { timeZone } : {}) } });
  if (!res.ok) throw refusal('usage', res.status);
  return usageSchema.parse(await res.json());
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

/**
 * The guest link, carrying where the person came from ('Record every sign-in,
 * with guest activity, for 12 months', issue 653).
 *
 * **Read from the sign-in page, because the Worker cannot**: the Referer it
 * sees on the guest route is Cockpit's own page. It is passed as a plain
 * query parameter the Worker reduces to a host and never trusts; nothing is
 * added when the browser reported no referrer.
 */
export function guestSignInPath(referrer: string): string {
  return referrer
    ? `${GUEST_SIGN_IN_PATH}?${new URLSearchParams({ referrer })}`
    : GUEST_SIGN_IN_PATH;
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
  return workspaceSnapshotSchema.parse(await res.json());
}

/**
 * Every rewrite attempt for one workspace's items, most recent first - the
 * table opened from the Inbox's own menu ("See the history of what Cockpit
 * proposed for the Inbox's items", issue 444).
 */
export async function fetchRewriteHistoryForWorkspace(workspaceId: string): Promise<RewriteHistoryResponse> {
  const res = await api.v1.workspaces[':workspaceId']['rewrite-history'].$get({
    param: { workspaceId },
  });
  if (!res.ok) throw refusal('rewrite history', res.status);
  return rewriteHistoryResponseSchema.parse(await res.json());
}

/** Every rewrite attempt for one item, most recent first - what its form's What Cockpit changed tab reads (issue 690). */
export async function fetchRewriteHistoryForItem(itemId: string): Promise<RewriteHistoryResponse> {
  const res = await api.v1.items[':itemId']['rewrite-history'].$get({
    param: { itemId },
  });
  if (!res.ok) throw refusal('rewrite history', res.status);
  return rewriteHistoryResponseSchema.parse(await res.json());
}

/**
 * *Check now* on a pulled connection ("Check a pulled connection now, from its
 * row or its history", issue 1143): its check made due at once. Its own
 * function rather than a `commandSenders` entry - it changes no Item or
 * setting, only when the next check runs.
 */
export async function checkConnectionNow(workspaceId: string, sourceAccountId: string): Promise<CheckedNow> {
  const res = await api.v1.workspaces[':workspaceId'].connections[':sourceAccountId']['check-now'].$post({
    param: { workspaceId, sourceAccountId },
  });
  if (!res.ok) throw refusal('checking the connection', res.status);
  return checkedNowSchema.parse(await res.json());
}

/** One sender per command; adding a command extends this map and nothing else. */
const commandSenders = {
  create_workspace: (p: CommandPayload<'create_workspace'>, o?: ClientRequestOptions) =>
    api.v1.commands.create_workspace.$post({ json: p }, o),
  rename_workspace: (p: CommandPayload<'rename_workspace'>, o?: ClientRequestOptions) =>
    api.v1.commands.rename_workspace.$post({ json: p }, o),
  delete_workspace: (p: CommandPayload<'delete_workspace'>, o?: ClientRequestOptions) =>
    api.v1.commands.delete_workspace.$post({ json: p }, o),
  // Only the disconnect: connecting is a navigation through Microsoft, and
  // the command it ends in is written by the callback route rather than sent
  // from here (`connectSourceAccountSchema`, @cockpit/shared).
  disconnect_source_account: (p: CommandPayload<'disconnect_source_account'>, o?: ClientRequestOptions) =>
    api.v1.commands.disconnect_source_account.$post({ json: p }, o),
  set_connection_choice: (p: CommandPayload<'set_connection_choice'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_connection_choice.$post({ json: p }, o),
  set_connection_files_by_name: (p: CommandPayload<'set_connection_files_by_name'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_connection_files_by_name.$post({ json: p }, o),
  set_connection_due_in_days: (p: CommandPayload<'set_connection_due_in_days'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_connection_due_in_days.$post({ json: p }, o),
  reorder_workspaces: (p: CommandPayload<'reorder_workspaces'>, o?: ClientRequestOptions) =>
    api.v1.commands.reorder_workspaces.$post({ json: p }, o),
  set_workspace_theme: (p: CommandPayload<'set_workspace_theme'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_workspace_theme.$post({ json: p }, o),
  add_dashboard: (p: CommandPayload<'add_dashboard'>, o?: ClientRequestOptions) =>
    api.v1.commands.add_dashboard.$post({ json: p }, o),
  rename_dashboard: (p: CommandPayload<'rename_dashboard'>, o?: ClientRequestOptions) =>
    api.v1.commands.rename_dashboard.$post({ json: p }, o),
  delete_dashboard: (p: CommandPayload<'delete_dashboard'>, o?: ClientRequestOptions) =>
    api.v1.commands.delete_dashboard.$post({ json: p }, o),
  reorder_dashboards: (p: CommandPayload<'reorder_dashboards'>, o?: ClientRequestOptions) =>
    api.v1.commands.reorder_dashboards.$post({ json: p }, o),
  add_panel: (p: CommandPayload<'add_panel'>, o?: ClientRequestOptions) => api.v1.commands.add_panel.$post({ json: p }, o),
  rename_panel: (p: CommandPayload<'rename_panel'>, o?: ClientRequestOptions) =>
    api.v1.commands.rename_panel.$post({ json: p }, o),
  set_panel_settings: (p: CommandPayload<'set_panel_settings'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_panel_settings.$post({ json: p }, o),
  delete_panel: (p: CommandPayload<'delete_panel'>, o?: ClientRequestOptions) =>
    api.v1.commands.delete_panel.$post({ json: p }, o),
  move_panel_to_dashboard: (p: CommandPayload<'move_panel_to_dashboard'>, o?: ClientRequestOptions) =>
    api.v1.commands.move_panel_to_dashboard.$post({ json: p }, o),
  set_panel_text: (p: CommandPayload<'set_panel_text'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_panel_text.$post({ json: p }, o),
  set_panel_read_only: (p: CommandPayload<'set_panel_read_only'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_panel_read_only.$post({ json: p }, o),
  set_panel_never_propose: (p: CommandPayload<'set_panel_never_propose'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_panel_never_propose.$post({ json: p }, o),
  set_panel_format: (p: CommandPayload<'set_panel_format'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_panel_format.$post({ json: p }, o),
  set_panel_filter: (p: CommandPayload<'set_panel_filter'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_panel_filter.$post({ json: p }, o),
  set_panel_sort: (p: CommandPayload<'set_panel_sort'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_panel_sort.$post({ json: p }, o),
  save_layout: (p: CommandPayload<'save_layout'>, o?: ClientRequestOptions) => api.v1.commands.save_layout.$post({ json: p }, o),
  capture_item: (p: CommandPayload<'capture_item'>, o?: ClientRequestOptions) => api.v1.commands.capture_item.$post({ json: p }, o),
  move_item_to_panel: (p: CommandPayload<'move_item_to_panel'>, o?: ClientRequestOptions) =>
    api.v1.commands.move_item_to_panel.$post({ json: p }, o),
  add_item_to_panel: (p: CommandPayload<'add_item_to_panel'>, o?: ClientRequestOptions) =>
    api.v1.commands.add_item_to_panel.$post({ json: p }, o),
  remove_item_from_panel: (p: CommandPayload<'remove_item_from_panel'>, o?: ClientRequestOptions) =>
    api.v1.commands.remove_item_from_panel.$post({ json: p }, o),
  set_done: (p: CommandPayload<'set_done'>, o?: ClientRequestOptions) => api.v1.commands.set_done.$post({ json: p }, o),
  set_started: (p: CommandPayload<'set_started'>, o?: ClientRequestOptions) => api.v1.commands.set_started.$post({ json: p }, o),
  send_item_to_claude: (p: CommandPayload<'send_item_to_claude'>, o?: ClientRequestOptions) =>
    api.v1.commands.send_item_to_claude.$post({ json: p }, o),
  finish_agent_run: (p: CommandPayload<'finish_agent_run'>, o?: ClientRequestOptions) =>
    api.v1.commands.finish_agent_run.$post({ json: p }, o),
  set_dismissed: (p: CommandPayload<'set_dismissed'>, o?: ClientRequestOptions) => api.v1.commands.set_dismissed.$post({ json: p }, o),
  associate: (p: CommandPayload<'associate'>, o?: ClientRequestOptions) => api.v1.commands.associate.$post({ json: p }, o),
  set_next_action: (p: CommandPayload<'set_next_action'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_next_action.$post({ json: p }, o),
  set_priority: (p: CommandPayload<'set_priority'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_priority.$post({ json: p }, o),
  set_due_date: (p: CommandPayload<'set_due_date'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_due_date.$post({ json: p }, o),
  set_repeat: (p: CommandPayload<'set_repeat'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_repeat.$post({ json: p }, o),
  set_title: (p: CommandPayload<'set_title'>, o?: ClientRequestOptions) => api.v1.commands.set_title.$post({ json: p }, o),
  set_description: (p: CommandPayload<'set_description'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_description.$post({ json: p }, o),
  remove_attachment: (p: CommandPayload<'remove_attachment'>, o?: ClientRequestOptions) =>
    api.v1.commands.remove_attachment.$post({ json: p }, o),
  set_duplicate_settled: (p: CommandPayload<'set_duplicate_settled'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_duplicate_settled.$post({ json: p }, o),
  remember_sentence: (p: CommandPayload<'remember_sentence'>, o?: ClientRequestOptions) =>
    api.v1.commands.remember_sentence.$post({ json: p }, o),
  edit_remembered_sentence: (p: CommandPayload<'edit_remembered_sentence'>, o?: ClientRequestOptions) =>
    api.v1.commands.edit_remembered_sentence.$post({ json: p }, o),
  delete_remembered_sentence: (p: CommandPayload<'delete_remembered_sentence'>, o?: ClientRequestOptions) =>
    api.v1.commands.delete_remembered_sentence.$post({ json: p }, o),
  set_item_form_presentation: (p: CommandPayload<'set_item_form_presentation'>, o?: ClientRequestOptions) =>
    api.v1.commands.set_item_form_presentation.$post({ json: p }, o),
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
 * The server's own words for a refusal, where it gave any - shared by
 * `uploadAttachment` and `sendCommand` below, which otherwise each wrote
 * this out by hand. A body that is missing or not JSON (a gateway's error
 * page, a redirect to sign in) must not turn a refusal into a parse
 * failure, so this answers `undefined` rather than throwing.
 */
async function refusalFrom(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return body.error;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Uploads a file and attaches it to an Item ("Attach a file to an item",
 * issue 441). Its own function rather than a `sendCommand` sender: the
 * command this creates, `add_attachment`, has no JSON route to post to
 * (`ClientCommandName`, `@cockpit/shared`) - a file's bytes go over the wire
 * as the request body itself, and the server builds the command from what
 * actually landed. `attachmentId`/`commandId` are the caller's to generate
 * and hold onto, the same as every other command's envelope, so a chip can
 * be drawn optimistically before this resolves.
 *
 * **No `Content-Length` header is set here.** It is a forbidden header name
 * under `fetch` - the browser computes it from `file`'s own size, which is
 * what the upload route reads to refuse an oversized file before touching
 * the body at all.
 */
export async function uploadAttachment({
  itemId,
  workspaceId,
  attachmentId,
  commandId,
  file,
  signal,
}: {
  itemId: string;
  workspaceId: string;
  attachmentId: string;
  commandId: string;
  file: File;
  /** Aborts the upload, for a sender that has given up waiting on it (`captureOutboxSender.tsx`). */
  signal?: AbortSignal;
}): Promise<CommandResult> {
  const res = await fetch(`/v1/items/${encodeURIComponent(itemId)}/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      'X-Attachment-Id': attachmentId,
      'X-Command-Id': commandId,
      'X-Issued-At': new Date().toISOString(),
      'X-Workspace-Id': workspaceId,
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new CommandRefused(res.status, (await refusalFrom(res)) ?? `attaching ${file.name} failed: ${res.status}`);
  }
  return (await res.json()) as CommandResult;
}

/** An Item's attachment, opened or downloaded from a click on its chip (issue 441). */
export function attachmentUrl(attachmentId: string): string {
  return attachmentAddress(attachmentId);
}

/**
 * `ClientCommandName` rather than `CommandName`: the registry in
 * `packages/shared` also holds the commands Cockpit sends itself, which have no
 * endpoint and so no sender above ("Clean up a captured note into a clear title
 * and a fuller message", issue 296).
 */
export async function sendCommand<N extends Exclude<ClientCommandName, WindowCommandName>>(
  name: N,
  payload: CommandPayload<N>,
  /** Aborts the request, for a sender that has given up waiting on it (`captureOutboxSender.tsx`). */
  signal?: AbortSignal,
): Promise<CommandResult> {
  const send = commandSenders[name] as (p: never, o?: ClientRequestOptions) => Promise<Response>;
  const res = await send(payload as never, signal ? { init: { signal } } : undefined);
  if (!res.ok) {
    throw new CommandRefused(res.status, (await refusalFrom(res)) ?? `${name} failed: ${res.status}`);
  }
  return (await res.json()) as CommandResult;
}
