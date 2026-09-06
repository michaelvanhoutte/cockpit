import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';

/**
 * The gate in front of the operator's routes, which is a secret rather than a
 * sign-in.
 *
 * **Why not the signed-in user's role.** Every user carries `user` or `admin`
 * already, and this would be the first thing to enforce it - but on a deployed
 * environment signing in is choosing a name off a list, which proves nothing
 * (architecture, "App login"). Gating "hand me every account's data" on that
 * would put all of it one click from anyone who can reach the URL. A secret in
 * the platform's own store is not the identity model these routes eventually
 * want, and it is strictly stronger than the one that exists today.
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
 */
export function adminGate(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!isAdminPath(new URL(c.req.url).pathname)) return next();
    if (!secretAccepted(c.req.header('authorization'), c.env.BACKUP_TOKEN)) {
      return c.json({ error: 'not allowed' }, 401);
    }
    return next();
  };
}
