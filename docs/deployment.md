# Deployment, Environments, and Branching

How Cockpit runs on Cloudflare, which branch reaches which environment, and the
decisions behind both. Architecture §9 records *that* the platform is
Cloudflare and why; this document records *how*, and it is the runbook.

## 1. The branch model

**Decision: trunk-based, one long-lived branch.** `main` is the trunk;
everything else is a short-lived branch, gated on every push and deployed
nowhere (§4). **Merging deploys to staging; production is a separate,
deliberate promotion.**

```
  claude/swipe    ●───● ┐
  claude/panel  ●───●   │  gates run per push; nothing is deployed
                    ┌───┴───┐
  main ──●──────────●───────●───────●────────►  staging      (automatic; cron + queues run here)
                            │       │
                            └───────┴─ click Promote, pinned to one commit
                                       ↓
                                       production
```

| Trigger | Result |
|---|---|
| push to any branch | the gates run; nothing is deployed |
| merge PR into `main` | staging deploys automatically |
| run **Promote to production** | that commit deploys to production |

The rules:

- **`main` receives only squash-merged PRs**, so the trunk reads as one commit per unit of work.
- **Production is never deployed by merging.** It is a `workflow_dispatch` run of
  `.github/workflows/deploy-production.yml`, so shipping is an act rather than a side effect.
- **The promotion is pinned to a commit.** The workflow takes an optional `sha`
  (blank means current `main` HEAD), because `main` moves and deploying "main"
  would ship whatever landed between the soak and the click. It **refuses any sha
  that is not an ancestor of `main`**, so a commit that never passed CI cannot
  reach production by mistyping.
- **No hotfix branch, and no back-merge rule.** An urgent fix is an ordinary
  branch and an ordinary PR; promoting it is the same click. This is the clearest
  win over a two-branch model, which needs a `hotfix/*` path precisely because its
  long-lived branches can diverge.

### Why staging exists, and why it is not a branch

Staging classically solves multi-team integration, and Cockpit has one developer.
Since §4 it is also the first place a change runs deployed at all. It earns its
place for a narrower reason: **staging is the only environment besides production
where cron triggers and queue consumers run continuously against a database that
accumulates state.** Nothing else runs long enough to age an OAuth token into a
refresh, trip the dead-man's switch, or meet a migration applied to a table that
already has rows — precisely the failure modes architecture's "Observability"
calls hardest to detect.

**That argument justifies a staging *environment*, not a staging *branch*.** An
earlier draft gave staging its own long-lived `dev` branch, buying the soak at the
price of two branches to keep in sync, a promotion merge and a `hotfix/*` path
with a mandatory back-merge. Pointing staging at the trunk buys the same soak for
one branch, and the gate moves from "which branch is it on" to "has someone chosen
to ship it".

**Rejected: Git Flow.** Release branches coordinate a versioned artifact shipped
to people who install it; Cockpit is one continuously-deployed Worker.

**Rejected: `main` auto-deploying to production.** The simplest model, and the one
to fall back to if promotion becomes a rubber stamp. Rejected while the
background-jobs layer is young, because it would make production the first place a
cron trigger or queue consumer ever runs.

### Naming and commits

Branch names carry no mechanical meaning — the workflows trigger on every branch
regardless of prefix — so `claude/<slug>` stays: the slug says what the change is
and the prefix records that it was agent-generated.

The changelog value people want from branch prefixes is taken in commit messages
instead: **Conventional Commits on the squash-merge message into `main`**. Writing
the message at merge time gives exactly one well-formed commit per feature, with
no commitlint hook to install and nothing for an agent to get wrong.

## 2. The environments

| | Deployed by | Worker | Database | Cron/Queues | URL | Access |
|---|---|---|---|---|---|---|
| **production** | manual promotion | `cockpit` | `cockpit` | yes | `cockpit.vanhoutte-michael.workers.dev` | gated |
| **staging** | every commit on `main` | `cockpit-staging` | `cockpit-staging` | yes | `cockpit-staging.vanhoutte-michael.workers.dev` | gated |

There is no third environment; branches are deployed nowhere (§4).

**Every environment is gated, `/health` excepted.** There is no public instance:
the showcase is this repository, not a running app holding real mail and messages.

Production therefore **lags `main` by design**. `git log <promoted-sha>..main`
answers "what is merged but not live"; the promotion run's summary records which
commit shipped.

Two D1 databases, out of the free plan's ten. The two thresholds that would force
the $5/month Workers Paid plan, recorded so they are recognised rather than
rediscovered: **a database crossing 500 MB** (or 5 GB across both), and **needing
queue retention beyond 24 hours**. Cloudflare Queues moved onto the free plan in
February 2026, so it is no longer a reason to upgrade on its own.

## 3. One Worker serves the whole application

