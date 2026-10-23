import {
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import type { Env } from '../env.js';
import { GRANT_LIFETIME_S } from './connected-apps.js';
import { grantHolder } from './grant.js';
import { AUTHORIZE_PATH, REGISTER_PATH, TOKEN_PATH, type OAuthDoor } from '../auth/mcp-paths.js';
import { answerMcp, type ProtectedContext } from './server.js';
import { answerPanelRead } from './panel-reads.js';
import { resourcesOf } from './resources.js';

/**
 * Cockpit as an OAuth server for MCP clients ("Connect Claude to Cockpit, and
 * capture an item from it", issue 599) and for the apps that read your Panels
 * ("Read a Panel from an app allowed only to read, and open Capture from its
 * address", issue 1445), through Cloudflare's own library.
 *
 * **A library rather than hand-rolled**, unlike Google sign-in
 * (`auth/oidc.ts`): that is a client of one issuer, three checks long, while
 * this is an authorization server - client registration, PKCE, code and token
 * exchange, refresh rotation, discovery - which is far more surface than this
 * application should own. What stays Cockpit's is who may consent and what a
 * grant may do (`consent.ts`, the two handlers).
 *
 * **The library's role-based setup: one authorization server, two protected
 * resources.**
 *
 * | | Address | Handler |
 * |---|---|---|
 * | resource | `{origin}/mcp` | `server.ts`: MCP, to capture an Item |
 * | resource | `{origin}/apps` | `panel-reads.ts`: the two reads of Panels |
 * | authorization server | token, registration, discovery | the library's |
 *
 * **A token is bound to one resource** - the one the app named when it signed
 * in - and the library refuses it at the other on every request, so what an app
 * may reach is never decided by this application, and there is no scope.
 *
 * **`/mcp` is the default and the legacy resource.** An authorization naming no
 * resource, as Claude's does not, is given `/mcp` (`defaultResource`); and every
 * grant and token made before resources existed, which hold none, is read as
 * made for `/mcp` (`legacyGrantResource`) and re-filed under it at its next
 * refresh. So Claude keeps working and nobody signs in again.
 *
 * **One set per address this environment is reached on.** A resource is an
 * absolute URL fixed when the server is made, and the address is configuration
 * (`APP_ORIGIN`) that the Worker only learns from `env` on a request - so it is
 * made on the first request and kept.
 */

/**
 * What a request looks like at the address a person or an app is actually
 * using - the one the provider's tokens and discovery documents name.
 *
 * **Not this Worker's own address, for the reason the sign-in callback is
 * configured rather than derived** (`callbackUrl`, `auth/gate.ts`): in
 * development the browser and the app are on Vite, which proxies here under
 * another host, and the library checks a token's audience against the address
 * the request arrived on. A deployment is reached on `APP_ORIGIN` anyway, so
 * there this changes nothing.
 */
export function asReachedAt(request: Request, env: Env): Request {
  const { pathname, search } = new URL(request.url);
  return new Request(new URL(`${pathname}${search}`, env.APP_ORIGIN), request);
}

interface OAuthSetup {
  readonly authorizationServer: OAuthAuthorizationServer<Env>;
  readonly mcp: OAuthResourceServer<Env>;
  readonly apps: OAuthResourceServer<Env>;
}

function setupFor(env: Env): OAuthSetup {
  const origin = new URL(env.APP_ORIGIN).origin;
  const resources = resourcesOf(env);

  const authorizationServer = new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: [resources.mcp, resources.apps],
    // An authorization naming no resource gets MCP, as Claude's does today, and
    // every grant and token from before resources existed is filed under it.
    defaultResource: resources.mcp,
    legacyGrantResource: resources.mcp,
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    // Dynamic registration, which is how Claude Code and Claude's apps add a
    // server today. Client ID Metadata Documents are left off: they need a
    // compatibility flag that changes how every `fetch` this Worker makes is
    // routed, which is a decision of its own.
    clientRegistrationEndpoint: REGISTER_PATH,
    // An app on a phone is returned to by an address of its own - `cockpit-widget://`
    // (RFC 8252) - which it registers and has to ask for exactly as registered. A
    // code another app intercepts is useless without the PKCE proof the asking
    // app kept back, so this widens who can *receive* a code and not who can use
    // one (issue 1445). The consent page names such an address whole.
    allowPrivateUseRedirectUris: true,
    // A sign-in's thirty days, sliding with use the way a sign-in does, and
    // cut short at once by deleting or disabling the person (`grant.ts`).
    refreshTokenTTL: GRANT_LIFETIME_S,
    refreshTokenIdleTTL: GRANT_LIFETIME_S,
    // **The person is asked for again on every code exchange and refresh**, as
    // both handlers ask on every call (`grant.ts`). Somebody deleted or disabled is
    // refused with `invalid_grant`, which the library also takes as the grant
    // being dead and revokes, so the app cannot refresh its way back in and has
    // to ask for consent again, where nobody without access gets through.
    tokenExchangeCallback: async ({ props, env: requestEnv }) => {
      if (!(await grantHolder(requestEnv, props))) {
        throw new OAuthError('invalid_grant', { description: 'This grant no longer acts for anybody' });
      }
    },
    onError: ({ status, internal }) => {
      // The library's reason, which never goes on the wire; never the token.
      console.warn(
        JSON.stringify({ level: 'warn', message: 'an app was refused', status, ...internal, detail: undefined }),
      );
    },
  });

  const resourceServer = (resource: string, name: string, handler: (request: Request, env: Env, ctx: ProtectedContext) => Promise<Response>) =>
    new OAuthResourceServer<Env>({
      resourceMetadata: {
        resource,
        authorization_servers: [origin],
        resource_name: name,
        bearer_methods_supported: ['header'],
      },
      // The library's own check, on every request: a token made for the other
      // resource, a token that ran out and one that never existed are all `null`.
      validateToken: (requestEnv) => (asked, token) => authorizationServer.validateToken(asked, token, requestEnv),
      handler: { fetch: (request, handlerEnv, ctx) => handler(request, handlerEnv, ctx) },
    });

  return {
    authorizationServer,
    mcp: resourceServer(resources.mcp, 'Cockpit', answerMcp),
    apps: resourceServer(resources.apps, 'Cockpit apps', answerPanelRead),
  };
}

