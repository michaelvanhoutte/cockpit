import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import {
  commandResultSchema,
  commandSchemas,
  workspaceListSchema,
  workspaceSnapshotSchema,
  type CommandName,
  type CommandPayload,
  type CommandResult,
} from '@cockpit/shared';
import type { Env } from '../env.js';
import {
  AccountNotInRegisterError,
  AccountNotUpToDateError,
  ConflictInAccountError,
  CURRENT_ACCOUNT_NAME,
  NotFoundInAccountError,
  RefusedByAccountError,
  openAccount,
} from '../accounts/index.js';
import { checkHealth } from '../accounts/probe.js';
import { getConnector } from '../connectors/registry.js';

type AppEnv = { Bindings: Env };

const errorSchema = z.object({ error: z.string() });

/** Thin adapters only: validate → call the account, serialize (architecture, "Hono + Zod on Cloudflare Workers"). */
const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: 'validation failed', issues: result.error.issues }, 400);
    }
  },
});

app.onError((err, c) => {
  if (err instanceof NotFoundInAccountError) {
    return c.json({ error: err.message }, 404);
  }
  if (err instanceof ConflictInAccountError) {
    return c.json({ error: err.message }, 409);
  }
  // A 400 rather than a 409: nothing is in the way, the colors are simply not
  // on offer. Shaped like the wire schema's own refusals, which is what the
  // client already knows how to read.
  if (err instanceof RefusedByAccountError) {
    return c.json({ error: err.message }, 400);
  }
  // An account that cannot be found or cannot be brought up to date is the
  // server's problem, not the caller's - nobody chooses an account yet - so it
  // is a 500. What it says is the exception to "internal error": the message
  // names the account, and for a change that would not apply it names the
  // change and the underlying cause. That is the whole reason this path exists
  // rather than the default, which reports only `Rollback` and loses the real
  // error in the response and the logs alike.
  if (err instanceof AccountNotInRegisterError || err instanceof AccountNotUpToDateError) {
    console.error(JSON.stringify({ level: 'error', message: err.message, stack: err.stack }));
    return c.json({ error: err.message }, 500);
  }
  console.error(JSON.stringify({ level: 'error', message: err.message, stack: err.stack }));
  return c.json({ error: 'internal error' }, 500);
});

// --- health -----------------------------------------------------------------

/**
 * `ok` stays the single verdict, because it is the only field anything reads:
 * scripts/health-check.sh greps for it, scripts/lib/stack.mjs waits on it before
 * starting the e2e suite, and apps/web/src/api/loadFailure.ts asks this endpoint
 * whether a failed request means "sign in again" or "the deployment is unwell".
 * The two below say which half was unwell, for whoever reads the answer by hand.
 *
 * `db` is gone rather than kept alongside them. It meant "the data is
 * reachable" when all of it was in D1, and once an account's data moved into
 * its own store it silently narrowed to the register while still reading like
 * the whole claim - which is what let a deployment where every request failed
 * keep answering `{"ok":true,"db":true}`.
 */
const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: {
    200: {
      description: 'Whether the register and an account store can both be reached',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean(), register: z.boolean(), store: z.boolean() }),
        },
      },
    },
  },
});

// --- reads (the snapshot model: architecture, "The read model") --------------

const workspacesRoute = createRoute({
  method: 'get',
  path: '/v1/workspaces',
  responses: {
    200: {
      description: 'All workspaces of the account',
      content: { 'application/json': { schema: workspaceListSchema } },
    },
  },
});

