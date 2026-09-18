import type {
  Ai,
  D1Database,
  DurableObjectNamespace,
  Queue,
  R2Bucket,
} from '@cloudflare/workers-types';
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
   * The bytes of every attachment an Item holds ("Attach a file to an item",
   * issue 441) - the account's own store carries the metadata (filename,
   * size, type) and never the bytes themselves. Unlike `ACCOUNT`, this names
   * one bucket rather than a per-account namespace: R2 keys are already
   * account- and item-scoped (`apps/api/src/domain/attachments.ts`), so one
   * bucket is every account's, the same way one D1 database is every
   * account's register.
   *
   * R2 has a full local simulator, unlike Workers AI, so this is bound for
   * real on every stack - `pnpm dev`, the browser suite and CI alike - with
   * nothing to stand in for it.
   */
  ATTACHMENTS: R2Bucket;
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
   * The application Microsoft knows this Cockpit as, and the secret that
   * proves it, for connecting a Workspace's Teams account ("Connect a
   * Microsoft Teams source account", issue 485).
   *
   * Both optional in the type, unlike Google's above, and the difference is
   * what each one's absence means: without Google's, nobody can sign in at
   * all, while without these a deployment simply connects nothing and works
   * in every other way - the same standing `BACKUP_TOKEN` below has. The
   * connect route refuses where either is missing rather than sending
   * somebody to Microsoft to be turned away there.
   *
   * Both are secrets set per environment (`wrangler secret put`,
   * docs/deployment.md, "Secrets and access"), the client id included: no
   * Entra registration exists yet, so a placeholder in wrangler.jsonc would
   * be configuration nobody chose.
   */
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  /**
   * The Azure Bot resource's own Microsoft App ID, which is the audience of
   * every call the Bot Framework signs for this Cockpit ("Save a Teams message
   * to Cockpit", issue 486).
   *
   * Optional for the reason the pair above is, and its absence is what makes
   * the Teams ingress not exist at all rather than exist and refuse everything
   * (`connectors/registry.ts`): a deployment with no bot behind it answers 404
   * at that address and works in every other way.
   *
   * **Separate from `MS_CLIENT_ID`, even where an operator registers both
   * against the same Entra application.** They are the audiences of two
   * different tokens - one an identity a person signs in with, the other a
   * channel's own call - and a single value would make widening one of them
   * silently widen the other.
   */
  MS_BOT_APP_ID?: string;
  /**
   * What a connected source account's credential is sealed with: 32 random
   * bytes, base64 (`src/connectors/credential-crypto.ts`).
   *
   * Optional for the reason the two above are, and refused rather than worked
   * around: an environment with no key stores no credential at all, because
   * the alternative - storing one in the clear - is the thing this exists to
   * make impossible. **Losing it makes every stored credential unreadable**,
   * which is a disconnect-and-connect-again for whoever holds one rather
   * than lost work, and docs/deployment.md says so where it says how to make
   * one.
   */
  CONNECTOR_CREDENTIAL_KEY?: string;
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