const setups = new Map<string, OAuthSetup>();

function setupForOrigin(env: Env): OAuthSetup {
  const origin = new URL(env.APP_ORIGIN).origin;
  let setup = setups.get(origin);
  if (!setup) {
    setup = setupFor(env);
    setups.set(origin, setup);
  }
  return setup;
}

/**
 * Hands a request to the part of the library that answers it, as the address
 * the app reached it on (`asReachedAt`).
 */
export function answerOAuth(door: OAuthDoor, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const setup = setupForOrigin(env);
  const reached = asReachedAt(request, env);
  if (door === 'mcp') return setup.mcp.fetch(reached, env, ctx);
  if (door === 'apps') return setup.apps.fetch(reached, env, ctx);
  return setup.authorizationServer.fetch(reached, env, ctx);
}

/**
 * The helpers the consent page uses, against the same options the server
 * was made with - made once per environment and address, as the server is.
 *
 * Keyed by the `env` object as well as the address, because the helpers hold
 * the bindings they were made with; a Worker isolate is handed the same `env`
 * on every request, so in practice this is made once.
 */
const helpers = new WeakMap<Env, Map<string, OAuthHelpers>>();

export function oauthHelpersFor(env: Env): OAuthHelpers {
  const origin = new URL(env.APP_ORIGIN).origin;
  let byOrigin = helpers.get(env);
  if (!byOrigin) helpers.set(env, (byOrigin = new Map()));
  let made = byOrigin.get(origin);
  if (!made) byOrigin.set(origin, (made = setupForOrigin(env).authorizationServer.getOAuthApi(env)));
  return made;
}
