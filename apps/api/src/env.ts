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
}
