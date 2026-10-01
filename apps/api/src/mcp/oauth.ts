import {
  OAuthError,
  OAuthProvider,
  getOAuthApi,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import type { Env } from '../env.js';
import { GRANT_LIFETIME_S } from './connected-apps.js';
import { grantHolder } from './grant.js';
import { AUTHORIZE_PATH, MCP_PATH, REGISTER_PATH, TOKEN_PATH } from './paths.js';
import { answerMcp } from './server.js';

/**
 * Cockpit as an OAuth server for MCP clients ("Connect Claude to Cockpit, and
 * capture an item from it", issue 599), through Cloudflare's own library.
 *
 * **A library rather than hand-rolled**, unlike Google sign-in
 * (`auth/oidc.ts`): that is a client of one issuer, three checks long, while
 * this is an authorization server - client registration, PKCE, code and token
 * exchange, refresh rotation, discovery - which is far more surface than this
 * application should own. What stays Cockpit's is who may consent and what a
 * grant may do (`consent.ts`, `server.ts`).
 *
 * **One provider per address this environment is reached on.** The resource a
 * token is bound to is an absolute URL, fixed when the provider is made, and
 * the address is configuration (`APP_ORIGIN`) that the Worker only learns from
 * `env` on a request - so it is made on the first request and kept.
 */

/**
 * What a request looks like at the address a person or an app is actually
 * using - the one the provider's tokens and discovery documents name.
 *
 * **Not this Worker's own address, for the reason the sign-in callback is
 * configured rather than derived** (`callbackUrl`, `http/app.ts`): in
 * development the browser and the app are on Vite, which proxies here under
 * another host, and the library checks a token's audience against the address
 * the request arrived on. A deployment is reached on `APP_ORIGIN` anyway, so
 * there this changes nothing.
 */
export function asReachedAt(request: Request, env: Env): Request {
  const { pathname, search } = new URL(request.url);
  return new Request(new URL(`${pathname}${search}`, env.APP_ORIGIN), request);
}

function optionsFor(env: Env): OAuthProviderOptions<Env> {
  const origin = new URL(env.APP_ORIGIN).origin;
  return {
    apiRoute: MCP_PATH,
    apiHandler: { fetch: (request, handlerEnv, ctx) => answerMcp(request, handlerEnv, ctx) },
    // Never reached: only the library's own addresses are routed to it
    // (`isAnsweredByTheAuthorizationServer`), and the consent page is routed
    // beside it rather than through it (`worker.ts`).
    defaultHandler: { fetch: async () => new Response(null, { status: 404 }) },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    // Dynamic registration, which is how Claude Code and Claude's apps add a
    // server today. Client ID Metadata Documents are left off: they need a
    // compatibility flag that changes how every `fetch` this Worker makes is
    // routed, which is a decision of its own.
    clientRegistrationEndpoint: REGISTER_PATH,
    // A sign-in's thirty days, sliding with use the way a sign-in does, and
    // cut short at once by deleting or disabling the person (`grant.ts`).
    refreshTokenTTL: GRANT_LIFETIME_S,
    refreshTokenIdleTTL: GRANT_LIFETIME_S,
    // **The person is asked for again on every code exchange and refresh**, as
    // `/mcp` asks on every call (`grant.ts`). Somebody deleted or disabled is
    // refused with `invalid_grant`, which the library also takes as the grant
    // being dead and revokes, so the app cannot refresh its way back in and has
    // to ask for consent again, where nobody without access gets through.
    tokenExchangeCallback: async ({ props, env: requestEnv }) => {
      if (!(await grantHolder(requestEnv, props))) {
        throw new OAuthError('invalid_grant', { description: 'This grant no longer acts for anybody' });
      }
    },
    resourceMetadata: {
      resource: `${origin}${MCP_PATH}`,
      authorization_servers: [origin],
      resource_name: 'Cockpit',
      bearer_methods_supported: ['header'],
    },
    onError: ({ status, internal }) => {
      // The library's reason, which never goes on the wire; never the token.
      console.warn(
        JSON.stringify({ level: 'warn', message: 'an app was refused', status, ...internal, detail: undefined }),
      );
    },
  };
}

const providers = new Map<string, OAuthProvider<Env>>();

/** The provider for this environment's address, made on first use. */
export function providerFor(env: Env): OAuthProvider<Env> {
  const origin = new URL(env.APP_ORIGIN).origin;
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>(optionsFor(env));
    providers.set(origin, provider);
  }
  return provider;
}

/**
 * The helpers the consent page uses, against the same options the provider
 * was made with - made once per environment and address, as the provider is.
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
  if (!made) byOrigin.set(origin, (made = getOAuthApi<Env>(optionsFor(env), env)));
  return made;
}
