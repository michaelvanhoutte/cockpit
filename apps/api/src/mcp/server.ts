import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ACCOUNT_WIDE, textsFromCapture, uuidv7 } from '@cockpit/shared';
import { NotFoundInAccountError, RefusedByAccountError, openAccount, type Account } from '../accounts/index.js';
import type { Env } from '../env.js';
import { enqueueCleanUp, enqueueProposalForClaude, enqueueReadingItsMeaning } from '../jobs/enrichment.js';
import { REPORT_RUN, readReport, reportRunTool } from './report-run.js';
import { FIND_ITEMS, describeFound, findItemsTool, readFind, refusePanel } from './find-items.js';
import { CREATE_ITEM, SERVER_INSTRUCTIONS, createItemTool, readCapture, senderFrom } from './create-item.js';
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
 * Three tools, `create_item`, `report_run` (issue 1160) and `find_items`
 * (issue 1242, the only one that reads), and no resources or prompts: the
 * server declares the tools capability alone, so a client never asks for the
 * others.
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
      const workspaces = await account.workspaces();
      return { tools: [createItemTool(workspaces), reportRunTool(), findItemsTool(workspaces)] };
    } catch (error) {
      logged(error);
      throw new McpError(ErrorCode.InternalError, SOMETHING_BROKE);
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== CREATE_ITEM && params.name !== REPORT_RUN && params.name !== FIND_ITEMS) {
      return toolError(`There is no tool called ${params.name}.`);
    }
    try {
      const said =
        params.name === REPORT_RUN
          ? await reportRun(account, app, params.arguments)
          : params.name === FIND_ITEMS
            ? await find(env, account, holder.accountName, app, params.arguments)
            : await capture(env, ctx, account, holder.accountName, app, params.arguments);
      return 'refusal' in said ? toolError(said.refusal) : { content: [{ type: 'text', text: said.reply }] };
    } catch (error) {
      logged(error);
      return toolError(SOMETHING_BROKE);
    }
  });

  // No `sessionIdGenerator`, which is what makes the transport stateless.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
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
  const [admitted, workspaces] = await Promise.all([
    account.appCaptureArrived(app.grantId, new Date().toISOString()),
    account.workspaces(),
  ]);
  if (admitted === 'too-many') {
    return { refusal: 'Too many calls in the last minute. Wait a minute and try again.' };
  }

  const read = readCapture(args, workspaces);
  if (!read.ok) return { refusal: read.refusal };

  const itemId = uuidv7();
  const sender = senderFrom(app.clientName);
  try {
    await account.applyChange('capture_item', {
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: read.workspaceId,
      itemId,
      message: read.message,
      ...(read.decided ? {} : { workspaceDecided: false }),
      // Said by this route and by no client: the app's registered name is the
      // sender a row shows ("Show which app captured an item", issue 598), and
      // which app it was is the source's own id for it.
      capturedFrom: {
        source: 'mcp',
        sourceId: app.clientId.slice(0, 500),
        ...(sender ? { sender } : {}),
      },
    });
  } catch (error) {
    // A workspace deleted between the read above and the write: the
    // same refusal a name that matched nothing gets, so the model can retry.
    if (error instanceof NotFoundInAccountError) {
      return { refusal: 'That workspace was just removed. List the tools again for the current names.' };
    }
    throw error;
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
    (item) => item?.title ?? textsFromCapture(read.message).title,
    (error: unknown) => {
      logged(error);
      return textsFromCapture(read.message).title;
    },
  );
  const where = read.decided
    ? `the ${workspaces.find((w) => w.id === read.workspaceId)?.name ?? ''} Inbox`
    : 'every Inbox, until a workspace is chosen for it';
  const link = new URL(`/w/${encodeURIComponent(read.workspaceId)}`, env.APP_ORIGIN);
  link.searchParams.set('item', itemId);
  return { reply: `Captured "${title}" in ${where}. Open it: ${link.href}` };
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
