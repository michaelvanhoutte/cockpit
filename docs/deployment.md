# Deployment, Environments, and Branching

How Cockpit runs on Cloudflare, which branch reaches which environment, and the
decisions behind both. Architecture §9 records *that* the platform is
Cloudflare and why; this document records *how*, and it is the runbook.

## 1. The branch model

**Decision: trunk-based, one long-lived branch.** `main` is the trunk.
Everything else is a short-lived branch with its own preview environment.
**Merging deploys to staging; production is a separate, deliberate promotion.**

```
                        ┌─ every branch gets its own Access-gated preview URL
  claude/swipe    ●───● ┤
  claude/panel  ●───●   │  squash-merge, via PR
                    ┌───┴───┐
  main ──●──────────●───────●───────●────────►  staging      (automatic; cron + queues run here)
                            │       │
                            └───────┴─ click Promote, pinned to one commit
                                       ↓
                                       production
```

| Trigger | Result |
|---|---|
| push to any branch | preview URL, Access-gated, shared preview database |
| merge PR into `main` | staging deploys automatically |
| run **Promote to production** | that commit deploys to production |

The rules:

- **`main` receives only squash-merged PRs.** A branch arrives as one commit, so
  the trunk's history reads as one line per unit of work rather than as a wall of
  "wip" and "fix typo".
- **Production is never deployed by merging.** It is a `workflow_dispatch` run of
  `.github/workflows/deploy-production.yml`, so shipping is an act rather than a
  side effect of landing a PR.
- **The promotion is pinned to a commit.** The workflow takes an optional `sha`
  input; blank means current `main` HEAD. This matters because `main` moves: if
  the promotion simply deployed "main", it would ship whatever happened to land
  between the soak and the click. The workflow also **refuses any sha that is not
  an ancestor of `main`**, so a commit that never passed CI and never ran on
  staging cannot reach production even by mistyping.
- **No hotfix branch, and no back-merge rule.** An urgent fix is an ordinary
  short-lived branch and an ordinary PR into `main`; promoting it is the same
  click as always. This is the clearest single win over a two-branch model, which
  needs a `hotfix/*` path precisely because its long-lived branches can diverge.

### Why staging exists, and why it is not a branch

Staging classically solves multi-team integration, and Cockpit has one developer.
Every branch already gets a clickable environment, so staging adds nothing to
"review this change". It earns its place for a narrower and more specific reason:
**staging is the only environment besides production where cron triggers and
queue consumers run continuously against a database that accumulates state.**

Triggers attach to a Worker's *active deployment*, not to uploaded versions, so a
per-branch preview serves HTTP and will never fire a §6.3 sync cadence, never age
an OAuth token into needing a refresh, never trip the §9.2 dead-man's switch, and
never meet a migration applied to a table that already has rows in it. Those are
precisely the failure modes architecture §9.2 calls hardest to detect.

The insight that shapes this document: **that argument justifies a staging
*environment*, not a staging *branch*.** An earlier draft gave staging its own
long-lived `dev` branch, which bought the soak at the price of two branches to
keep in sync, a promotion merge, and a `hotfix/*` path with a mandatory
back-merge. Pointing staging at the trunk and making production a promotion buys
the same soak for one branch: every commit on `main` soaks automatically, and the
gate moved from "which branch is it on" to "has someone chosen to ship it".

**Rejected: Git Flow** (`develop` + `release/*` + version tags). Release branches
exist to coordinate a versioned artifact shipped to people who install it.
Cockpit is one continuously-deployed Worker, so the whole apparatus would be
ceremony with no user for it.

**Rejected: `main` auto-deploying straight to production.** The simplest possible
model, and the one to fall back to if promotion ever becomes a rubber stamp. It
is rejected while the background-jobs layer is young: it would make production
the first place a cron trigger or queue consumer ever runs.

### Naming and commits

Branch names carry no mechanical meaning: the deploy workflow triggers on every
branch regardless of prefix. So `claude/<slug>` stays, because the slug already
says what the change is and the prefix usefully records that the branch was
agent-generated. Renaming what the agents produce would cost more than a `feat/`
prefix returns.

The changelog value people want from branch prefixes actually lives in commit
messages, so it is taken there instead: **Conventional Commits on the
squash-merge message into `main`.** Squashing lets the message be written at merge
time, which means exactly one well-formed commit per feature, authored
deliberately, with no commitlint hook to install and nothing for an agent to get
wrong.

## 2. The environments

