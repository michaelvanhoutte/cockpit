import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  commandResultSchema,
  commandSchemas,
  signedInSchema,
  itemTypeListSchema,
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
  attemptHeld,
  forgetAttempt,
  forgetSessionCookie,
  gate,
  rememberAttempt,
  rememberSessionCookie,
  stillSignedIn,
  type GatedEnv,
} from '../auth/gate.js';
import { endpointsFor, exchangeCode, issuerFor, keysOf } from '../auth/issuer.js';
import { authorizationUrl, identityFrom, newAttempt, replyBelongsTo } from '../auth/oidc.js';
import { endSession, signInWithGoogle } from '../auth/register.js';
import { getConnector } from '../connectors/registry.js';

type AppEnv = GatedEnv;

const errorSchema = z.object({ error: z.string() });

/**
 * Where Google is told to send the browser back: this environment's own
 * address, configured, and never taken from the request.
 *
 * **It is the address the person is looking at, which is not the address this
 * Worker answers on.** In development they are two different servers - the
 * browser is on Vite, which proxies `/v1` through - so a callback built from
 * the request would take the browser off the application it is using and onto
 * the Worker, where it would land on the last *built* copy of the app rather
 * than the one being edited. Found by driving it, not by reading it.
 *
 * Configured rather than derived also settles the other half: it has to be
 * character-for-character one of the redirect URIs registered with the Google
 * client (docs/deployment.md, "A Google OAuth client"), and a Host header is
 * something a request carries rather than something this application knows.
 */
function callbackUrl(c: Context): string {
  return new URL('/v1/sign-in/google/callback', c.env.APP_ORIGIN).toString();
}

/**
 * A sign-in that will not be completed, whether something was wrong with it or
 * something broke.
 *
 * **Why goes to the log and never to the browser.** Each reason names something
 * an attacker got wrong, and the person actually signing in can do nothing with
 * any of them; the page says the sign-in failed and offers to start another.
 * The one refusal they *can* act on - a Google account this Cockpit does not
 * know - is the one the callback answers with a reason of its own.
 */
function refuse(c: Context, reason: string, cause?: unknown) {
  console.error(
    JSON.stringify({
      level: 'error',
      message: `sign-in refused: ${reason}`,
      ...(cause === undefined
        ? {}
        : { cause: cause instanceof Error ? cause.message : String(cause) }),
    }),
  );
  return c.redirect('/signin?refused=failed', 302);
}

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
 * scripts/health-check.mjs asserts it, and scripts/lib/stack.mjs waits on it
 * before starting the e2e suite. The two below say which half was unwell, for
 * whoever reads the answer by hand.
 *
 * apps/web/src/api/loadFailure.ts reads none of them. It asks this endpoint only
 * whether *anything* answers, which is how it tells a dead connection from a
 * request that vanished on its way here; what the answer says is the deploy
 * check's business and the uptime monitor's, not the app's.
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
 * Signing in is two navigations, not a request the page makes, so neither of
 * the two routes is declared here: a browser is sent to Google and comes back,
 * and there is no JSON in either direction for a client to be typed against.
 * They are registered with the rest of the routes below, beside the other two
 * this is true of (the live-updates stream and webhook ingress).
 *
 * **The list of names is gone**, and so is the endpoint that served it. It was
 * the one read that had to answer before anybody had signed in; now that
 * proving who you are is Google's job, publishing who has an account here would
 * be a leak with nothing to buy it.
 */

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

