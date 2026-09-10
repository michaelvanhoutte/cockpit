import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  addUserSchema,
  changeUserSchema,
  commandResultSchema,
  commandSchemas,
  itemTypeListSchema,
  registeredUserListSchema,
  setAccessSchema,
  signedInSchema,
  userAddedSchema,
  userChangedSchema,
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
  RegisterDisagreesError,
  RegisterRowUnusableError,
  RowsFromAnotherAccountError,
  backUpAccount,
  openAccount,
  addUser,
  changeUser,
  registerContents,
  registeredAccountNames,
  registeredUsers,
  setAccess,
  restoreAccount,
  restoreRegister,
  type AccountBackup,
  type RegisterBackup,
} from '../accounts/index.js';
import { checkHealth } from '../accounts/probe.js';
import { enqueueCleanUp, enqueueRepropose } from '../jobs/index.js';
import { ADMIN_PREFIX, adminGate } from '../auth/admin.js';
import {
  MOVED_OPERATOR_PREFIXES,
  OPERATOR_PREFIX,
  operatorGate,
} from '../auth/operator.js';
import {
  attemptHeld,
  forgetAttempt,
  forgetSessionCookie,
  gate,
  rememberAttempt,
  rememberSessionCookie,
  stillSignedIn,
  RETIRED_PATHS,
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

/**
 * And the operator's own gate behind it, in front of the routes the sign-in
 * gate deliberately lets past. Registered second so the order reads the way the
 * request travels: the sign-in gate waves `/v1/operator/` through, and this is
 * what it is waved through *to*. Neither is a spare for the other.
 *
 * **Mounted on the pattern, not on `*`.** The middleware checks the path itself
 * as well, and this says the same thing a second way on purpose: matching here
 * is Hono's own, so the set of requests that reach the operator's routes and
 * the set this stands in front of are decided by one matcher rather than by two
 * that can disagree. They did disagree once - `auth/operator.ts` records how.
 */
app.use(`${OPERATOR_PREFIX}*`, operatorGate());

/**
 * And the admin pages' own gate, which is the `admin` role rather than a secret
 * ("See who can sign in, on a page only an admin can open", issue 230).
 *
 * **After the sign-in gate, not beside it**: it reads the visitor that gate
 * resolved, so there is one reading of who is asking per request. The addresses
 * the operator's routes moved off are under this same prefix and are skipped by
 * `isAdminPath`, since they answer a command line that holds no session at all.
 */
app.use(`${ADMIN_PREFIX}*`, adminGate());

/**
 * What this application used to answer, saying so.
 *
 * Every method rather than the one each address used to have: what a retired
 * address is retired for is every way of asking, and one that answered a `POST`
 * while refusing a `GET` would leave half the browsers this exists for exactly
 * where they were. The list is `auth/gate.ts`'s, read from there rather than
 * written again, since an address that answers here without being waved through
 * the gate answers nobody.
 *
 * **Registered here rather than in the chain below**, which is not tidiness:
 * that chain is what `AppType` is inferred from, and a route registered on
 * several paths at once widens the inference to a wildcard that swallows every
 * other route with it - the typed client stops knowing that `/v1/workspaces`
 * exists at all. Found by the compiler, in one line of this file, reported in
 * seven of another.
 */
for (const path of RETIRED_PATHS) {
  app.all(path, (c) =>
    c.json({ error: 'this address has been retired; the app needs a newer version' }, 410),
  );
}

/**
 * And where the operator's commands used to be answered, saying where they went.
 *
 * A different sentence from the one above because a different caller reads it -
 * a command line rather than a browser - and `auth/operator.ts` is where that
 * is argued, along with what these prefixes forbid being served under them.
 * Here rather than in the chain below for the reason the loop above records.
 */
for (const prefix of MOVED_OPERATOR_PREFIXES) {
  app.all(`${prefix}*`, (c) =>
    c.json({ error: `this address has moved to ${OPERATOR_PREFIX}; update your checkout` }, 410),
  );
}


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
 *
 * **`ai` is reported and deliberately not part of `ok`**, which is the whole of
 * why it is here ("Clean up a captured note into a clear title and a fuller
 * message", issue 296). An environment with no key works: every capture
 * succeeds and the Item keeps the mechanical title. What it cannot do is say so
 * - a deployment nobody put a key in would enrich nothing for months with
 * everything green, which is the failure docs/deployment.md already records for
 * `CLAUDE_CODE_OAUTH_TOKEN`. Folding it into `ok` would instead make local
 * development and the browser suite - which have no key and need none - report
 * an unhealthy deployment and stop the e2e stack from ever starting.
 *
 * **Whether there is a key, never what it is.** This endpoint answers anybody
 * at all (docs/deployment.md, "`/health` answers without a sign-in").
 */
const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: {
    200: {
      description:
        'Whether the register and an account store can both be reached, and whether this environment can enrich anything',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.boolean(),
            register: z.boolean(),
            store: z.boolean(),
            ai: z.boolean(),
          }),
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

/**
 * Everyone this Cockpit knows, for the admin pages. The role gate in front of
 * it is what refuses anybody who is not an admin; nothing here re-asks.
 */
const adminUsersRoute = createRoute({
  method: 'get',
  path: '/v1/admin/users',
  responses: {
    200: {
      description: 'Everyone in the register',
      content: { 'application/json': { schema: registeredUserListSchema } },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/json': { schema: errorSchema } },
    },
    403: {
      description: 'Signed in, but not an admin',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * Adding somebody, from the admin page. Behind the same role gate as the list.
 *
 * A 409 for a refusal the admin can act on - an address already in the register,
 * a name that leaves nothing an account could be called - rather than a 400,
 * which the shape check above already uses for what was typed being unusable as
 * a request at all.
 */
const addUserRoute = createRoute({
  method: 'post',
  path: '/v1/admin/users',
  request: {
    body: { content: { 'application/json': { schema: addUserSchema } }, required: true },
  },
  responses: {
    201: {
      description: 'The person, and whether their account was ready',
      content: { 'application/json': { schema: userAddedSchema } },
    },
    // Declared because the shape check answers it (`defaultHook`), and a status
    // the contract does not name is one the typed client refuses to let the
    // browser read - which is how this one was found.
    400: {
      description: 'Not shaped like a request to add somebody',
      content: { 'application/json': { schema: errorSchema } },
    },
    409: {
      description: 'Refused: the register already holds this, or the name gives no account',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/json': { schema: errorSchema } },
    },
    403: {
      description: 'Signed in, but not an admin',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * Changing somebody's name and role, from their row on the admin page ("Rename
 * a user, and make somebody an admin", issue 232). Behind the same role gate as
 * the list and the add.
 *
 * **PATCH rather than PUT**: what it carries is the two things a form edits, not
 * the whole person - the address, the account and whether they have ever signed
 * in are all in the register and none of them is settable here.
 *
 * A 404 for somebody the register does not hold, and a 409 for a change it
 * holds and will not make - a name of nothing, or either of the two refusals
 * that keep the admin pages reachable. The difference matters to the page: one
 * is an address to fix, the other a sentence to show under the form.
 */
const changeUserRoute = createRoute({
  method: 'patch',
  path: '/v1/admin/users/{userId}',
  request: {
    params: z.object({ userId: z.string() }),
    body: { content: { 'application/json': { schema: changeUserSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Somebody as they stand after the change',
      content: { 'application/json': { schema: userChangedSchema } },
    },
    400: {
      description: 'Not shaped like a change to somebody',
      content: { 'application/json': { schema: errorSchema } },
    },
    404: {
      description: 'Nobody the register holds',
      content: { 'application/json': { schema: errorSchema } },
    },
    409: {
      description: 'Refused: no name, or a change that would leave the admin pages unreachable',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/json': { schema: errorSchema } },
    },
    403: {
      description: 'Signed in, but not an admin',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * Taking somebody's access away, or giving it back ("Take somebody's access
 * away without taking their work", issue 233). Behind the same role gate as the
 * rest of the admin pages.
 *
 * **An address of its own under the person's**, rather than a field on the
 * change: it is one thing done from the row's own menu, it ends the sign-ins
 * that person holds, and it carries refusals the form does not.
 */
const setAccessRoute = createRoute({
  method: 'patch',
  path: '/v1/admin/users/{userId}/access',
  request: {
    params: z.object({ userId: z.string() }),
    body: { content: { 'application/json': { schema: setAccessSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Somebody as they stand after the change',
      content: { 'application/json': { schema: userChangedSchema } },
    },
    400: {
      description: 'Not shaped like a change to somebody’s access',
      content: { 'application/json': { schema: errorSchema } },
    },
    404: {
      description: 'Nobody the register holds',
      content: { 'application/json': { schema: errorSchema } },
    },
    409: {
      description: 'Refused: the change would leave the admin pages unreachable',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/json': { schema: errorSchema } },
    },
    403: {
      description: 'Signed in, but not an admin',
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
 * `move_item_to_panel` and `add_item_to_panel`, either of which may settle a
 * routing - landing an Item on a real Panel for the first time - which is
 * the moment a refresh of the rest of its Workspace's Inbox is worth firing
 * ("Re-propose the rest of the inbox the moment you file one", issue 300).
 *
 * **Reads `result.settledRouting` rather than asking first, separately,
 * whether the Item was already filed.** A pre-read would be a second,
 * independent call answering the same question `command-service.ts` already
 * decides atomically inside `applyChange` - two calls a concurrent move of
 * the same Item could land between, so one settle is missed or one
 * reorganizing move is wrongly read as one. Reading the fact off the one
 * call that decided it has no such window.
 *
 * **`waitUntil`, not `await`**, for the same reason `capture_item` below
 * enqueues its own job that way: nobody filing an item is waiting on the
 * rest of the Inbox to be refreshed.
 */
async function changeThatMightSettleARouting<N extends 'move_item_to_panel' | 'add_item_to_panel'>(
  c: Context<AppEnv>,
  name: N,
  payload: CommandPayload<N>,
): Promise<CommandResult> {
  const accountName = c.get('visitor').accountName;
  const result = await change(c, name, payload);
  if (result.settledRouting) {
    c.executionCtx.waitUntil(enqueueRepropose(c.env, accountName, payload.workspaceId));
  }
  return result;
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

/**
 * What the operator's restore routes accept.
 *
 * **They validate like every other route**, per this file's own rule that
 * handlers are thin adapters which validate, call the account and serialize.
 * The first draft of these two did not, and cast the parsed body instead - so
 * every malformed body answered `500 internal error`, telling an operator
 * nothing about a file they could fix. Worse than the message: the only reason
 * a malformed body was not *destructive* was that the two guards which throw on
 * one happen to run before the transaction opens. That is an accident of
 * ordering rather than a property, and this is what makes it a property.
 *
 * A row is left as an open record because a backup's shape is the store's,
 * which this layer deliberately knows nothing about - `restore.ts` checks the
 * rows of a table agree with each other, and the database checks the rest.
 */
const rowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

/**
 * **`account` is required, and it is what says whose file this is.**
 *
 * A backup carries the name it was taken from, and until it was checked nothing
 * anywhere compared that to the account being restored into: the rows' own
 * `tenant_id` was doing the work, which holds for a file with rows in it and
 * says nothing at all about one without any. A backup of an account nobody has
 * opened is exactly that file, so somebody else's empty backup could be poured
 * into a busy account - dropping every table it held and answering 200, having
 * detected no violation because there were no rows to disagree.
 */
const accountBackupSchema = z.object({
  account: z.string(),
  changesApplied: z.array(z.string()),
  tables: z.record(z.string(), z.array(rowSchema)),
});

const registerBackupSchema = z.object({
  tenants: z.array(rowSchema),
  users: z.array(rowSchema),
});

/**
 * The same shape a backup file's name has to take (`scripts/lib/backup.mjs`).
 * The register cannot be consulted here - an account is restored before its
 * register row exists - so this is what stands between a typed name and a store
 * created under it that nothing will ever address again.
 */
const accountNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);

/** Something a person can act on, rather than the whole of Zod's report. */
function firstProblem(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'it is the wrong shape';
  const at = first.path.join('.');
  return at ? `${at} ${first.message.toLowerCase()}` : first.message.toLowerCase();
}

/** A body that is not JSON at all is the same answer as one of the wrong shape. */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
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
    const { userId, name, role } = c.get('visitor');
    return c.json({ user: { id: userId, name, role } }, 200);
  })
  .openapi(adminUsersRoute, async (c) => c.json({ users: await registeredUsers(c.env) }, 200))
  .openapi(addUserRoute, async (c) => {
    const { name, email } = c.req.valid('json');
    const added = await addUser(c.env, { name, address: email }, new Date());
    if (!added.added) return c.json({ error: added.refused }, 409);

    /**
     * **The account is opened as they are added**, so a change that will not
     * apply is met by the admin who added them rather than by that person's
     * first sign-in - which is the whole reason this happens here rather than
     * being left to happen naturally.
     *
     * After the register and never before it: a store opened for an account
     * nobody owns is an object nothing can reach, while a person whose account
     * is not ready simply has it made on their first request.
     */
    let accountReady = true;
    try {
      await (await openAccount(c.env, added.accountId)).workspaces();
    } catch (error) {
      accountReady = false;
      console.error(
        JSON.stringify({
          level: 'error',
          message: `${added.user.id} was added but their account would not open`,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return c.json({ user: added.user, accountReady }, 201);
  })
  .openapi(changeUserRoute, async (c) => {
    const { userId } = c.req.valid('param');
    const changed = await changeUser(c.env, { userId, ...c.req.valid('json') }, c.get('visitor').userId);
    if (!changed.changed) {
      return changed.because === 'nobody'
        ? c.json({ error: changed.refused }, 404)
        : c.json({ error: changed.refused }, 409);
    }
    return c.json({ user: changed.user }, 200);
  })
  .openapi(setAccessRoute, async (c) => {
    const { userId } = c.req.valid('param');
    const { disabled } = c.req.valid('json');
    const changed = await setAccess(
      c.env,
      { userId, disabled },
      c.get('visitor').userId,
      new Date(),
    );
    if (!changed.changed) {
      return changed.because === 'nobody'
        ? c.json({ error: changed.refused }, 404)
        : c.json({ error: changed.refused }, 409);
    }
    return c.json({ user: changed.user }, 200);
  })
  .openapi(healthRoute, async (c) => {
    const { register, store, ai, failure } = await checkHealth(c.env);
    // The reason goes to the logs and not into the body: this endpoint answers
    // anyone at all, and why a change would not apply names tables and columns.
    if (failure) {
      console.error(JSON.stringify({ level: 'error', message: `unhealthy: ${failure}` }));
    }
    return c.json({ ok: register && store, register, store, ai }, 200);
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
  .openapi(commandRoute('set_panel_text'), async (c) => c.json(await change(c, 'set_panel_text', c.req.valid('json')), 200))
  .openapi(commandRoute('set_panel_read_only'), async (c) => c.json(await change(c, 'set_panel_read_only', c.req.valid('json')), 200))
  .openapi(commandRoute('set_panel_format'), async (c) => c.json(await change(c, 'set_panel_format', c.req.valid('json')), 200))
  .openapi(commandRoute('save_layout', { conflict: 'The dashboard already has a layout at that screen size' }), async (c) => c.json(await change(c, 'save_layout', c.req.valid('json')), 200))
  .openapi(commandRoute('delete_layout'), async (c) => c.json(await change(c, 'delete_layout', c.req.valid('json')), 200))
  .openapi(
    commandRoute('create_screen_size', { conflict: 'The account already has a screen size by that name' }),
    async (c) => c.json(await change(c, 'create_screen_size', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('rename_screen_size', { conflict: 'The account already has a screen size by that name' }),
    async (c) => c.json(await change(c, 'rename_screen_size', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('delete_screen_size'), async (c) =>
    c.json(await change(c, 'delete_screen_size', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_workspace_theme'), async (c) => c.json(await change(c, 'set_workspace_theme', c.req.valid('json')), 200))
  .openapi(commandRoute('delete_workspace'), async (c) => c.json(await change(c, 'delete_workspace', c.req.valid('json')), 200))
  .openapi(commandRoute('capture_item'), async (c) => {
    const captured = c.req.valid('json');
    const result = await change(c, 'capture_item', captured);
    // **After the Item is written, and only where it was actually written.** A
    // replayed capture answers `applied: false` and enqueues nothing, so a
    // client retrying an offline capture does not buy a second model call for
    // the same note; and a capture that was refused never reaches here at all
    // ("Clean up a captured note into a clear title and a fuller message",
    // issue 296).
    //
    // **`waitUntil`, not `await`.** Putting a message on a queue is a round
    // trip to Cloudflare's own queue service, and capture is the one path in
    // this product that may never be held up for something the person
    // capturing cannot act on - it is what somebody does in a car. The Item is
    // already written and already carries its mechanical title, so the send
    // outlives the response rather than delaying it.
    if (result.applied) {
      c.executionCtx.waitUntil(
        enqueueCleanUp(c.env, c.get('visitor').accountName, captured.itemId),
      );
    }
    return c.json(result, 200);
  })
  .openapi(
    commandRoute('move_item_to_panel', {
      conflict: 'The order sent is not the order of that panel any more',
    }),
    async (c) =>
      c.json(await changeThatMightSettleARouting(c, 'move_item_to_panel', c.req.valid('json')), 200),
  )
  .openapi(
    commandRoute('add_item_to_panel', {
      conflict: 'The order sent is not the order of that panel any more',
    }),
    async (c) =>
      c.json(await changeThatMightSettleARouting(c, 'add_item_to_panel', c.req.valid('json')), 200),
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
  .openapi(commandRoute('set_routing_summary_correction'), async (c) =>
    c.json(await change(c, 'set_routing_summary_correction', c.req.valid('json')), 200),
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
      // These are the two refusals the person can act on, so they are the two
      // the logon page is told about - and they are told apart, because a
      // colleague whose access was removed must not be sent looking for a
      // sign-in problem that is not theirs.
      if (!signedIn.signedIn) {
        const refused = signedIn.because === 'access removed' ? 'access-removed' : 'unknown-account';
        return c.redirect(`/signin?refused=${refused}`, 302);
      }

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
  })
  // --- the operator's backup routes ------------------------------------------
  // Behind the secret in `auth/operator.ts` and outside the sign-in gate, because
  // whoever calls these holds no session cookie. Plain routes rather than
  // `.openapi(...)`, like ingress above: nothing generated from this
  // application's contract calls them, and they are not part of the shape
  // apps/web infers.
  //
  // Two routes rather than one answer, because an account is read whole in a
  // single call - which is what makes a backup one moment rather than a smear
  // (src/accounts/backup.ts) - and one answer carrying every account would put
  // every account's data in one Worker's memory at once.
  .get('/v1/operator/backup/register', async (c) => {
    const [register, accounts] = await Promise.all([
      registerContents(c.env),
      registeredAccountNames(c.env),
    ]);
    return c.json({ ...register, accounts }, 200);
  })
  .get('/v1/operator/backup/accounts/:name', async (c) => {
    const accountName = c.req.param('name');
    try {
      return c.json({ account: accountName, ...(await backUpAccount(c.env, accountName)) }, 200);
    } catch (error) {
      // A 404 rather than the 500 `onError` gives this error everywhere else,
      // and the difference is which of the two shapes of caller made it: every
      // other route resolves the account from whoever signed in, so a name that
      // is not in the register means the server is confused. Here the caller
      // typed it, so it is theirs to fix and saying which name was wrong is the
      // useful answer.
      if (error instanceof AccountNotInRegisterError) {
        return c.json({ error: `no account ${accountName}` }, 404);
      }
      // Nothing is written out. A store holding somebody else's rows is a
      // question about the data rather than about the request, so it says what
      // it found and refuses rather than backing up a mixture.
      if (error instanceof RowsFromAnotherAccountError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  })
  // Restoring, which is the half that destroys something. Accounts go in first
  // and the register after, so a user never exists pointing at a store that has
  // not arrived - the order is the caller's to keep, and the CLI keeps it.
  .post('/v1/operator/restore/accounts/:name', async (c) => {
    const accountName = c.req.param('name');
    if (!accountNameSchema.safeParse(accountName).success) {
      return c.json({ error: `${accountName} cannot be an account's name` }, 400);
    }
    const force = c.req.query('force') === 'true';
    const read = accountBackupSchema.safeParse(await readJsonBody(c));
    if (!read.success) {
      return c.json({ error: `that is not a backup: ${firstProblem(read.error)}` }, 400);
    }
    // Before anything is dropped, and before the rows are looked at: a file
    // says whose it is, and a file that says somebody else's may not be poured
    // in however few rows it has to disagree with.
    if (read.data.account !== accountName) {
      return c.json(
        {
          error: `that is ${read.data.account}'s backup, and it was going into ${accountName} - nothing was restored`,
        },
        400,
      );
    }
    const backup = read.data as AccountBackup;
    try {
      return c.json(await restoreAccount(c.env, accountName, backup, force), 200);
    } catch (error) {
      // Already holds data and nobody asked to replace it.
      if (error instanceof ConflictInAccountError) {
        return c.json({ error: error.message }, 409);
      }
      // A backup from a newer version, or one carrying another account's rows.
      // The request is well formed and the answer is that this file may not go
      // into this store, which is the caller's to fix.
      if (error instanceof RefusedByAccountError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  })
  .post('/v1/operator/restore/register', async (c) => {
    const read = registerBackupSchema.safeParse(await readJsonBody(c));
    if (!read.success) {
      return c.json({ error: `that is not a register: ${firstProblem(read.error)}` }, 400);
    }
    const incoming = read.data as RegisterBackup;
    try {
      const plan = await restoreRegister(c.env, incoming);
      return c.json(
        { accountsCreated: plan.tenantsToCreate.length, usersCreated: plan.usersToCreate.length },
        200,
      );
    } catch (error) {
      // A row nothing could write, whatever is here - a broken file rather than
      // a disagreement, so it reads as the caller's to fix like every other
      // malformed body, and not as something about this register.
      if (error instanceof RegisterRowUnusableError) {
        return c.json({ error: error.message }, 400);
      }
      // The backup and this environment disagree about who somebody is, which
      // is not a thing a restore may decide.
      if (error instanceof RegisterDisagreesError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
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