| | Deployed by | Worker | Database | Cron/Queues | URL | Access |
|---|---|---|---|---|---|---|
| **production** | manual promotion | `cockpit` | `cockpit` | yes | `cockpit.vanhoutte-michael.workers.dev` | gated |
| **staging** | every commit on `main` | `cockpit-staging` | `cockpit-staging` | yes | `cockpit-staging.vanhoutte-michael.workers.dev` | gated |
| **preview** | every push to any other branch | `cockpit-preview`, one version per branch | `cockpit-preview`, shared | no | `<alias>-cockpit-preview.vanhoutte-michael.workers.dev` | gated |

**Every environment is gated, `/health` excepted.** There is no public instance;
the showcase is this repository, not a running app holding real mail and messages.

Production therefore **lags `main` by design**, by however many commits have been
merged but not promoted. `git log <promoted-sha>..main` is the answer to "what is
merged but not live"; the promotion run's summary records which commit shipped.

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

Every branch except `main` gets one, triggered on `push` rather than
`pull_request` so that a draft PR, or a branch with no PR at all, is deployed
too.

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

Promotion interacts with this in one direction only, and it is worth being
explicit about. Promoting a commit several ahead of production applies every
pending migration in order, which is fine. **Promoting an earlier commit does not
un-apply anything**, because migrations only roll forward. So a rollback by
promotion runs old code against a newer schema, which is exactly the case
expand-contract makes safe and destructive migrations make fatal.

Rollback, in order of preference:

1. **Re-promote the previous commit.** Run *Promote to production* with the
   previous `sha`. Fast, and it touches no data. Safe because of expand-contract.
2. **Redeploy the previous Worker version** without going through git:
   `wrangler versions list` then `wrangler versions deploy <id>`. Use when the
   commit that shipped is not obvious.
3. **Revert the commit** on `main`, let staging pick it up, then promote it. The
   slowest, and the right one when the bad change should also leave the trunk.
4. **D1 Time Travel** for data. D1 retains 30 days of point-in-time recovery, so
   there is no separate backup to build:
   `wrangler d1 time-travel restore cockpit --timestamp <iso8601>`.

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
| Secret | `CLAUDE_CODE_OAUTH_TOKEN` | stored by `/install-github-app`, run once from an interactive Claude Code session |
| Variable | `CLOUDFLARE_WORKERS_SUBDOMAIN` | `vanhoutte-michael` |

`CLAUDE_CODE_OAUTH_TOKEN` deploys nothing: it is what the review and `@claude` workflows
authenticate with, and it is listed here because this is the table someone reads
when standing up the repository, and a missing secret there presents as a workflow
that goes green having done nothing. The readme's *Development automation* section
has the rest of what those two workflows need.

**All three environments are gated with Cloudflare Access, production included.**

**This is a recorded reversal.** An earlier draft of this document gated staging
and previews but left production open, reasoning that production is the showcase.
That was backwards, and the owner corrected it: **the showcase is this repository**
(the decisions, the architecture, the arguments), not a running instance. The
production instance is the one holding real Gmail, Slack and Notion content pulled
in by connectors, which makes it the *most* sensitive environment rather than the
least, and §8.1's app login does not exist yet, so without Access it has no
authentication whatsoever. Previews, by contrast, hold `seed.sql` fixtures.

Cloudflare makes this a toggle rather than per-branch work. Enabling Access on any
preview URL creates one account-level policy (`Cloudflare Workers Preview URLs`)
that covers every preview, including branches that do not exist yet; each
`workers.dev` URL gets its own per-Worker policy, so production and staging are
gated independently of each other.

### `/health` must stay outside the gate

Two things depend on reaching `/health` unauthenticated, and both break silently
without it: the post-deploy assertion in the deploy workflows, and §9.2's external
uptime check, which is deliberately the only observability layer not running on the
app's own code. `/health` returns `{"ok":true,"db":true}` and nothing else, so it
discloses only whether the database answered.

The recipe, which is fiddly enough to be worth writing down exactly:

**One** Access application (Zero Trust → Access → Applications → self-hosted)
holding **two destinations**, one policy, covering both environments (an app takes
up to five destinations):

| Subdomain | Domain | Path |
|---|---|---|
| `cockpit` | `vanhoutte-michael.workers.dev` | `health` |
| `cockpit-staging` | `vanhoutte-michael.workers.dev` | `health` |

with a single policy: Action **Bypass**, Include **Everyone**.

Three traps, each of which cost a wrong turn:

- **Use the "public hostname" destination, not the "Workers" one.** The Workers
  destination type is whole-Worker only (`A Worker's production and preview URLs`)
  and offers no path field, so a Bypass on it would unprotect the entire Worker.
  The public-hostname row is `<subdomain>.<domain>/<path>`, and
  `vanhoutte-michael.workers.dev` appears in the domain dropdown, so "switch to
  custom input" is not needed.
- **An application with a destination and no policy denies everything.** Policies
  are default-deny, so a half-finished bypass app makes `/health` *less*
  reachable, not more. Create the policy before wondering why the deploy broke.
