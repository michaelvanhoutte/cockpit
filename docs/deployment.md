# Deployment, Environments, and Branching

How Cockpit runs on Cloudflare, which branch reaches which environment, and the
decisions behind both. Architecture §9 records *that* the platform is
Cloudflare and why; this document records *how*, and it is the runbook.

## 1. The branch model

**Decision: trunk-based, one long-lived branch.** `main` is the trunk.
Everything else is a short-lived branch, gated on every push and deployed
nowhere (§4).
**Merging deploys to staging; production is a separate, deliberate promotion.**

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

Branches used to get their own environment on every push. They no longer do, and
the reason is a platform limitation rather than a preference: §4.

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
Since §4, staging is also the first place a change runs deployed at all, which
makes it more load-bearing than this section originally described. It still earns
its place for a narrower and more specific reason:
**staging is the only environment besides production where cron triggers and
queue consumers run continuously against a database that accumulates state.**

Nothing else runs long enough to age an OAuth token into needing a refresh, trip
the §9.2 dead-man's switch, or meet a migration applied to a table that already
has rows in it. Those are precisely the failure modes architecture §9.2 calls
hardest to detect, and only somewhere long-running can find them.

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

There is no third environment. Branches are gated on every push and deployed
nowhere; §4 has the reason and what it costs.

**Every environment is gated, `/health` excepted.** There is no public instance;
the showcase is this repository, not a running app holding real mail and messages.

Production therefore **lags `main` by design**, by however many commits have been
merged but not promoted. `git log <promoted-sha>..main` is the answer to "what is
merged but not live"; the promotion run's summary records which commit shipped.

Two D1 databases, out of the free plan's ten - three until `cockpit-preview`
went with §4. The two thresholds that would
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

## 4. No branch environments

**Removed, deliberately.** A branch used to get its own Access-gated URL on every
push. It cannot any more, and rebuilding the capability another way costs more
than it is worth here. Both halves of that are argued below rather than asserted,
because "we deleted the preview environment" is the kind of sentence that reads
as neglect a year later.

What is gone: `deploy-preview.yml`, the `cockpit-preview` Wrangler environment,
`scripts/branch-alias.sh` and the CI step that asserted it. What replaces it is
nothing - a push runs the gates in `ci.yml` and deploys nowhere.

### Why it could not stay

Cloudflare does not generate version preview URLs for a Worker that implements a
Durable Object, and since "Account data moves into a per-account store"
(issue 84) this one does. The mechanism, the error it produced and how it
presents are in "Preview URLs and Durable Objects are mutually exclusive" below.
Everything after that is about what to do instead.

### Why nothing replaced it

Four shapes were weighed. Two keep a clickable branch environment and two do not:

| | Click through before merge | Cost |
|---|---|---|
| Keep the job as a rehearsal, no URL | no | a workflow that deploys nothing anyone can see |
| A Worker per branch, every push | yes | per-environment Access, lifecycle, on every push |
| A Worker per branch, on request | yes | per-environment Access, lifecycle, when asked |
| **Remove it** | no | no rehearsal against real Cloudflare before merge |

The two that keep the capability both founder on the same thing, and it is not
lifecycle: **a branch Worker cannot be gated cheaply.** That is
"Gating a branch Worker costs what previews did not" below - Access on a
`workers.dev` URL is per Worker, `.workers.dev` has no wildcard subdomains, and
the account-level policy that covered every preview was a property of preview
URLs specifically. Each branch environment would therefore need its own Access
application, created and destroyed with it, with an unauthenticated instance of
this application on the public internet as the failure mode. A custom domain
would fix that with one wildcard application, and that is a zone, DNS and
custom-domain routing for a convenience.

Between the two that give the capability up, the rehearsal is the smaller loss
and the larger residue: a workflow, a database, a Worker and an alias script kept
alive to produce a green check nobody looks at. Removing it is the same trade
taken further, and it is the one that leaves nothing to explain.

### What it costs, stated plainly

**Nothing is deployed anywhere until a branch merges.** A migration or a
configuration that fails only against the real platform now surfaces on
**staging, after the merge** - main is briefly a commit whose staging deploy is
red, and the fix is an ordinary short-lived branch and an ordinary pull request,
which is what the branch model says about every other fix.

That is not hypothetical. The Durable Object migration error in
"A Durable Object class cannot be introduced by a preview" below was caught
before merge by exactly the step this section removes. The trade is accepted with
that example in view: one deploy-time surprise per platform limitation, against a
workflow, a Worker, a database and an Access policy maintained permanently.

