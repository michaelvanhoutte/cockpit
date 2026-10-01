import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TITLE_LENGTH, uuidv7 } from '@cockpit/shared';
import { NotFoundInAccountError, openAccount, type Account } from '../accounts/index.js';
import { noteTypeId } from '../accounts/changes.js';
import type { Env } from '../env.js';
import { enqueueCleanUp, enqueueReadingItsMeaning } from '../jobs/enrichment.js';
import { CREATE_ITEM, SERVER_INSTRUCTIONS, createItemTool, readCapture } from './create-item.js';
import { grantHolder, isGrantProps } from './grant.js';
import { MCP_PATH } from './paths.js';

/**
 * `/mcp`, once the OAuth library has accepted the access token
 * ("Connect Claude to Cockpit, and capture an item from it", issue 599).
 *
 * **Built for every request and holding nothing between them.** The
 * Streamable HTTP transport runs stateless - no session id, plain JSON
 * answers - so any instance answers any call, and the tool list is read from
 * the account as it is now: a workspace renamed a moment ago is listed by its
 * new name on the next `tools/list`, with nothing to invalidate.
 *
 * One tool, `create_item`, and no resources or prompts: the server declares
 * the tools capability alone, so a client never asks for the others.
 */

/** What the library hands a protected handler, narrowed to what is read here. */
interface ProtectedContext {
  readonly props: unknown;
  readonly auth?: { readonly token: string; readonly clientId?: string };
  waitUntil(work: Promise<unknown>): void;
}

export async function answerMcp(request: Request, env: Env, ctx: ProtectedContext): Promise<Response> {
  // **Asked again on every call**, never trusted from the grant (`grant.ts`):
  // somebody deleted or disabled since they consented is nobody now, and the
  // app is told so the way the library tells it a token is no good, so it
  // asks the person to connect again rather than retrying.
  const holder = await grantHolder(env, ctx.props);
  if (!holder || !isGrantProps(ctx.props)) return tokenRefused(env);
  const account = await openAccount(env, holder.accountName);
  const app = {
    clientId: ctx.auth?.clientId ?? 'unknown',
    clientName: ctx.props.clientName,
    grantId: grantIdOf(ctx.auth?.token),
  };

  const server = new Server(
    { name: 'cockpit', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const [workspaces, types] = await Promise.all([account.workspaces(), account.itemTypes()]);
    return { tools: [createItemTool(workspaces, types)] };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== CREATE_ITEM) return toolError(`There is no tool called ${params.name}.`);
    const said = await capture(env, ctx, account, holder.accountName, app, params.arguments);
    return 'refusal' in said ? toolError(said.refusal) : { content: [{ type: 'text', text: said.reply }] };
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
  if ((await account.appCaptureArrived(app.grantId, new Date().toISOString())) === 'too-many') {
    return { refusal: 'Too many captures in the last minute. Wait a minute and try again.' };
  }

  const [workspaces, types] = await Promise.all([account.workspaces(), account.itemTypes()]);
  const read = readCapture(args, workspaces, types, noteTypeId(accountName));
  if (!read.ok) return { refusal: read.refusal };

  const itemId = uuidv7();
  const sender = app.clientName.trim().slice(0, TITLE_LENGTH).trim();
  try {
    await account.applyChange('capture_item', {
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: read.workspaceId,
      itemId,
      message: read.message,
      typeId: read.typeId,
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
    // A workspace or type deleted between the read above and the write: the
    // same refusal a name that matched nothing gets, so the model can retry.
    if (error instanceof NotFoundInAccountError) {
      return { refusal: 'That workspace or type was just removed. List the tools again for the current names.' };
    }
    throw error;
  }
  ctx.waitUntil(enqueueCleanUp(env, accountName, itemId));
  ctx.waitUntil(enqueueReadingItsMeaning(env, accountName, itemId));

  const item = await account.item(itemId);
  const where = read.decided
    ? `the ${workspaces.find((w) => w.id === read.workspaceId)?.name ?? ''} Inbox`
    : 'every Inbox, until a workspace is chosen for it';
  const link = new URL(`/w/${encodeURIComponent(read.workspaceId)}`, env.APP_ORIGIN);
  link.searchParams.set('item', itemId);
  return { reply: `Captured "${item?.title ?? read.message}" in ${where}. Open it: ${link.href}` };
}

function toolError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * The grant a token belongs to, which is the middle of the three parts the
 * library writes every token as (`userId:grantId:secret`). What the capture
 * limit counts by, so two apps one person connected each get their own minute.
 */
function grantIdOf(token: string | undefined): string {
  return token?.split(':')[1] ?? 'unknown';
}

/** The library's own answer to a token that is no good, for a person who no longer is. */
function tokenRefused(env: Env): Response {
  const origin = new URL(env.APP_ORIGIN).origin;
  const metadata = `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'This grant no longer acts for anybody' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer realm="OAuth", error="invalid_token", error_description="This grant no longer acts for anybody", resource_metadata="${metadata}"`,
    },
  });
}
