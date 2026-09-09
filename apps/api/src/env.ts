import type { D1Database, DurableObjectNamespace, Queue } from '@cloudflare/workers-types';
import type { AccountStoreRpc } from './accounts/rpc.js';
import type { EnrichmentJob } from './jobs/enrichment.js';

/**
 * Worker bindings. Extended as queues/secrets land (architecture, "Background
 * jobs" and "Security").
 *
 * `DB` is the register - which accounts exist - and nothing else. `ACCOUNT`
 * names a *namespace*, not one account's store: every account is reached by
 * name inside it at runtime, so no account is ever named in configuration and
 * adding one needs no deploy.
 */
export interface Env {
  DB: D1Database;
  ACCOUNT: DurableObjectNamespace<AccountStoreRpc>;
  /**
   * Work deferred out of a request, so nothing a person waits for waits on a
   * model call (architecture, "Background jobs"). One queue per environment,
   * because `queues` is not inheritable and staging must not consume
   * production's messages.
   */
  ENRICHMENT: Queue<EnrichmentJob>;
  /** The application Google knows this Cockpit as, and the secret that proves it. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /**
   * Where this environment is reached by the people using it, which is where a
   * sign-in comes back to. Not this Worker's own address: in development the
   * browser is on Vite and only `/v1` reaches here.
   */
  APP_ORIGIN: string;
  /**
   * Who to believe about who somebody is. Unset everywhere but local
   * development and the browser suite, which point it at the stub issuer so
   * they run the same flow a deployment runs (src/auth/issuer.ts).
   */
  OIDC_ISSUER?: string;
  /**
   * The operator's secret, and the only thing standing in front of the backup
   * routes. Optional in the type because it is a secret rather than a binding:
   * an environment that has not had one put in it must refuse those routes
   * outright rather than fail to compile, since every *other* route has to go
   * on working (`src/auth/operator.ts`).
   *
   * Set per environment, both of them, because secrets are not inheritable:
   * `wrangler secret put BACKUP_TOKEN` and again with `--env staging`.
   */
  BACKUP_TOKEN?: string;
  /**
   * What Cockpit talks to Claude with, and the application's own credential
   * rather than anybody's - so it has no settings screen ("Clean up a captured
   * note into a clear title and a fuller message", issue 296).
   *
   * Optional in the type for the reason `BACKUP_TOKEN` is: it is a secret
   * rather than a binding, and an environment that has not had one put in it
   * has to go on working with nothing enriched rather than fail to compile.
   * `/health` reports whether it is set, because that is the difference between
   * "nothing is being enriched" and "nothing is wrong".
   */
  ANTHROPIC_API_KEY?: string;
  /**
   * Which Anthropic workspace the key belongs to, sent as `anthropic-workspace-id`.
   *
   * Needed when the key is scoped to the organisation rather than to one
   * workspace, which answers `400 invalid_request_error` without it - a failure
   * that reads like a broken integration rather than a credential's scope. Set
   * beside the key and by the same command, because it is part of the
   * credential and means nothing without it; unset is correct for a
   * workspace-scoped key, so the header is only sent when there is one.
   */
  ANTHROPIC_WORKSPACE_ID?: string;
}
