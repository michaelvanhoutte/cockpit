import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';

/**
 * The gate in front of the operator's routes, which is a secret rather than a
 * sign-in.
 *
 * **Why not the signed-in user's role**, which `auth/admin.ts` now enforces on
 * the admin pages: a role is carried by a session, and whoever calls these
 * holds none. They are a command-line tool - there is no browser to send to
 * Google and back - so the sign-in that gate reads is one their caller cannot
 * obtain.
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
 * **It is `/v1/operator/` and not `/v1/admin/`**, which these routes held until
 * "Give the operator's routes the operator's name, and free /v1/admin/ for the
 * admin section" (issue 229). The old name described neither the caller nor the
 * gate - an operator holds a secret, an admin holds a role - and it stood on
 * the address the admin section wants for every page it will have. The two now
 * read as what they are:
 *
 * | Prefix | Who calls it | What lets them in |
 * |---|---|---|
 * | `/v1/operator/` | a command line, no browser | the `BACKUP_TOKEN` secret |
 * | `/v1/admin/` | a person on the admin pages | a sign-in, and the `admin` role |
 *
 * It is named in `gate.ts` as standing outside the sign-in gate, for the same
 * reason webhook ingress does: whoever calls it holds no session cookie and
 * never will. The two gates are not alternatives - what is outside one is
 * inside the other, and this prefix is only outside the first because this is
 * in front of it.
 */
export const OPERATOR_PREFIX = '/v1/operator/';

export function isOperatorPath(path: string): boolean {
  return path.startsWith(OPERATOR_PREFIX);
}

/**
 * Where these routes answered before that, kept beside the prefix that replaced
 * them rather than in the gate that has to let them past: a move is a fact
 * about this address, and splitting the two halves across files is how one of
 * them gets forgotten when the next move happens.
 *
 * **They answer `410` naming the new prefix**, and the sentence matters more
 * than the status: whoever still asks here is `pnpm backup:export` run from a
 * checkout somebody has not updated, and the sign-in gate's "sign in to
 * continue" is advice a command line cannot take. Nothing guards them, because
 * there is nothing behind them to guard.
 *
 * **Prefixes rather than exact paths**, unlike `RETIRED_PATHS`, because two of
 * the four addresses carry an account name. That is safe only while nothing is
 * served beneath either: `app.ts` answers the whole of both subtrees and
 * registers nothing else there. **An admin page under `/v1/admin/backup/**` or
 * `/v1/admin/restore/**` would be shadowed by that answer rather than reached**
 * - and since the app turns any `410` into a forced update
 * (`apps/web/src/updating.ts`), the symptom would be a reload loop rather than
 * a 404. Either name such a page outside these two subtrees or take the entry
 * out; they are removable as soon as no checkout still asks, which for a
 * command run by hand is a judgement rather than a date.
 *
 * **`/v1/admin/` itself is deliberately not here**: it is where the admin
 * section is going, and a page there is guarded by a sign-in and the `admin`
 * role like everything else.
 */
export const MOVED_OPERATOR_PREFIXES: readonly string[] = [
  '/v1/admin/backup/',
  '/v1/admin/restore/',
];

/**
 * Whether a request carries the secret.
 *
 * Kept apart from the middleware so every branch is provable without a request
 * (`tests/unit/auth/operator.test.ts`), which is where the cases that matter
 * are: the environment with no secret set, and the header that is present but
 * wrong.
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
 * matching - so `/v1/%6Fperator/backup/register` reaches the handler registered
 * at `/v1/operator/backup/register` while a raw-path check says it is not an
 * operator path at all, and waves it through with no secret. That was a real
 * hole in this file's first draft, found by the security review and reproduced
 * against a running deployment. A gate has to decide on the same string the
 * router matched on; anything else is two answers to one question. The escape
 * moved with the prefix - it is whichever letter is written `%6F` rather than
 * `o` - so the case is re-proved against the new spelling rather than assumed
 * to have moved with it.
 */
export function operatorGate(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!isOperatorPath(c.req.path)) return next();
    if (!secretAccepted(c.req.header('authorization'), c.env.BACKUP_TOKEN)) {
      return c.json({ error: 'not allowed' }, 401);
    }
    return next();
  };
}
