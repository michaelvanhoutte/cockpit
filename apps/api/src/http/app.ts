import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  commandResultSchema,
  commandSchemas,
  signedInSchema,
  signInSchema,
  userListSchema,
  workspaceListSchema,
  workspaceSnapshotSchema,
  type CommandName,
  type CommandPayload,
  type CommandResult,
} from '@cockpit/shared';
import {
  AccountNotInRegisterError,
  AccountNotUpToDateError,
  ConflictInAccountError,
  NotFoundInAccountError,
  RefusedByAccountError,
  openAccount,
} from '../accounts/index.js';
import { checkHealth } from '../accounts/probe.js';
import {
  forgetSessionCookie,
  gate,
  rememberSessionCookie,
  stillSignedIn,
  type GatedEnv,
} from '../auth/gate.js';
import { endSession, listUsers, startSession } from '../auth/register.js';
import { getConnector } from '../connectors/registry.js';

type AppEnv = GatedEnv;

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
  // server's problem, not the caller's - nobody names an account on a request,
  // it is resolved from who signed in - so it is a 500. The first of the two is
  // now unreachable from here anyway, because a user's account is a foreign key
  // into the register (see the register's own constraints); it stays because
  // addressing a store by name creates one, so the register is what turns a
  // name nobody owns into an error rather than an empty account.
  // What it says is the exception to "internal error": the message
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

/**
 * Before every route below, so that "signed in" is a property of reaching a
 * handler at all rather than something each one remembers to check - and on
 * `*` rather than on `/v1/*`, so that a route added later is refused until
 * somebody decides otherwise instead of being open until somebody notices. What
 * answers without a sign-in is named in `auth/gate.ts`, with the reason each one
 * is there.
 */
app.use('*', gate());


// --- health -----------------------------------------------------------------

/**
 * `ok` stays the single verdict, because it is the only field anything reads:
 * scripts/health-check.mjs asserts it, scripts/lib/stack.mjs waits on it before
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

// --- signing in --------------------------------------------------------------

/**
 * The people to choose from. Outside the gate, because it is what you read
 * while you are still nobody, and carrying names only for the same reason:
 * anyone who can reach the logon page can read this, so which account somebody
 * owns and what role they hold are not in it.
 */
const usersRoute = createRoute({
  method: 'get',
  path: '/v1/users',
  responses: {
    200: {
      description: 'Everyone who can sign in to this Cockpit',
      content: { 'application/json': { schema: userListSchema } },
    },
  },
});

/**
 * Signing in: you say which of them you are, and that is the whole proof.
 *
 * **This is an identity selector, not an authentication control**, and saying
 * so plainly is what keeps it from being mistaken for one later. What replaces
 * it is a single step - how we come to believe who you are - because everything
 * downstream of this handler is already the real thing: a real session row, a
 * real cookie, a real gate on every request. Until then Cloudflare Access stays
 * in front of every deployed environment (docs/architecture.md, "App login").
 *
 * **There is no CSRF token here, and what stands in for one is the declared
 * content type.** The risk this endpoint would otherwise carry is login CSRF -
 * another site making a browser sign in as somebody its owner did not choose.
 *
 * The protection is *not* that a form cannot produce a JSON-shaped body: it
 * can. `enctype="text/plain"` is CORS-safelisted, needs no preflight, and a
 * field named `{"userId":"…","junk":"` with a value of `"}` serializes to
 * exactly `{"userId":"…","junk":"="}`, which parses. The protection is that
 * this route declares `application/json` and the validator checks the header
 * rather than only parsing the body, so a `text/plain` delivery is refused
 * before anything reads it - and `Content-Type: application/json` is one of the
 * headers a form cannot set, which is what forces the preflight this origin
 * answers no CORS headers to.
 *
 * That distinction is a library's behaviour rather than this file's, so it is
 * **pinned by a test** ("signing in cannot be done by another site on your
 * behalf", tests/integration/http/sign-in.test.ts) instead of being trusted to
 * a comment that a dependency bump could quietly falsify.
 *
 * When Google sign-in lands, the code flow's `state` parameter is what covers
 * this properly, and it is one of the risks "App login" records as deliberately
 * owned.
 */