Not Pages plus a separate API Worker. One Worker per environment serves the Hono
API, the SSE stream, the queue consumers, the cron triggers and the built SPA, via
[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).
One deploy, one origin, no CORS, and no split-brain about which half of the app a
request belongs to. It is also the current Cloudflare answer: Pages is being
absorbed into Workers.

The routing rule lives in `apps/api/wrangler.jsonc`:

- `run_worker_first: ["/v1/*", "/health", "/ingress/*"]` sends exactly those three prefixes to the Worker.
- Everything else is served from `apps/web/dist` **before the Worker runs**, so a cold page load bills no Worker invocation.
- `not_found_handling: "single-page-application"` returns `index.html` for unmatched paths, so client-side routes deep-link.

Those three prefixes are also the first three the service worker refuses to
intercept (`navigateFallbackDenylist` in `apps/web/vite.config.ts`), and **for
this application's own prefixes the two lists must be kept in sync.**

**They are not the same list, and the difference is load-bearing.** The denylist
carries a fourth, `/cdn-cgi/`, which must never appear here: it is Cloudflare's,
answered by Access at the edge. Leaving it out of the denylist is what stopped
signing in from ever finishing — Access ends a sign-in by redirecting to
`/cdn-cgi/access/authorized`, the cached shell answered that navigation, and the
cookie was never set.

Because `assets.directory` points at `../web/dist`, the web app must be built
before the API is deployed or run with `wrangler dev`. `pnpm build` first.

## 4. No branch environments

**Removed, deliberately.** A branch used to get its own Access-gated URL on every
push. It cannot any more, and rebuilding the capability costs more than it is
worth. Both halves are argued below, because "we deleted the preview environment"
reads as neglect a year later.

Gone: `deploy-preview.yml`, the `cockpit-preview` Wrangler environment,
`scripts/branch-alias.sh` and the CI step that asserted it. What replaces it is
nothing — a push runs the gates in `ci.yml` and deploys nowhere.

### Why it could not stay

Cloudflare does not generate version preview URLs for a Worker that implements a
Durable Object, and since "Account data moves into a per-account store" (issue 84)
this one does. Mechanism and symptoms below.

### Why nothing replaced it

| | Click through before merge | Cost |
|---|---|---|
| Keep the job as a rehearsal, no URL | no | a workflow that deploys nothing anyone can see |
| A Worker per branch, every push | yes | per-environment Access, lifecycle, on every push |
| A Worker per branch, on request | yes | per-environment Access, lifecycle, when asked |
| **Remove it** | no | no rehearsal against real Cloudflare before merge |

The two that keep the capability founder on the same thing, and it is not
lifecycle: **a branch Worker cannot be gated cheaply** (below). Between the two
that give it up, the rehearsal is the smaller loss and the larger residue — a
workflow, a database, a Worker and an alias script kept alive for a green check
nobody looks at. Removing it leaves nothing to explain.

### What it costs, stated plainly

**Nothing is deployed anywhere until a branch merges.** A migration or
configuration that fails only against the real platform now surfaces on
**staging, after the merge**: `main` is briefly a commit whose staging deploy is
red, and the fix is an ordinary branch and an ordinary pull request.

That is not hypothetical — the Durable Object migration error below was caught
before merge by exactly the step this section removes. The trade is accepted with
that example in view: one deploy-time surprise per platform limitation, against a
workflow, a Worker, a database and an Access policy maintained permanently.

**What still gates a branch:** `ci.yml` on every push — typecheck, the fast test
tiers, the browser tier against its own local stack, the build, the script tests
and the concept registry. Nothing about *code* correctness moved.

### Removing the infrastructure

The repository no longer references them, but the `cockpit-preview` Worker and D1
database still exist on Cloudflare, along with any Access application scoped to
them. Deleting them is **one-time and irreversible**, done by hand because nothing
here should be able to delete infrastructure on its own:

```bash
wrangler delete cockpit-preview
wrangler d1 delete cockpit-preview
```

Neither holds anything but `seed.sql` fixtures, and leaving them costs nothing but
a stale dashboard row, so this is cleanup rather than a requirement.

### Preview URLs and Durable Objects are mutually exclusive

