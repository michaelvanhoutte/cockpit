import { OAuthProvider, getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { SIGN_IN_LIFETIME_MS } from '../auth/session.js';
import type { Env } from '../env.js';
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

/** How long a grant lasts without being used again: as long as a sign-in does. */
const GRANT_LIFETIME_S = Math.floor(SIGN_IN_LIFETIME_MS / 1000);

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

/** The helpers the consent page uses, against the same options the provider was made with. */
export function oauthHelpersFor(env: Env): OAuthHelpers {
  return getOAuthApi<Env>(optionsFor(env), env);
}