- **Name it distinctly.** The one-click Worker toggles create their own
  applications named after the Workers, so an app called `cockpit` that is
  actually the hole in the perimeter is a trap for later. `Cockpit /health
  (public)` or similar.

Previews need none of this: `deploy-preview.yml` runs no health check.

`scripts/health-check.sh` detects the gated case and names this fix, rather than
failing with an unexplained parse error on an HTML login page.

**Verified 2026-08-13**, from outside, unauthenticated:

| | `/` | `/v1/workspaces` | `/health` |
|---|---|---|---|
| production | 302 → Access | 302 → Access | 200 `{"ok":true,"db":true}` |
| staging | 302 → Access | 302 → Access | 200 `{"ok":true,"db":true}` |
| preview alias | 302 → Access | — | 302 → Access |

All challenges redirect to `conselit.cloudflareaccess.com`. Two things this
settles that the documentation does not state: **a path-scoped public-hostname
destination does take precedence over a whole-Worker Access app on a
`workers.dev` hostname**, and **the `*-cockpit-preview` wildcard covers aliases
created after Access was enabled** (tested by uploading a fresh alias and
confirming it was challenged).

### The cost of gating production, stated plainly

§8.1 rejected Cloudflare Access as the *application's* authentication, and one of
its reasons now applies to us directly: **Access's expired-session redirects to an
HTML login page break silent `fetch` and `EventSource` refresh.** Cockpit
revalidates on focus and holds an SSE stream open (§5.2), so when an Access session
expires, the client gets HTML where it expects JSON or events. On the installed
phone PWA that presents as an inbox that quietly stopped updating.

**A second, sharper case: requests the browser makes with credentials omitted.**
The web app manifest is fetched that way by specification unless its `<link>`
carries `crossorigin="use-credentials"`, so behind Access it went out with no
session cookie, was redirected to `conselit.cloudflareaccess.com`, and was then
rejected by the browser as a cross-origin redirect with no
`Access-Control-Allow-Origin` — surfacing as a CORS error, which is what makes it
so misleading to diagnose. Fixed by `useCredentials: true` in
[apps/web/vite.config.ts](../apps/web/vite.config.ts). Two things worth carrying
forward: **a valid session does not help here**, because the cookie is never
offered, so the long-session mitigation below does not touch this class; and
manifest *icon* fetches are a separate path that this attribute does not govern,
so whether install and splash artwork resolve behind Access is untested.

Two mitigations, neither of which is a fix, and note the first covers only the
expiry case above:

- **Set a long Access session duration** (up to one month) so expiry is rare.
- **Treat this as interim.** It is the perimeter that exists *because* §8.1 has not
  been built. When the OIDC flow lands, Access on production should be
  reconsidered rather than left in place by inertia: it would then be a second
  gate in front of the app's own, and the §8.1 rejection reasons (tenancy left
  unexercised, cannot become customer auth) start applying for real as soon as a
  second user exists.

This does **not** reverse §8.1. Access here is a perimeter around a deployment, not
the application's identity model, and it buys time rather than a design.

The Zero Trust team domain is `conselit.cloudflareaccess.com`. It is account-wide
rather than per-project (the same account runs conselit.be and the task-creator
worker), which is why it is named after the owner and not after this app.

### Two known gaps in the perimeter

Recorded rather than fixed, both deliberately:

1. **The Worker does not validate the Access JWT.** Cloudflare's own guidance is to
   verify `Cf-Access-Jwt-Assertion` inside the Worker so that a request which
   somehow reaches it without passing Access is still rejected. Deferred because it
   means three per-environment `aud` tags, JWKS fetching, RS256 verification, and a
   local-dev bypass — throwaway code that §8.1's session handling replaces. The
   practical bypass surface is currently small (the `*-cockpit-preview` wildcard
   covers versioned preview URLs, and no service bindings or extra routes exist),
   and production holds `seed.sql` fixtures rather than real mail.

   **The trigger to close this is the first connector landing.** Real Gmail or
   Slack content in the production database changes the calculation, and that is
   the same moment §8.1 becomes urgent, so the two should be done together.

   Note the distinction that makes this safe to defer: validating the JWT as a
   *gate* is defence in depth, whereas reading its email claim to decide *who the
   user is* is the §8.1 path that was rejected. Only the first is being deferred;
   the second should not be built at all.

2. **Access on a `workers.dev` URL does not cover a custom domain.** If a custom
   domain is ever attached to production (§6 contemplates it), the app becomes
   publicly reachable on the new hostname while the dashboard still reports Access
   as enabled on the `workers.dev` one. Gating a custom domain is a separate Access
   application. This is an easy and quiet mistake, which is why it is written down
   here rather than left to be remembered.

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

