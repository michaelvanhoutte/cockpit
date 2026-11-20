import { hc, type ClientRequestOptions } from 'hono/client';
import type { AppType } from '@cockpit/api';
import {
  accountHoldingsSchema,
  attachmentAddress,
  checkedNowSchema,
  finishedItemsSchema,
  usageSchema,
  rewriteHistoryResponseSchema,
  type AccountHoldings,
  type CheckedNow,
  type FinishedItems,
  signedInSchema,
  workspaceListSchema,
  workspaceSnapshotSchema,
  type ClientCommandName,
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
 * One Workspace's finished Items, read when *All items* first opens or an
 * address names an Item the Workspace's read does not hold ("Fetch a
 * Workspace's finished Items the first time All items opens", issue 1434).
 */
export async function fetchFinishedItems(workspaceId: string): Promise<FinishedItems> {
  const res = await api.v1.workspaces[':workspaceId']['finished-items'].$get({
    param: { workspaceId },
  });
  if (!res.ok) throw refusal('finished items', res.status);
  return finishedItemsSchema.parse(await res.json());
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
 * function rather than a change posted by `sendCommand` - it changes no Item or
 * setting, only when the next check runs.
 */
export async function checkConnectionNow(workspaceId: string, sourceAccountId: string): Promise<CheckedNow> {
  const res = await api.v1.workspaces[':workspaceId'].connections[':sourceAccountId']['check-now'].$post({
    param: { workspaceId, sourceAccountId },
  });
  if (!res.ok) throw refusal('checking the connection', res.status);
  return checkedNowSchema.parse(await res.json());
}

/**
 * Every change is posted to its own route, `/v1/commands/<name>`, by name: one
 * call for all of them rather than a sender each, which the initial bundle
 * would carry. A client command with no route fails to compile here.
 */
type CommandRoutes = { [N in ClientCommandName]: (typeof api.v1.commands)[N]['$post'] };
type Post = (body: { json: never }, o?: ClientRequestOptions) => Promise<Response>;

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

/**
 * Uploads the small copy a device made of one of an Item's pictures, which the
 * server stores beside the picture and records as its thumbnail ("Item form:
 * there is no way to mark which image stands for an Item", issue 1863). Its own
 * function for the reason `uploadAttachment` is: the copy's bytes are the
 * request body. *Stop using as thumbnail* carries no copy and is the ordinary
 * `set_thumbnail` command instead.
 */
export async function uploadThumbnail({
  itemId,
  workspaceId,
  attachmentId,
  commandId,
  issuedAt,
  copy,
  signal,
}: {
  itemId: string;
  workspaceId: string;
  attachmentId: string;
  commandId: string;
  issuedAt: string;
  copy: Blob;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  const res = await fetch(
    `/v1/items/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(attachmentId)}/thumbnail`,
    {
      method: 'POST',
      headers: {
        'Content-Type': copy.type,
        'X-Command-Id': commandId,
        'X-Issued-At': issuedAt,
        'X-Workspace-Id': workspaceId,
      },
      body: copy,
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    throw new CommandRefused(res.status, (await refusalFrom(res)) ?? `the thumbnail could not be saved: ${res.status}`);
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
 * endpoint and so no route to post to ("Clean up a captured note into a clear title
 * and a fuller message", issue 296).
 */
export async function sendCommand<N extends ClientCommandName>(
  name: N,
  payload: CommandPayload<N>,
  /** Aborts the request, for a sender that has given up waiting on it (`captureOutboxSender.tsx`). */
  signal?: AbortSignal,
): Promise<CommandResult> {
  const routes = api.v1.commands as unknown as Record<ClientCommandName, { $post: Post }> & CommandRoutes;
  const res = await (routes[name] as { $post: Post }).$post({ json: payload as never }, signal ? { init: { signal } } : undefined);
  if (!res.ok) {
    throw new CommandRefused(res.status, (await refusalFrom(res)) ?? `${name} failed: ${res.status}`);
  }
  return (await res.json()) as CommandResult;
}
