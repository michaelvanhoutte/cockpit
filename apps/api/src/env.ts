import type { Ai, D1Database, DurableObjectNamespace, Queue } from '@cloudflare/workers-types';
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
  /**
   * Workers AI, which reads what a note means so that one saying what another
   * one already said can be flagged ("Flag a captured note that says what
   * another one already said", issue 407).
   *
   * Optional in the type, and gated on nothing else: an environment without it
   * flags nothing and goes on taking every note, and `/health` reports the
   * fact. It is deliberately separate from `ANTHROPIC_API_KEY` below - an
   * environment that cannot clean a note up must still be able to flag a
   * duplicate.
   */
  AI?: Ai;
  /**
   * Reads meaning with a stand-in rather than with a model - words counted into
   * buckets, which is enough to drive the feature and nothing like enough to
   * prove what it flags (`src/embeddings/index.ts`).
   *
   * Set by the two local stacks and by nothing else (scripts/dev.mjs,
   * scripts/e2e-stack.mjs), because Workers AI has no local simulator and both
   * have to run without a Cloudflare account. Compared to the literal `'true'`
   * for the reason `GUEST_SIGN_IN` below is.
   */
  EMBEDDINGS_STAND_IN?: string;
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
   * Whether this environment offers a way in without a Google account at all
   * ("Sign in as a guest, without a password", issue 354). Set on production,
   * and on the two local stacks so the control can be driven at all;
   * deliberately absent from staging, which holds real rows rather than being
   * somewhere to show a stranger the product.
   *
   * Optional in the type because absence is how it is turned off, so an
   * environment that has never set it must compile and refuse the route rather
   * than fail to build.
   *
   * **Compared to the literal `'true'`, not merely truthy.** Every var here is
   * a string, so a stray `"false"` typed into an environment block meaning to
   * turn this off would otherwise turn it on - the one value that ever came
   * from a person's own judgement rather than from a boolean.
   */
  GUEST_SIGN_IN?: string;
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
