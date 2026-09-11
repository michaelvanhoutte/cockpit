import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import type { Attempt } from './oidc.js';
import { MOVED_OPERATOR_PREFIXES, isOperatorPath } from './operator.js';
import { extendSession, sessionHeld, type Visitor } from './register.js';
import { recogniseSession, SIGN_IN_LIFETIME_MS } from './session.js';

/**
 * The gate: nothing but the logon page's own two reads works until you have
 * signed in.
 *
 * **It refuses in the application's own format and never with a web page.**
 * That is the point of building this rather than leaning on a perimeter in
 * front of the deployment: a gate that answers a background revalidation or a
 * live-updates stream with HTML produces a failure which does not read like a
 * sign-in problem at all. A `401` with `{ "error": ... }` is something the
 * client can act on.
 */

/** What the gate leaves on the request for the routes behind it. */
export interface GateVariables {
  visitor: Visitor;
  /** So signing out can end the exact sign-in this request arrived with. */
  sessionId: string;
}

export type GatedEnv = { Bindings: Env; Variables: GateVariables };

/** The cookie is a name for a row in the register and carries nothing else. */
export const SESSION_COOKIE = 'cockpit_session';

/**
 * That name, with the address's port on it wherever there is one.
 *
 * **Cookies are not scoped by port**, and every `pnpm dev` worktree plus the
 * browser suite's own stack is `localhost` to a browser (scripts/lib/ports.mjs
 * moves the ports so several can run at once, which only isolates localStorage
 * and IndexedDB). One name would therefore be one slot shared between them all,
 * and since each stack has a register of its own, every other stack refuses the
 * sign-in it finds there *and* deletes it on the way out - signing you out of
 * the one it belonged to, whichever of them you were using.
 *
 * A deployed address has no port in it, and `URL` drops an explicitly written
 * `:443` or `:80` as well, so a deployment keeps the bare name and no release
 * changes what anybody is already holding.
 */
export function sessionCookieName(url: string): string {
  return perStack(SESSION_COOKIE, url);
}

/**
 * The same name, per stack, for every cookie this application sets - which is
 * both of them: the sign-in and the sign-in being attempted. Written once,
 * because two copies of this rule is two chances for one cookie to be shared
 * between stacks while the other is not.
 */
function perStack(name: string, url: string): string {
  const { port } = new URL(url);
  return port ? `${name}_${port}` : name;
}

/**
 * Addresses this application used to have and no longer does.
 *
 * **They answer, rather than being refused**, and that is the whole point:
 * a browser holding an older build goes on asking for them, and a refusal is
 * indistinguishable to it from "you are not signed in" - which lands it on a
 * failure panel offering *Try again* for a read that can never work again
 * ("Update instead of failing when a build asks for an address that has been
 * retired", issue 217). What they answer is `410`, which that build reads as
 * "you are behind" and acts on by fetching the new version
 * (apps/web/src/updating.ts).
 *
 * **Outside the gate for the same reason**: the browser this exists for is
 * sitting on the logon page holding no sign-in at all, so an answer behind the
 * gate would never reach it. Nothing is disclosed by saying an address used to
 * exist - it is in the git history of a public repository either way.
 *
 * Both of these went with the list of names ("Sign in with Google, and retire
 * the list of names", issue 196). A retired address is kept here until no
 * browser can plausibly still be holding a build that asks for it.
 */
export const RETIRED_PATHS: readonly string[] = ['/v1/users', '/v1/sign-in'];

/**
 * The only paths that answer without a sign-in, and each is here for a stated
 * reason rather than by omission:
 *
 * - `/health` is deliberately outside every gate, including this one
 *   (docs/deployment.md, "`/health` answers without a sign-in"): the client asks
 *   it precisely when its requests are getting nowhere, to tell a dead
 *   connection from a deployment that is answering, and the uptime monitor and
 *   the post-deploy assertion both read it.
 * - `/v1/sign-in/google` is how you stop being nobody: it sends you to Google
 *   to be asked who you are, and it is the only thing a person who is nobody
 *   yet can usefully reach.
 * - `/v1/sign-in/google/callback` is where Google sends you back, carrying
 *   nothing this application will believe until it has checked it
 *   (src/auth/oidc.ts).
 * - `/v1/sign-in/guest` is the other way to stop being nobody, where the
 *   environment offers one ("Sign in as a guest, without a password", issue
 *   354). Whether it does is the route's own question and not this gate's: a
 *   request that never gets past here could not be refused for the right
 *   reason.
 *
 * **The list of people to choose from is gone from here**, along with the
 * endpoint behind it: once it is no longer the way in, publishing who has an
 * account is a leak rather than a necessity ("Sign in with Google, and retire
 * the list of names", issue 196).
 *
 * Exact matches, not prefixes, so a path that merely starts with one of these
 * is not a hole nobody chose.
 */