const snapshotRoute = createRoute({
  method: 'get',
  path: '/v1/workspaces/{workspaceId}/snapshot',
  request: { params: z.object({ workspaceId: z.string() }) },
  responses: {
    200: {
      description: 'The full read model for one workspace',
      content: { 'application/json': { schema: workspaceSnapshotSchema } },
    },
    404: {
      description: 'Unknown workspace',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

// --- changes ("Mutations are commands"): one POST endpoint per change --------

function commandRoute<N extends CommandName>(name: N, extra?: { conflict: string }) {
  return createRoute({
    method: 'post',
    path: `/v1/commands/${name}`,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: commandSchemas[name] } },
      },
    },
    responses: {
      200: {
        description: 'Command accepted (applied=false means idempotent replay or stale write)',
        content: { 'application/json': { schema: commandResultSchema } },
      },
      404: {
        // Workspace as well as item, since renaming and deleting a workspace
        // name one that has to still be there.
        description: 'The item or workspace it names does not exist',
        content: { 'application/json': { schema: errorSchema } },
      },
      // Only the commands that can actually collide declare a 409, so the
      // published contract does not promise one from every endpoint.
      ...(extra
        ? {
            409: {
              description: extra.conflict,
              content: { 'application/json': { schema: errorSchema } },
            },
          }
        : {}),
    },
  });
}

/**
 * Every change endpoint is the same two steps, so they are written once:
 * resolve the account, hand its store the validated body. Nothing here knows
 * what a change does or where it is stored.
 */
async function change<N extends CommandName>(
  env: Env,
  name: N,
  payload: CommandPayload<N>,
): Promise<CommandResult> {
  const account = await openAccount(env, CURRENT_ACCOUNT_NAME);
  return account.applyChange(name, payload);
}

/**
 * Where /v1/relogin is allowed to send the browser afterwards.
 *
 * The return location arrives in a query string, so it is attacker-supplied by
 * definition, and handing it to a redirect unchecked is an open redirect: a
 * link on our own trusted host that silently lands on someone else's. Only a
 * path inside this app is allowed, and anything a browser could read as a host
 * falls back to the start page rather than being cleaned up — rejecting is
 * safe, repairing is where the bypasses live.
 */
export function safeReturnPath(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/')) return '/';
  // `//elsewhere.example` and `/\elsewhere.example` are both read as hosts.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // A control character would let the value continue into a header of its own.
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  return raw;
}

/**
 * Whether an error raised while streaming changes is worth reporting.
 *
 * A browser closing its tab is how a stream ends, not a failure: the loop is
 * mid-flight when that happens and its database read is torn down along with
 * the request, surfacing as an error like any other. Reporting those would file
 * one for every closed tab and bury the real ones underneath.
 *
 * Only the decision lives here, because only the decision can be checked. That
 * the teardown reaches this at all is workerd's behaviour, not ours, and it does
 * not happen under the test runner — see apps/api/tests/unit/http/app.test.ts.
 */
export function worthReporting(stream: { aborted: boolean; closed: boolean }): boolean {
  return !stream.aborted && !stream.closed;
}

// --- route registration ------------------------------------------------------
// Chained so the exported AppType gives the web client end-to-end inference.

