# Deployment, Environments, and Branching

How Cockpit runs on Cloudflare, which branch reaches which environment, and the
decisions behind both. Architecture §9 records *that* the platform is
Cloudflare and why; this document records *how*, and it is the runbook.

## 1. The branch model

**Decision: two long-lived branches.** `main` is production, `dev` is staging,
and everything else is short-lived and gets its own preview environment.

```
                        ┌─ every branch gets its own Access-gated preview URL
  claude/swipe    ●───● ┤
  claude/panel  ●───●   │  squash-merge
                    ┌───┴───┐
  dev  ──●──────────●───────●────────────►  staging     (cron + queues run here)
                            │ merge commit, via PR
  main ──●──────────────────●────────────►  production
```

The rules, and each one is load-bearing:

- **`dev` receives only squash-merged PRs from short-lived branches.** A branch
  arrives as one commit, so `dev`'s history reads as one line per unit of work
  rather than as a wall of "wip" and "fix typo".
- **`main` receives only a merge commit from `dev`, never a cherry-pick.** This
  keeps `main` a strict ancestor of `dev`, which is what makes `git log main..dev`
  a truthful answer to "what is merged but not live". Squashing here would flatten
  several features into one commit and destroy the per-feature history the
  previous rule just built.
- **Promotion is a PR** (`dev` → `main`), so the production diff is reviewable
  and every deploy has an audit trail.
- **`hotfix/*` branches from `main`, merges to `main`, then immediately
  back-merges to `main` → `dev`.** This is the one path that can make the two
  branches diverge, so the back-merge is a rule and not a courtesy: skip it and
  the next promotion either conflicts or quietly reverts the hotfix.

### Why staging exists at all

This deserves an argument, because the usual one does not apply. Staging
classically solves multi-team integration, and Cockpit has one developer. Worse,
every branch already gets a clickable environment, so staging adds nothing to
"review this change".

It earns its place for a narrower and more specific reason: **staging is the only
environment besides production where cron triggers and queue consumers run
continuously against a database that accumulates state.** Triggers attach to a
Worker's *active deployment*, not to uploaded versions, so a per-branch preview
serves HTTP and will never fire a §6.3 sync cadence, never age an OAuth token
into needing a refresh, never trip the §9.2 dead-man's switch, and never meet a
migration applied to a table that already has rows in it. Those are precisely
the failure modes architecture §9.2 calls hardest to detect. Staging is where
they get rehearsed.

The honest cost: two merges instead of one to reach production. If the
background-jobs layer were ever removed, this decision should be revisited,
because then trunk-based development with previews would dominate it.

**Rejected: Git Flow** (`develop` + `release/*` + version tags). Release branches
exist to coordinate a versioned artifact shipped to people who install it.
Cockpit is one continuously-deployed Worker, so the whole apparatus would be
ceremony with no user for it.

**Rejected: staging tracking `main`, with production promoted by tag.** Three
steps instead of two, production lagging `main`, and no safety the model above
does not already provide.

### Naming and commits

Branch names carry no mechanical meaning: the deploy workflow triggers on every
branch regardless of prefix. So `claude/<slug>` stays, because the slug already
says what the change is and the prefix usefully records that the branch was
agent-generated. Renaming what the agents produce would cost more than a `feat/`
prefix returns.

The changelog value people want from branch prefixes actually lives in commit
messages, so it is taken there instead: **Conventional Commits on the
squash-merge message into `dev`.** Squashing lets the message be written at merge
time, which means exactly one well-formed commit per feature, authored
deliberately, with no commitlint hook to install and nothing for an agent to get
wrong.

## 2. The environments