export const PATHS_OUTSIDE_THE_GATE: readonly string[] = [
  '/health',
  '/v1/sign-in/google',
  '/v1/sign-in/google/callback',
  '/v1/sign-in/guest',
  ...RETIRED_PATHS,
];

/**
 * The first of the prefixes outside the gate, and the only one this file owns:
 * **webhook ingress is called by Slack, Gmail and the rest**, which can never
 * hold a session cookie, so a sign-in is the wrong question to ask of it. What
 * authenticates a delivery is the connector's own signature verification
 * (architecture, "Connectors"), which lives behind this route and not in front
 * of it.
 *
 * It has to be a prefix because the path carries the connector's id and
 * whatever the source appends after it. **Every prefix here is one somebody
 * argued for by name**, and there are three: this, the operator's own, and the
 * addresses the operator's routes have moved off. The gate stands in front of
 * everything it has not been told about, so a route added later is refused
 * until somebody decides otherwise rather than open until somebody notices.
 */
const INGRESS_PREFIX = '/ingress/';

/**
 * The other two, and the same shape of reason: **the operator's commands hold
 * no session cookie**, so a sign-in is the wrong question to ask of them or of
 * the addresses they have moved off. What authenticates one is the secret
 * checked in `auth/operator.ts`, which stands in front of this gate rather than
 * behind it; what the moved addresses answer is a `410` saying where the routes
 * went, and why that is not the sign-in gate's refusal is argued there.
 *
 * Outside *this* gate is not outside every gate, and that distinction is the
 * whole safety of the line above: `/health` is genuinely open, while the
 * operator's routes are shut to everyone without the secret. Removing the
 * operator's gate would therefore not reopen the sign-in gate, it would open
 * those routes to everybody - so the two belong together and neither is a
 * spare.
 *
 * Both imported rather than written again here: two copies of a prefix is a
 * hole that can outlive the gate it was cut for, and one of the two edits is
 * the easy one to forget.
 */