const signInRoute = createRoute({
  method: 'post',
  path: '/v1/sign-in',
  request: {
    body: { required: true, content: { 'application/json': { schema: signInSchema } } },
  },
  responses: {
    200: {
      description: 'Signed in, and the browser now holds the sign-in',
      content: { 'application/json': { schema: signedInSchema } },
    },
    404: {
      description: 'Nobody by that name',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/** Ends this sign-in for good: the row goes, so the cookie names nothing. */
const signOutRoute = createRoute({
  method: 'post',
  path: '/v1/sign-out',
  responses: {
    200: {
      description: 'Signed out',
      content: { 'application/json': { schema: z.object({ signedOut: z.boolean() }) } },
    },
    401: {
      // Declared because the client acts on it: a sign-out refused for not
      // being signed in has produced the outcome that was asked for.
      description: 'The sign-in had already ended',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * Who Cockpit currently believes you are - and, by being refused, whether it
 * does at all. The browser reads this to decide between painting the app and
 * going to the logon page, and the shell shows the name it answers with.
 */
const meRoute = createRoute({
  method: 'get',
  path: '/v1/me',
  responses: {
    200: {
      description: 'The signed-in user',
      content: { 'application/json': { schema: signedInSchema } },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/json': { schema: errorSchema } },
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
  c: Context<AppEnv>,
  name: N,
  payload: CommandPayload<N>,
): Promise<CommandResult> {
  const account = await openAccount(c.env, c.get('visitor').accountName);
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
  .openapi(usersRoute, async (c) => c.json({ users: await listUsers(c.env) }, 200))
  .openapi(signInRoute, async (c) => {
    const { userId } = c.req.valid('json');
    const started = await startSession(c.env, userId, new Date());
    // A name that is not on the list cannot be signed in as, and nothing was
    // written on the way to finding that out.
    if (!started) return c.json({ error: `no user ${userId}` }, 404);
    rememberSessionCookie(c, started.sessionId);
    return c.json({ user: started.user }, 200);
  })
  .openapi(signOutRoute, async (c) => {
    await endSession(c.env, c.get('sessionId'));
    forgetSessionCookie(c);
    return c.json({ signedOut: true }, 200);
  })
  .openapi(meRoute, (c) => {
    const { userId, name } = c.get('visitor');
    return c.json({ user: { id: userId, name } }, 200);
  })
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
    const account = await openAccount(c.env, c.get('visitor').accountName);
    return c.json({ workspaces: await account.workspaces() }, 200);
  })
  .openapi(snapshotRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const account = await openAccount(c.env, c.get('visitor').accountName);
    const snapshot = await account.snapshot(workspaceId);
    return c.json({ ...snapshot, generatedAt: new Date().toISOString() }, 200);
  })
  .openapi(
    commandRoute('create_workspace', { conflict: 'A workspace already has that name' }),
    async (c) => c.json(await change(c, 'create_workspace', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('rename_workspace', { conflict: 'A workspace already has that name' }),
    async (c) => c.json(await change(c, 'rename_workspace', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('add_dashboard', { conflict: 'The workspace already has a dashboard by that name' }),
    async (c) => c.json(await change(c, 'add_dashboard', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('rename_dashboard', {
      conflict: 'The workspace already has a dashboard by that name',
    }),
    async (c) => c.json(await change(c, 'rename_dashboard', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('delete_dashboard', { conflict: 'A workspace keeps at least one dashboard' }),
    async (c) => c.json(await change(c, 'delete_dashboard', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('reorder_workspaces', {
      conflict: 'The workspaces changed while they were being put in order',
    }),
    async (c) => c.json(await change(c, 'reorder_workspaces', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('add_panel', { conflict: 'The dashboard already has a panel by that name' }),
    async (c) => c.json(await change(c, 'add_panel', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('rename_panel', { conflict: 'The dashboard already has a panel by that name' }),
    async (c) => c.json(await change(c, 'rename_panel', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('delete_panel'), async (c) => c.json(await change(c, 'delete_panel', c.req.valid('json')), 200))
  .openapi(commandRoute('save_layout'), async (c) => c.json(await change(c, 'save_layout', c.req.valid('json')), 200))
  .openapi(commandRoute('delete_layout'), async (c) => c.json(await change(c, 'delete_layout', c.req.valid('json')), 200))
  .openapi(commandRoute('set_workspace_theme'), async (c) => c.json(await change(c, 'set_workspace_theme', c.req.valid('json')), 200))
  .openapi(commandRoute('delete_workspace'), async (c) => c.json(await change(c, 'delete_workspace', c.req.valid('json')), 200))
  .openapi(commandRoute('capture_item'), async (c) => c.json(await change(c, 'capture_item', c.req.valid('json')), 200))
  .openapi(
    commandRoute('move_item_to_panel', {
      conflict: 'The order sent is not the order of that panel any more',
    }),
    async (c) => c.json(await change(c, 'move_item_to_panel', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('add_item_to_panel', {
      conflict: 'The order sent is not the order of that panel any more',
    }),
    async (c) => c.json(await change(c, 'add_item_to_panel', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('remove_item_from_panel'), async (c) =>
    c.json(await change(c, 'remove_item_from_panel', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_status'), async (c) => c.json(await change(c, 'set_status', c.req.valid('json')), 200))
  .openapi(commandRoute('snooze_until'), async (c) => c.json(await change(c, 'snooze_until', c.req.valid('json')), 200))
  .openapi(commandRoute('associate'), async (c) => c.json(await change(c, 'associate', c.req.valid('json')), 200))
  .openapi(commandRoute('set_focus'), async (c) => c.json(await change(c, 'set_focus', c.req.valid('json')), 200))
  .openapi(commandRoute('set_next_action'), async (c) => c.json(await change(c, 'set_next_action', c.req.valid('json')), 200))
  .openapi(commandRoute('set_priority'), async (c) => c.json(await change(c, 'set_priority', c.req.valid('json')), 200))
  .openapi(commandRoute('set_title'), async (c) => c.json(await change(c, 'set_title', c.req.valid('json')), 200))
  .openapi(commandRoute('set_description'), async (c) =>
    c.json(await change(c, 'set_description', c.req.valid('json')), 200),
  )
  // --- push invalidation: an SSE doorbell, not a data channel ----------------
  .get('/v1/events', (c) =>
    streamSSE(
      c,
      async (stream) => {
        // The account is resolved once, outside the loop: which account this
        // person owns cannot change while the stream is open, so asking again
        // would be the same question of the same row for as long as a tab
        // stays open.
        const account = await openAccount(c.env, c.get('visitor').accountName);
        const sessionId = c.get('sessionId');
        let cursor = new Date().toISOString();
        let lastPing = Date.now();
        await stream.writeSSE({ event: 'ping', data: '' });
        while (!stream.aborted) {
          // Whether the sign-in is still current *is* a question whose answer
          // changes, which is why it is asked again where the account is not.
          // The gate answers it once on the way in, and that is enough for a
          // request; a stream outlives its own admission by hours, so without
          // this it would go on delivering an account's changes long after
          // somebody signed out - and signing out is meant to be final, not to
          // take effect on the next request the browser happens to make.
          //
          // Every time round rather than on a slower cadence of its own: the
          // loop already wakes every three seconds and already reads the
          // account's store, so this is one small read beside one that is
          // happening anyway, and it saves a second interval to get wrong.
          if (!(await stillSignedIn(c.env, sessionId))) break;

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

// Behind the gate like everything else not named in `PATHS_OUTSIDE_THE_GATE`.
// Nothing reads it programmatically - it is here to be opened by hand - so
// requiring a sign-in costs nothing and keeps the shape of every endpoint from
// being readable by anyone who finds the URL.
app.doc('/v1/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Cockpit API', version: '0.0.0' },
});

export type AppType = typeof routes;
export default app;
