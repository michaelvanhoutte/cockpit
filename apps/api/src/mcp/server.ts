import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ACCOUNT_WIDE, UNTITLED, textsFromCapture, uuidv7 } from '@cockpit/shared';
import { NotFoundInAccountError, RefusedByAccountError, openAccount, putAttachment, type Account } from '../accounts/index.js';
import type { Env } from '../env.js';
import { enqueueCleanUp, enqueueProposalForClaude, enqueueReadingItsMeaning, enqueueRepropose } from '../jobs/enrichment.js';
import { REPORT_RUN, readReport, reportRunTool } from './report-run.js';
import { FIND_ITEMS, describeFound, findItemsTool, readFind, refusePanel } from './find-items.js';
import {
  DELETE_ITEM,
  NO_SUCH_ITEM,
  RESTORE_ITEM,
  deleteItemTool,
  readItemId,
  restoreItemTool,
} from './delete-item.js';
import {
  UPDATE_ITEM,
  describeUpdate,
  planUpdate,
  readUpdate,
  resolveUpdatePanels,
  updateItemTool,
  waitTimeZone,
} from './update-item.js';
import {
  CREATE_ITEM,
  SERVER_INSTRUCTIONS,
  createItemTool,
  readCapture,
  senderFrom,
  stepsAfterCapture,
} from './create-item.js';
import { MOST_BODY_BYTES, bytesOf, describeAdded, recordFile, resolveRemovals, type FileStored, type FileToAdd } from './files.js';
import { noteCapture } from './connected-apps.js';
import { grantHolder } from './grant.js';
import { MCP_PATH } from '../auth/mcp-paths.js';
import { attachmentLinkAddress, attachmentLinkKey } from '../auth/attachment-link.js';
import type { FoundPage } from '../domain/item-search.js';

/**
 * `/mcp`, once the OAuth library has accepted an access token made for it
 * ("Connect Claude to Cockpit, and capture an item from it", issue 599).
 *
 * **Built for every request and holding nothing between them.** The
 * Streamable HTTP transport runs stateless - no session id, plain JSON
 * answers - so any instance answers any call, and the tool list is read from
 * the account as it is now: a workspace renamed a moment ago is listed by its
 * new name on the next `tools/list`, with nothing to invalidate.
 *
 * Six tools, `create_item`, `report_run` (issue 1160), `find_items`
 * (issue 1242, the only one that reads), `update_item` (issue 1811, which
 * changes an Item's texts, priority, due date and status), and `delete_item`
 * with `restore_item` (issue 1810, which dismiss and bring back), and no
 * resources or prompts: the server declares the tools capability alone, so a
 * client never asks for the others.
 */

/** What the library hands a protected handler, narrowed to what is read here. */
export interface ProtectedContext {
  readonly props: unknown;
  readonly auth?: { readonly token: string; readonly clientId?: string };
  waitUntil(work: Promise<unknown>): void;
}

