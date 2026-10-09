import type { ExecutionContext } from '@cloudflare/workers-types';
import type { Connector } from '@cockpit/connector-sdk';
import worker, { AccountStore as RealAccountStore } from '../src/worker.js';
import type { Env } from '../src/env.js';

/**
 * What the browser suite runs in place of `src/worker.ts` (`scripts/e2e-stack.mjs`
 * passes it to Wrangler as the entry): the same Worker, with one fake pulled
 * connector registered beside the registry's own list through the setting the
 * backend suite uses (`TEST_CONNECTORS`, `src/env.ts`).
 *
 * **It exists so a walk can reach a connector that declares a choice** ("Ask a
 * connection's one choice on connecting, and change it later", issue 942): no
 * real source is pulled through the generic host yet, and `pnpm dev` and every
 * deployment register none of these. Signing in is the stub issuer's, as
 * Teams' is, so the walk drives a real redirect and a real code exchange. Its
 * `sync` reads nothing, since the walk is about the window, the redirect and the
 * stored row; what a connector is handed on its next run is held one tier down
 * (apps/api/tests/integration/connectors/connection-choice.test.ts).
 */
const FAKE_PAGES = 'e2e-pages';

function fakePages(issuer: string): Connector {
  return {
    manifest: {
      id: FAKE_PAGES,
      displayName: 'Fake Pages',
      cardText: 'Pages from a source that only exists in the browser suite.',
      source: 'notion',
      supportsPush: false,
      pulled: true,
      choice: {
        question: 'Bring in pages',
        options: [
          { value: 'starred', label: 'Starred pages' },
          { value: 'all', label: 'Every page' },
        ],
      },
      auth: {
        kind: 'oauth2',
        endpoints: { issuer },
        scopes: ['openid', 'email', 'profile'],
        clientSettings: { id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET' },
      },
    },
    async sync() {},
    accountFrom({ claims }) {
      const email = typeof claims?.email === 'string' ? claims.email : '';
      return email ? { key: email, displayName: email } : null;
    },
  };
}

/** Registered once per environment object, wherever the Worker meets it first. */
function withFakes(env: Env): Env {
  if (env.OIDC_ISSUER?.trim()) env.TEST_CONNECTORS ??= [fakePages(env.OIDC_ISSUER.trim())];
  return env;
}

export class AccountStore extends RealAccountStore {
  constructor(state: ConstructorParameters<typeof RealAccountStore>[0], env: Env) {
    super(state, withFakes(env));
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => worker.fetch(request, withFakes(env), ctx),
  scheduled: (event: never, env: Env, ctx: ExecutionContext) =>
    (worker.scheduled as (event: never, env: Env, ctx: ExecutionContext) => unknown)(event, withFakes(env), ctx),
  queue: (batch: never, env: Env, ctx: ExecutionContext) =>
    (worker.queue as (batch: never, env: Env, ctx: ExecutionContext) => unknown)(batch, withFakes(env), ctx),
};