export function isOutsideTheGate(path: string): boolean {
  return (
    PATHS_OUTSIDE_THE_GATE.includes(path) ||
    path.startsWith(INGRESS_PREFIX) ||
    isOperatorPath(path) ||
    MOVED_OPERATOR_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/**
 * The session cookie this request arrived holding, or `undefined` for one
 * that holds none - read the one way, so a request asked twice (the gate, and
 * anything outside it that still cares whether a browser is already signed
 * in) cannot end up reading two different cookies for two different reasons.
 */
export function heldSessionId(c: Context): string | undefined {
  return getCookie(c, sessionCookieName(c.req.url));
}

/**
 * Refuses anything that did not arrive with a current sign-in, and extends the
 * ones that did.
 *
 * The extension is a write on every request, which is a deliberate trade: this
 * is one small `UPDATE` against the register, and the alternative - only
 * renewing once a sign-in is past some fraction of its life - is a second rule
 * with its own branch to get wrong, for a saving nothing here is short of.
 */
export function gate(): MiddlewareHandler<GatedEnv> {
  return async (c, next) => {
    // `c.req.path` rather than the raw URL's pathname, so this gate and the
    // router answer one question with one string - see `auth/operator.ts` for the
    // hole the difference opened there. This one failed the safe way round (an
    // escaped `/health` got *more* protection, not less) and is changed anyway,
    // because leaving two spellings of "which path is this" in one directory is
    // how the next gate inherits the wrong one.
    if (isOutsideTheGate(c.req.path)) return next();

    const sessionId = heldSessionId(c);
    const held = sessionId ? await sessionHeld(c.env, sessionId) : null;
    const now = new Date();
    const verdict = recogniseSession(held?.session, now);

    if (!verdict.recognised) {
      // The cookie names nothing worth keeping, so it goes rather than being
      // offered again on every later request.
      if (sessionId) forgetSessionCookie(c);
      return c.json({ error: 'sign in to continue' }, 401);
    }

    await extendSession(c.env, sessionId!, verdict.expiresAt, now);
    rememberSessionCookie(c, sessionId!);
    c.set('sessionId', sessionId!);
    c.set('visitor', held!.visitor);
    return next();
  };
}

/**
 * Whether the sign-in something was started with is *still* current.
 *
 * The gate answers that once, on the way in, which is all a request needs
 * because a request is over in milliseconds. A live-updates stream is not: it is
 * held open for hours, and without this it would go on delivering an account's
 * changes long after that sign-in was ended - which is precisely what signing
 * out is supposed to stop. So the stream asks again as it goes (see the
 * `/v1/events` handler).
 *
 * Deliberately does **not** extend the sign-in. A stream is a listener, not use:
 * a person actually working makes other requests, and renewing from an open
 * socket would keep a forgotten tab's sign-in alive for as long as the tab was
 * left open.
 */
export async function stillSignedIn(env: Env, sessionId: string): Promise<boolean> {
  const held = await sessionHeld(env, sessionId);
  return recogniseSession(held?.session, new Date()).recognised;
}

/**
 * Sets the cookie, and re-sets it on every request so the browser's own copy
 * slides along with the row.
 *
 * `httpOnly` so script cannot read it, `sameSite: 'Lax'` so it is not sent on
 * a cross-site POST while a normal navigation back into the app still carries
 * it, and `secure` wherever the request came in over TLS. It is conditional
 * rather than always on for one reason: local development and the browser
 * suite both run over plain HTTP, and a `Secure` cookie there is one the
 * browser refuses to store at all, which would make signing in silently
 * impossible everywhere except a deployment.
 */
export function rememberSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, sessionCookieName(c.req.url), sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    maxAge: Math.floor(SIGN_IN_LIFETIME_MS / 1000),
  });
}

export function forgetSessionCookie(c: Context): void {
  deleteCookie(c, sessionCookieName(c.req.url), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
  });
}

/**
 * The sign-in being attempted, kept where only the browser that started it can
 * carry it back.
 *
 * **`sameSite: 'Lax'` is what makes this work at all**, and it is the one
 * place in the application where that is load-bearing rather than a default:
 * Google sends the browser back with a top-level navigation, which `Lax` sends
 * cookies on and `Strict` does not - a `Strict` cookie here would make every
 * sign-in look like one that never began.
 *
 * `httpOnly` because nothing in the page has any business reading it, and ten
 * minutes because that is a generous length for choosing a Google account and a
 * short one for a value that completes a sign-in.
 */
const ATTEMPT_COOKIE = 'cockpit_sign_in';
const ATTEMPT_LIFETIME_S = 10 * 60;

function attemptCookieName(url: string): string {
  return perStack(ATTEMPT_COOKIE, url);
}

export function rememberAttempt(c: Context, attempt: Attempt): void {
  setCookie(c, attemptCookieName(c.req.url), JSON.stringify(attempt), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    maxAge: ATTEMPT_LIFETIME_S,
  });
}

/**
 * What the browser is carrying, or `null` - which is the same answer for a
 * sign-in that was never started here, one whose ten minutes ran out, and one
 * whose cookie has been tampered with.
 */
export function attemptHeld(c: Context): Attempt | null {
  const held = getCookie(c, attemptCookieName(c.req.url));
  if (!held) return null;
  try {
    const parsed: unknown = JSON.parse(held);
    if (!parsed || typeof parsed !== 'object') return null;
    const { state, nonce, codeVerifier } = parsed as Record<string, unknown>;
    if (typeof state !== 'string' || typeof nonce !== 'string' || typeof codeVerifier !== 'string') {
      return null;
    }
    return { state, nonce, codeVerifier };
  } catch {
    return null;
  }
}

/**
 * Ends the attempt, whichever way it went. **An attempt is spent once**: the
 * cookie goes before the reply is acted on, so the same reply delivered twice
 * finds nothing to check itself against the second time.
 */
export function forgetAttempt(c: Context): void {
  deleteCookie(c, attemptCookieName(c.req.url), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
  });
}