export async function answerMcp(request: Request, env: Env, ctx: ProtectedContext): Promise<Response> {
  // **POST only.** Stateless, there is no stream to hold open for a `GET` and
  // no session for a `DELETE` to end, and the transport would otherwise answer
  // a `GET` with a stream that never closes - so both are refused here, as the
  // SDK's own stateless example refuses them.
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }

  // **Asked again on every call**, never trusted from the grant (`grant.ts`):
  // somebody deleted or disabled since they consented is nobody now. The app
  // is answered the way the library answers a token that is no good, and its
  // next refresh is refused and the grant revoked (`oauth.ts`), so it cannot
  // get access back without somebody consenting again.
  let holder: Awaited<ReturnType<typeof grantHolder>>;
  let account: Account;
  try {
    holder = await grantHolder(env, ctx.props);
    if (!holder) return tokenRefused(env);
    account = await openAccount(env, holder.accountName);
  } catch (error) {
    // The register or the account could not be read: the same logged,
    // plain answer a broken tool call gets, rather than the runtime's own.
    logged(error);
    return Response.json(
      { jsonrpc: '2.0', error: { code: ErrorCode.InternalError, message: SOMETHING_BROKE }, id: null },
      { status: 500 },
    );
  }
  const app = {
    clientId: ctx.auth?.clientId ?? 'unknown',
    clientName: holder.clientName,
    grantId: grantIdOf(ctx.auth?.token),
  };

  const server = new Server(
    { name: 'cockpit', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      // The Workspaces with their Panels: what each write tool names them from.
      const catalogue = await account.panelCatalogue();
      const workspaces = catalogue.map((one) => one.workspace);
      return {
        tools: [
          createItemTool(catalogue),
          reportRunTool(),
          findItemsTool(workspaces),
          updateItemTool(catalogue),
          deleteItemTool(),
          restoreItemTool(),
        ],
      };
    } catch (error) {
      logged(error);
      throw new McpError(ErrorCode.InternalError, SOMETHING_BROKE);
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const known = [CREATE_ITEM, REPORT_RUN, FIND_ITEMS, UPDATE_ITEM, DELETE_ITEM, RESTORE_ITEM];
    if (!known.includes(params.name)) {
      return toolError(`There is no tool called ${params.name}.`);
    }
    try {
      const said =
        params.name === REPORT_RUN
          ? await reportRun(account, app, params.arguments)
          : params.name === FIND_ITEMS
            ? await find(env, account, holder.accountName, app, params.arguments)
            : params.name === UPDATE_ITEM
              ? await update(env, ctx, account, holder.accountName, app, params.arguments)
              : params.name === DELETE_ITEM || params.name === RESTORE_ITEM
                ? await dismiss(account, app, params.name === DELETE_ITEM, params.arguments)
                : await capture(env, ctx, account, holder.accountName, app, params.arguments);
      return 'refusal' in said ? toolError(said.refusal) : { content: [{ type: 'text', text: said.reply }] };
    } catch (error) {
      logged(error);
      return toolError(SOMETHING_BROKE);
    }
  });

  // No `sessionIdGenerator`, which is what makes the transport stateless.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    // Files ride in the call as base64, so the body may be well over the transport's 4 MiB default.
    maxRequestBodySize: MOST_BODY_BYTES,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/**
 * One `create_item` call: admitted, read against the account as it is now,
 * written through `capture_item` exactly as the capture page writes one, and
 * the same two jobs queued after it.
 *
 * **No idempotency, deliberately**: an app that lost the reply and asks again
 * gets a second Item, which the duplicate check flags ("Flag a captured note
 * that says what another one already said", issue 407). The only id a call
 * could be keyed on is one client's own private metadata, so ids here are
 * fresh every time.
 */
