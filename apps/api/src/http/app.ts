import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import {
  commandResultSchema,
  commandSchemas,
  workspaceListSchema,
  workspaceSnapshotSchema,
  type CommandName,
} from '@cockpit/shared';
import type { Env } from '../env.js';
import { DEFAULT_TENANT_ID } from '../tenancy.js';
import { createDb } from '../db/client.js';
import { getWorkspace, listAssociationsForWorkspace, listOpenItems, listWorkspaces } from '../db/repo.js';
import { ItemNotFoundError, runCommand } from './command-service.js';
import { collectInvalidations } from './events.js';
import { getConnector } from '../connectors/registry.js';

type AppEnv = { Bindings: Env };

const errorSchema = z.object({ error: z.string() });

/** Thin adapters only: validate → call domain/service → serialize (§6.1). */
const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: 'validation failed', issues: result.error.issues }, 400);
    }
  },
});

app.onError((err, c) => {
  if (err instanceof ItemNotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  console.error(JSON.stringify({ level: 'error', message: err.message, stack: err.stack }));
  return c.json({ error: 'internal error' }, 500);
});

// --- health -----------------------------------------------------------------

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: {
    200: {
      description: 'Service and database health',
      content: { 'application/json': { schema: z.object({ ok: z.boolean(), db: z.boolean() }) } },
    },
  },
});

// --- reads (the snapshot model, §5.2) ----------------------------------------

const workspacesRoute = createRoute({
  method: 'get',
  path: '/v1/workspaces',
  responses: {
    200: {
      description: 'All workspaces of the tenant',
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

// --- commands (§4.3): one POST endpoint per command ---------------------------

function commandRoute<N extends CommandName>(name: N) {
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
        description: 'Target item does not exist',
        content: { 'application/json': { schema: errorSchema } },
      },
    },
  });
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

// --- route registration ------------------------------------------------------
// Chained so the exported AppType gives the web client end-to-end inference.

const routes = app
  .openapi(healthRoute, async (c) => {
    let db = false;
    try {
      await c.env.DB.prepare('SELECT 1').first();
      db = true;
    } catch {
      db = false;
    }
    return c.json({ ok: db, db }, 200);
  })
  .openapi(workspacesRoute, async (c) => {
    const db = createDb(c.env.DB);
    const workspaces = await listWorkspaces(db, DEFAULT_TENANT_ID);
    return c.json({ workspaces }, 200);
  })
  .openapi(snapshotRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const db = createDb(c.env.DB);
    const workspace = await getWorkspace(db, DEFAULT_TENANT_ID, workspaceId);
    if (!workspace) return c.json({ error: `workspace ${workspaceId} not found` }, 404);
    const [items, associations] = await Promise.all([
      listOpenItems(db, DEFAULT_TENANT_ID, workspaceId),
      listAssociationsForWorkspace(db, DEFAULT_TENANT_ID, workspaceId),
    ]);
    return c.json(
      { workspace, items, associations, generatedAt: new Date().toISOString() },
      200,
    );
  })
  .openapi(commandRoute('capture_item'), async (c) => {
    const result = await runCommand(createDb(c.env.DB), DEFAULT_TENANT_ID, 'capture_item', c.req.valid('json'));
    return c.json(result, 200);
  })
  .openapi(commandRoute('set_status'), async (c) => {
    const result = await runCommand(createDb(c.env.DB), DEFAULT_TENANT_ID, 'set_status', c.req.valid('json'));
    return c.json(result, 200);
  })
  .openapi(commandRoute('snooze_until'), async (c) => {
    const result = await runCommand(createDb(c.env.DB), DEFAULT_TENANT_ID, 'snooze_until', c.req.valid('json'));
    return c.json(result, 200);
  })
  .openapi(commandRoute('associate'), async (c) => {
    const result = await runCommand(createDb(c.env.DB), DEFAULT_TENANT_ID, 'associate', c.req.valid('json'));
    return c.json(result, 200);
  })
  .openapi(commandRoute('set_focus'), async (c) => {
    const result = await runCommand(createDb(c.env.DB), DEFAULT_TENANT_ID, 'set_focus', c.req.valid('json'));
    return c.json(result, 200);
  })
  .openapi(commandRoute('set_next_action'), async (c) => {
    const result = await runCommand(createDb(c.env.DB), DEFAULT_TENANT_ID, 'set_next_action', c.req.valid('json'));
    return c.json(result, 200);
  })
  .openapi(commandRoute('set_priority'), async (c) => {
    const result = await runCommand(createDb(c.env.DB), DEFAULT_TENANT_ID, 'set_priority', c.req.valid('json'));
    return c.json(result, 200);
  })
  // --- push invalidation (§5.5): SSE doorbell, not a data channel -------------
  .get('/v1/events', (c) =>
    streamSSE(c, async (stream) => {
      const db = createDb(c.env.DB);
      let cursor = new Date().toISOString();
      let lastPing = Date.now();
      await stream.writeSSE({ event: 'ping', data: '' });
      while (!stream.aborted) {
        const { events, cursor: next } = await collectInvalidations(db, DEFAULT_TENANT_ID, cursor);
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
    }),
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
  // --- generic webhook ingress (§6.2): no source-specific routes here ---------
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