**Measured, then confirmed against Cloudflare's
[preview URLs page](https://developers.cloudflare.com/workers/configuration/previews/):**

> Preview URLs are not generated for Workers that implement a Durable Object,
> including Containers and Sandbox Workers.

**How it presents is the dangerous part.** `wrangler versions upload` still
succeeds, so the Preview check passes — it asserts that the upload happened, not
that anything is reachable. The workflow then *constructs* the alias URL from the
alias it passed rather than reading one back from Wrangler, and comments it on the
pull request. So a pull request carries a green check and a URL that looks right
and answers with a placeholder. The tell in the log is that Wrangler prints no
`Version Preview URL:` line at all.

### Gating a branch Worker costs what previews did not

**The account-level Access policy does not reach a branch Worker**, and no naming
or wildcard makes it. Two facts, both from Cloudflare: Access on a `workers.dev`
URL protects
[one Worker's production URL, its preview URLs, or both](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) —
it is per Worker; and
[`.workers.dev` does not support wildcard subdomains](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
so one application cannot stand in front of every branch Worker the way
`Cloudflare Workers Preview URLs` stands in front of every preview URL. That
account-level policy was a property of **preview URLs specifically**, so a branch
Worker inherits nothing.

Three shapes remain and none is free:

- **Create and delete an Access application per environment from the workflow.**
  Doable through the API, and it widens the CI token from Workers and D1 to
  Access. Its failure mode is the one §6 exists to prevent: an application that is
  not created leaves an unauthenticated instance of this app on the public
  internet, and nothing about the deploy looks wrong when that happens.
- **Move branch environments to a custom domain**, where one wildcard application
  covers them all. The documented answer, and a bigger one-time setup: a zone, DNS
  and custom-domain routing.
- **Accept public branch environments.** They hold `seed.sql` fixtures, which is
  the argument §6 already makes about previews — but §6 gates them anyway, and
  that reversal was the owner's.

This is what reopened §4, and it is recorded here rather than in a commit message
because the cost is the decision.

### A Durable Object class cannot be introduced by a preview

**Measured, not inferred**, on the first preview deploy that carried one:

```
Version upload failed. You attempted to upload a version of a Worker that
includes a Durable Object migration, but migrations must be fully applied via
a non-versioned deployment. [code: 10211]
```

Previews use `wrangler versions upload`, and Cloudflare will not apply a Durable
Object migration through it. Staging and production are unaffected: both run
`wrangler deploy`, which applies migrations as part of the deploy.

So a **new** Durable Object class had to reach the preview Worker once by hand,
**from the branch that introduces the class** — the command deploys the working
tree you are standing in, and a tree without the class introduces nothing:

```bash
# from the repository root of that branch's checkout or worktree
pnpm --filter @cockpit/api exec wrangler deploy --env <that Worker's environment>
```

`pnpm ... exec` because `wrangler` is a devDependency of `apps/api`; it also needs
`apps/web/dist` to exist, so `pnpm build` first if it is missing.

**Written as history, not as an instruction:** §4 removed the environment this was
run against, and nothing uploads a version any more. It is kept because the rule
outlives its cause — a Durable Object migration cannot travel by version upload,
and the next thing that uploads one will meet it, whether that is a returning
preview or a gradual deployment.

The same held for account data, more sharply: every preview version ran under the
one preview Worker, sharing its Durable Object namespace and therefore the *same*
account store, so a branch adding a change to `apps/api/src/accounts/changes.ts`
applied it to the store every other branch was reading.

**What is genuinely given up:** two branch environments with incompatible
migrations to the *register* will collide, because a migration applied by one is
immediately visible to every other. There is no mitigation, only a detection
story — deploying applies migrations first, so the branch that breaks is the
branch that notices. If this bites, the recorded escalation is per-branch
databases on the Workers Paid plan.

### The footgun this configuration exists to defuse

**Preview versions inherit the top-level bindings by default, which means a
preview reads and writes the production database unless something stops it** — a
real and [documented gap](https://github.com/cloudflare/cloudflare-docs/issues/23377)
people hit after migrating from Pages.

What stops it here: `d1_databases` is a **non-inheritable** Wrangler config key,
so each `[env.*]` block declares its own database, and every deploy command passes
`--env` explicitly rather than relying on `CLOUDFLARE_ENV`. Production uses
`--env=""`, which targets the top-level environment explicitly; Wrangler warns on
a bare `deploy` once any environment exists, precisely to stop an accidental
production ship.

`assets` and `observability` *are* inheritable, so environments do not repeat
them. When Queues land, note that `queues` is **not** inheritable and each
environment needs its own queue names, or staging will consume production's
messages.

Verified rather than assumed: a marker row inserted into the preview database
appeared on the preview URL of the day and on neither staging nor production.

## 5. Migrations and rollback

**This section is about the register.** An account's own store is brought up to
date lazily, by the first request that opens it after a deploy, because nothing
can reach a Durable Object before one exists. Two consequences for any change to
`apps/api/src/accounts/changes.ts`: a change that will not apply takes down every
account, one at a time as each is opened, so the deploy-time gate D1 gives for
free is not there; and **a change that has shipped must never be edited**, because
accounts that already applied it will not apply it again.

The gate that replaces the deploy-time one is
`apps/api/tests/integration/accounts/aged-store.test.ts`: it brings a store no
account owns up to every point in the list, fills it with rows, and applies the
rest. A test rather than a workflow step, because `pnpm test` already runs before
both deploys, so a red one already stops the deploy. **An update that creates a
table needs a row adding to that file's fixtures in the same change**, or the next
update meets an empty table and the gate quietly goes back to proving what opening
a new account already proves.

Every deploy applies migrations **before** the new code goes live, so new code
never meets an old schema. The inverse window is real and unavoidable: for the
seconds between the migration and the deploy, the **old** code runs against the
**new** schema.

**Therefore migrations must be expand-then-contract, never destructive in a single
release.** Add a column, deploy code that writes both, remove the old one in a
later release. A migration that drops or renames a column in the same release as
the code change will fail requests during that window.

Promotion interacts with this in one direction. Promoting a commit several ahead
applies every pending migration in order, which is fine. **Promoting an earlier
commit does not un-apply anything**, so a rollback by promotion runs old code
against a newer schema — exactly the case expand-contract makes safe and
destructive migrations make fatal.

Rollback, in order of preference:

1. **Re-promote the previous commit.** Fast, touches no data, safe because of expand-contract.
2. **Redeploy the previous Worker version** without git: `wrangler versions list` then `wrangler versions deploy <id>`. Use when the commit that shipped is not obvious.
3. **Revert the commit** on `main`, let staging pick it up, then promote. The slowest, and right when the bad change should also leave the trunk.
4. **D1 Time Travel** for data — 30 days of point-in-time recovery, so there is no separate backup to build: `wrangler d1 time-travel restore cockpit --timestamp <iso8601>`.

## 6. Secrets and access

Secrets live in the platform, never in the repository. Per environment, because
they are non-inheritable:

```bash
wrangler secret put <NAME>                 # production
wrangler secret put <NAME> --env staging
```

CI needs, in GitHub:

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | scoped token, created in the Cloudflare dashboard |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | `091e6e85f8268ee838089d6fed968585` |
| Secret | `CLAUDE_CODE_OAUTH_TOKEN` | stored by `/install-github-app`, run once from an interactive Claude Code session |
| Variable | `CLOUDFLARE_WORKERS_SUBDOMAIN` | `vanhoutte-michael` |

`CLAUDE_CODE_OAUTH_TOKEN` deploys nothing — it is what the review and `@claude`
workflows authenticate with — and it is listed here because a missing secret
presents as a workflow that goes green having done nothing. The readme's
*Development automation* section has the rest.

**Both environments are gated with Cloudflare Access, production included.**

**This is a recorded reversal.** An earlier draft left production open, reasoning
that production is the showcase. That was backwards, and the owner corrected it:
**the showcase is this repository**, not a running instance. Production is the one
holding real Gmail, Slack and Notion content, which makes it the *most* sensitive
environment, and the proof-of-identity half of "App login" does not exist yet — so
without Access it has no authentication whatsoever, Cockpit's own sign-in being a
list of names anybody reaching the URL could click.

Each `workers.dev` URL gets its own per-Worker policy, so production and staging
are gated independently. There is also an account-level `Cloudflare Workers
Preview URLs` policy covering every *preview URL* at once, which is what used to
make previews free to gate and what nothing replaced when they went (§4).

### `/health` must stay outside the gate

Two things depend on reaching `/health` unauthenticated and both break silently
without it: the post-deploy assertion in the deploy workflows, and the external
uptime check, deliberately the only observability layer not running on the app's
own code.

`/health` returns `{"ok":true,"register":true,"store":true}` and nothing else, so
it discloses only whether each half answered — never *why* one did not, since the
reason an update will not apply names tables and columns and this endpoint answers
anyone. That reason goes to the logs.

`store` is checked against a store belonging to no account, addressed by a name
the same request confirms is absent from the register. An unauthenticated endpoint
must not open somebody's data to decide whether a deploy was safe, and this one
structurally cannot: it never goes through `openAccount`.

**The first request after a deploy is the one that does the work**, because that
is when the store applies outstanding changes, so `/health` can legitimately
answer `store: false` for a moment and be well immediately after (observed on the
deploy of a762ff1: unwell ten seconds after, healthy on every ask afterwards). The
post-deploy check therefore asks until the deployment says it is well or a minute
is up, and reports how many attempts it took; a redirect or a login page is not
waited on, since no amount of asking again puts a Bypass policy back. Whether that
first-touch failure is a race or something to fix is unsettled — the attempt count
in the deploy log is the evidence.

The recipe, fiddly enough to be worth writing down exactly. **One** Access
application (Zero Trust → Access → Applications → self-hosted) holding **two
destinations**, one policy, covering both environments:

| Subdomain | Domain | Path |
|---|---|---|
| `cockpit` | `vanhoutte-michael.workers.dev` | `health` |
| `cockpit-staging` | `vanhoutte-michael.workers.dev` | `health` |

with a single policy: Action **Bypass**, Include **Everyone**. Three traps, each
of which cost a wrong turn:

- **Use the "public hostname" destination, not the "Workers" one.** The Workers
  type is whole-Worker only and offers no path field, so a Bypass on it would
  unprotect the entire Worker.
- **An application with a destination and no policy denies everything.** Policies
  are default-deny, so a half-finished bypass app makes `/health` *less*
  reachable, not more.
- **Name it distinctly.** The one-click Worker toggles create their own
  applications named after the Workers, so an app called `cockpit` that is
  actually the hole in the perimeter is a trap for later.

`scripts/health-check.mjs` detects the gated case and names this fix rather than
failing with an unexplained parse error on an HTML login page.

**Verified 2026-08-13**, from outside, unauthenticated:

| | `/` | `/v1/workspaces` | `/health` |
|---|---|---|---|
| production | 302 → Access | 302 → Access | 200 `{"ok":true,...}` |
| staging | 302 → Access | 302 → Access | 200 `{"ok":true,...}` |
| preview alias | 302 → Access | — | 302 → Access |

The preview row records a test that was run, not a live environment. All
challenges redirect to `conselit.cloudflareaccess.com`. Two things this settles
that the documentation does not state: **a path-scoped public-hostname destination
does take precedence over a whole-Worker Access app on a `workers.dev` hostname**,
and **the `*-cockpit-preview` wildcard covered aliases created after Access was
enabled**. The second is what made previews free to gate.

### The cost of gating production, stated plainly

Gating costs one thing concretely: **Access's expired-session redirects to an HTML
login page break silent `fetch` and `EventSource` refresh.** Cockpit revalidates on
focus and holds an SSE stream open, so an expired Access session hands the client
HTML where it expects JSON or events.

**Amended 2026-08-31, for reads and for the push stream.** The client now
recognises the case: it asks `/health` — outside the gate, so an answer proves the
deployment is healthy and the fault is this browser's sign-in — then sends itself
through `/v1/relogin`, which Access challenges and which hands the browser back to
the page it came from. The push stream recovers by a related route, since
`EventSource` abandons a badly-answered connection after one attempt: the client
reopens on a backoff and runs the same check.

**A second, sharper case: requests the browser makes with credentials omitted.**
The web app manifest is fetched that way by specification unless its `<link>`
carries `crossorigin="use-credentials"`, so behind Access it went out with no
session cookie, was redirected to `conselit.cloudflareaccess.com`, and was
rejected by the browser as a cross-origin redirect with no
`Access-Control-Allow-Origin` — surfacing as a CORS error, which is what makes it
misleading to diagnose. Fixed by `useCredentials: true` in
[apps/web/vite.config.ts](../apps/web/vite.config.ts). Three things to carry
forward: **a valid session does not help here**, because the cookie is never
offered; **the recovery above does not reach it either**, because nothing was
refused and so nothing asks why; and manifest *icon* fetches are a separate path
this attribute does not govern, so whether install artwork resolves behind Access
is untested.

Three mitigations, of which only the first is a fix, and it covers the expiry case
rather than the credentials-omitted one:

- **Recover in the client**, as above. It removes the dead-end, not the interruption.
- **Set a long Access session duration** (up to one month) so expiry is rare.
- **Treat this as interim.** The perimeter exists *because* the proof-of-identity
  half of "App login" has not been built. **The trigger to reconsider it is
  password or OAuth login shipping — not signing in.** Cockpit has had its own
  sign-in, session and request gate since issue 86, and that changes nothing here:
  clicking a name off a list is an identity selector, not an authentication
  control. When the OIDC flow lands, Access on production should be reconsidered
  rather than left in place by inertia — it would then be a second gate in front
  of the app's own.

This does **not** reverse the architecture decision. Access here is a perimeter
around a deployment, not the application's identity model, and it buys time rather
than a design.

The Zero Trust team domain is `conselit.cloudflareaccess.com`, account-wide rather
than per-project (the same account runs conselit.be and the task-creator worker).

### Two known gaps in the perimeter

Recorded rather than fixed, both deliberately:

1. **The Worker does not validate the Access JWT.** Cloudflare's guidance is to
   verify `Cf-Access-Jwt-Assertion` inside the Worker so a request that somehow
   reaches it without passing Access is still rejected. Deferred because it means
   three per-environment `aud` tags, JWKS fetching, RS256 verification and a
   local-dev bypass — throwaway code that the session handling replaces. The
   practical bypass surface is small (two Workers, no service bindings, nothing
   deployed per branch) and production holds `seed.sql` fixtures.

   **The trigger to close this is the first connector landing**, which is the same
   moment "App login" becomes urgent, so the two should be done together.

   Note the distinction that makes it safe to defer: validating the JWT as a
   *gate* is defence in depth, whereas reading its email claim to decide *who the
   user is* is the path that was rejected. Only the first is deferred.

2. **Access on a `workers.dev` URL does not cover a custom domain.** If one is
   ever attached to production, the app becomes publicly reachable on the new
   hostname while the dashboard still reports Access as enabled on the
   `workers.dev` one. Gating a custom domain is a separate Access application.

### A constraint to know before auth lands

**This used to be a problem and §4 dissolved it.** Preview URLs cannot run on a
custom domain, so per-branch hostnames would have stayed on `workers.dev`
permanently — and **Google requires exact redirect URIs with no wildcards**, which
per-branch hostnames cannot each be registered for. With no per-branch hostnames
there is nothing to register beyond production and staging, whose URLs are fixed.
The cost comes back if branch environments ever return on a custom domain.

## 7. Bootstrap runbook

**Already executed on 2026-08-13**, against Cloudflare account
`091e6e85f8268ee838089d6fed968585`, subdomain `vanhoutte-michael`. Recorded so it
can be redone on a new account, not as pending work. Everything after this is
automatic via `.github/workflows/`.

`wrangler` below is the workspace's own (`apps/api`'s devDependency), so either
prefix each line with `pnpm --filter @cockpit/api exec` or run them where a global
one is installed.

```bash
# 1. two databases
wrangler d1 create cockpit
wrangler d1 create cockpit-staging
# put the returned ids into apps/api/wrangler.jsonc (they are not secrets)

# 2. schema and bootstrap data, per environment
pnpm build                                  # assets must exist before deploy
cd apps/api
wrangler d1 migrations apply cockpit          --remote --env=""
wrangler d1 migrations apply cockpit-staging  --remote --env staging
wrangler d1 execute cockpit         --remote --yes --env=""      --file=./seed.sql
wrangler d1 execute cockpit-staging --remote --yes --env staging --file=./seed.sql

# 3. the two Workers.
wrangler deploy --env=""
wrangler deploy --env staging
```

Production is seeded here as a **one-time bootstrap**, not as part of the deploy
workflow: `seed.sql` puts the accounts *and the people who own them* in the
register, neither of which the application has an onboarding flow to create. When
onboarding exists, this step goes away. **Staging is deliberately never
re-seeded**, because accumulated old data is the point of it — which means a
staging database from before issue 86 has the two new tables and no rows in
`users`, and nobody can sign in until the seed is run there once by hand.

**No sign-ins are seeded**, and `seed.sql` has no column for a secret to put in
one. Signing in is choosing a name, which proves nothing, and Cloudflare Access is
what actually authenticates a deployed environment.

**There is no seed step for an account's own data, and there cannot be.** Its
workspaces, dashboards, items and associations live in a Durable Object created by
the first request that opens it, and `wrangler d1 execute` speaks only to D1. So
the three workspaces an account starts with are its first change instead
(`apps/api/src/accounts/changes.ts`), applied inside whichever request opens the
account first. Same temporary bootstrap, in the only place that can hold it.

Then, by hand (no API, or deliberately not automated):

1. **Cloudflare Access** on both Workers, production included, plus a **Bypass
   policy scoped to `/health`** so the deploy checks and the uptime monitor can
   still reach it. Dashboard only, one per Worker; set a long session duration
   (§6). (There used to be a third, free: a single account-level policy covering
   every preview URL. It went with the previews.)
2. **A scoped API token** for CI (Workers Scripts: Edit, D1: Edit, Account
   Settings: Read), stored as the `CLOUDFLARE_API_TOKEN` GitHub secret.
3. **Branch protection** on `main`. The payload lives in
   [.github/branch-protection.json](../.github/branch-protection.json) rather than
   only in a dashboard, because configuration nobody can review or restore is not
   really configuration:

   ```
   gh api -X PUT repos/michaelvanhoutte/cockpit/branches/main/protection --input .github/branch-protection.json
   ```

   Reading the settings, since the JSON cannot carry comments:

   - **`required_approving_review_count: 0`** — require a PR, but zero approvals.
     GitHub forbids approving your own PR, so requiring one locks a
     single-developer repository out of its own trunk.
   - **`strict: false`** — do *not* require branches to be up to date before
     merging. It would force an "Update branch" click every time `main` moves, and
     the semantic conflict it guards against is exactly what staging catches; a
     bad merge reaches staging, never production.
   - **`contexts`** — eight names: five of the six jobs in `ci.yml` (Test Explorer
     publishes a report and deliberately does not gate), and three from CodeQL,
     matched exactly.

     The three are not interchangeable. `CodeQL (javascript-typescript)` and
     `CodeQL (actions)` are the matrix legs and say only that the analysis *ran*.
     The one that says it was **clean** is the third, named plainly `CodeQL` and
     posted by GitHub Advanced Security — the check that goes red on an alert at or
     above the failure threshold. Requiring the legs without it would gate on the
     analysis having happened while letting a high-severity finding merge.

     **All three names were read off a real run** ("Analyse every pull request with
     CodeQL, and let Dependabot report vulnerable dependencies", pull request 92),
     never predicted, and that ordering is the point. GitHub matches these strings
     with no idea whether anything reports under them, and a name nothing reports
     under does not go red: it sits at *Expected — waiting for status to be
     reported*, indefinitely. So when a check is added or renamed the order is
     always: merge the workflow, let it run, read the name off that run, then apply
     this payload.

     One thing to confirm, because it is not yet known: a pull request from a fork
     gets a read-only token, so its results upload may be refused — in which case
     all three CodeQL checks are unpassable from a fork and requiring them closes
     this repository to outside contribution.

     **The payload is what this file says; it is not what GitHub is enforcing.**
     Checking one in does not apply it, and the two drift silently. Measured
     2026-09-01, the payload listed eight contexts while `main` enforced four:
     `E2E (F3)` had been added to the file and never applied, so the browser tier
     had been reporting on every pull request without gating any of them. So read
     the live setting whenever the answer matters:

     ```bash
     gh api repos/michaelvanhoutte/cockpit/branches/main/protection --jq '.required_status_checks.contexts'
     ```
   - **`required_linear_history: true`** — makes §1's squash-merge rule mechanical
     rather than remembered.
   - **`enforce_admins: false`** — keeps an admin escape hatch for emergencies,
     safe for the same reason `strict: false` is.

   *Requires the repository **owner** account.* A collaborator with `push` cannot
   do this, and the branch-protection API answers `404` rather than `403` when the
   caller lacks admin, which reads as "wrong URL".

4. **The GitHub-native security controls.** Checked 2026-08-31, **secret scanning**
   and **secret scanning push protection** were already on, both free on a public
   repository, and between them they catch a committed credential before it is
   pushed rather than after.

   Two more were turned on by "Scan every pull request with CodeQL, and let
   Dependabot report vulnerable dependencies" (issue 28). Neither has a file to
   check in, so they are recorded as the commands that set them:

   ```bash
   gh api -X PUT repos/michaelvanhoutte/cockpit/vulnerability-alerts      # Dependabot alerts
   gh api -X PUT repos/michaelvanhoutte/cockpit/automated-security-fixes  # Dependabot security updates
   ```

   Reading them back takes two calls, because three of the four live on the
   repository resource and **Dependabot alerts is not one of them** — its key is
   simply absent from `security_and_analysis`, which reads exactly like "off":

   ```bash
   # secret scanning, push protection, Dependabot security updates
   gh api repos/michaelvanhoutte/cockpit --jq '.security_and_analysis'
   # Dependabot alerts: 204 when on, 404 when off, no body either way
   gh api repos/michaelvanhoutte/cockpit/vulnerability-alerts --silent && echo enabled || echo disabled
   ```

   `security_and_analysis` is only populated for a caller with admin — a non-admin
   gets `null`, which reads as "everything is off" the same way the
   branch-protection `404` reads as "wrong URL".

   **Routine dependency version updates are deliberately off.** They would need a
   `.github/dependabot.yml`, and a pull request for every dependency that falls
   behind is a steady stream, each dragging a full CI run and a Claude review
   behind it. Security updates are the ones worth that.

   **The code-scanning check-failure threshold stays at its default**, which fails
   a pull request on alerts of error, critical or high severity — what issue 28
   asked for, so the default is a decision rather than something nobody looked at.
   It is a dashboard setting with no API to read it back from.

### Commit attribution

Commits must be authored with an email GitHub can link to the account, or they are
orphaned: no profile link, no contribution graph, no author. This repository has
history in exactly that state, from a `user.email` that was a bare username with
no `@`. The fix:

```
git config --global user.email "43439790+michaelvanhoutte@users.noreply.github.com"
```

The `users.noreply.github.com` form links commits correctly, keeps a real address
out of a public repository, and is bound to the GitHub account rather than to any
mail provider.

## 8. Deferred, with reasons

- **Per-tier CI jobs.** Architecture wants the fast tiers split one job per tier
  so a misplaced test is visible; the split lands with the tiers.
- **L3 on merge, and the nightly contract runs**: they land with the suites they
  would run. F3 no longer waits — the browser tier runs as its own `E2E (F3)` job
  on every pull request and on `main`, against its own isolated local stack.
- **F3 against a deployed environment.** The suite already takes `E2E_BASE_URL`
  and the `CF-Access-Client-*` header pair, so pointing it at one is configuration
  rather than code. What is missing is the credential: Access fronts every
  deployment (§6) and no **service token** exists yet, so an unauthenticated run
  would test the login page. Creating one (Zero Trust → Access → Service Auth,
  then a policy that accepts it) is owner work. The only candidate now is staging,
  which accumulates state on purpose, so a suite asserting what is on screen would
  be running against whatever is there. Until then the local stack is the only
  thing F3 drives, which leaves the service worker, the built bundle and the
  Worker's asset routing proven by nothing but a manual look.
- **Bundle-size gate:** the budget needs recording as a number before it can be enforced as one.
- **Sentry, the connector watchdog, and the external uptime check:** they land
  with the code they observe. `/health` already reports whether the register and
  an account store can both be reached, and the production deploy asserts it.
- **~~Preview alias cleanup.~~** Gone with the previews (§4). What remains is a
  one-time tidy: the `cockpit-preview` Worker and database still exist on
  Cloudflare, and "Removing the infrastructure" has the two commands.

## 9. Diagnosing a broken environment

For the moment before you know what is wrong: a deployed environment is showing
something bad and it is not yet clear whether the deployment is broken, the
database is unreachable, or this browser simply needs to sign in again. It exists
because the likeliest failure was already predicted in the wrong genre — "The cost
of gating production" names it exactly, but nobody reads a decision's rationale
while staring at a broken page.

### First question: is it the deployment, or is it me?

One command settles it, and it is why `/health` is Bypass-policied out of the gate:

```bash
curl -i https://cockpit-staging.vanhoutte-michael.workers.dev/health
```

| Answer | Meaning | Go to |
|---|---|---|
| `200 {"ok":true,...}` | Worker up, register answering, an account store openable. The deployment is fine. | *In the browser*, below |
| `200 {"ok":false,"register":true,"store":false}` | A store would not open — most often an update that will not apply. | *At the deployment*, below |
| `200 {"ok":false,"register":false,...}` | Either D1 did not answer, **or** somebody registered an account under the health check's own name, which makes it refuse to run rather than open their data. Two faults with one shape, so read the logs — the reason is never in the body. | *At the deployment*, below |
| `200` with any other body | Something answered in front of the Worker — usually a login page, so the Bypass policy has come undone | *In the browser* |
| `301`/`302` | The Bypass policy is gone; `/health` is behind the gate | *`/health` must stay outside the gate* |
| `5xx` | The Worker is up and failing | *At the deployment*, below |
| Nothing, or a TLS error | Not reachable at all | *At the deployment*, below |

### In the browser: read the shape of the message first

Cockpit names its own failures (`apps/web/src/components/LoadFailure.tsx`), so
usually the screen has done this triage for you. When you are looking at a raw
error instead, the wording identifies the class before you open anything:

| What you see | What it means | What it rules out |
|---|---|---|
| `TypeError: Failed to fetch` | The request never completed | Not a Worker error. The Worker was never reached, or its answer was a redirect the browser refused to follow |
| `... failed: 500` | The Worker answered, and failed | Not a sign-in or connectivity problem |
| `... failed: 401` / `403` | The gate answered rather than redirecting | Not a Worker problem |
| A `ZodError` | The API and this build of the SPA disagree on shape | Not a sign-in problem; it is version skew, and a reload fixes it |

`Failed to fetch` is ambiguous by design: the browser will not tell a page whether
a cross-origin redirect happened. That is why the app asks `/health` before naming
a reason, and why you should too.

Then, in DevTools, in this order:

1. **Network**, with *Preserve log* ticked — without it the 302 disappears before
   you can read it. A `Location:` pointing at `conselit.cloudflareaccess.com` is a
   sign-in that has run out, full stop.
2. **Application → Cookies**, for the environment's origin. `CF_Authorization`
   absent or expired is the whole story.
3. **Application → Service Workers**, which explains the confusing part: why a
   signed-out browser shows a *rendered app* instead of a login page. The service
   worker answers navigations from its own precache, so the document never touches
   the network and never gets redirected; only the `/v1/*` calls do. Tick *Bypass
   for network* to see what the server would really have said.

**A plain reload does not sign you back in**, for that same reason. Only a
navigation to a path on the service worker's denylist leaves the browser at all —
which is what `/v1/relogin` is for.

### At the deployment

```bash
gh run list --workflow=deploy-staging.yml --limit 5
```

Then the Worker's own logs — `observability.logs` is enabled in
`apps/api/wrangler.jsonc`, so this streams real requests as they arrive:

```bash
pnpm --filter @cockpit/api exec wrangler tail --env staging
```

If the deploy is the problem rather than the code, *Migrations and rollback* has
the four ways back, in preference order.

### What this does not cover

The push stream (`apps/web/src/api/useServerEvents.ts`) fails the same way and now
recovers, but *quietly* — `EventSource` cannot report why it stopped, so there is
nothing to show a person and nothing said when the replacement succeeds. If you
are chasing "it stopped updating", look in the Network tab for repeated
`/v1/events` requests spaced 3s, 6s, 12s apart, which is the client backing off
against something that keeps refusing it.