async function capture(
  env: Env,
  ctx: ProtectedContext,
  account: Account,
  accountName: string,
  app: { clientId: string; clientName: string; grantId: string },
  args: unknown,
): Promise<{ reply: string } | { refusal: string }> {
  // Asked together: the count is the store's memory and the two reads are its
  // tables, and a call refused for being one too many has simply read for
  // nothing. Every call is counted, refused ones included.
  const [admitted, catalogue] = await Promise.all([
    account.appCaptureArrived(app.grantId, new Date().toISOString()),
    account.panelCatalogue(),
  ]);
  if (admitted === 'too-many') {
    return { refusal: 'Too many calls in the last minute. Wait a minute and try again.' };
  }

  const read = readCapture(args, catalogue);
  if (!read.ok) return { refusal: read.refusal };
  const workspaces = catalogue.map((one) => one.workspace);

  const itemId = uuidv7();
  const sender = senderFrom(app.clientName);
  // A wait counts its days on the calendar of the account's latest capture.
  const timeZone = read.status?.to === 'waiting' ? waitTimeZone(await account.recentCapturedTimeZones(), new Date()) : 'UTC';
  // Every read is behind us, so the files are put just before the store call and not before; `now` is taken after, so the commands are stamped when they are sent and not before an upload that takes seconds.
  const stored = await putFiles(env, accountName, itemId, read.files);
  const now = new Date();
  // The capture, then the steps to its status, in one call to the store: a tab
  // hears of the new item once, and what follows the capture cannot be seen
  // without it.
  const afterStatus = stepsAfterCapture(read, itemId, now.toISOString(), timeZone);
  const applied = await account.applyChanges([
    {
      name: 'capture_item',
      payload: {
        commandId: uuidv7(),
        issuedAt: now.toISOString(),
        workspaceId: read.workspaceId,
        itemId,
        message: read.message,
        ...(read.decided ? {} : { workspaceDecided: false }),
        ...(read.title ? { title: read.title } : {}),
        ...(read.nextAction ? { nextAction: read.nextAction } : {}),
        ...(read.priority ? { priority: read.priority } : {}),
        ...(read.dueDate ? { dueDate: read.dueDate } : {}),
        ...(read.panels.length ? { panelIds: read.panels.map((panel) => panel.id) } : {}),
        // Said by this route and by no client: the app's registered name is the
        // sender a row shows ("Show which app captured an item", issue 598), and
        // which app it was is the source's own id for it.
        capturedFrom: {
          source: 'mcp',
          sourceId: app.clientId.slice(0, 500),
          ...(sender ? { sender } : {}),
        },
      },
    },
    ...afterStatus,
    ...stored.map((file) => recordFile(file, itemId, read.workspaceId, now.toISOString())),
  ]);
  // Nothing was captured: a workspace deleted between the read above and the
  // write is the same refusal a name that matched nothing gets, so the model can retry.
  if (applied.stopped?.at === 0) {
    return {
      refusal:
        applied.stopped.because === 'missing'
          ? 'That workspace was just removed. List the tools again for the current names.'
          : applied.stopped.what,
    };
  }
  ctx.waitUntil(enqueueCleanUp(env, accountName, itemId, 'mcp'));
  ctx.waitUntil(enqueueReadingItsMeaning(env, accountName, itemId, 'mcp'));
  ctx.waitUntil(enqueueProposalForClaude(env, accountName, itemId, 'mcp'));
  // What the Connected apps list says this app last did (issue 600).
  ctx.waitUntil(noteCapture(env, app.grantId, new Date().toISOString()));

  // **The Item is written by now**, so nothing after this may answer as if it
  // were not: a failure would have the app try again and capture it twice.
  // The title it was written with is the message's mechanical one
  // (`textsFromCapture`), so that is the answer where the read back fails.
  const title = await account.item(itemId).then(
    (item) => item?.title ?? read.title ?? textsFromCapture(read.message).title,
    (error: unknown) => {
      logged(error);
      return read.title ?? textsFromCapture(read.message).title;
    },
  );
  const workspaceName = workspaces.find((w) => w.id === read.workspaceId)?.name ?? '';
  const where = read.panels.length
    ? `on top of ${read.panels.map((panel) => panel.place).join(' and ')} in ${workspaceName}`
    : read.decided
      ? `in the ${workspaceName} Inbox`
      : 'in every Inbox, until a workspace is chosen for it';
  const link = new URL(`/w/${encodeURIComponent(read.workspaceId)}`, env.APP_ORIGIN);
  link.searchParams.set('item', itemId);
  if (applied.stopped) {
    const filesFrom = 1 + afterStatus.length;
    const attached = applied.results.slice(filesFrom).filter((result) => result.applied).length;
    return {
      refusal: `Captured "${title}" ${where}, but ${applied.stopped.at >= filesFrom ? 'a file could not be attached' : 'its status could not be set'}: ${applied.stopped.what}.${stored.length ? ` ${attached} of ${stored.length} files were attached.` : ''} Open it: ${link.href}`,
    };
  }
  return { reply: `Captured "${title}" ${where}${stored.length ? `, with ${describeAdded(stored)}` : ''}. Open it: ${link.href}` };
}

/**
 * One `find_items` call ("Find items in Cockpit by text and condition, over
 * MCP", issue 1242): admitted at its own limits, apart from capture's, read
 * against the workspaces as they are now, and answered from the account's
 * Items - the account of the grant's person and no other.
 *
 * **The count is asked before anything is read**, and a call refused for being
 * one too many reads nothing.
 */
async function find(
  env: Env,
  account: Account,
  accountName: string,
  app: { grantId: string },
  args: unknown,
): Promise<{ reply: string } | { refusal: string }> {
  const now = new Date();
  const admitted = await account.appFindArrived(app.grantId, now.toISOString());
  if (admitted === 'too-many-this-minute') {
    return { refusal: 'Too many searches in the last minute (10 a minute). Wait a minute and try again.' };
  }
  if (admitted === 'too-many-today') {
    return { refusal: 'Too many searches today (500 a day). Try again tomorrow.' };
  }

  const workspaces = await account.workspaces();
  const read = readFind(args, workspaces, now);
  if (!read.ok) return { refusal: read.refusal };
  const found = await account.findItems(read.search);
  if ('noSuchPanel' in found) return { refusal: refusePanel(read.search, found, workspaces) };
  return { reply: describeFound(found, workspaces, env.APP_ORIGIN, await linksToFilesOf(env, accountName, found, now)) };
}

