import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env.js';
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
 * The only paths that answer without a sign-in, and each is here for a stated
 * reason rather than by omission:
 *
 * - `/health` is deliberately outside every gate, including this one
 *   (docs/deployment.md, "`/health` must stay outside the gate"): the client
 *   asks it precisely when its requests are being refused, to tell an expired
 *   sign-in apart from a deployment that is unwell, and the uptime monitor and
 *   the post-deploy assertion both read it.
 * - `/v1/users` is the logon page's list of names. It is what you read while
 *   you are still nobody, so it cannot be behind the thing it exists to get you
 *   through - which is why it carries names only and nothing else about a
 *   person.
 * - `/v1/sign-in` is how you stop being nobody.
 *
 * Exact matches, not prefixes. `/v1/users` opening `/v1/users/anything` would
 * be a hole nobody chose.
 */
export const PATHS_OUTSIDE_THE_GATE: readonly string[] = ['/health', '/v1/users', '/v1/sign-in'];

/**
 * The one prefix outside the gate, and the only thing here that is not an exact
 * path: **webhook ingress is called by Slack, Gmail and the rest**, which can
 * never hold a session cookie, so a sign-in is the wrong question to ask of it.
 * What authenticates a delivery is the connector's own signature verification
 * (architecture, "Connectors"), which lives behind this route and not in front
 * of it.
 *
 * It has to be a prefix because the path carries the connector's id and
 * whatever the source appends after it. That is deliberately the only one: the
 * gate stands in front of everything it has not been told about, so a route
 * added later is refused until somebody decides otherwise, rather than open
 * until somebody notices.
 */
const INGRESS_PREFIX = '/ingress/';

export function isOutsideTheGate(path: string): boolean {
  return PATHS_OUTSIDE_THE_GATE.includes(path) || path.startsWith(INGRESS_PREFIX);
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
    if (isOutsideTheGate(new URL(c.req.url).pathname)) return next();

    const sessionId = getCookie(c, SESSION_COOKIE);
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
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    maxAge: Math.floor(SIGN_IN_LIFETIME_MS / 1000),
  });
}

export function forgetSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
  });
}