**Already executed on 2026-08-13**, against Cloudflare account
`091e6e85f8268ee838089d6fed968585`, subdomain `vanhoutte-michael`. Recorded so it
can be redone on a new account or rebuilt from scratch, not as pending work.
Everything after this is automatic via `.github/workflows/`.

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

Then, by hand (no API, or deliberately not automated):

1. **Cloudflare Access** on all three Workers, production included, plus a
   **Bypass policy scoped to `/health`** so the deploy checks and the §9.2 uptime
   monitor can still reach it. Dashboard only. Enabling it on any one preview URL
   creates a single account-level policy covering every preview, including
   branches that do not exist yet. Set a long session duration; see §6 for why.
2. **A scoped API token** for CI (Workers Scripts: Edit, D1: Edit, Account
   Settings: Read), stored as the `CLOUDFLARE_API_TOKEN` GitHub secret.
3. **Branch protection** on `main`. The payload lives in
   [.github/branch-protection.json](../.github/branch-protection.json) rather than
   only in a dashboard, because configuration nobody can review or restore is not
   really configuration. Apply it with:

   ```
   gh api -X PUT repos/michaelvanhoutte/cockpit/branches/main/protection --input .github/branch-protection.json
   ```

   Reading the settings, since the JSON cannot carry comments:

   - **`required_approving_review_count: 0`** — require a PR, but zero approvals.
     GitHub forbids approving your own PR, so requiring even one review locks a
     single-developer repository out of its own trunk.
   - **`strict: false`** — do *not* require branches to be up to date before
     merging. It would force an "Update branch" click every time `main` moves, and
     the semantic conflict it guards against (two branches that each passed CI
     alone) is exactly what staging catches. A bad merge reaches staging, never
     production, because production is a separate promotion.
   - **`contexts`** — the four job names in `ci.yml`. They must match exactly.
   - **`required_linear_history: true`** — makes §1's squash-merge rule mechanical
     rather than remembered, per the preference for violations that are impossible
     over violations caught in review.
   - **`enforce_admins: false`** — keeps an admin escape hatch for emergencies,
     safe for the same reason `strict: false` is.

   *Requires the repository **owner** account.* A collaborator with `push` cannot
   do this, and the branch-protection API answers `404` rather than `403` when the
   caller lacks admin, which reads as "wrong URL" and sends you looking in the
   wrong place. Not the same thing as the Cloudflare credentials.

### Commit attribution

Commits must be authored with an email GitHub can link to the account, or they are
orphaned: no profile link, no contribution graph, no author. This repository has
history in exactly that state, from a `user.email` that was a bare username with
no `@`. The fix, and the right setting for a public repository:

```
git config --global user.email "43439790+michaelvanhoutte@users.noreply.github.com"
```

The `users.noreply.github.com` form is preferred over a real address for three
reasons: it links commits correctly, it keeps a real address out of a public
repository where it would be scraped, and it is bound to the GitHub account rather
than to any mail provider, so it survives changing employer or email.

## 8. Deferred, with reasons

- **Per-tier CI jobs.** Architecture §9.1 wants L1/L2/F1/F2 split one job per
  tier so a misplaced test is visible. Cockpit is one service with one test
  file today, and testing-strategy §2 is explicit that the levels are roles
  rather than mandatory folders. The split lands with the tiers.
- **L3 on merge, and the nightly contract runs** (the CI/CD section of the
  architecture, §9.1): they land with the suites they would run. F3 no longer
  waits — the browser tier runs as its own `E2E (F3)` job on every pull request
  and on `main`, against its own isolated local stack, never the `pnpm dev`
  pair.
- **F3 against a deployed preview.** The suite already takes `E2E_BASE_URL` and
  the `CF-Access-Client-*` header pair, so pointing it at a branch's preview is
  configuration rather than code. What is missing is the credential: Access
  fronts every deployment (secrets and access, §6) and no **service token**
  exists yet, so an
  unauthenticated run would test the login page. Creating one (Zero Trust →
  Access → Service Auth, then a policy on the preview application that accepts
  it) is owner work, and the preview-deploy job that uses it lands with it.
  Until then the local pair is the only thing F3 drives, which leaves the
  service worker, the built bundle and the Worker's own asset routing proven by
  nothing but a manual look.
- **Bundle-size gate** (§7): the budget needs recording as a number before it
  can be enforced as one.
- **Sentry, the connector watchdog, and the external uptime check** (§9.2): they
  land with the code they observe. `/health` already reports D1 connectivity and
  the production deploy asserts it.
- **Preview alias cleanup.** Aliases for deleted branches persist. Harmless
  (each serves an old version of a public showcase app behind Access) and there
  is no reaping command worth wiring today.