/**
 * The links that open the files of a page's Items for an hour without signing
 * in ("Give attachment links with found items, over MCP", issue 1244): the same
 * sealed links the send to Cowork or Claude Code mints (`auth/attachment-link.ts`),
 * by file id. **None where the environment has no sealing key**, which leaves
 * the reply naming files only. The files are those just read from this account
 * for this page, so none needs checking again.
 */
async function linksToFilesOf(
  env: Env,
  accountName: string,
  page: FoundPage,
  now: Date,
): Promise<Record<string, string>> {
  const key = await attachmentLinkKey(env.CONNECTOR_CREDENTIAL_KEY);
  if (!key) return {};
  const links: Record<string, string> = {};
  for (const { attachments } of page.items) {
    for (const { id } of attachments) {
      links[id] = await attachmentLinkAddress(key, { accountName, attachmentId: id }, now, env.APP_ORIGIN);
    }
  }
  return links;
}

/**
 * One `report_run` call (issue 1160): admitted at the rate capture is, read,
 * and written through `report_claude_run`, which finds the Run and refuses one
 * that is unknown, another account's (this account's store cannot see it) or
 * ended, in the same words for each.
 */
async function reportRun(
  account: Account,
  app: { grantId: string },
  args: unknown,
): Promise<{ reply: string } | { refusal: string }> {
  if ((await account.appCaptureArrived(app.grantId, new Date().toISOString())) === 'too-many') {
    return { refusal: 'Too many calls in the last minute. Wait a minute and try again.' };
  }
  const read = readReport(args);
  if (!read.ok) return { refusal: read.refusal };
  try {
    await account.applyChange('report_claude_run', {
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      // Replaced by the Run's own Workspace where it is written.
      workspaceId: ACCOUNT_WIDE,
      runId: read.runId,
      stage: read.stage,
      ...(read.sessionUrl ? { sessionUrl: read.sessionUrl } : {}),
      ...(read.resultUrl ? { resultUrl: read.resultUrl } : {}),
      ...(read.note ? { note: read.note } : {}),
    });
  } catch (error) {
    if (error instanceof NotFoundInAccountError) {
      return { refusal: 'There is no open run with that id. It may have ended, or the id may be wrong; check the prompt.' };
    }
    if (error instanceof RefusedByAccountError) return { refusal: error.message };
    throw error;
  }
  return { reply: 'Reported. Cockpit now shows this on the item.' };
}

/**
 * Said for a dismissed Item, which the form could not be opened on either: the
 * model brings it back first rather than changing what nobody can see.
 */
const DISMISSED_ITEM = 'That item is dismissed. Restore it with restore_item first, then change it.';

/**
 * One `update_item` call ("MCP changes and deletes: add update_item", issue
 * 1811): admitted at the rate capture is - the count shared with `create_item`,
 * `report_run`, `delete_item` and `restore_item` - and every argument read
 * before the Item is looked at, so a call refused for what it says writes
 * nothing.
 *
 * **One call to the account's store runs the commands** (`applyChanges`), each
 * the command the form sends for its field, so a tab hears of the change once
 * and nothing else runs between them. A command refused partway keeps what
 * applied before it, and the reply names which fields changed and which did
 * not. **One refusal for an id nobody has and for another account's**: the
 * store opened is this account's alone (see `dismiss`).
 */