const routes = app
  .openapi(healthRoute, async (c) => {
    const { register, store, failure } = await checkHealth(c.env);
    // The reason goes to the logs and not into the body: this endpoint answers
    // anyone at all, and why a change would not apply names tables and columns.
    if (failure) {
      console.error(JSON.stringify({ level: 'error', message: `unhealthy: ${failure}` }));
    }
    return c.json({ ok: register && store, register, store }, 200);
  })
  .openapi(workspacesRoute, async (c) => {
    const account = await openAccount(c.env, CURRENT_ACCOUNT_NAME);
    return c.json({ workspaces: await account.workspaces() }, 200);
  })
  .openapi(snapshotRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const account = await openAccount(c.env, CURRENT_ACCOUNT_NAME);
    const snapshot = await account.snapshot(workspaceId);
    return c.json({ ...snapshot, generatedAt: new Date().toISOString() }, 200);
  })
  .openapi(
    commandRoute('create_workspace', { conflict: 'A workspace already has that name' }),
    async (c) => c.json(await change(c.env, 'create_workspace', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('rename_workspace', { conflict: 'A workspace already has that name' }),
    async (c) => c.json(await change(c.env, 'rename_workspace', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('add_dashboard', { conflict: 'The workspace already has a dashboard by that name' }),
    async (c) => c.json(await change(c.env, 'add_dashboard', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('rename_dashboard', {
      conflict: 'The workspace already has a dashboard by that name',
    }),
    async (c) => c.json(await change(c.env, 'rename_dashboard', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('delete_dashboard', { conflict: 'A workspace keeps at least one dashboard' }),
    async (c) => c.json(await change(c.env, 'delete_dashboard', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_workspace_theme'), async (c) => c.json(await change(c.env, 'set_workspace_theme', c.req.valid('json')), 200))
  .openapi(commandRoute('delete_workspace'), async (c) => c.json(await change(c.env, 'delete_workspace', c.req.valid('json')), 200))
  .openapi(commandRoute('capture_item'), async (c) => c.json(await change(c.env, 'capture_item', c.req.valid('json')), 200))
  .openapi(commandRoute('set_status'), async (c) => c.json(await change(c.env, 'set_status', c.req.valid('json')), 200))
  .openapi(commandRoute('snooze_until'), async (c) => c.json(await change(c.env, 'snooze_until', c.req.valid('json')), 200))
  .openapi(commandRoute('associate'), async (c) => c.json(await change(c.env, 'associate', c.req.valid('json')), 200))
  .openapi(commandRoute('set_focus'), async (c) => c.json(await change(c.env, 'set_focus', c.req.valid('json')), 200))
  .openapi(commandRoute('set_next_action'), async (c) => c.json(await change(c.env, 'set_next_action', c.req.valid('json')), 200))
  .openapi(commandRoute('set_priority'), async (c) => c.json(await change(c.env, 'set_priority', c.req.valid('json')), 200))
  // --- push invalidation: an SSE doorbell, not a data channel ----------------
  .get('/v1/events', (c) =>
    streamSSE(
      c,
      async (stream) => {
        // The account is resolved once, outside the loop: the stream is long-
        // lived, and re-checking the register every three seconds would ask the
        // same question of the same row for as long as a tab stays open.
        const account = await openAccount(c.env, CURRENT_ACCOUNT_NAME);
        let cursor = new Date().toISOString();
        let lastPing = Date.now();
        await stream.writeSSE({ event: 'ping', data: '' });
        while (!stream.aborted) {
          const { events, cursor: next } = await account.changesSince(cursor);
          cursor = next;
          for (const event of events) {
            await stream.writeSSE({ event: 'change', data: JSON.stringify(event) });
          }
          // Heartbeat keeps intermediaries from closing the idle stream.
          if (Date.now() - lastPing > 25_000) {
            await stream.writeSSE({ event: 'ping', data: '' });
            lastPing = Date.now();
          }
          await stream.sleep(3_000);
        }
      },
      async (error, stream) => {
        if (!worthReporting(stream)) return;
        console.error(
          JSON.stringify({ level: 'error', message: error.message, stack: error.stack }),
        );
      },
    ),
  )
  // --- returning from the perimeter's sign-in --------------------------------
  // Reached only *after* the gate has let the request through, which is the
  // whole trick: the browser cannot follow a sign-in redirect from a background
  // request, and a plain reload is answered by the service worker out of its
  // own cache and never leaves the machine. So the client navigates here for
  // real (`/v1/*` is on the service worker's denylist), the gate challenges it,
  // and once signed in this hands the browser back to the page it came from.
  //
  // Plain `.get` rather than an OpenAPI route: this answers with a redirect,
  // not with a documented response body.
  .get('/v1/relogin', (c) => c.redirect(safeReturnPath(c.req.query('return')), 302))
  // --- generic webhook ingress: no source-specific routes here ---------------
  .post('/ingress/:connectorId/*', async (c) => {
    const connector = getConnector(c.req.param('connectorId'));
    if (!connector?.handleWebhook) {
      return c.json({ error: 'unknown connector' }, 404);
    }
    // Host-side wiring (state store, credentials, emit) lands with the first
    // real connector; until then ingress only proves the routing shape.
    return c.json({ error: 'connector ingress not yet wired' }, 501);
  });

app.doc('/v1/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Cockpit API', version: '0.0.0' },
});

export type AppType = typeof routes;
export default app;
