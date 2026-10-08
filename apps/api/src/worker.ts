/**
 * What Wrangler deploys: the request handler, and every Durable Object class a
 * binding names.
 *
 * Separate from `index.ts`, which is this package's entry for `apps/web`, and
 * separate for a reason worth knowing before merging the two back together. The
 * store's class extends `DurableObject` from `cloudflare:workers`, a module that
 * exists only in the Workers runtime's own type definitions. `apps/web` compiles
 * this package's source to infer the API contract and cannot resolve it, so
 * exporting the class from `index.ts` breaks the web app's typecheck - loudly,
 * and nowhere near the change that caused it. The OAuth library behind `/mcp`
 * names the same module in its types, which is why it is wired here too.
 */
import type { ExecutionContext } from '@cloudflare/workers-types';
import application from './index.js';
import type { Env } from './env.js';
import { consent } from './mcp/consent.js';
import { asReachedAt, oauthHelpersFor, providerFor } from './mcp/oauth.js';
import { SHARE_TARGET_PATH } from '@cockpit/shared';
import { answerShare } from './share-target.js';
import { AUTHORIZE_PATH, isAnsweredByTheAuthorizationServer } from './mcp/paths.js';
import { AccountStoreBase } from './accounts/store.js';
import { pulledConnectorIds } from './connectors/registry.js';

export type { AppType } from './index.js';

/**
 * The account's store, told here which connectors are pulled, since the
 * store may not import the registry ("Check a pulled connector on its cadence
 * through the generic host", issue 891).
 */
export class AccountStore extends AccountStoreBase {
  protected pulledConnectorIds(): readonly string[] {
    return pulledConnectorIds(this.env);
  }
}

/**
 * Four doors, decided by path before anything else runs ("Connect Claude to
 * Cockpit, and capture an item from it", issue 599):
 *
 * | Path | Answered by | Admitted by |
 * |---|---|---|
 * | `/mcp`, `/oauth/token`, `/oauth/register`, `/.well-known/oauth-*` | the OAuth library | an access token it issued, or the protocol's own checks |
 * | `/oauth/authorize` | the consent page (`mcp/consent.ts`) | a Google sign-in, read by the page |
 * | `/share-target` | a redirect to Capture (`share-target.ts`) | nothing: it reads nothing |
 * | everything else | the application (`http/app.ts`) | the sign-in gate (`auth/gate.ts`) |
 *
 * **In front of the gate rather than behind it**, so a session cookie never
 * reaches `/mcp` at all: the gate's own argument for that is in `auth/gate.ts`.
 */
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const { pathname } = new URL(request.url);
    if (isAnsweredByTheAuthorizationServer(pathname)) {
      return providerFor(env).fetch(asReachedAt(request, env), env, ctx as never);
    }
    if (pathname === AUTHORIZE_PATH) return consent.fetch(request, env, ctx);
    if (pathname === SHARE_TARGET_PATH) return answerShare(request);
    // The library's helpers, for the admin routes that revoke somebody's
    // apps when their access goes (`mcp/revoke.ts`).
    env.OAUTH_PROVIDER ??= oauthHelpersFor(env);
    return application.fetch(request, env, ctx);
  },
  scheduled: application.scheduled,
  queue: application.queue,
};