async function update(
  env: Env,
  ctx: ProtectedContext,
  account: Account,
  accountName: string,
  app: { grantId: string },
  args: unknown,
): Promise<{ reply: string } | { refusal: string }> {
  if ((await account.appCaptureArrived(app.grantId, new Date().toISOString())) === 'too-many') {
    return { refusal: 'Too many calls in the last minute. Wait a minute and try again.' };
  }
  const read = readUpdate(args);
  if (!read.ok) return { refusal: read.refusal };

  const item = await account.item(read.itemId);
  if (!item) return { refusal: NO_SUCH_ITEM };
  if (item.deletedAt !== null) {
    const into = await account.mergedInto(item.id);
    return {
      refusal:
        into === null
          ? DISMISSED_ITEM
          : `That item was merged into "${into}" and is dismissed. Restore it with restore_item first, then change it.`,
    };
  }

  // The Panels are read only where the call names them, and found in the Item's
  // Workspace as it is now (every Workspace, for an Item none has been chosen for).
  let panels: ReturnType<typeof resolveUpdatePanels> | null = null;
  if (read.fields.panels) {
    panels = resolveUpdatePanels(item, await account.panelCatalogue(), read.fields.panels);
    if (!panels.ok) return { refusal: panels.refusal };
  }

  // Files to take off are found by name among the Item's own, before anything is stored.
  let removals: { id: string; filename: string }[] = [];
  if (read.fields.files?.remove.length) {
    const found = resolveRemovals(read.fields.files.remove, await account.attachmentsOfItem(item.id));
    if (!found.ok) return { refusal: found.refusal };
    removals = found.remove;
  }

  // A wait counts its days on the calendar of the account's latest capture, so
  // the zones are read only where a wait is asked for.
  const timeZone =
    read.fields.status?.to === 'waiting' ? waitTimeZone(await account.recentCapturedTimeZones(), new Date()) : 'UTC';
  // Every check is behind us: the bytes go into R2 now, and are recorded in the store call below. `now` is taken after, so the commands are stamped when they are sent and not before an upload that takes seconds.
  const stored = await putFiles(env, accountName, item.id, read.fields.files?.add ?? []);
  const now = new Date();
  const plan = planUpdate(item, read.fields, now, timeZone, panels?.ok ? panels.panels : null, {
    remove: removals,
    add: stored,
  });

  const title = item.title.trim() || UNTITLED;
  const linkTo = (workspaceId: string) => {
    const link = new URL(`/w/${encodeURIComponent(workspaceId)}`, env.APP_ORIGIN);
    link.searchParams.set('item', item.id);
    return link.href;
  };
  if (!plan.steps.length) return describeUpdate(title, read.fields, plan, null, linkTo(item.workspaceId));

  const applied = await account.applyChanges(plan.steps.map((step) => step.change));
  // A text written here is queued for the same follow-up work the form's edit
  // queues (duplicate mark, meaning, Claude's proposal), once it was applied.
  const wroteTexts = plan.steps.some(
    (step, i) => (step.field === 'title' || step.field === 'description') && applied.results[i]?.applied,
  );
  if (wroteTexts) {
    ctx.waitUntil(enqueueReadingItsMeaning(env, accountName, item.id));
  }
  // A filing queues what the Panel routes' filings do ("Re-propose the rest of
  // the inbox the moment you file one", issue 300): the rest of the Inbox
  // where it settled a routing, and Claude's proposal, made from the Panel the
  // Item sits on, once for any change to it.
  const filed = plan.steps.flatMap((step, i) => (step.field === 'panels' && applied.results[i]?.applied ? [i] : []));
  for (const i of filed) {
    if (applied.results[i]?.settledRouting) {
      ctx.waitUntil(enqueueRepropose(env, accountName, plan.steps[i]!.change.payload.workspaceId));
    }
  }
  if (wroteTexts || filed.length) ctx.waitUntil(enqueueProposalForClaude(env, accountName, item.id, 'item-changed'));
  // An Item no Workspace had been chosen for is in the Workspace of the Panel it was filed on now.
  const settledIn = item.workspaceDecided ? undefined : filed.map((i) => plan.steps[i]!.change.payload.workspaceId)[0];
  return describeUpdate(title, read.fields, plan, applied, linkTo(settledIn ?? item.workspaceId));
}

/**
 * Puts each file of a call into the attachments bucket under the Item's key,
 * one at a time so only one is decoded at once, and answers what R2 says it
 * stored. **Called only once every argument has been checked**, and before the
 * store call: a store call refused after it leaves the objects orphaned, the
 * cost the upload route already accepts ("MCP changes and deletes: add and remove files in create_item and update_item", issue 1813).
 */
