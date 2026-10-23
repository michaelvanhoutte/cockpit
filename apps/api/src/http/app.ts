import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  accountHoldingsSchema,
  appDisconnectedSchema,
  connectedAppListSchema,
  addAttachmentSchema,
  addUserSchema,
  attachmentContentTypeSchema,
  changeUserSchema,
  userDeletedSchema,
  attachmentLinksRequestSchema,
  attachmentLinksSchema,
  rememberOfferAnswerSchema,
  rememberedSentenceListSchema,
  ACCOUNT_WIDE,
  commandResultSchema,
  commandSchemas,
  MAX_ATTACHMENT_SIZE,
  MAX_RECORDING_BYTES,
  TRANSCRIPTION_PATH,
  registeredUserListSchema,
  usageRequestSchema,
  usageSchema,
  rewriteHistoryResponseSchema,
  setAccessSchema,
  signedInSchema,
  registeredConnectorListSchema,
  sendPhoneCodeSchema,
  phoneCodeSentSchema,
  confirmPhoneCodeSchema,
  phoneConnectedSchema,
  recurringItemListSchema,
  sourceAccountListSchema,
  DUE_IN_DAYS_MAX,
  DUE_IN_DAYS_MIN,
  connectionHistorySchema,
  checkedNowSchema,
  uuidv7,
  userAddedSchema,
  userChangedSchema,
  workspaceListSchema,
  workspaceSnapshotSchema,
  type ClientCommandName,
  type CommandName,
  type CommandPayload,
  type CommandResult,
} from '@cockpit/shared';
import {
  accountBackupSchema,
  accountNameSchema,
  firstProblem,
  registerBackupSchema,
} from '../accounts/backup.js';
import {
  AccountNotInRegisterError,
  AccountNotUpToDateError,
  AllowanceSpentError,
  ConflictInAccountError,
  NotFoundInAccountError,
  RefusedByAccountError,
  RegisterDisagreesError,
  RegisterRowUnusableError,
  RowsFromAnotherAccountError,
  accountHoldings,
  accountOpened,
  backUpAccount,
  openAccount,
  serveAttachment,
  addUser,
  changeUser,
  deleteUser,
  nobodyHere,
  registerContents,
  registeredAccountNames,
  registeredUsers,
  setAccess,
  resetGuestAccount,
  restoreAccount,
  restoreRegister,
  type Account,
  type AccountBackup,
  type RegisterBackup,
} from '../accounts/index.js';
import { checkHealth } from '../accounts/probe.js';
import { transcriberFor } from '../transcription/index.js';
import { ALLOWANCE_SPENT_MESSAGE, allowanceSpent } from '../accounts/allowance.js';
import { attachmentR2Key, type AttachmentForDownload } from '../domain/attachments.js';
import {
  ATTACHMENT_LINK_PREFIX,
  attachmentLinkKey,
  openAttachmentLink,
  sealAttachmentLink,
} from '../auth/attachment-link.js';
import {
  CannotReadMeaningError,
  enqueueCleanUp,
  enqueueProposalForClaude,
  enqueueProposalsForSentence,
  enqueueReadingItsMeaning,
  enqueueRepropose,
  enqueueGuestArrivals,
  readWhatTheseNotesMean,
} from '../jobs/index.js';
import { offerToRemember } from '../jobs/offer-to-remember.js';
import { onOneLine } from '../domain/remembered-sentences.js';
import { readUsage } from '../accounts/usage.js';
import { USAGE_RECORDS_PATH, receiveRecord } from '../gateway/receive.js';
import { ADMIN_PREFIX, adminGate } from '../auth/admin.js';
import {
  MOVED_OPERATOR_PREFIXES,
  OPERATOR_PREFIX,
  operatorGate,
} from '../auth/operator.js';
import { readUsageRecords } from '../gateway/export.js';
import {
  attemptHeld,
  connectAttemptHeld,
  forgetAttempt,
  forgetConnectAttempt,
  forgetSessionCookie,
  callbackUrl,
  gate,
  heldSessionId,
  refuseSignIn,
  rememberAttempt,
  rememberConnectAttempt,
  rememberSessionCookie,
  stillSignedIn,
  RETIRED_PATHS,
  type GatedEnv,
} from '../auth/gate.js';
import { endpointsFor, exchangeCode, issuerFor, keysOf } from '../auth/issuer.js';
import { authorizationUrl, identityFrom, newAttempt, replyBelongsTo } from '../auth/oidc.js';
import { returnPathFrom } from '../auth/return-path.js';
import { connectedAppsOf, disconnectApp } from '../mcp/connected-apps.js';
import { revokeAppsOf } from '../mcp/revoke.js';
import { open, seal, sealingKey, type Sealed } from '../connectors/credential-crypto.js';
import {
  accountSignedIn,
  authorizationRequest,
  backToConnections,
  choiceOptionsOf,
  clientOf,
  refuseConnection,
  signInOf,
  textedCodeOf,
} from '../connectors/sign-in.js';
import { revokeAfterDisconnect } from '../connectors/revoke.js';
import { guestConnectionGate } from '../auth/guest-connections.js';
import { countForGuest, countryOf, referrerHostOf } from '../auth/sign-in-history.js';
import { GUEST_ACCOUNT_NAME } from '../accounts/new-user.js';
import {
  endSession,
  signInAsGuest,
  signInWithGoogle,
} from '../auth/register.js';
import { connectors, getConnector, pulledConnectorIds, pushedConnectorIds, sourceNames } from '../connectors/registry.js';
import { handlePush } from '../connectors/push-host.js';
import { rememberConnectionAfterStoring } from '../connectors/directory.js';
import { confirmTextedCode, sendTextedCode } from '../connectors/texted-code.js';
import type { Env } from '../env.js';

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
  // A 503 rather than a 500: nothing is wrong with the data or the code, the
  // free tier has run out for the day. Also caught by message, for a call that
  // met the limit outside the store's own answer.
  if (err instanceof AllowanceSpentError || allowanceSpent(err)) {
    console.error(JSON.stringify({ level: 'error', message: err.message, stack: err.stack }));
    return c.json({ error: ALLOWANCE_SPENT_MESSAGE }, 503);
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

/** And the guest's refusal of every connection change, behind the same gate (`auth/guest-connections.ts`). */
app.use('*', guestConnectionGate());

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
 * apps/web/src/api/loadFailure.ts reads none of them (the page reads `transcription`, below). It asks this endpoint only
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
 * **`embeddings` is the same thing said about a different capability**: whether
 * there is a binding to read what a note *means* with, and so whether this
 * environment can flag one saying what another one already said ("Flag a
 * captured note that says what another one already said", issue 407). Separate
 * from `ai` because the two are separately configured - an environment can
 * have either, both or neither - and outside `ok` for the same reason.
 *
 * **`transcription` is the same again for turning a recording into words**
 * ("Dictate in Write with Whisper", issue 1041): whether there is a binding, or
 * the stand-in the local stacks use, and so whether Capture draws a mic. The
 * page reads it (`apps/web/src/api/transcription.ts`), unlike the rest.
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
        'Whether the register and an account store can both be reached, whether this environment can enrich anything, and whether it can read what a note means',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.boolean(),
            register: z.boolean(),
            store: z.boolean(),
            ai: z.boolean(),
            embeddings: z.boolean(),
            transcription: z.boolean(),
            allowanceSpent: z.literal(true).optional(),
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
 * What the admin's Usage window reads: sign-ins and guest sessions over a
 * bounded window of days ("Add an admin Usage window for sign-ins and guest
 * sessions", issue 654). Behind the same role gate as the list of users.
 *
 * The window and its days are counted on the calendar of the zone the request
 * carries ("Count Settings › Usage's days on your own calendar", issue 1428).
 */
const adminUsageRoute = createRoute({
  method: 'get',
  path: '/v1/admin/usage',
  request: { query: usageRequestSchema },
  responses: {
    200: {
      description: 'Named users’ sign-ins and guest sessions over the window',
      content: { 'application/json': { schema: usageSchema } },
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
 * Deleting somebody, and the account they owned ("Delete a user, and the
 * account they owned with them", issue 234). Behind the same role gate as the
 * rest of the admin pages.
 *
 * The same 404 and 409 a change answers: somebody the register does not hold -
 * which is what a second deletion of the same person meets - and a deletion it
 * holds them for and will not make.
 */
const deleteUserRoute = createRoute({
  method: 'delete',
  path: '/v1/admin/users/{userId}',
  request: { params: z.object({ userId: z.string() }) },
  responses: {
    200: {
      description: 'They, and the account they owned, are gone',
      content: { 'application/json': { schema: userDeletedSchema } },
    },
    404: {
      description: 'Nobody the register holds',
      content: { 'application/json': { schema: errorSchema } },
    },
    409: {
      description: 'Refused: yourself, the last admin, or an account somebody else also uses',
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
 * What somebody's account holds, for the question asked before deleting them
 * (issue 234). Its own read rather than a column in the list, because counting
 * for every row would wake every account's store to draw one page.
 */
const accountHoldingsRoute = createRoute({
  method: 'get',
  path: '/v1/admin/users/{userId}/account',
  request: { params: z.object({ userId: z.string() }) },
  responses: {
    200: {
      description: 'How many workspaces their account holds',
      content: { 'application/json': { schema: accountHoldingsSchema } },
    },
    404: {
      description: 'Nobody the register holds',
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

/**
 * Every rewrite attempt for one workspace's items, most recent first - the
 * table opened from the Inbox's own menu ("See the history of what Cockpit
 * proposed for the Inbox's items", issue 444).
 */
const rewriteHistoryForWorkspaceRoute = createRoute({
  method: 'get',
  path: '/v1/workspaces/{workspaceId}/rewrite-history',
  request: { params: z.object({ workspaceId: z.string() }) },
  responses: {
    200: {
      description: "One workspace's rewrite history, most recent first",
      content: { 'application/json': { schema: rewriteHistoryResponseSchema } },
    },
  },
});

/**
 * The source accounts one Workspace has connected ("Connect a Microsoft Teams
 * source account", issue 485) - its own route rather than a slice of the
 * Workspace snapshot: the
 * window that reads it is opened now and then, while a snapshot is read on
 * every navigation.
 */
const sourceAccountsRoute = createRoute({
  method: 'get',
  path: '/v1/workspaces/{workspaceId}/connections',
  request: { params: z.object({ workspaceId: z.string() }) },
  responses: {
    200: {
      description: 'The source accounts this workspace has connected, oldest first',
      content: { 'application/json': { schema: sourceAccountListSchema } },
    },
    404: {
      description: 'Unknown workspace',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * The recurring items one Workspace holds, soonest first ("Make, change and
 * delete recurring items from the Recurring items modal", issue 1449) - read
 * when the modal opens, never part of the Workspace snapshot, which every
 * navigation reads.
 */
const recurringItemsRoute = createRoute({
  method: 'get',
  path: '/v1/workspaces/{workspaceId}/recurring-items',
  request: { params: z.object({ workspaceId: z.string() }) },
  responses: {
    200: {
      description: "The Workspace's running recurring items, soonest first",
      content: { 'application/json': { schema: recurringItemListSchema } },
    },
    404: {
      description: 'Unknown workspace',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * One connection's history, newest line first ("See when a pulled connection
 * was checked, and why it failed, from its row's History…", issue 1140) - read
 * when *History…* opens it, never part of the Workspace snapshot, which would
 * carry every line on every navigation.
 */
const connectionHistoryRoute = createRoute({
  method: 'get',
  path: '/v1/workspaces/{workspaceId}/connections/{sourceAccountId}/history',
  request: { params: z.object({ workspaceId: z.string(), sourceAccountId: z.string() }) },
  responses: {
    200: {
      description: "The connection's history, newest line first",
      content: { 'application/json': { schema: connectionHistorySchema } },
    },
    404: {
      description: 'Unknown workspace or connection',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * *Check now* on one pulled connection ("Check a pulled connection now, from
 * its row or its history", issue 1143): its check made due at once through the
 * path a person's change takes, labelled *Check now*. A POST to the
 * connection and not a command - it changes no Item or setting, only when the
 * next check runs, and pressing it twice makes one check.
 */
const checkConnectionNowRoute = createRoute({
  method: 'post',
  path: '/v1/workspaces/{workspaceId}/connections/{sourceAccountId}/check-now',
  request: { params: z.object({ workspaceId: z.string(), sourceAccountId: z.string() }) },
  responses: {
    200: {
      description: 'What pressing it did to the connection’s check',
      content: { 'application/json': { schema: checkedNowSchema } },
    },
    404: {
      description: 'Unknown workspace, or not a pulled connection of it',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * The connectors this environment's registry holds that a person can sign in
 * to ("List the registry's connectors in the Connections window", issue 894):
 * what the Connections window draws a card from, so adding a source adds its
 * card without a change to the web app. One that is not registered, such as
 * Teams where its bot is not configured, is not listed; neither is one with
 * no sign-in or no client or sealing key configured, since its card would
 * have a Connect that goes nowhere.
 */
const registeredConnectorsRoute = createRoute({
  method: 'get',
  path: '/v1/connectors',
  responses: {
    200: {
      description: 'The connectors a person can sign in to, in registration order',
      content: { 'application/json': { schema: registeredConnectorListSchema } },
    },
  },
});

/**
 * Connecting a phone by confirming a code texted to it ("Connect a phone in
 * Settings by confirming a code texted to it", issue 1335): two requests from
 * the Connections window, each refusing in the connector's words. Sending a
 * code is refused for a number the connector does not accept, for an account
 * that has asked for its hour's codes, and where the source fails; confirming
 * is refused for a code that is wrong or no longer valid, and connects the
 * number only when it is approved. Behind the guest's gate like every
 * connection change, and 404 where the connector is not registered here.
 */
const sendPhoneCodeRoute = createRoute({
  method: 'post',
  path: '/v1/workspaces/{workspaceId}/connections/{connectorId}/phone/code',
  request: {
    params: z.object({ workspaceId: z.string(), connectorId: z.string() }),
    body: { required: true, content: { 'application/json': { schema: sendPhoneCodeSchema } } },
  },
  responses: {
    200: {
      description: 'A code was texted to this number',
      content: { 'application/json': { schema: phoneCodeSentSchema } },
    },
    400: {
      description: 'The number is not one the connector accepts',
      content: { 'application/json': { schema: errorSchema } },
    },
    404: {
      description: 'Unknown workspace, or no such connector offered here',
      content: { 'application/json': { schema: errorSchema } },
    },
    429: {
      description: 'The account has asked for as many codes as an hour allows',
      content: { 'application/json': { schema: errorSchema } },
    },
    502: {
      description: 'The source could not be asked',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

const confirmPhoneCodeRoute = createRoute({
  method: 'post',
  path: '/v1/workspaces/{workspaceId}/connections/{connectorId}/phone/confirm',
  request: {
    params: z.object({ workspaceId: z.string(), connectorId: z.string() }),
    body: { required: true, content: { 'application/json': { schema: confirmPhoneCodeSchema } } },
  },
  responses: {
    200: {
      description: 'The number is now connected to this workspace',
      content: { 'application/json': { schema: phoneConnectedSchema } },
    },
    400: {
      description: 'The number is not one the connector accepts, or the code is wrong or no longer valid',
      content: { 'application/json': { schema: errorSchema } },
    },
    404: {
      description: 'Unknown workspace, or no such connector offered here',
      content: { 'application/json': { schema: errorSchema } },
    },
    429: {
      description: 'The account has asked for as many codes as an hour allows',
      content: { 'application/json': { schema: errorSchema } },
    },
    502: {
      description: 'The source could not be asked',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * The apps the signed-in person has allowed into their Cockpit ("See the apps
 * connected to your Cockpit, and disconnect one", issue 600). Only their own:
 * what somebody else allowed, into the same account or not, is theirs to see.
 */
const connectedAppsRoute = createRoute({
  method: 'get',
  path: '/v1/connected-apps',
  responses: {
    200: {
      description: 'The apps this person allowed, oldest first',
      content: { 'application/json': { schema: connectedAppListSchema } },
    },
  },
});

/**
 * What Settings lists under *What Cockpit remembers* ("See and change what
 * Cockpit remembers", issue 1164): this account's sentences, the newest first.
 */
const rememberedSentencesRoute = createRoute({
  method: 'get',
  path: '/v1/remembered-sentences',
  responses: {
    200: {
      description: 'The remembered sentences, newest first',
      content: { 'application/json': { schema: rememberedSentenceListSchema } },
    },
  },
});

/**
 * The address each of these files opens at for a Claude session that cannot
 * sign in ("Send an item to Cowork or Claude Code with its prompt reviewed
 * first", issue 1159). Made for this account only, and checked when opened
 * (`auth/attachment-link.ts`), so an id that is not this account's file
 * yields an address that opens nothing.
 */
const attachmentLinksRoute = createRoute({
  method: 'post',
  path: '/v1/attachment-links',
  request: {
    body: { required: true, content: { 'application/json': { schema: attachmentLinksRequestSchema } } },
  },
  responses: {
    200: {
      description: 'One address per file, none where links cannot be made',
      content: { 'application/json': { schema: attachmentLinksSchema } },
    },
  },
});

/**
 * The sentence worth remembering from the edit a send was made with ("Remember
 * an edit as a sentence you confirm", issue 1163). Asked after the link has
 * opened, so it is a request of its own and never part of the send; **always a
 * 200**, with no offer for every way there is none (`offerToRemember`).
 */
const rememberOfferRoute = createRoute({
  method: 'post',
  path: '/v1/claude-sends/{runId}/remember-offer',
  request: { params: z.object({ runId: z.uuid() }) },
  responses: {
    200: {
      description: 'The offer, or none',
      content: { 'application/json': { schema: rememberOfferAnswerSchema } },
    },
  },
});

/** Ends one app's access at once; what it captured stays. */
const disconnectAppRoute = createRoute({
  method: 'delete',
  path: '/v1/connected-apps/{appId}',
  request: { params: z.object({ appId: z.string() }) },
  responses: {
    200: {
      description: 'The app can no longer reach Cockpit',
      content: { 'application/json': { schema: appDisconnectedSchema } },
    },
    404: {
      description: 'Not an app this person allowed',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

/**
 * A request body as bytes, or null where it runs past `limit` - read a chunk at
 * a time, so a body that says nothing of its length is still cut off rather than
 * read whole first. The binary twin of `bodyWithin`.
 */
async function bytesWithin(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return whole;
}

/**
 * Every rewrite attempt for one item, most recent first - the table opened
 * from that item's own menu (issue 444).
 */
const rewriteHistoryForItemRoute = createRoute({
  method: 'get',
  path: '/v1/items/{itemId}/rewrite-history',
  request: { params: z.object({ itemId: z.uuid() }) },
  responses: {
    200: {
      description: "One item's rewrite history, most recent first",
      content: { 'application/json': { schema: rewriteHistoryResponseSchema } },
    },
  },
});

// --- changes ("Mutations are commands"): one POST endpoint per change --------

// `ClientCommandName`, not `CommandName`: a command with no generic JSON
// endpoint (`add_attachment`, `packages/shared/src/commands.ts`) must not be
// wired onto this route at all, or it would accept a client-claimed
// `size`/`contentType` the upload route exists specifically to not trust.
function commandRoute<N extends ClientCommandName>(name: N, extra?: { conflict: string }) {
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
 * A remembered sentence as it stands before it is reworded or deleted
 * (issue 1164), undefined where there is none. **Held to the same minute as
 * Remember**, since each change asks for Items to be proposed again.
 */
async function sentenceBeforeItChanges(env: Env, accountName: string, sentenceId: string) {
  const account = await openAccount(env, accountName);
  const before = (await account.rememberedSentences()).sentences.find((one) => one.id === sentenceId);
  if ((await account.sentenceCallArrived('remember', new Date().toISOString())) === 'too-many') {
    throw new ConflictInAccountError('Too many sentences were changed in the last minute. Try again shortly.');
  }
  return before;
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
  // Any filing, settling or not, changes the Panel a proposal for Claude is made from (issue 1161).
  if (result.applied) c.executionCtx.waitUntil(enqueueProposalForClaude(c.env, accountName, payload.itemId, 'item-changed'));
  return result;
}

/**
 * `set_title` and `set_description` - the two changes that replace what an Item
 * says, and so the two that make whatever was worked out about its meaning
 * wrong ("Flag a captured note that says what another one already said", issue
 * 407) and, where they correct what Cockpit proposed, the two that teach how
 * this account writes ("Learn how you write from the titles you correct",
 * issue 394).
 *
 * **A correction queues the re-reading of what the Item means, and of what to
 * do with it** ("Propose what to do with each item before you look", issue
 * 1161), and nothing else: what it teaches reaches later captures only; the
 * Items already in the Inbox keep the texts they have ("Cut what cleaning up a captured note costs",
 * issue 887).
 *
 * **The form showing the duplicates is where a stale answer would show up
 * first**, which is why the re-read is fired from the edit rather than left to
 * anything later: a person renames a note to something they already have, and
 * the mark has to follow.
 *
 * **Only where the write landed.** A replay and a change made against an older
 * version both answer `applied: false` and queue nothing, so neither buys a
 * second reading of a note nobody changed. `waitUntil` for the reason capture's
 * own job is: nobody pressing Save is waiting to be told about a duplicate.
 */
async function changeThatRewritesTheTexts<N extends 'set_title' | 'set_description'>(
  c: Context<AppEnv>,
  name: N,
  payload: CommandPayload<N>,
): Promise<CommandResult> {
  const accountName = c.get('visitor').accountName;
  const result = await change(c, name, payload);
  if (result.applied) {
    c.executionCtx.waitUntil(enqueueReadingItsMeaning(c.env, accountName, payload.itemId));
    c.executionCtx.waitUntil(enqueueProposalForClaude(c.env, accountName, payload.itemId, 'item-changed'));
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

/** A body that is not JSON at all is the same answer as one of the wrong shape. */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * How many Items one call of the backfill may read ("Give every item already
 * there a vector", issue 409).
 *
 * **Bounded, and low.** Every reading in a batch is a call to the model, made
 * before any of them is written, so the batch is both what a single request can
 * spend and what an interrupted one can lose. The command asks again from where
 * the last answer stopped, so a small batch costs an extra query rather than an
 * extra reading.
 */
const LARGEST_BATCH = 100;
const BATCH_BY_DEFAULT = 25;

/** The answer a Connect carries to whether it files by name: exactly `true` or `false`, else none (issue 1147). */
function filesByNameAnswered(asked: string | undefined): boolean | undefined {
  return asked === 'true' ? true : asked === 'false' ? false : undefined;
}

/**
 * The answer a Connect carries to how many days after it arrives each Item is
 * due (issue 1409): a whole number in range, `none` for none, absent for no
 * answer, and anything else is not an answer.
 */
function dueInDaysAnswered(asked: string | undefined): number | null | undefined | 'not an answer' {
  if (asked === undefined) return undefined;
  if (asked === 'none') return null;
  if (!/^\d{1,3}$/.test(asked)) return 'not an answer';
  const days = Number(asked);
  return days >= DUE_IN_DAYS_MIN && days <= DUE_IN_DAYS_MAX ? days : 'not an answer';
}

/** The batch a call asked for, or that what it asked for is not one. */
function batchSize(asked: string | undefined): number | 'not a batch size' {
  if (asked === undefined || asked === '') return BATCH_BY_DEFAULT;
  if (!/^\d+$/.test(asked)) return 'not a batch size';
  const wanted = Number(asked);
  if (wanted < 1 || wanted > LARGEST_BATCH) return 'not a batch size';
  return wanted;
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
  .openapi(adminUsageRoute, async (c) => {
    const { days, timeZone } = c.req.valid('query');
    return c.json(await readUsage(c.env, days, new Date(), timeZone), 200);
  })
  .openapi(addUserRoute, async (c) => {
    const { name, email } = c.req.valid('json');
    const added = await addUser(c.env, { name, address: email }, new Date());
    if (!added.added) return c.json({ error: added.refused }, 409);

    // Opened as they are added, so a change that will not apply is met by the
    // admin who added them rather than by that person's first sign-in.
    const accountReady = await accountOpened(c.env, added.accountId, `${added.user.id} was added`);
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
    // Access taken away takes the apps they connected with it, for good
    // ("Connect Claude to Cockpit, and capture an item from it", issue 599):
    // after the change, and never in its way (`mcp/revoke.ts`).
    if (disabled) await revokeAppsOf(c.env, userId);
    return c.json({ user: changed.user }, 200);
  })
  .openapi(deleteUserRoute, async (c) => {
    const { userId } = c.req.valid('param');
    const deleted = await deleteUser(c.env, userId, c.get('visitor').userId);
    if (!deleted.deleted) {
      return deleted.because === 'nobody'
        ? c.json({ error: deleted.refused }, 404)
        : c.json({ error: deleted.refused }, 409);
    }
    // And so does being deleted, the same way.
    await revokeAppsOf(c.env, userId);
    return c.json({ deleted: true as const }, 200);
  })
  .openapi(accountHoldingsRoute, async (c) => {
    const { userId } = c.req.valid('param');
    const holdings = await accountHoldings(c.env, userId);
    if (!holdings) return c.json({ error: nobodyHere(userId).refused }, 404);
    return c.json(holdings, 200);
  })
  .openapi(healthRoute, async (c) => {
    const { register, store, ai, embeddings, transcription, failure, allowanceSpent: spent } = await checkHealth(c.env);
    // The reason goes to the logs and not into the body: this endpoint answers
    // anyone at all, and why a change would not apply names tables and columns.
    if (failure) {
      console.error(JSON.stringify({ level: 'error', message: `unhealthy: ${failure}` }));
    }
    // Present only when the limit is spent, so a healthy answer is unchanged.
    return c.json(
      { ok: register && store, register, store, ai, embeddings, transcription, ...(spent ? { allowanceSpent: true } : {}) },
      200,
    );
  })
  .openapi(workspacesRoute, async (c) => {
    const account = await openAccount(c.env, c.get('visitor').accountName);
    return c.json({ workspaces: await account.workspaces() }, 200);
  })
  .openapi(snapshotRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const account = await openAccount(c.env, c.get('visitor').accountName);
    const snapshot = await account.snapshot(workspaceId);
    // Opening a Workspace is opening its Dashboards: the read the app makes
    // each time one is shown (issue 653).
    await countForGuest(c.env, c.get('sessionId'), 'dashboardsOpened');
    return c.json({ ...snapshot, sourceNames: sourceNames(c.env), generatedAt: new Date().toISOString() }, 200);
  })
  .openapi(sourceAccountsRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const account = await openAccount(c.env, c.get('visitor').accountName);
    // Whose Workspace this is needs no check of its own: `openAccount`
    // resolves the signed-in visitor's own account, and another account's
    // store is a different SQLite database entirely - so there is no
    // workspace id this request could name that reaches somebody else's
    // connections, the same reasoning the attachment download route records.
    // A described source's choice is stored as its value, and said in its
    // connector's words here, where the registry is known (issue 942).
    // A pulled connection's checks are what its history holds (issue 1140), and
    // a pushed one's deliveries (issue 1144); only a pulled one can be checked.
    const pulled = pulledConnectorIds(c.env);
    const pushed = pushedConnectorIds(c.env);
    return c.json(
      {
        sourceAccounts: (await account.sourceAccounts(workspaceId)).map((held) => {
          const options = choiceOptionsOf(c.env, held.connectorId);
          const chosen = options?.find((option) => option.value === held.follows);
          const label = chosen?.label;
          const isPulled = pulled.includes(held.connectorId);
          const keepsHistory = isPulled || pushed.includes(held.connectorId);
          return {
            ...held,
            ...(label === undefined ? {} : { followsLabel: label }),
            ...(chosen?.listed === undefined ? {} : { followsListed: chosen.listed }),
            ...(keepsHistory ? { keepsHistory } : {}),
            ...(isPulled ? { pulled: true } : {}),
          };
        }),
      },
      200,
    );
  })
  .openapi(recurringItemsRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const account = await openAccount(c.env, c.get('visitor').accountName);
    return c.json({ recurringItems: await account.recurringItems(workspaceId) }, 200);
  })
  .openapi(connectionHistoryRoute, async (c) => {
    const { workspaceId, sourceAccountId } = c.req.valid('param');
    const account = await openAccount(c.env, c.get('visitor').accountName);
    // Throws where the row is not a live connection of this Workspace, which
    // `onError` answers with the 404 every connection route gives.
    return c.json(await account.connectionHistory(workspaceId, sourceAccountId), 200);
  })
  .openapi(checkConnectionNowRoute, async (c) => {
    const { workspaceId, sourceAccountId } = c.req.valid('param');
    const account = await openAccount(c.env, c.get('visitor').accountName);
    // Throws where it is not a live pulled connection of this Workspace,
    // which `onError` answers with the 404 every connection route gives.
    return c.json({ status: await account.checkNow(workspaceId, sourceAccountId) }, 200);
  })
  .openapi(registeredConnectorsRoute, async (c) => {
    // Listed only where Connect would go through: the sign-in, client and
    // sealing key the connect route requires - or, for a phone, the key and
    // the texted-code description the code routes require.
    const sealable = (await sealingKey(c.env.CONNECTOR_CREDENTIAL_KEY)) !== null;
    return c.json(
      {
        connectors: connectors(c.env)
          .filter(({ manifest }) => {
            if (textedCodeOf(c.env, manifest.id)) return sealable;
            const sign = signInOf(c.env, manifest.id);
            return sealable && sign !== null && clientOf(c.env, sign.auth) !== null;
          })
          .map(({ manifest }) => ({
            id: manifest.id,
            displayName: manifest.displayName,
            cardText: manifest.cardText,
            asksFirst: manifest.choice !== undefined || manifest.names !== undefined || manifest.pulled === true,
            ...(manifest.pulled === true ? { pulled: true } : {}),
            ...(manifest.choice
              ? { choice: { question: manifest.choice.question, options: manifest.choice.options.map((option) => ({ ...option })) } }
              : {}),
            ...(manifest.names ? { names: { noun: manifest.names.noun, example: manifest.names.example } } : {}),
            refusals: signInOf(c.env, manifest.id)?.auth.refusals ?? {},
            ...(manifest.auth.kind === 'texted-code' ? { textedCode: { textTo: manifest.auth.textTo } } : {}),
          })),
      },
      200,
    );
  })
  // --- connecting a phone: two requests, nothing pending between them ---------
  .openapi(sendPhoneCodeRoute, async (c) => {
    const { workspaceId, connectorId } = c.req.valid('param');
    const { number } = c.req.valid('json');
    const sent = await sendTextedCode(c.env, c.get('visitor').accountName, workspaceId, connectorId, number, new Date());
    return sent.done ? c.json({ number: sent.number }, 200) : c.json({ error: sent.error }, sent.status);
  })
  .openapi(confirmPhoneCodeRoute, async (c) => {
    const { workspaceId, connectorId } = c.req.valid('param');
    const { number, code } = c.req.valid('json');
    const connected = await confirmTextedCode(
      c.env,
      c.get('visitor').accountName,
      workspaceId,
      connectorId,
      number,
      code,
      new Date(),
    );
    return connected.done ? c.json({ number: connected.number }, 200) : c.json({ error: connected.error }, connected.status);
  })
  .openapi(rememberedSentencesRoute, async (c) => {
    const account = await openAccount(c.env, c.get('visitor').accountName);
    return c.json(await account.rememberedSentences(), 200);
  })
  .openapi(connectedAppsRoute, async (c) => {
    return c.json({ apps: await connectedAppsOf(c.env, c.get('visitor').userId) }, 200);
  })
  .openapi(disconnectAppRoute, async (c) => {
    const { appId } = c.req.valid('param');
    if (!(await disconnectApp(c.env, c.get('visitor').userId, appId))) {
      return c.json({ error: 'no such app' }, 404);
    }
    return c.json({ disconnected: true as const }, 200);
  })
  .openapi(attachmentLinksRoute, async (c) => {
    const { attachmentIds } = c.req.valid('json');
    const key = await attachmentLinkKey(c.env.CONNECTOR_CREDENTIAL_KEY);
    if (!key) return c.json({ links: {} }, 200);
    const now = new Date();
    const accountName = c.get('visitor').accountName;
    const account = await openAccount(c.env, accountName);
    const links: Record<string, string> = {};
    for (const attachmentId of attachmentIds) {
      // Only a file of this account on an Item that is not deleted gets an address.
      if (!(await account.attachmentForDownload(attachmentId))) continue;
      links[attachmentId] = new URL(
        `${ATTACHMENT_LINK_PREFIX}${await sealAttachmentLink(key, { accountName, attachmentId }, now)}`,
        c.env.APP_ORIGIN,
      ).toString();
    }
    return c.json({ links }, 200);
  })
  .openapi(rewriteHistoryForWorkspaceRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const account = await openAccount(c.env, c.get('visitor').accountName);
    return c.json({ entries: await account.rewriteHistoryForWorkspace(workspaceId) }, 200);
  })
  .openapi(rewriteHistoryForItemRoute, async (c) => {
    const { itemId } = c.req.valid('param');
    const account = await openAccount(c.env, c.get('visitor').accountName);
    return c.json({ entries: await account.rewriteHistoryForItem(itemId) }, 200);
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
    commandRoute('reorder_dashboards', {
      conflict: 'The dashboards changed while they were being put in order',
    }),
    async (c) => c.json(await change(c, 'reorder_dashboards', c.req.valid('json')), 200),
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
  .openapi(
    commandRoute('set_panel_settings', { conflict: 'The dashboard already has a panel by that name' }),
    async (c) => c.json(await change(c, 'set_panel_settings', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('delete_panel'), async (c) => c.json(await change(c, 'delete_panel', c.req.valid('json')), 200))
  .openapi(commandRoute('move_panel_to_dashboard'), async (c) => c.json(await change(c, 'move_panel_to_dashboard', c.req.valid('json')), 200))
  .openapi(commandRoute('set_panel_text'), async (c) => c.json(await change(c, 'set_panel_text', c.req.valid('json')), 200))
  .openapi(commandRoute('set_panel_read_only'), async (c) => c.json(await change(c, 'set_panel_read_only', c.req.valid('json')), 200))
  .openapi(commandRoute('set_panel_never_propose'), async (c) => c.json(await change(c, 'set_panel_never_propose', c.req.valid('json')), 200))
  .openapi(commandRoute('set_panel_format'), async (c) => c.json(await change(c, 'set_panel_format', c.req.valid('json')), 200))
  .openapi(commandRoute('set_panel_filter'), async (c) => c.json(await change(c, 'set_panel_filter', c.req.valid('json')), 200))
  .openapi(commandRoute('set_panel_sort'), async (c) => c.json(await change(c, 'set_panel_sort', c.req.valid('json')), 200))
  .openapi(commandRoute('save_layout'), async (c) => c.json(await change(c, 'save_layout', c.req.valid('json')), 200))
  // The other half of connecting is not a command endpoint at all: it is the
  // callback Microsoft returns to, further down this chain ("Connect a
  // Microsoft Teams source account", issue 485).
  .openapi(commandRoute('disconnect_source_account'), async (c) => {
    const cmd = c.req.valid('json');
    // A source that revokes has its credential read before it is forgotten,
    // and its revoke called once the row has gone (issue 941). Only this
    // Workspace's own row is read, and reading nothing is the same disconnect
    // as before: the command below is what decides, and refuses, whether
    // there is anything to disconnect.
    const account = await openAccount(c.env, c.get('visitor').accountName);
    const heldConnector = (await account.sourceAccounts(cmd.workspaceId).catch(() => [])).find(
      (held) => held.id === cmd.sourceAccountId,
    );
    const revocable = heldConnector ? getConnector(c.env, heldConnector.connectorId) : undefined;
    const sealedToRevoke = revocable?.revoke ? await account.sealedCredential(cmd.sourceAccountId) : null;
    const result = await account.applyChange('disconnect_source_account', cmd);
    // After the row is gone and only then: a revoke that fails or hangs must
    // never keep it.
    if (revocable && sealedToRevoke && result.applied) {
      await revokeAfterDisconnect(
        c.env,
        revocable,
        account,
        { accountName: c.get('visitor').accountName, workspaceId: cmd.workspaceId },
        sealedToRevoke,
      );
    }
    return c.json(result, 200);
  })
  .openapi(commandRoute('set_connection_choice'), async (c) => {
    const cmd = c.req.valid('json');
    // The value has to be one the connection's connector offers, which only
    // this layer can say: the store is blind to connectors. Read from this
    // Workspace's own connections, so another Workspace's reads as missing
    // here as the command itself would refuse it (issue 942).
    const account = await openAccount(c.env, c.get('visitor').accountName);
    const held = (await account.sourceAccounts(cmd.workspaceId)).find((one) => one.id === cmd.sourceAccountId);
    if (!held) throw new NotFoundInAccountError(`source account ${cmd.sourceAccountId} not found`);
    const options = choiceOptionsOf(c.env, held.connectorId);
    if (!options?.some((option) => option.value === cmd.choice)) {
      throw new RefusedByAccountError('that is not a choice this connection offers');
    }
    return c.json(await account.applyChange('set_connection_choice', cmd), 200);
  })
  .openapi(commandRoute('set_connection_files_by_name'), async (c) => {
    const cmd = c.req.valid('json');
    // Only a connection whose connector reports names can file by them, which
    // only this layer can say, as for a choice (issue 1146).
    const account = await openAccount(c.env, c.get('visitor').accountName);
    const held = (await account.sourceAccounts(cmd.workspaceId)).find((one) => one.id === cmd.sourceAccountId);
    if (!held) throw new NotFoundInAccountError(`source account ${cmd.sourceAccountId} not found`);
    if (!getConnector(c.env, held.connectorId)?.manifest.names) {
      throw new RefusedByAccountError('this connection does not file by name');
    }
    return c.json(await account.applyChange('set_connection_files_by_name', cmd), 200);
  })
  .openapi(commandRoute('set_connection_due_in_days'), async (c) => {
    const cmd = c.req.valid('json');
    // Only a connection Cockpit pulls from can give its Items a due date, which
    // only this layer can say, as for names (issue 1409).
    const account = await openAccount(c.env, c.get('visitor').accountName);
    const held = (await account.sourceAccounts(cmd.workspaceId)).find((one) => one.id === cmd.sourceAccountId);
    if (!held) throw new NotFoundInAccountError(`source account ${cmd.sourceAccountId} not found`);
    if (getConnector(c.env, held.connectorId)?.manifest.pulled !== true) {
      throw new RefusedByAccountError('this connection does not give a due date');
    }
    return c.json(await account.applyChange('set_connection_due_in_days', cmd), 200);
  })
  .openapi(
    commandRoute('send_item_to_claude', { conflict: 'The item is done, dismissed, or Claude is already on it' }),
    async (c) => c.json(await change(c, 'send_item_to_claude', c.req.valid('json')), 200),
  )
  .openapi(rememberOfferRoute, async (c) => {
    // Counted before the model is reached, and every ask is counted: each is a
    // call that is paid for. Over the rate is no offer, as any other reason is.
    const account = await openAccount(c.env, c.get('visitor').accountName);
    if ((await account.sentenceCallArrived('offer', new Date().toISOString())) === 'too-many') return c.json({ offer: null }, 200);
    return c.json({ offer: await offerToRemember(c.env, c.get('visitor').accountName, c.req.valid('param').runId) }, 200);
  })
  .openapi(commandRoute('remember_sentence', { conflict: 'The sentence is refused: it points somewhere, the account keeps too many, or too many were remembered in a minute' }), async (c) => {
    const cmd = c.req.valid('json');
    // The kinds of source Cockpit names, and the two front doors it does not.
    if (![...Object.keys(sourceNames(c.env)), 'internal', 'mcp'].includes(cmd.sourceKind)) {
      throw new ConflictInAccountError('Cockpit does not know that kind of source, so it cannot remember a sentence for it.');
    }
    const account = await openAccount(c.env, c.get('visitor').accountName);
    if ((await account.sentenceCallArrived('remember', new Date().toISOString())) === 'too-many') {
      throw new ConflictInAccountError('Too many sentences were remembered in the last minute. Try again shortly.');
    }
    const result = await change(c, 'remember_sentence', cmd);
    // The open Items it may fit are proposed for again behind the work already
    // queued; a replay of the same Remember asks for nothing twice.
    if (result.applied) {
      c.executionCtx.waitUntil(
        enqueueProposalsForSentence(c.env, c.get('visitor').accountName, cmd.sourceKind, cmd.workspaceId === ACCOUNT_WIDE ? null : cmd.workspaceId),
      );
    }
    return c.json(result, 200);
  })
  .openapi(commandRoute('edit_remembered_sentence', { conflict: 'The sentence is refused: it points somewhere, or too many were changed in a minute' }), async (c) => {
    const cmd = c.req.valid('json');
    const accountName = c.get('visitor').accountName;
    const before = await sentenceBeforeItChanges(c.env, accountName, cmd.sentenceId);
    const result = await change(c, 'edit_remembered_sentence', cmd);
    // Proposed again with the sentence as it now reads, unless it reads as it did.
    if (result.applied && before && before.sentence !== onOneLine(cmd.sentence)) {
      c.executionCtx.waitUntil(enqueueProposalsForSentence(c.env, accountName, before.sourceKind, before.workspaceId));
    }
    return c.json(result, 200);
  })
  .openapi(commandRoute('delete_remembered_sentence', { conflict: 'Too many sentences were changed in a minute' }), async (c) => {
    const cmd = c.req.valid('json');
    const accountName = c.get('visitor').accountName;
    const before = await sentenceBeforeItChanges(c.env, accountName, cmd.sentenceId);
    const result = await change(c, 'delete_remembered_sentence', cmd);
    // The Items it shaped are proposed again without it; already gone asks for nothing.
    if (result.applied && before) {
      c.executionCtx.waitUntil(enqueueProposalsForSentence(c.env, accountName, before.sourceKind, before.workspaceId));
    }
    return c.json(result, 200);
  })
  .openapi(commandRoute('set_workspace_theme'), async (c) => c.json(await change(c, 'set_workspace_theme', c.req.valid('json')), 200))
  .openapi(commandRoute('delete_workspace'), async (c) => c.json(await change(c, 'delete_workspace', c.req.valid('json')), 200))
  .openapi(commandRoute('capture_item'), async (c) => {
    // **Where a capture says it came from is dropped from anything a client
    // posts** ("Save a Teams message to Cockpit", issue 486): only an ingress
    // route may say that, having proved the push genuine first, so a browser
    // cannot write somebody else's name and link onto an Item.
    const { capturedFrom: _saidByTheClient, ...captured } = c.req.valid('json');
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
      await countForGuest(c.env, c.get('sessionId'), 'itemsCaptured');
      const accountName = c.get('visitor').accountName;
      c.executionCtx.waitUntil(enqueueCleanUp(c.env, accountName, captured.itemId, 'captured-in-app'));
      // The two texts this capture just wrote are what a duplicate is looked
      // for against ("Flag a captured note that says what another one already
      // said", issue 407) - so a note is compared against the Inbox as soon as
      // it lands, whether or not this environment can also clean it up. Where
      // it can, the cleanup's own rewrite queues a second read of its own.
      c.executionCtx.waitUntil(enqueueReadingItsMeaning(c.env, accountName, captured.itemId, 'captured-in-app'));
      // And what to do with it, debounced so the cleanup's rewrite takes this ask's place (issue 1161).
      c.executionCtx.waitUntil(enqueueProposalForClaude(c.env, accountName, captured.itemId, 'captured-in-app'));
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
  .openapi(commandRoute('remove_item_from_panel'), async (c) => {
    const payload = c.req.valid('json');
    const result = await change(c, 'remove_item_from_panel', payload);
    // Off a Panel is a filing changed too, as in `changeThatMightSettleARouting` (issue 1161).
    if (result.applied) {
      c.executionCtx.waitUntil(enqueueProposalForClaude(c.env, c.get('visitor').accountName, payload.itemId, 'item-changed'));
    }
    return c.json(result, 200);
  })
  .openapi(commandRoute('set_done'), async (c) => c.json(await change(c, 'set_done', c.req.valid('json')), 200))
  .openapi(commandRoute('set_started'), async (c) => c.json(await change(c, 'set_started', c.req.valid('json')), 200))
  .openapi(commandRoute('wait_for_reply'), async (c) => c.json(await change(c, 'wait_for_reply', c.req.valid('json')), 200))
  .openapi(commandRoute('finish_agent_run'), async (c) =>
    c.json(await change(c, 'finish_agent_run', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_dismissed'), async (c) => c.json(await change(c, 'set_dismissed', c.req.valid('json')), 200))
  .openapi(commandRoute('associate'), async (c) => c.json(await change(c, 'associate', c.req.valid('json')), 200))
  .openapi(commandRoute('set_next_action'), async (c) => c.json(await change(c, 'set_next_action', c.req.valid('json')), 200))
  .openapi(commandRoute('set_priority'), async (c) => c.json(await change(c, 'set_priority', c.req.valid('json')), 200))
  .openapi(commandRoute('set_due_date'), async (c) => c.json(await change(c, 'set_due_date', c.req.valid('json')), 200))
  .openapi(commandRoute('set_repeat'), async (c) => c.json(await change(c, 'set_repeat', c.req.valid('json')), 200))
  .openapi(commandRoute('create_recurring_item'), async (c) =>
    c.json(await change(c, 'create_recurring_item', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('write_recurring_item'), async (c) =>
    c.json(await change(c, 'write_recurring_item', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('delete_recurring_item'), async (c) =>
    c.json(await change(c, 'delete_recurring_item', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_title'), async (c) =>
    c.json(await changeThatRewritesTheTexts(c, 'set_title', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_description'), async (c) =>
    c.json(await changeThatRewritesTheTexts(c, 'set_description', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('remove_attachment'), async (c) =>
    c.json(await change(c, 'remove_attachment', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_duplicate_settled'), async (c) =>
    c.json(await change(c, 'set_duplicate_settled', c.req.valid('json')), 200),
  )
  .openapi(commandRoute('set_item_form_presentation'), async (c) =>
    c.json(await change(c, 'set_item_form_presentation', c.req.valid('json')), 200),
  )
  // --- dictation ("Dictate in Write with Whisper", issue 1041): outside the
  // OpenAPI/JSON contract for the reason attachments are - the body is the
  // recording's own bytes. Behind the sign-in gate like everything not named
  // there, and answered in the request: the person is waiting on the words.
  .post(TRANSCRIPTION_PATH, async (c) => {
    // Refused from the headers alone, before a byte of the body is read or the
    // model is reached.
    if (!/^audio\//i.test(c.req.header('content-type') ?? '')) {
      return c.json({ error: 'that is not a recording' }, 415);
    }
    const transcriber = transcriberFor(c.env);
    if (!transcriber) return c.json({ error: 'this environment cannot transcribe' }, 503);
    // Counted before the body is read, and every request is counted, refused
    // ones included: the guest account on production is shared by every visitor.
    const account = await openAccount(c.env, c.get('visitor').accountName);
    if ((await account.transcriptionArrived(new Date().toISOString())) === 'too-many') {
      return c.json({ error: 'too many transcriptions in the last minute' }, 429);
    }
    const audio = await bytesWithin(c.req.raw, MAX_RECORDING_BYTES);
    if (audio === null) return c.json({ error: 'that recording is longer than Cockpit transcribes' }, 413);
    if (audio.byteLength === 0) return c.json({ error: 'nothing was recorded' }, 400);
    // Held in memory for this call and passed on; never written anywhere.
    const text = await transcriber.transcribe(audio, c.get('visitor').accountName);
    return c.json({ text }, 200);
  })
  // --- attachments ("Attach a file to an item", issue 441): outside the
  // OpenAPI/JSON contract, the same as the ingress and operator routes below
  // - a file's bytes cannot ride in a `commandRoute`'s JSON body, and a
  // download answers with the bytes themselves rather than JSON.
  .post('/v1/items/:itemId/attachments', async (c) => {
    const itemId = c.req.param('itemId');

    // Both refused from headers alone, before anything reads the body - the
    // upload's own two refusal test cases (issue 441): "refused before the
    // upload route reads a byte of the body", "nothing written" either way.
    const contentType = attachmentContentTypeSchema.safeParse(c.req.header('content-type'));
    if (!contentType.success) {
      return c.json({ error: 'that kind of file is not one Cockpit accepts' }, 400);
    }
    const declaredSize = Number(c.req.header('content-length'));
    if (!Number.isInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_ATTACHMENT_SIZE) {
      return c.json({ error: `an attachment may be at most ${MAX_ATTACHMENT_SIZE} bytes` }, 413);
    }

    // `decodeURIComponent` throws on a malformed escape rather than
    // answering false, so a bad header is caught here - the ordinary refusal
    // path below, not the app-wide 500 an uncaught `URIError` would fall
    // into.
    const filenameHeader = c.req.header('x-filename');
    let filename: string | undefined;
    try {
      filename = filenameHeader === undefined ? undefined : decodeURIComponent(filenameHeader);
    } catch {
      return c.json({ error: 'the filename was not a validly encoded header value' }, 400);
    }

    const parsedCommand = addAttachmentSchema.safeParse({
      commandId: c.req.header('x-command-id'),
      issuedAt: c.req.header('x-issued-at'),
      workspaceId: c.req.header('x-workspace-id'),
      attachmentId: c.req.header('x-attachment-id'),
      itemId,
      filename,
      size: declaredSize,
      contentType: contentType.data,
    });
    if (!parsedCommand.success) {
      return c.json({ error: 'validation failed', issues: parsedCommand.error.issues }, 400);
    }

    const accountName = c.get('visitor').accountName;
    const account = await openAccount(c.env, accountName);
    // Checked before R2 is touched, the same as the two refusals above -
    // narrower than a transaction can make it (`command-service.ts`'s own
    // comment on `add_attachment`), but it is what keeps the ordinary case
    // (an item deleted from another tab) from ever reaching R2 at all.
    const item = await account.item(itemId);
    if (!item || item.deletedAt) return c.json({ error: `item ${itemId} not found` }, 404);

    // Checked before R2 is ever touched, not only before it: an id reusing
    // an existing attachment's must never let a second upload's bytes reach
    // the object the existing row already names, whether that reuse turns
    // out to be a genuine replay or a refusal - `add_attachment`'s own
    // handler (`command-service.ts`) is where that distinction is made, and
    // it is only safe to make *after* nothing has been overwritten to reach
    // it. A fresh id skips straight to the upload below. Whether it exists
    // is asked of the account's own row, not of R2 directly: an orphaned R2
    // object with no row naming it (the accepted cost of a race the route's
    // own item pre-check narrows but cannot close) must not be mistaken for
    // one, or a fresh upload reusing that key would record a new row
    // pointing at bytes nobody just uploaded.
    if (await account.attachmentExists(parsedCommand.data.attachmentId)) {
      // Checked against R2's own measured size, not the stored row's - a
      // reused id naming a genuinely different upload has to be caught
      // *here*, from what this new request itself declares, or forcing
      // `cmd.size` to whatever is already stored would make `command-
      // service.ts`'s own size comparison compare that stored value with
      // itself: always equal, never catching anything. A size R2 confirms
      // agrees with what was just declared is the one case safe to accept
      // as a replay; `command-service.ts` still checks filename/contentType
      // on top of this, for the same reason. A declared size can disagree
      // for two reasons this route cannot tell apart - a genuinely
      // different file, or the very first upload landing short of what it
      // declared - and since this branch never reads a body to settle it
      // either way, both are refused alike; a short original's id stays
      // refused for good, and a real retry needs a fresh one.
      const existingObject = await c.env.ATTACHMENTS.head(
        attachmentR2Key(accountName, itemId, parsedCommand.data.attachmentId),
      );
      if (existingObject && existingObject.size !== parsedCommand.data.size) {
        return c.json(
          { error: `attachment ${parsedCommand.data.attachmentId} already names a different upload` },
          409,
        );
      }
      const cmd = { ...parsedCommand.data, size: existingObject?.size ?? parsedCommand.data.size };
      return c.json(await account.applyChange('add_attachment', cmd), 201);
    }

    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'nothing was uploaded' }, 400);
    // Streamed straight into R2, never buffered here (issue 441) - `body` is
    // the request's own `ReadableStream`, piped through rather than read.
    //
    // The `any` is not a style choice: `apps/web` also compiles this file (to
    // infer `AppType` for the typed client), and its own tsconfig carries the
    // DOM lib alongside `@cloudflare/workers-types` - two ambient
    // declarations of `ReadableStream` that Cloudflare's own types docs say
    // not to mix, and do not merge cleanly where they are. `body` is a real
    // `ReadableStream` either way; only its *type* disagrees with itself
    // depending on which of the two compiles this file.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const object = await c.env.ATTACHMENTS.put(
      attachmentR2Key(accountName, itemId, parsedCommand.data.attachmentId),
      body as any,
      { httpMetadata: { contentType: parsedCommand.data.contentType } },
    );
    // R2's own account of what it actually stored, not the `Content-Length`
    // the client claimed - a dropped connection or a truncating proxy must
    // not leave this row disagreeing with the object it names.
    const cmd = { ...parsedCommand.data, size: object.size };

    return c.json(await account.applyChange('add_attachment', cmd), 201);
  })
  .get('/v1/attachments/:attachmentId', async (c) => {
    const attachmentId = c.req.param('attachmentId');
    const account = await openAccount(c.env, c.get('visitor').accountName);
    // Authenticated and workspace-scoped by construction, not by a check
    // named here: `openAccount` resolves the signed-in visitor's own account,
    // and a different account's Durable Object is a different SQLite
    // database entirely, so there is no id this request could name that
    // reaches somebody else's attachment.
    const attachment = await account.attachmentForDownload(attachmentId);
    const served = attachment && (await serveAttachment(c.env, attachment));
    return served || c.json({ error: `attachment ${attachmentId} not found` }, 404);
  })
  /**
   * One attachment, for an agent's session that cannot sign in ("Send an
   * item's attachments along when an agent starts", issue 573). **Outside
   * the sign-in gate**: the sealed token is the whole authentication, naming
   * the account and the attachment and when it stops working
   * (`auth/attachment-link.ts`). Every refusal is the same 404, so a link
   * says nothing about why it no longer opens.
   */
  .get(`${ATTACHMENT_LINK_PREFIX}:token`, async (c) => {
    const refused = () => c.json({ error: 'this link does not open anything' }, 404);
    const key = await attachmentLinkKey(c.env.CONNECTOR_CREDENTIAL_KEY);
    const named = key ? await openAttachmentLink(key, c.req.param('token'), new Date()) : null;
    if (!named) return refused();
    let attachment: AttachmentForDownload | null;
    try {
      attachment = await (await openAccount(c.env, named.accountName)).attachmentForDownload(named.attachmentId);
    } catch (error) {
      // An account removed since the link was made.
      if (error instanceof AccountNotInRegisterError) return refused();
      throw error;
    }
    const served = attachment && (await serveAttachment(c.env, attachment));
    if (!served) return refused();
    // The address is the credential: kept out of any cache that would
    // outlive its hour, and out of the Referer of anything the file links to.
    served.headers.set('Cache-Control', 'no-store');
    served.headers.set('Referrer-Policy', 'no-referrer');
    return served;
  })
  // --- connecting a source account: two navigations, like signing in ---------
  /**
   * Sends the browser to a source to be asked whose account this is, for any
   * registered connector whose manifest describes an OAuth sign-in, keeping
   * what it has to come back with and which Workspace asked ("Connect and
   * disconnect a source through one generic sign-in flow", issue 892; Teams
   * was the first, "Connect a Microsoft Teams source account", issue 485).
   *
   * **An id nothing is registered under, or one whose sign-in is `none`, is
   * not found** rather than refused: there is no connector here to have
   * refused anything.
   *
   * **Behind the gate**, and that is the whole shape of it: connecting is
   * something a signed-in person does to one of their own Workspaces, so the
   * session is what says whose account the connection lands in and the
   * browser never names it. A navigation rather than a request the page
   * makes, for the reason signing in is one: it ends somewhere else entirely.
   */
  .get('/v1/workspaces/:workspaceId/connections/:connectorId/connect', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const sign = signInOf(c.env, c.req.param('connectorId'));
    if (!sign) return c.notFound();
    // The choice the connector asks, answered before anybody leaves: a value
    // among its options, or the Connect is refused and nothing is started
    // (issue 942). A source that asks nothing carries nothing.
    const asked = sign.connector.manifest.choice;
    const choice = c.req.query('choice');
    if (asked && !asked.options.some((option) => option.value === choice)) {
      return refuseConnection(c, workspaceId, 'the choice is not one the source offers');
    }
    // Whether it files by the names the source gives mail, answered the same
    // way for a connector that reports names: a yes or a no, or the Connect is
    // refused and nothing is started (issue 1147). Not asked at all - a tab
    // opened before Connect asked it - carries no answer, so a new connection
    // starts off and a reconnect keeps what it holds. A source that reports
    // none carries nothing.
    const filesByNameAsked = c.req.query('filesByName');
    const filesByName = filesByNameAnswered(filesByNameAsked);
    if (sign.connector.manifest.names && filesByNameAsked !== undefined && filesByName === undefined) {
      return refuseConnection(c, workspaceId, 'whether to file by name was not answered');
    }
    // How many days after it arrives each Item is due, answered the same way
    // for a connector that is pulled: a number in range or none, or the Connect
    // is refused and nothing is started (issue 1409).
    const pulled = sign.connector.manifest.pulled === true;
    const dueInDays = dueInDaysAnswered(c.req.query('dueInDays'));
    if (pulled && dueInDays === 'not an answer') {
      return refuseConnection(c, workspaceId, 'how many days to give a due date was not answered');
    }
    try {
      // Theirs, and still there - asked before anybody is sent away, so a
      // Workspace deleted in another tab refuses here rather than after a
      // round trip through the source.
      const account = await openAccount(c.env, c.get('visitor').accountName);
      if (!(await account.workspaces()).some((workspace) => workspace.id === workspaceId)) {
        return refuseConnection(c, workspaceId, 'no such workspace');
      }
      const client = clientOf(c.env, sign.auth);
      if (!client || !(await sealingKey(c.env.CONNECTOR_CREDENTIAL_KEY))) {
        return refuseConnection(c, workspaceId, 'this environment cannot connect a source account');
      }

      // The account goes in the attempt as well as the Workspace, because the
      // Workspace alone does not name one (`ConnectAttempt`, auth/gate.ts).
      const attempt = {
        ...newAttempt(),
        workspaceId,
        accountName: c.get('visitor').accountName,
        connectorId: sign.connector.manifest.id,
        ...(asked && choice ? { choice } : {}),
        ...(sign.connector.manifest.names && filesByName !== undefined ? { filesByName } : {}),
        ...(pulled && dueInDays !== undefined && dueInDays !== 'not an answer' ? { dueInDays } : {}),
      };
      rememberConnectAttempt(c, attempt);
      // `client.clientId`, never the setting again: the two have to be
      // character-for-character the same value the callback exchanges with,
      // and a secret stored with a stray newline is otherwise two ids.
      return c.redirect(await authorizationRequest(c.env, sign, client, attempt), 302);
    } catch (error) {
      return refuseConnection(c, workspaceId, 'the issuer could not be reached', error);
    }
  })
  /**
   * Where the source sends the browser back.
   *
   * Everything arriving here came through the person connecting, so nothing is
   * believed until it has been checked against the attempt this application
   * started (src/auth/oidc.ts) - and the attempt is spent before any of it is
   * acted on, so a reply delivered twice (the back button, a bookmarked
   * address) gets nowhere the second time and cannot write a second row.
   *
   * **Nothing is stored until the source has said who this is and the
   * credential has been sealed**, and the storing itself is one command
   * ("Connect a Microsoft Teams source account", issue 485). So the two ends
   * are the only ends there are: a row that is there and visible, or nothing
   * at all and a refusal in the window.
   */
  .get('/v1/connections/:connectorId/callback', async (c) => {
    const sign = signInOf(c.env, c.req.param('connectorId'));
    if (!sign) return c.notFound();
    const connectorId = sign.connector.manifest.id;
    const held = connectAttemptHeld(c);
    forgetConnectAttempt(c);
    // An attempt started for another source did not begin here.
    const attempt = held?.connectorId === connectorId ? held : null;
    const reply = c.req.query();

    const wrong = replyBelongsTo(attempt, reply);
    // Including the source's own refusal - somebody who declined the consent
    // screen is told so in the window they started from, unlike a cancelled
    // sign-in, which simply leaves you where you already were.
    if (wrong) return refuseConnection(c, attempt?.workspaceId, wrong);

    // **The account that started it has to be the account that comes back.**
    // The session is what decides whose store the row lands in, and every
    // account is handed a workspace under the same id (`0015-first-workspace`),
    // so without this a sign-out and a different sign-in while somebody was
    // away at the source would seal their credential into whoever is signed in
    // now. Sent nowhere in particular, because the Workspace the attempt names
    // is not this visitor's to be shown.
    if (attempt!.accountName !== c.get('visitor').accountName) {
      return refuseConnection(c, undefined, 'the connection was started by another account');
    }

    // The choice the attempt carries is the one the person made at the start;
    // one that is not among the connector's options is refused and nothing is
    // stored (issue 942).
    const asked = sign.connector.manifest.choice;
    if (asked && !asked.options.some((option) => option.value === attempt!.choice)) {
      return refuseConnection(c, attempt!.workspaceId, 'the choice is not one the source offers');
    }
    // Whether it files by name rides along as asked: an attempt carrying
    // anything but a yes or no is not read at all, and one carrying none - a
    // tab opened before Connect asked it - leaves a new connection off and a
    // reconnected one as it was (issue 1147).
    const reportsNames = sign.connector.manifest.names !== undefined;
    // And so does the days, for a connector that is pulled (issue 1409).
    const givesADueDate = sign.connector.manifest.pulled === true;

    try {
      const client = clientOf(c.env, sign.auth);
      const key = await sealingKey(c.env.CONNECTOR_CREDENTIAL_KEY);
      if (!client || !key) {
        return refuseConnection(c, attempt!.workspaceId, 'this environment cannot connect a source account');
      }

      const signedIn = await accountSignedIn(c.env, sign, client, reply.code!, attempt!, new Date());
      if (!signedIn.signedIn) {
        return refuseConnection(
          c,
          attempt!.workspaceId,
          signedIn.refusal,
          undefined,
          signedIn.because === undefined ? undefined : { connectorId, code: signedIn.because },
        );
      }
      const { account, asIssued } = signedIn;

      // Sealed here, so the credential exists in the clear only inside this
      // request and never in a command payload a log would keep (`forTheLog`,
      // accounts/command-service.ts).
      const sealed = await seal(asIssued, key);
      const connectedAt = new Date().toISOString();
      await change(c, 'connect_source_account', {
        commandId: uuidv7(),
        issuedAt: connectedAt,
        workspaceId: attempt!.workspaceId,
        sourceAccountId: uuidv7(),
        connectorId,
        externalAccountKey: account.key,
        displayName: account.displayName,
        ...sealed,
        ...(asked ? { choice: attempt!.choice! } : {}),
        ...(reportsNames && attempt!.filesByName !== undefined ? { filesByName: attempt!.filesByName } : {}),
        ...(givesADueDate && attempt!.dueInDays !== undefined ? { dueInDays: attempt!.dueInDays } : {}),
      });
      // The register's index, after the connection is stored and never failing
      // it (`rememberConnectionAfterStoring`, connectors/directory.ts): what
      // lets a push find this Workspace later ("Save a Teams message to
      // Cockpit", issue 486). Only a source that pushes has anything to be
      // found by, and a source that revokes is where a disconnect finds out
      // whether another Workspace holds the same account.
      if (sign.connector.manifest.supportsPush || sign.connector.revoke) {
        const where = { accountName: c.get('visitor').accountName, workspaceId: attempt!.workspaceId };
        await rememberConnectionAfterStoring(c.env, where, connectorId, account.key, connectedAt);
      }
      return backToConnections(c, attempt!.workspaceId, 'connected');
    } catch (error) {
      return refuseConnection(c, attempt!.workspaceId, 'the connection could not be finished', error);
    }
  })
  // --- signing in: two navigations, not two requests -------------------------
  /**
   * Sends the browser to Google to be asked who it is, keeping what it has to
   * come back with.
   *
   * **`return` is where to go afterwards, and only ever a path here**
   * (`auth/return-path.ts`): the consent page an app opened sends somebody who
   * is not signed in through this and expects them back ("Connect Claude to
   * Cockpit, and capture an item from it", issue 599). Anything that is not a
   * plain path on this application is dropped rather than refused, so the
   * sign-in still happens and lands on `/` as it always did.
   */
  .get('/v1/sign-in/google', async (c) => {
    try {
      const endpoints = await endpointsFor(issuerFor(c.env));
      const attempt = newAttempt();
      const returnTo = returnPathFrom(c.req.query('return'));
      rememberAttempt(c, returnTo ? { ...attempt, returnTo } : attempt);
      const url = await authorizationUrl(
        endpoints,
        c.env.GOOGLE_CLIENT_ID,
        callbackUrl(c),
        attempt,
      );
      return c.redirect(url, 302);
    } catch (error) {
      return refuseSignIn(c,'the issuer could not be reached', error);
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
    if (wrong) return refuseSignIn(c,wrong);

    try {
      const endpoints = await endpointsFor(issuerFor(c.env));
      // Only the identity is kept here; the rest of what the issuer answered
      // is a credential for a source account rather than for a sign-in
      // (`ExchangedTokens`, auth/issuer.ts).
      const exchanged = await exchangeCode(
        endpoints,
        { clientId: c.env.GOOGLE_CLIENT_ID, clientSecret: c.env.GOOGLE_CLIENT_SECRET },
        {
          code: reply.code!,
          codeVerifier: attempt!.codeVerifier,
          redirectUri: callbackUrl(c),
        },
      );
      if (!exchanged) return refuseSignIn(c,'the exchange was refused');

      const verdict = await identityFrom(
        exchanged.idToken,
        keysOf(endpoints),
        {
          issuer: endpoints.issuer,
          clientId: c.env.GOOGLE_CLIENT_ID,
          nonce: attempt!.nonce,
        },
        new Date(),
      );
      if (!verdict.identified) return refuseSignIn(c,verdict.refusal);

      const signedIn = await signInWithGoogle(
        c.env,
        verdict.identity,
        new Date(),
        { country: countryOf(c.req.raw), referrerHost: null },
      );
      // These are the two refusals the person can act on, so they are the two
      // the logon page is told about - and they are told apart, because a
      // colleague whose access was removed must not be sent looking for a
      // sign-in problem that is not theirs.
      if (!signedIn.signedIn) {
        const refused = signedIn.because === 'access removed' ? 'access-removed' : 'unknown-account';
        return c.redirect(`/signin?refused=${refused}`, 302);
      }

      // Somebody the register had never seen, whose account this sign-in just
      // made: opened before they land in it, for the reason adding somebody
      // opens theirs. They are signed in whether or not it opens - their first
      // request makes it if this could not.
      if (signedIn.newAccount) {
        await accountOpened(
          c.env,
          signedIn.newAccount,
          `${signedIn.user.id} signed in for the first time`,
        );
      }

      rememberSessionCookie(c, signedIn.sessionId);
      return c.redirect(attempt!.returnTo ?? '/', 302);
    } catch (error) {
      return refuseSignIn(c,'the sign-in could not be finished', error);
    }
  })
  /**
   * The way in that asks nobody anything: one press, into the one guest account
   * everybody shares ("Sign in as a guest, without a password", issue 354).
   *
   * A navigation like the two above rather than a request, for the same reason:
   * it ends somewhere else, and the browser already knows how to follow a link.
   * That is also its exposure - a plain `GET` a cross-site page can send
   * somebody to without their doing anything - so a browser already holding a
   * live sign-in is sent straight to `/` untouched rather than having its
   * cookie replaced: the one thing this must never do is quietly move a real
   * person into the account every stranger reads. **Asked first, before
   * anything about the environment**, so a signed-in visitor on a deployment
   * that does not offer guest sign-in is sent home the same way rather than
   * refused and left wondering whether they are still signed in at all.
   *
   * **Offered only where the environment says so**, which is production
   * (wrangler.jsonc). The control is in one built SPA that both deployments
   * serve, so this is the only place the two can be told apart - and an
   * environment that does not offer it answers a direct request exactly as it
   * answers the control being pressed.
   *
   * Refused in the same words as everything else that will not be completed:
   * there is nothing a visitor can do about a way in this deployment does not
   * have, so the reason goes to the log and the page says the sign-in failed.
   * That covers a failure reading the existing cookie too, which is why the
   * check above is inside the same `try` rather than ahead of it.
   */
  .get('/v1/sign-in/guest', async (c) => {
    try {
      const held = heldSessionId(c);
      if (held && (await stillSignedIn(c.env, held))) return c.redirect('/', 302);

      if (c.env.GUEST_SIGN_IN !== 'true') return refuseSignIn(c,'this environment offers no guest sign-in');

      const signedIn = await signInAsGuest(c.env, new Date(), {
        country: countryOf(c.req.raw),
        referrerHost: referrerHostOf(c.req.query('referrer'), new URL(c.req.url).hostname),
      });
      if (!signedIn.signedIn) return refuseSignIn(c,'the guest account is not available');
      rememberSessionCookie(c, signedIn.sessionId);
      // Only here, past the already-signed-in return above: a fresh guest sign-in
      // is what a mail and a Teams message arrive for (issue 775).
      await enqueueGuestArrivals(c.env);
      return c.redirect('/', 302);
    } catch (error) {
      return refuseSignIn(c,'the guest sign-in could not be finished', error);
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
  /**
   * Where a source pushes ("Save a Teams message to Cockpit", issue 486).
   *
   * **Outside the sign-in gate, and that is what makes the connector's own
   * verification the only door.** Nobody is signed in: a saved message arrives
   * from Microsoft rather than from a browser, so what stands here instead is
   * the connector proving the call genuine and the host matching what it names
   * to a stored connection (`connectors/push-host.ts`).
   *
   * The request goes through verbatim, headers and body alike - a signature is
   * over what was sent, so anything read or rewritten on the way would be a
   * second copy to keep in step.
   */
  .post('/ingress/:connectorId/*', async (c) => {
    const connector = getConnector(c.env, c.req.param('connectorId'));
    if (!connector?.handleWebhook) {
      return c.json({ error: 'unknown connector' }, 404);
    }
    return handlePush(connector, c.req.raw, {
      env: c.env,
      filed: (accountName, itemId, filedBy) => {
        c.executionCtx.waitUntil(enqueueCleanUp(c.env, accountName, itemId, `connector:${filedBy}`));
        c.executionCtx.waitUntil(enqueueReadingItsMeaning(c.env, accountName, itemId, `connector:${filedBy}`));
        c.executionCtx.waitUntil(enqueueProposalForClaude(c.env, accountName, itemId, `connector:${filedBy}`));
      },
    });
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
  // The usage records ("Export a period's usage records as CSV with pnpm
  // usage:export", issue 918): read-only, behind the same secret, a page at a
  // time because a year of records is more than one answer should carry.
  .get('/v1/operator/usage/records', async (c) => {
    const since = c.req.query('since') ?? '';
    const after = Number(c.req.query('after') ?? 0);
    // A caller typed these, so a bad one is theirs to fix and says which.
    if (Number.isNaN(Date.parse(since)) || !/^\d{4}-\d{2}-\d{2}T/.test(since)) {
      return c.json({ error: 'since has to be a UTC time, like 2026-10-01T00:00:00Z' }, 400);
    }
    if (!Number.isSafeInteger(after) || after < 0) {
      return c.json({ error: 'after has to be a record number, or left out' }, 400);
    }
    return c.json(await readUsageRecords(c.env, new Date(since).toISOString(), after), 200);
  })
  // Where staging and a laptop send the records of their Claude calls ("Record
  // staging's and local Claude calls in production, under a token per
  // environment", issue 1458). Outside the sign-in gate and not behind the
  // operator's secret: each sending environment's own recording token is what
  // admits it, checked in `gateway/receive.ts`, and opens this and nothing else.
  .post(USAGE_RECORDS_PATH, async (c) => {
    const received = await receiveRecord(c.env, c.req.header('authorization'), () => c.req.json());
    return received.status === 201 ? c.body(null, 201) : c.json({ error: received.error }, received.status);
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
  })
  // Putting the shared guest account back to its demonstration by hand - the
  // same reset the nightly run does (jobs/index.ts), for a demo due before it
  // comes round. It names no account because there is only one it can mean.
  .post('/v1/operator/guest/reset', async (c) => {
    try {
      if ((await resetGuestAccount(c.env)) === 'no guest account') {
        return c.json({ error: 'this environment has no guest account to reset' }, 404);
      }
      return c.json({ reset: GUEST_ACCOUNT_NAME }, 200);
    } catch (error) {
      // The guest's id held by somebody real, or a store holding another
      // account's rows: `onError`'s 409 says which.
      if (error instanceof ConflictInAccountError) throw error;
      // Anything else is ours rather than the caller's - nothing was sent that
      // could cause it - so it is logged. The sentence still goes back, because
      // the operator is the one person who can act on it, and because the one
      // thing they need to know is that the account was left as it was.
      const why = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: 'error', message: `the guest account was not reset: ${why}` }));
      return c.json({ error: `the guest account was not reset, and holds what it held: ${why}` }, 500);
    }
  })
  // Reading the notes that were already in the Inbox when duplicate flagging
  // shipped ("Give every item already there a vector", issue 409). Two routes,
  // the same shape as the backup pair above and for a second reason: one batch
  // per call is what bounds the work a single request does, so the command can
  // say how far it got and carry on from there.
  //
  // **The guest account is left off this list.** It is dropped and reseeded
  // every night (`resetGuestAccount`), so nothing a run reads there survives
  // to the next one - every unnamed run would read it again for good, against
  // the very pacing this command exists to respect. Naming it with `--user`
  // still reaches it; nothing about the route refuses that.
  .get('/v1/operator/duplicates/accounts', async (c) => {
    const accounts = await registeredAccountNames(c.env);
    return c.json({ accounts: accounts.filter((name) => name !== GUEST_ACCOUNT_NAME) }, 200);
  })
  .post('/v1/operator/duplicates/accounts/:name', async (c) => {
    const accountName = c.req.param('name');
    const limit = batchSize(c.req.query('batch'));
    if (limit === 'not a batch size') {
      return c.json({ error: `a batch is a whole number of items, 1 to ${LARGEST_BATCH}` }, 400);
    }
    // Empty and absent are the same thing - the start of the walk - because a
    // command that builds a query string from a cursor it has not got yet sends
    // the one rather than omitting the other.
    const after = c.req.query('after') || null;
    try {
      return c.json({ account: accountName, ...(await readWhatTheseNotesMean(c.env, accountName, { after, limit })) }, 200);
    } catch (error) {
      // The caller typed the name, so saying which one was wrong is the useful
      // answer - the same reason the backup route above answers 404 rather than
      // letting `onError` call it a 500.
      if (error instanceof AccountNotInRegisterError) {
        return c.json({ error: `no account ${accountName}` }, 404);
      }
      // Nothing was written. The request is well formed and it is the
      // environment that cannot answer it, which is the operator's to fix - by
      // pointing this at one with the AI binding, or by giving this one it.
      if (error instanceof CannotReadMeaningError) {
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
