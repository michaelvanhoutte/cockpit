import type { MiddlewareHandler } from 'hono';
import { ADMIN } from '@cockpit/shared';
import { MOVED_OPERATOR_PREFIXES } from './operator.js';
import type { GatedEnv } from './gate.js';

/**
 * The gate in front of the admin pages, which is a role rather than a secret -
 * and the first thing in this application to enforce one ("See who can sign in,
 * on a page only an admin can open", issue 230).
 *
 * **It is not the operator's gate and does not substitute for it**, which the
 * architecture has said since the operator's routes were built: a role is
 * carried by a session, and the command line behind `/v1/operator/` holds none.
 * Which prefix is behind which gate is written once, in `auth/operator.ts`.
 *
 * **Behind the sign-in gate rather than beside it.** Everything here needs a
 * visitor before it can have a role, so this reads what `gate()` left on the
 * request and never the register again: one read of a person per request, and
 * no way for the two gates to disagree about who is asking.
 */
export const ADMIN_PREFIX = '/v1/admin/';

/**
 * The one role that opens the admin pages, taken from the contract rather than
 * written again: the browser compares against the same word to decide what to
 * offer, and two spellings of it is a door that is offered and then refused.
 */
export const ADMIN_ROLE: string = ADMIN;

/**
 * Whether this is an address the role guards.
 *
 * **The addresses the operator's routes moved off are under this prefix and are
 * not guarded**, because they are outside the sign-in gate entirely and answer
 * `410` to a command line that holds no session. Sending them through a role
 * check would refuse them for having no visitor - a 401 telling `pnpm
 * backup:export` to sign in, which is exactly the answer issue 229 removed.
 */
export function isAdminPath(path: string): boolean {
  if (MOVED_OPERATOR_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return path.startsWith(ADMIN_PREFIX);
}

/**
 * What a request may reach, given who is asking.
 *
 * Pure, and separate from the middleware, so every branch is provable without a
 * request (`tests/unit/auth/admin.test.ts`) - and so the answer for "signed in,
 * but not an admin" is written once rather than inferred from a 401 somewhere.
 */
export function roleOpens(path: string, role: string | undefined): boolean {
  if (!isAdminPath(path)) return true;
  return role === ADMIN_ROLE;
}

/**
 * Refuses an admin address to anybody whose role is not `admin`.
 *
 * **A 403 rather than a 404.** Whoever reaches here is signed in and known -
 * the sign-in gate has already turned everyone else away - so hiding that the
 * address exists buys nothing against them, while a plain refusal is something
 * the app can draw. What it does not say is who *is* an admin.
 *
 * **`c.req.path`, never the raw URL's pathname**, for the reason
 * `auth/operator.ts` records at length: the router decodes escapes before
 * matching, so a gate reading the raw path answers a different question than
 * the router asked, and `/v1/%61dmin/users` walks through the gap.
 */
export function adminGate(): MiddlewareHandler<GatedEnv> {
  return async (c, next) => {
    if (roleOpens(c.req.path, c.get('visitor')?.role)) return next();
    return c.json({ error: 'not allowed' }, 403);
  };
}