async function putFiles(env: Env, accountName: string, itemId: string, files: readonly FileToAdd[]): Promise<FileStored[]> {
  const stored: FileStored[] = [];
  const first = Date.now();
  for (const [index, file] of files.entries()) {
    // One millisecond apart, so the files list in the order they were sent.
    const attachmentId = uuidv7(first + index);
    const size = await putAttachment(env, { accountName, itemId, attachmentId }, bytesOf(file.base64), file.contentType);
    stored.push({ attachmentId, name: file.name, contentType: file.contentType, size });
  }
  return stored;
}

/**
 * One `delete_item` or `restore_item` call (issue 1810): admitted at the rate
 * capture is - the count shared with `create_item` and `report_run` - and
 * written through `set_dismissed` by `applyChange`, which is what a swipe
 * sends, so the pulled check that takes a Gmail or Outlook label off is
 * brought forward by the same code and open tabs hear of it the same way.
 *
 * **One refusal for an id nobody has and for another account's**: the store
 * opened is this account's alone, so an Item of another account is simply not
 * there. An Item already in the state asked for is answered as done and
 * nothing is written, since `set_dismissed` would otherwise stamp it again.
 */
async function dismiss(
  account: Account,
  app: { grantId: string },
  dismissed: boolean,
  args: unknown,
): Promise<{ reply: string } | { refusal: string }> {
  if ((await account.appCaptureArrived(app.grantId, new Date().toISOString())) === 'too-many') {
    return { refusal: 'Too many calls in the last minute. Wait a minute and try again.' };
  }
  const read = readItemId(args);
  if (!read.ok) return { refusal: read.refusal };

  const item = await account.item(read.itemId);
  if (!item) return { refusal: NO_SUCH_ITEM };
  const title = item.title.trim() || UNTITLED;
  const already = (item.deletedAt !== null) === dismissed;
  // A dismissed original says where it went: *Merged into …* ("Brainstorming: related loose notes can't be brought together", issue 1826).
  const into = item.deletedAt !== null ? await account.mergedInto(item.id) : null;
  const mergedNote = into === null ? '' : ` It was merged into "${into}", which stays.`;
  if (!already) {
    try {
      const result = await account.applyChange('set_dismissed', {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        // The Item's own, where open tabs listen for it; an Item no workspace
        // has been chosen for is told to every one of them where it is written.
        workspaceId: item.workspaceId,
        itemId: item.id,
        dismissed,
      });
      // Logged but not applied: the Item changed after this call read it, so
      // it must not be reported as done.
      if (!result.applied) {
        return { refusal: 'Cockpit could not change that item just now because it was changed a moment ago. Try again.' };
      }
    } catch (error) {
      // Gone between the read and the write.
      if (error instanceof NotFoundInAccountError) return { refusal: NO_SUCH_ITEM };
      throw error;
    }
  }
  return {
    reply: dismissed
      ? `${already ? 'Already dismissed' : 'Dismissed'} "${title}" (id ${item.id}).${mergedNote} Bring it back with restore_item.`
      : `${already ? 'Already open' : 'Restored'} "${title}" (id ${item.id}).${mergedNote}`,
  };
}

/**
 * What an app is told when something on Cockpit's side broke: never the
 * error's own message, which can name an account, a table or a cause nobody
 * outside should read - the same rule the application's `onError` keeps
 * (`http/app.ts`). The detail goes to the log instead.
 */
export const SOMETHING_BROKE = 'Something went wrong in Cockpit. Try again in a moment.';

export function logged(error: unknown): void {
  const { message, stack } = error instanceof Error ? error : { message: String(error), stack: undefined };
  console.error(JSON.stringify({ level: 'error', message, stack }));
}

function toolError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * The grant a token belongs to, which is the middle of the three parts the
 * library writes every token as (`userId:grantId:secret`). What the capture
 * limit counts by, so two apps one person connected each get their own minute.
 */
export function grantIdOf(token: string | undefined): string {
  return token?.split(':')[1] ?? 'unknown';
}

/** The library's own answer to a token that is no good, for a person who no longer is. */
export function tokenRefused(env: Env, resourcePath: string = MCP_PATH): Response {
  const origin = new URL(env.APP_ORIGIN).origin;
  const metadata = `${origin}/.well-known/oauth-protected-resource${resourcePath}`;
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'This grant no longer acts for anybody' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer realm="OAuth", error="invalid_token", error_description="This grant no longer acts for anybody", resource_metadata="${metadata}"`,
    },
  });
}