**What still gates a branch:** `ci.yml`, on every push - typecheck, the fast test
tiers, the browser tier against its own local stack, the build, the script tests
and the concept registry. Nothing about *code* correctness moved.

### Removing the infrastructure

The repository no longer references them, but the `cockpit-preview` Worker and
the `cockpit-preview` D1 database still exist on Cloudflare, along with any
Access application scoped to them. Deleting them is a **one-time, irreversible**
step, done by hand because nothing here should be able to delete infrastructure
on its own:

```bash
wrangler delete cockpit-preview
wrangler d1 delete cockpit-preview
```

D1 keeps 30 days of point-in-time recovery, but a deleted database is deleted;
there is nothing in either that is not `seed.sql` fixtures. Leaving them costs
nothing but a stale row in the dashboard, so this is cleanup rather than a
requirement.

### Preview URLs and Durable Objects are mutually exclusive

**Measured, then confirmed against Cloudflare's own documentation.** The upload
succeeds and the check goes green; the URL serves nothing. Cloudflare's
[preview URLs page](https://developers.cloudflare.com/workers/configuration/previews/)
says it outright:

> Preview URLs are not generated for Workers that implement a Durable Object,
> including Containers and Sandbox Workers.

An account's data lives in one Durable Object per account, so `cockpit-preview`
implements one, so it gets no preview URLs. Nothing about the alias, the
bootstrap or the workflow changes that; the limitation is the platform's.

**How it presents, which is the dangerous part.** `wrangler versions upload`
still succeeds, so the Preview check passes — it asserts that the upload
happened, not that anything is reachable. The workflow then *constructs* the
alias URL from the alias it passed rather than reading one back from Wrangler,
and comments it on the pull request. So a pull request carries a green check and
a URL that looks right and answers with a placeholder. The tell in the log is
that Wrangler prints no `Version Preview URL:` line at all.

**What replaced it.** Nothing - see "Why nothing replaced it" above for the four
candidates and why the two that keep a clickable environment both founder on the
section that follows this one.

### Gating a branch Worker costs what previews did not

**The account-level Access policy does not reach a branch Worker**, and no
naming or wildcard makes it. Two facts, both from Cloudflare:

- Access on a `workers.dev` URL protects
  [one Worker's production URL, its preview URLs, or both](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
  - it is per Worker.
- [`.workers.dev` does not support wildcard subdomains](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
  so one application cannot stand in front of every branch Worker the way
  `Cloudflare Workers Preview URLs` stands in front of every preview URL.

That account-level policy covering "every preview, including branches that do
not exist yet" was a property of **preview URLs specifically**. Losing preview
URLs loses it, and a branch Worker inherits nothing.

So a branch environment is gated per environment or not at all, which leaves
three shapes and no free one:

- **Create and delete an Access application per environment from the workflow.**
  Doable through the API, and it widens the CI token from Workers and D1 to
  Access. Its failure mode is the one §6 exists to prevent: an application that
  is not created leaves an unauthenticated instance of this app on the public
  internet, and nothing about the deploy looks wrong when that happens.
- **Move branch environments to a custom domain**, where a wildcard application
  does work and covers them all once. That is the documented answer to exactly
  this, and it is a bigger, one-time setup: a zone, DNS, and custom-domain
  routing.
- **Accept public branch environments.** They hold `seed.sql` fixtures rather
  than real mail, which is the argument §6 already makes about previews - but §6
  gates them anyway, and that reversal was the owner's.

This is what reopened §4. It is recorded here rather than in a commit message
because the cost is the decision.

### A Durable Object class cannot be introduced by a preview

**Measured, not inferred**, on the first preview deploy that carried one:

```
Version upload failed. You attempted to upload a version of a Worker that
includes a Durable Object migration, but migrations must be fully applied via
a non-versioned deployment. [code: 10211]
```

Previews use `wrangler versions upload`, which is the whole point of them - one
Worker, one version per branch, addressed by alias - and Cloudflare will not
apply a Durable Object migration through it. Staging and production are
unaffected: both run `wrangler deploy`, which applies migrations as part of the
deploy.

So a **new** Durable Object class has to reach `cockpit-preview` once, by hand,
before any branch carrying it can upload a version. Run it **from the branch
that introduces the class**, not from `main`: this deploys the working tree you
are standing in, and a tree without the class in its `wrangler.jsonc` introduces
nothing.

```bash
# from the repository root of that branch's checkout or worktree
pnpm --filter @cockpit/api exec wrangler deploy --env preview
```

`pnpm ... exec` because `wrangler` is a devDependency of `apps/api` and is not
on the PATH; a bare `wrangler` only works where one happens to be installed
globally. It also needs `apps/web/dist` to exist, since Wrangler refuses to
start without the assets directory - `pnpm build` first if it is missing.

That is the same one-time bootstrap the runbook below already performs for the
preview Worker, repeated for the class. Afterwards the migration is applied and
every branch's `versions upload` sends no migration at all, so the failure does
not recur - including for branches that do not know the class exists.

**Nothing uploads a version any more**, so this cannot bite today: staging and
production both `wrangler deploy`, which applies migrations the way it always
did. It is kept because the rule outlives its cause - a Durable Object migration
cannot travel by version upload, and the next thing that uploads one will meet
it, whether that is a returning preview or a gradual deployment.

The same is true of account data, and more sharply: every preview version runs
under the one `cockpit-preview` Worker, so they share its Durable Object
namespace and therefore the *same* account store. A branch that adds a change to
`apps/api/src/accounts/changes.ts` applies it to the store every other branch's
preview is also reading.

**What is genuinely given up**, recorded rather than waved away: two branches
with incompatible migrations to the *register* will collide, because a migration
applied by one branch environment is immediately visible to every other one.
There is no mitigation in place, only a detection story: deploying a branch
environment applies migrations first, so the branch that breaks is the branch
that notices - and now only when somebody asks for an environment, so a
collision can sit undetected until then. Account changes no longer collide at
all: each branch Worker has its own Durable Object namespace, so a change to
`src/accounts/changes.ts` reaches nothing but that branch's own store. If this bites in practice, the recorded escalation is per-branch
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
database appeared on the preview URL of the day and on neither staging nor
production.

## 5. Migrations and rollback

**This section is about the register.** An account's own store is brought up to
date lazily, by the first request that opens it after a deploy, because nothing
can reach a Durable Object before one exists — see "One store per account, and
`tenant_id` stays" in [architecture.md](architecture.md) and the decision behind
it in [account-storage-options.md](account-storage-options.md). Two consequences
worth carrying into any change to `apps/api/src/accounts/changes.ts`: a change
that will not apply takes down every account, one at a time as each is opened,
so the deploy-time gate D1 gives for free is not there; and a change that has
shipped must never be edited, because the accounts that already applied it will
not apply it again and the ones that had not will get the edited version. The
gate that has to replace the deploy-time one — applying an account's changes
against a scratch store in CI before the deploy — is its own piece of work and
is not built yet.

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

There is no third environment to do this for; §4.

`scripts/health-check.sh` detects the gated case and names this fix, rather than
failing with an unexplained parse error on an HTML login page.

**Verified 2026-08-13**, from outside, unauthenticated:

| | `/` | `/v1/workspaces` | `/health` |
|---|---|---|---|
| production | 302 → Access | 302 → Access | 200 `{"ok":true,"db":true}` |
| staging | 302 → Access | 302 → Access | 200 `{"ok":true,"db":true}` |
| preview alias | 302 → Access | — | 302 → Access |

The preview row is kept as the record of a test that was run, not as a live
environment; §4 removed it.

All challenges redirect to `conselit.cloudflareaccess.com`. Two things this
settles that the documentation does not state: **a path-scoped public-hostname
destination does take precedence over a whole-Worker Access app on a
`workers.dev` hostname**, and **the `*-cockpit-preview` wildcard covers aliases
created after Access was enabled** (tested by uploading a fresh alias and
confirming it was challenged). The second is what made previews free to gate, and
"Gating a branch Worker costs what previews did not" is where its absence lands
for anything that is not a preview URL.

### The cost of gating production, stated plainly

§8.1 rejected Cloudflare Access as the *application's* authentication, and one of
its reasons now applies to us directly: **Access's expired-session redirects to an
HTML login page break silent `fetch` and `EventSource` refresh.** Cockpit
revalidates on focus and holds an SSE stream open (§5.2), so when an Access session
expires, the client gets HTML where it expects JSON or events.

**Amended 2026-08-31, for reads and for the push stream.** That used to present as
an app that had quietly stopped working, and on a first load as the router's raw
`Failed to fetch`. The client now recognises the case and recovers from it: it
asks `/health` — which is outside the gate, so an answer proves the deployment
is healthy and the fault is this browser's sign-in — then sends itself through
`/v1/relogin`, which is challenged by Access and hands the browser back to the
page it came from. The push stream recovers by a related route: `EventSource`
abandons a badly-answered connection after one attempt, so the client reopens it
on a backoff and runs the same check to decide whether the sign-in is what went.

**A second, sharper case: requests the browser makes with credentials omitted.**
The web app manifest is fetched that way by specification unless its `<link>`
carries `crossorigin="use-credentials"`, so behind Access it went out with no
session cookie, was redirected to `conselit.cloudflareaccess.com`, and was then
rejected by the browser as a cross-origin redirect with no
`Access-Control-Allow-Origin` — surfacing as a CORS error, which is what makes it
so misleading to diagnose. Fixed by `useCredentials: true` in
[apps/web/vite.config.ts](../apps/web/vite.config.ts). Three things worth carrying
forward: **a valid session does not help here**, because the cookie is never
offered, so the long-session mitigation below does not touch this class; **the
recovery above does not reach it either**, because nothing was refused and so
nothing asks why; and manifest *icon* fetches are a separate path that this
attribute does not govern, so whether install and splash artwork resolve behind
Access is untested.

Three mitigations, of which only the first is a fix, and it covers the expiry
case above rather than the credentials-omitted one:

- **Recover in the client**, as above. It removes the dead-end, not the
  interruption: an expired session still costs a round trip through the login.
- **Set a long Access session duration** (up to one month) so expiry is rare.
- **Treat this as interim.** It is the perimeter that exists *because* §8.1 has not
  been built. When the OIDC flow lands, Access on production should be
  reconsidered rather than left in place by inertia: it would then be a second
  gate in front of the app's own, and the §8.1 rejection reasons (tenancy left
  unexercised, cannot become customer auth) start applying for real as soon as a
  second user exists.

This does **not** reverse §8.1. Access here is a perimeter around a deployment, not
the application's identity model, and it buys time rather than a design.

When this is what you are actually looking at on a broken page, the procedure is
in *Diagnosing a broken environment* rather than here.

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
   practical bypass surface is currently small - two Workers, no service bindings,
   no extra routes, and nothing deployed per branch since §4 - and production
   holds `seed.sql` fixtures rather than real mail.

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

**This used to be a problem and §4 dissolved it.** Preview URLs cannot run on a
custom domain, only `workers.dev`, so per-branch hostnames would have stayed on
`workers.dev` permanently - and **Google requires exact redirect URIs with no
wildcards**, which per-branch hostnames cannot each be registered for. Two
answers were on the table, both unpleasant: a fixed redirect endpoint bouncing to
the originating preview via signed state, or a stubbed development session on
previews only, which must never be a code path that can exist in production.

With no per-branch hostnames there is nothing to register beyond production and
staging, whose URLs are fixed. Worth knowing if branch environments ever come
back on a custom domain: this cost comes back with them.

## 7. Bootstrap runbook

**Already executed on 2026-08-13**, against Cloudflare account
`091e6e85f8268ee838089d6fed968585`, subdomain `vanhoutte-michael`. Recorded so it
can be redone on a new account or rebuilt from scratch, not as pending work.
Everything after this is automatic via `.github/workflows/`.

`wrangler` below is the workspace's own (`apps/api`'s devDependency), so either
put `pnpm --filter @cockpit/api exec` in front of each line or run them where a
global one is installed.

```bash
# 1. three databases
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

**This was executed when there were three of each.** The preview database and
Worker were removed with §4; if you are rebuilding from scratch, there were never
two of anything you now need.

Production is seeded here as a **one-time bootstrap**, not as part of the deploy
workflow: `seed.sql` puts the single account in the register, which the
application currently has no onboarding flow to create. When onboarding exists,
this step goes away. **Staging is deliberately never re-seeded**, because
accumulated old data is the entire point of it.

**There is no seed step for an account's own data, and there cannot be.** Its
workspaces, items and associations live in a Durable Object that is created by
the first request that opens it, and `wrangler d1 execute` speaks only to D1. So
the three workspaces an account starts with are its first change instead
(`apps/api/src/accounts/changes.ts`), applied once, inside whichever request
opens the account first. That is the same temporary bootstrap the paragraph
above describes, in the only place that can now hold it, and it goes the same
way when onboarding lands.

Then, by hand (no API, or deliberately not automated):

1. **Cloudflare Access** on both Workers, production included, plus a
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
   - **`contexts`** — eight names: five of the six jobs in `ci.yml` (Test Explorer
     publishes a report and deliberately does not gate), and three from CodeQL.
     They must match exactly.

     The three are not interchangeable. `CodeQL (javascript-typescript)` and
     `CodeQL (actions)` are the two matrix legs, and they say only that the
     analysis *ran*. The one that says it was **clean** is the third, named plainly
     `CodeQL` and posted by GitHub Advanced Security rather than by the workflow —
     it is the check that goes red on an alert at or above the failure threshold.
     Requiring the legs without it would gate on the analysis having happened while
     letting a high-severity finding merge.

     **All three names were read off a real run** ("Analyse every pull request
     with CodeQL, and let Dependabot report vulnerable dependencies", pull request
     92), never predicted, and that ordering is the point rather than a detail.
     GitHub matches these strings with no idea whether anything reports under
     them, and a name nothing reports under does not go red: it sits at *Expected
     — waiting for status to be reported* on every pull request, indefinitely.
     `enforce_admins: false` means the owner can still merge past a stuck check;
     nobody else can. So when a check is added or renamed, the order is always:
     merge the workflow, let it run, read the name off that run, then apply this
     payload.

     One thing to confirm before this is applied, because it is not yet known: a
     pull request from a fork gets a read-only token, so its results upload may be
     refused. If it is, all three CodeQL checks are unpassable from a fork, and
     requiring them closes this repository to outside contribution.
   - **`required_linear_history: true`** — makes §1's squash-merge rule mechanical
     rather than remembered, per the preference for violations that are impossible
     over violations caught in review.
   - **`enforce_admins: false`** — keeps an admin escape hatch for emergencies,
     safe for the same reason `strict: false` is.

   *Requires the repository **owner** account.* A collaborator with `push` cannot
   do this, and the branch-protection API answers `404` rather than `403` when the
   caller lacks admin, which reads as "wrong URL" and sends you looking in the
   wrong place. Not the same thing as the Cloudflare credentials.

4. **The GitHub-native security controls.** Two of these were already running
   before anything was built for them, and they are listed here so the next person
   reading this does not go and enable what is already enabled. Checked
   2026-08-31: **secret scanning** and **secret scanning push protection**, both
   on, both free on a public repository, and between them they are what catches a
   committed credential before it is pushed rather than after.

   Two more were turned on by "Scan every pull request with CodeQL, and let
   Dependabot report vulnerable dependencies" (issue 28). Neither has a file to
   check in, so they are recorded here as the commands that set them:

   ```bash
   gh api -X PUT repos/michaelvanhoutte/cockpit/vulnerability-alerts      # Dependabot alerts
   gh api -X PUT repos/michaelvanhoutte/cockpit/automated-security-fixes  # Dependabot security updates
   ```

   Reading them back takes two calls, not one, and the reason matters: three of
   the four live on the repository resource, and **Dependabot alerts is not one of
   them**. Its key is simply absent from `security_and_analysis`, which reads
   exactly like "off" to anyone checking.

   ```bash
   # secret scanning, push protection, Dependabot security updates
   gh api repos/michaelvanhoutte/cockpit --jq '.security_and_analysis'
   # Dependabot alerts: 204 when on, 404 when off, no body either way
   gh api repos/michaelvanhoutte/cockpit/vulnerability-alerts --silent && echo enabled || echo disabled
   ```

   `security_and_analysis` is also only populated for a caller with admin on the
   repository — a non-admin gets `null`, which reads as "everything is off" in the
   same way the branch-protection `404` above reads as "wrong URL". The `null` is
   GitHub's documented behaviour rather than something measured here, unlike the
   two calls above, which were run against this repository on 2026-08-31.

   **Routine dependency version updates are deliberately off.** They would need a
   `.github/dependabot.yml`, and there is none: a pull request for every
   dependency that falls behind is a steady stream against this workspace's
   lockfile, each one dragging a full CI run and a Claude review behind it.
   Security updates are the ones worth that, and those are on.

   **The code-scanning check-failure threshold stays at its default**, which fails
   a pull request's check on alerts of error, critical or high severity — which is
   what issue 28 asked for, so the default here is a decision rather than
   something nobody looked at. It is a dashboard setting (Settings → Code
   security) with no API to read it back from, which is the only reason it needs a
   paragraph instead of a command.

   Unlike branch protection, all four are settable by any admin, and the two
   `gh api` calls above answer `204` on success and print nothing.

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
## 9. Diagnosing a broken environment

The other sections are procedures for when you already know what is wrong. This
one is for the moment before that: a deployed environment is showing something
bad and it is not yet clear whether the deployment is broken, the database is
unreachable, or this browser simply needs to sign in again.

It exists because the failure most likely to bring you here was already
predicted, in the wrong genre. *The cost of gating production, stated plainly*
argues that gating is worth its cost and names that cost exactly — Access's
expired-session redirects break silent `fetch`. That is an argument for a
decision. Nobody reads it while staring at a broken page, because you would have
to know the answer already to know to look there.

### First question: is it the deployment, or is it me?

One command settles it, and it is the reason `/health` is Bypass-policied out of
the gate in the first place:

```bash
curl -i https://cockpit-staging.vanhoutte-michael.workers.dev/health
```

| Answer | Meaning | Go to |
|---|---|---|
| `200 {"ok":true,"db":true}` | Worker up, D1 answering. The deployment is fine. | *In the browser*, below |
| `200` with any other body | Something answered in front of the Worker | *In the browser* — usually a login page, so the Bypass policy has come undone |
| `301`/`302` | The Bypass policy is gone; `/health` is behind the gate | *`/health` must stay outside the gate* |
| `5xx` | The Worker is up and failing | *At the deployment*, below |
| Nothing, or a TLS error | Not reachable at all | *At the deployment*, below |

### In the browser: read the shape of the message first

Cockpit names its own failures (`apps/web/src/components/LoadFailure.tsx`), so
most of the time the screen has already done this triage for you. When you are
looking at a raw error instead — in the console, in a test, or in an older
build — the wording still identifies the class before you open anything:

| What you see | What it means | What it rules out |
|---|---|---|
| `TypeError: Failed to fetch` | The request never completed | Not a Worker error. The Worker was never reached, or its answer was a redirect the browser refused to follow |
| `... failed: 500` | The Worker answered, and failed | Not a sign-in or connectivity problem |
| `... failed: 401` / `403` | The gate answered rather than redirecting | Not a Worker problem |
| A `ZodError` | The API and this build of the SPA disagree on shape | Not a sign-in problem; it is version skew, and a reload fixes it |

`Failed to fetch` is the ambiguous one, and deliberately so: the browser will
not tell a page whether a cross-origin redirect happened. That is why the app
asks `/health` before it names a reason, and why you should too.

Then, in DevTools, in this order:

1. **Network**, with *Preserve log* ticked — without it the 302 disappears
   before you can read it. A `Location:` pointing at `conselit.cloudflareaccess.com`
   is a sign-in that has run out, full stop.
2. **Application → Cookies**, for the environment's origin. `CF_Authorization`
   absent or expired is the whole story.
3. **Application → Service Workers.** This is what explains the genuinely
   confusing part: why a signed-out browser shows a *rendered app* instead of a
   login page. The service worker answers navigations from its own precache
   (`navigateFallback` in `apps/web/vite.config.ts`), so the document never
   touches the network and never gets redirected; only the `/v1/*` calls do,
   and those are the ones that fail. Tick *Bypass for network* to see what the
   server would really have said.

**A plain reload does not sign you back in**, for that same reason, and this
surprises people every time. Only a navigation to a path on the service
worker's denylist leaves the browser at all — which is what `/v1/relogin` is
for: it is challenged by the gate, and once you are through it hands the
browser back to the page you came from.

### At the deployment

```bash
gh run list --workflow=deploy-staging.yml --limit 5
```

Then the Worker's own logs — `observability.logs` is enabled in
`apps/api/wrangler.jsonc`, so this streams real requests as they arrive:

```bash
pnpm --filter @cockpit/api exec wrangler tail --env staging
```

If the deploy is the problem rather than the code, *Migrations and rollback*
has the four ways back, in preference order.

### What this does not cover

The push stream (`apps/web/src/api/useServerEvents.ts`) fails the same way and
now recovers from it, but it recovers *quietly* — `EventSource` cannot report why
it stopped, so there is nothing to show a person and nothing said when the
replacement succeeds. If you are chasing "it stopped updating", the Network tab
is still where you see it: look for repeated `/v1/events` requests spaced 3s, 6s,
12s apart, which is the client backing off against something that keeps refusing
it.