| | Worker | Database | Cron/Queues | URL | Access |
|---|---|---|---|---|---|
| **production** | `cockpit` | `cockpit` | yes | [cockpit.vanhoutte-michael.workers.dev](https://cockpit.vanhoutte-michael.workers.dev) | open |
| **staging** | `cockpit-staging` | `cockpit-staging` | yes | `cockpit-staging.vanhoutte-michael.workers.dev` | gated |
| **preview** | `cockpit-preview`, one version per branch | `cockpit-preview`, shared | no | `<alias>-cockpit-preview.vanhoutte-michael.workers.dev` | gated |

Three D1 databases, out of the free plan's ten. The two thresholds that would
force the $5/month Workers Paid plan, recorded so they are recognised rather than
rediscovered: **a database crossing 500 MB** (or 5 GB across all three), and
**needing queue retention beyond 24 hours**. Cloudflare Queues moved onto the
free plan in February 2026, so it is no longer a reason to upgrade on its own.

## 3. One Worker serves the whole application

Not Cloudflare Pages plus a separate API Worker. One Worker per environment
serves the Hono API, the SSE stream, the queue consumers, the cron triggers, and
the built SPA, via [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).

This is what architecture §9 already implied ("the Worker plus static assets")
and what `apps/web/vite.config.ts` already assumed ("mirroring production where
both live on the same Cloudflare zone. No CORS"). One deploy, one origin, no
CORS, and no split-brain about which half of the app a request belongs to. It is
also simply the current Cloudflare answer: Pages is being absorbed into Workers,
new features land on Workers first, and greenfield projects are pointed at
Workers.

The routing rule lives in `apps/api/wrangler.jsonc`:

- `run_worker_first: ["/v1/*", "/health", "/ingress/*"]` sends exactly those
  three prefixes to the Worker.
- Everything else is served from `apps/web/dist` **before the Worker runs**, so a
  cold page load bills no Worker invocation.
- `not_found_handling: "single-page-application"` returns `index.html` for
  unmatched paths, so client-side routes deep-link.

Those three prefixes are the same ones the service worker refuses to intercept
(`navigateFallbackDenylist` in `apps/web/vite.config.ts`). **The two lists must
be kept in sync**; they are the same boundary expressed twice.

Because `assets.directory` points at `../web/dist`, the web app must be built
before the API is deployed *or* run with `wrangler dev`. `pnpm build` first.

## 4. Preview environments

Every branch that is not `main` or `dev` gets one, triggered on `push` rather
than `pull_request` so that a draft PR, or a branch with no PR at all, is
deployed too.

Previews are **versions of a single Worker**, not a Worker per branch.
`wrangler versions upload --env preview --preview-alias <alias>` uploads a new
version and points a stable aliased URL at it without touching that Worker's
active deployment. One Worker to exist, no per-branch Worker to reap.

### The alias, and why there is a script for it

Cloudflare caps the combined alias and Worker name at 63 characters, and aliases
must be lowercase alphanumeric-with-dashes beginning with a letter. Branch names
here are long (`claude/cloudflare-deployment-strategy-9dcc0f` is 44 characters
before any prefix handling), so a naive slug overflows. `scripts/branch-alias.sh`
applies four rules, and `scripts/branch-alias.test.sh` asserts them in CI
because a silent change would either collide two branches onto one URL or
produce an invalid hostname:

1. Use only the branch's last path segment (`claude/inbox-swipe` → `inbox-swipe`).
2. Sanitise to `[a-z0-9-]`, beginning with a letter.
3. Truncate to 38 characters.
4. Always append a 6-character hash of the **full** branch name.

38 + 1 + 6 = 45, plus `-cockpit-preview` = 61, two under the limit deliberately
so a future rename of the Worker does not silently break every preview URL.
Because the hash covers the full branch name, neither the truncation nor the
segment-stripping can collide two branches.

### Shared preview database: a recorded reversal

Architecture §9.1 specified "an isolated preview D1 database" per preview.
**That is amended: all previews share one `cockpit-preview` database**, which is
re-migrated and re-seeded (`seed.sql` is `INSERT OR IGNORE` throughout, so this
is idempotent) on every preview deploy.

The argument: per-branch isolation needs a database created on first push, its id
injected into a generated Wrangler config, and a reaper to delete it when the
branch goes away, and the free plan's ten-database ceiling means it does not fit
at all against the seventeen branches this repository already carries. The
shared database costs nothing to run and needs no lifecycle machinery.

**What is genuinely given up**, recorded rather than waved away: two branches
with incompatible migrations will collide, because a migration applied by one
preview is immediately visible to every other open branch's preview. There is no
mitigation in place, only a detection story: the preview deploy applies
migrations before uploading the version, so the branch that breaks is the branch
that notices. If this bites in practice, the recorded escalation is per-branch
databases on the Workers Paid plan, which is the option this decision defers
rather than forecloses.

### The footgun this configuration exists to defuse

**Preview versions inherit the top-level bindings by default, which means a
preview reads and writes the production database unless something stops it.**
This is a real and [documented gap](https://github.com/cloudflare/cloudflare-docs/issues/23377)
that people hit after migrating from Pages.

What stops it here: `d1_databases` is a **non-inheritable** Wrangler config key,
so each `[env.*]` block declares its own database, and every deploy command in
`.github/workflows/` passes `--env` explicitly rather than relying on the
`CLOUDFLARE_ENV` environment variable being set at the right moment. Production
uses `--env=""`, which targets the top-level environment explicitly; Wrangler
warns on a bare `deploy` once any environment exists, precisely to stop someone
shipping to production by accident.

Note that `assets` and `observability` *are* inheritable, so the environments do
not repeat them. When Queues land, note that `queues` is **not** inheritable and
each environment needs its own queue names, or staging will consume production's
messages.

This was verified rather than assumed: a marker row inserted into the preview
database appeared on the preview URL and on neither staging nor production.

## 5. Migrations and rollback

Every deploy applies migrations **before** the new code goes live, so new code
never meets an old schema. The inverse window is real and unavoidable: for the
seconds between the migration and the deploy, the **old** code runs against the
**new** schema.

**Therefore migrations must be expand-then-contract, never destructive in a
single release.** Add a column, deploy code that writes both, and only remove
the old one in a later release. A migration that drops or renames a column in
the same release as the code change will fail requests during that window.

Rollback, in order of preference:

1. **Redeploy the previous version.** `wrangler versions list` then
   `wrangler versions deploy <id>`. Fast, and it does not touch data.
2. **Revert the commit** on `main` and let the pipeline deploy it.
3. **D1 Time Travel** for data. D1 retains 30 days of point-in-time recovery, so
   there is no separate backup to build:
   `wrangler d1 time-travel restore cockpit --timestamp <iso8601>`.

Because of expand-contract, (1) is safe: the previous code still runs against
the migrated schema.

## 6. Secrets and access

Secrets live in the platform, never in the repository (architecture §8.2). Per
environment, because they are non-inheritable:

```bash
wrangler secret put <NAME>                 # production
wrangler secret put <NAME> --env staging
wrangler secret put <NAME> --env preview
```

CI needs, in GitHub:

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | scoped token, created in the Cloudflare dashboard |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | `091e6e85f8268ee838089d6fed968585` |
| Variable | `CLOUDFLARE_WORKERS_SUBDOMAIN` | `vanhoutte-michael` |

**Staging and previews are gated with Cloudflare Access**, production is open.
Architecture §8.1 rejected Cloudflare Access as the *application's* authentication
for reasons that all still hold (it can never become customer auth, and its
redirects break silent `fetch`/`EventSource` refresh). Using it purely as a
perimeter on non-production environments contradicts none of that reasoning: it
is not the app's auth, it is a fence around environments that should not be
world-readable in a public repository.

Cloudflare makes this a toggle rather than per-branch work. Enabling Access on
any preview URL creates one account-level policy (`Cloudflare Workers Preview
URLs`) that covers every preview, including branches that do not exist yet;
`workers.dev` production URLs get their own per-Worker policy, so staging is
gated independently.

### A constraint to know before auth lands

**Preview URLs cannot run on a custom domain, only `workers.dev`.** So when a
custom domain is attached to production and staging, previews stay on
`workers.dev` permanently.

That matters for §8.1's Google sign-in, because **Google requires exact redirect
URIs with no wildcards**, and per-branch preview hostnames cannot each be
registered. This is unsolved and deliberately so, since auth is not built yet.
The two candidate answers when it is: a single fixed redirect endpoint that
bounces to the originating preview via signed state, or a stubbed development
session on previews only. Whichever is chosen, it must not be a code path that
can exist in production.

## 7. Bootstrap runbook

Done once, recorded so it can be redone (a new account, or a rebuild from
scratch). Everything after this is automatic via `.github/workflows/`.

```bash
# 1. three databases
wrangler d1 create cockpit
wrangler d1 create cockpit-staging
wrangler d1 create cockpit-preview
# put the returned ids into apps/api/wrangler.jsonc (they are not secrets)

# 2. schema and bootstrap data, per environment
pnpm build                                  # assets must exist before deploy
cd apps/api
wrangler d1 migrations apply cockpit          --remote --env=""
wrangler d1 migrations apply cockpit-staging  --remote --env staging
wrangler d1 migrations apply cockpit-preview  --remote --env preview
wrangler d1 execute cockpit         --remote --yes --env=""      --file=./seed.sql
wrangler d1 execute cockpit-staging --remote --yes --env staging --file=./seed.sql
wrangler d1 execute cockpit-preview --remote --yes --env preview --file=./seed.sql

# 3. the three Workers. The preview Worker is deployed once so that it exists
#    with an active deployment; thereafter CI only ever uploads versions to it.
wrangler deploy --env=""
wrangler deploy --env staging
wrangler deploy --env preview
```

Production is seeded here as a **one-time bootstrap**, not as part of the deploy
workflow: `seed.sql` creates the single tenant and the three workspaces, which
the application currently has no onboarding flow to create. When onboarding
exists, this step goes away. The staging and preview seeds are re-run by CI for
previews only; **staging is deliberately never re-seeded**, because accumulated
old data is the entire point of it.

Then, by hand in the dashboard (no API for these):

1. **Cloudflare Access** on `cockpit-staging` and on the preview URLs.
2. **A scoped API token** for CI (Workers Scripts: Edit, D1: Edit, Account
   Settings: Read), stored as the `CLOUDFLARE_API_TOKEN` GitHub secret.
3. **Branch protection** on `main` and `dev`: require CI, require a PR.

## 8. Deferred, with reasons

- **Per-tier CI jobs.** Architecture §9.1 wants L1/L2/F1/F2 split one job per
  tier so a misplaced test is visible. Cockpit is one service with one test
  file today, and testing-strategy §2 is explicit that the levels are roles
  rather than mandatory folders. The split lands with the tiers.
- **L3/F3 on merge, and the nightly contract runs** (§9.1): they land with the
  suites they would run.
- **Bundle-size gate** (§7): the budget needs recording as a number before it
  can be enforced as one.
- **Sentry, the connector watchdog, and the external uptime check** (§9.2): they
  land with the code they observe. `/health` already reports D1 connectivity and
  the production deploy asserts it.
- **Preview alias cleanup.** Aliases for deleted branches persist. Harmless
  (each serves an old version of a public showcase app behind Access) and there
  is no reaping command worth wiring today.