const itemTypesRoute = createRoute({
  method: 'get',
  path: '/v1/item-types',
  responses: {
    200: {
      description: 'All live types of the account',
      content: { 'application/json': { schema: itemTypeListSchema } },
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
  .openapi(itemTypesRoute, async (c) => {
    const account = await openAccount(c.env, c.get('visitor').accountName);
    return c.json({ itemTypes: await account.itemTypes() }, 200);
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
  .openapi(commandRoute('save_layout', { conflict: 'The dashboard already has a layout by that name' }), async (c) => c.json(await change(c, 'save_layout', c.req.valid('json')), 200))
  .openapi(
    commandRoute('rename_layout', { conflict: 'The dashboard already has a layout by that name' }),
    async (c) => c.json(await change(c, 'rename_layout', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('delete_layout', { conflict: 'A dashboard keeps at least one layout' }), async (c) => c.json(await change(c, 'delete_layout', c.req.valid('json')), 200))
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
  .openapi(commandRoute('create_item_type'), async (c) =>
    c.json(await change(c, 'create_item_type', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('rename_item_type'), async (c) =>
    c.json(await change(c, 'rename_item_type', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_item_type_color'), async (c) =>
    c.json(await change(c, 'set_item_type_color', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('delete_item_type'), async (c) =>
    c.json(await change(c, 'delete_item_type', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('reorder_item_types'), async (c) =>
    c.json(await change(c, 'reorder_item_types', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_done'), async (c) => c.json(await change(c, 'set_done', c.req.valid('json')), 200))
  .openapi(commandRoute('set_dismissed'), async (c) => c.json(await change(c, 'set_dismissed', c.req.valid('json')), 200))
  .openapi(commandRoute('associate'), async (c) => c.json(await change(c, 'associate', c.req.valid('json')), 200))
  .openapi(commandRoute('set_next_action'), async (c) => c.json(await change(c, 'set_next_action', c.req.valid('json')), 200))
  .openapi(commandRoute('set_priority'), async (c) => c.json(await change(c, 'set_priority', c.req.valid('json')), 200))
  .openapi(commandRoute('set_title'), async (c) => c.json(await change(c, 'set_title', c.req.valid('json')), 200))
  .openapi(commandRoute('set_description'), async (c) =>
    c.json(await change(c, 'set_description', c.req.valid('json')), 200),
  )
  // --- signing in: two navigations, not two requests -------------------------
  /**
   * Sends the browser to Google to be asked who it is, keeping what it has to
   * come back with.
   */
  .get('/v1/sign-in/google', async (c) => {
    try {
      const endpoints = await endpointsFor(issuerFor(c.env));
      const attempt = newAttempt();
      rememberAttempt(c, attempt);
      const url = await authorizationUrl(
        endpoints,
        c.env.GOOGLE_CLIENT_ID,
        callbackUrl(c),
        attempt,
      );
      return c.redirect(url, 302);
    } catch (error) {
      return refuse(c, 'the issuer could not be reached', error);
    }
  })
  /**
   * Where Google sends the browser back.
   *
   * Everything arriving here came through the person signing in, so nothing is
   * believed until it has been checked against the attempt this application
   * started (src/auth/oidc.ts) - and the attempt is spent before any of it is
   * acted on, so the same reply delivered twice gets nowhere the second time.
   */
  .get('/v1/sign-in/google/callback', async (c) => {
    const attempt = attemptHeld(c);
    forgetAttempt(c);
    const reply = c.req.query();

    const wrong = replyBelongsTo(attempt, reply);
    // Somebody pressing cancel on Google's own screen is not a failure to
    // report: they are simply back where they started.
    if (wrong === 'the issuer refused the sign-in') return c.redirect('/signin', 302);
    if (wrong) return refuse(c, wrong);

    try {
      const endpoints = await endpointsFor(issuerFor(c.env));
      const idToken = await exchangeCode(
        endpoints,
        { clientId: c.env.GOOGLE_CLIENT_ID, clientSecret: c.env.GOOGLE_CLIENT_SECRET },
        {
          code: reply.code!,
          codeVerifier: attempt!.codeVerifier,
          redirectUri: callbackUrl(c),
        },
      );
      if (!idToken) return refuse(c, 'the exchange was refused');

      const verdict = await identityFrom(
        idToken,
        keysOf(endpoints),
        {
          issuer: endpoints.issuer,
          clientId: c.env.GOOGLE_CLIENT_ID,
          nonce: attempt!.nonce,
        },
        new Date(),
      );
      if (!verdict.identified) return refuse(c, verdict.refusal);

      const signedIn = await signInWithGoogle(c.env, verdict.identity, new Date());
      // Proving who you are at Google is not being entitled to an account here.
      // This is the one refusal the person can act on, so it is the one the
      // logon page is told about.
      if (!signedIn) return c.redirect('/signin?refused=unknown-account', 302);

      rememberSessionCookie(c, signedIn.sessionId);
      return c.redirect('/', 302);
    } catch (error) {
      return refuse(c, 'the sign-in could not be finished', error);
    }
  })
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
