import type { D1Database, DurableObjectNamespace } from '@cloudflare/workers-types';
import type { AccountStoreRpc } from './accounts/rpc.js';

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
   * on working (`src/auth/admin.ts`).
   *
   * Set per environment, both of them, because secrets are not inheritable:
   * `wrangler secret put BACKUP_TOKEN` and again with `--env staging`.
   */
  BACKUP_TOKEN?: string;
}
