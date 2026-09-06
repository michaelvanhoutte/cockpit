import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';

/**
 * The gate in front of the operator's routes, which is a secret rather than a
 * sign-in.
 *
 * **Why not the signed-in user's role.** Every user carries `user` or `admin`
 * already, and this would be the first thing to enforce it - but a role is
 * carried by a session, and whoever calls these holds none. They are a
 * command-line tool: there is no browser to send to Google and back, so the
 * sign-in these routes would have to check is one their caller cannot obtain.
 *
 * That reason survived the sign-in changing under it. This was first written
 * when signing in meant picking a name off a list, and the argument then was
 * that a role gate would put every account's data one click from anyone who
 * reached the URL. Google sign-in has since landed ("Sign in with Google, and
 * retire the list of names", issue 196) and that argument is gone, while the
 * answer is the same one: a secret is what a caller with no session can carry.
 *
 * **An environment with no secret answers nothing here.** Absent is refused the
 * same as wrong, so forgetting to put the secret in a new environment leaves
 * the routes shut rather than open - the failure worth having, since the other
 * way round is silent.
 */

/**
 * Everything behind the operator's secret. A prefix, because the routes under
 * it are addressed by account name.
 *
 * It is named in `gate.ts` as standing outside the sign-in gate, for the same
 * reason webhook ingress does: whoever calls it holds no session cookie and
 * never will. The two gates are not alternatives - what is outside one is
 * inside the other, and this prefix is only outside the first because this is
 * in front of it.
 */
export const ADMIN_PREFIX = '/v1/admin/';

export function isAdminPath(path: string): boolean {
  return path.startsWith(ADMIN_PREFIX);
}

/**
 * Whether a request carries the secret.
 *
 * Kept apart from the middleware so every branch is provable without a request
 * (`tests/unit/auth/admin.test.ts`), which is where the cases that matter are:
 * the environment with no secret set, and the header that is present but wrong.
 *
 * The comparison is not constant-time, and does not need to be: this is one
 * `fetch` per attempt across the internet against a secret with far more
 * entropy than a timing side channel on a string compare could recover.
 */
export function secretAccepted(offered: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  if (!offered) return false;
  return bearerToken(offered) === expected;
}

/** `Authorization: Bearer <secret>`, and nothing else counts. */
function bearerToken(header: string): string | null {
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

/**
 * Refuses anything under the prefix that did not arrive with the secret.
 *
 * The refusal says nothing about which of the two it was - no secret set here,
 * or the wrong one offered - because the difference is only useful to somebody
 * guessing.
 *
 * **`c.req.path`, never `new URL(c.req.url).pathname`.** The two differ:
 * `pathname` keeps percent-escapes, while the router decodes them before
 * matching - so `/v1/%61dmin/backup/register` reaches the handler registered at
 * `/v1/admin/backup/register` while a raw-path check says it is not an admin
 * path at all, and waves it through with no secret. That was a real hole in
 * this file's first draft, found by the security review and reproduced against
 * a running deployment. A gate has to decide on the same string the router
 * matched on; anything else is two answers to one question.
 */
export function adminGate(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!isAdminPath(c.req.path)) return next();
    if (!secretAccepted(c.req.header('authorization'), c.env.BACKUP_TOKEN)) {
      return c.json({ error: 'not allowed' }, 401);
    }
    return next();
  };
}
