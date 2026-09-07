# CI/CD Stability Reporting Options

**Status:** decisions taken on 7 September 2026, deliberately at the cheap end, and the first of them built as `tools/ci-stability` ("See how reliable each CI job on main is, without counting runs by hand", issue 244). Measured over the 638 workflow runs on `main` the Actions API held that day, 25 days of history. This document is the record of *why*; the tool and its tests are what stays true.

| Decision | Taken |
|---|---|
| 1. Granularity | **1.2, job level.** Per-test (1.3/1.4) was scoped and set aside as too much for now: it needs reporters, a store and a rendering layer, and the job-level numbers are what say whether it is worth building for F3 alone. |
| 2. Flakiness | **Deferred.** 2.3's scheduled repetition is the only honest measurement and it costs CI minutes, so it waits until the job-level numbers show where the minutes should go. Nothing on the page claims to be a flakiness rate in the meantime. |
| 3. History | **3.1, none kept.** Job-level history is already stored by GitHub; re-deriving it each build leaves no state to corrupt, migrate or back up. |
| 4. Publication | **4.1, the existing Pages deployment**, refreshed by merges to `main`. At roughly thirteen merges a day a schedule buys nothing; add 4.2's cron the day the merge rate drops or 2.3 lands. |

Per-test and the flake hunter keep their sections below as the record of what a second and third slice would be.

## Goal

Answer two questions daily, at a URL, without opening the Actions tab: **is `main` staying green**, and **which test automation is unreliable**.

## The baseline, and the facts that constrain every option

Every CI job on `main` in that window. Cancellations are separated from failures because `cancel-in-progress` produces a quarter of them:

| Job | Success | Failure | Cancelled | Pass rate of completed |
|---|---|---|---|---|
| Build | 20 | 0 | 0 | 100% |
| Scripts | 20 | 0 | 0 | 100% |
| Typecheck | 18 | 0 | 2 | 100% |
| Test | 17 | 1 | 2 | 94% |
| Test Explorer | 17 | 1 | 2 | 94% |
| E2E (F3) | 14 | 1 | 5 | 93% |
| **CI, whole workflow** | 13 | 2 | 5 | **87%** |
| Deploy staging | 18 | 1 | 0 | 95% |

1. **Cancelled is not failed**, and adding the two together makes every rate wrong. F3 is cancelled a third of the time because it is the slowest job in a `cancel-in-progress` group, so the job that most needs measuring is the one whose sample the concurrency rule thins most.
2. **Nothing on `main` is ever re-run.** Both failures were attempt 1, on different commits, and a `main` push produces no second run of the same tree — the `push`/`pull_request` pair only exists on branches. "Same commit, two verdicts", the usual flake detector, has no data here at all.
3. **`retries: 0` is policy**, not an oversight (`playwright.config.ts`, and "Never retry-to-green" in the testing strategy's flakiness policy). No single run will ever label a test flaky, so flakiness is only ever visible across runs. This is what decision 2 is about.
4. **No machine-readable test results exist today.** Playwright reports `github` + `list`; the `reporter: ['json']` in the three vitest configs is coverage, not results. Anything per-test starts by adding reporters.
5. **Pages is already occupied, and already wired.** `ci.yml`'s `pages` job publishes the test explorer from `main` to <https://michaelvanhoutte.github.io/cockpit/>. A repository gets one Pages site, so a stability page attaches to that deployment or it does not exist.
6. **The repository is public**, so a browser may call the Actions API unauthenticated — 60 requests per hour per IP, no token to leak.
7. **The merge rate is climbing, and a single day's sample lies about it**: 126 CI runs on `main` over the 25 days of history, but 94 of them in the last 7 — about five merges a day over the month and thirteen over the week. A *daily* pass rate therefore has almost no denominator at either end; 7- and 30-day windows do.

Both failures were in test automation rather than the build — `pnpm test:e2e` on one commit, `pnpm test` and `pnpm test:coverage` on another — which is the reason this dashboard is about tests rather than about deploys.

## Decision 1: granularity

| | Answers | Needs | Sample per day |
|---|---|---|---|
| **1.1 Workflow** | Is `main` green | Nothing new | ~17 runs |
| **1.2 Job** | Which tier is unreliable | Nothing new | ~17 per job |
| **1.3 Test case** | Which test is unreliable | Reporters + a place to keep results | ~17 per test |
| **1.4 Test × device project** | Whether it is phone-only | The same, plus keeping the project name | ~17 per pair |

**1.1** is one number, and the one number is already visible on the repository's home page. It cannot say what to fix.

**1.2** is the level at which today's data already has an answer: F3 is the least reliable job and Build and Scripts have never failed. It is free — the API already holds job names, conclusions and durations — and it is enough to answer "which test automation is unreliable" as long as the tiers stay one job each.

**1.3** is where "which test is unreliable" becomes actionable, and it is a genuinely different project: it needs reporters added, results uploaded, and history kept beyond artifact retention. Worth doing, and worth doing second — the per-job numbers tell you whether it is F3 or the unit tiers that deserve the instrumentation.

**1.4** costs nothing extra once 1.3 exists, because Playwright's JSON carries the project name, and it matters here: every spec runs under both `desktop` and `phone`, so a flake that only appears on one is a real class of finding that 1.3 would average away.

*Assessment:* 1.2 now, 1.3 with 1.4 as the second slice.

## Decision 2: what "flaky" means when nothing is retried

**2.1 Disagreement between attempts.** The standard definition, and dead on arrival: zero re-runs on `main` in the window, and a re-run only happens when a human presses the button.

**2.2 A failure the next commit clears without touching the test.** Inferred from history alone, no instrumentation: a job that failed at commit N and passed at N+1, where N+1's diff touches nothing the job covers. *Pros:* free, and retroactive — it can be computed over whatever history the API still holds, so the first render already has months of data. *Cons:* a heuristic, and it is confidently wrong about a real bug that someone fixed quickly, which is exactly the case a reliability number must not misreport. Better as a *suspicion* column than as a flakiness rate.

**2.3 Deliberate repetition.** A scheduled workflow runs the suite N times against an unchanged `main`, and reports the disagreement rate. *Pros:* the only option that **measures** flakiness instead of inferring it, and the number means one thing — "this suite disagrees with itself X% of the time on identical code". It gets the sample size the merge rate cannot: ten repeats a night beats thirteen single runs. It also detects a flake that never happened to fail during the day. *Cons:* real CI minutes — F3 is the expensive job and the one most worth repeating; and a nightly run on a fixed schedule measures a quiet runner, while the flakiness we know about is load-dependent (F3 failures that only reproduce with cores pinned). Mitigable by running the repeats concurrently, which reproduces contention rather than avoiding it.

**2.4 A flake-detection service** (Trunk, BuildPulse, Datadog CI Visibility). *Pros:* per-test history, quarantine workflows and trend analysis, none of it built here. *Cons:* another external service and another account for a one-person repository, results leave the repo, and every one of them is built around retry-to-green — the practice the testing strategy forbids — so their central metric would be permanently zero.

*Assessment:* 2.3 is the honest measurement and should be the flakiness number; 2.2 is worth rendering beside it as an unproven suspicion, because it is free and retroactive. 2.4 is rejected on the retry mismatch alone.

## Decision 3: where the history lives

| | Keeps | Cost | Limit |
|---|---|---|---|
| **3.1 Nothing — query the API at build time** | — | None | Only what the API retains, and only job level |
| **3.2 Nothing — query from the browser** | — | None | 60 req/h per IP; slow first paint; same job-level limit |
| **3.3 A JSON per run on a data branch** | Everything, forever | `contents: write` in CI | Commit noise; a write on every merge |
| **3.4 A table in D1, written by the Worker** | Everything, forever | An endpoint, a token, a migration | Puts CI telemetry in the product's database |
| **3.5 A SaaS** | Everything | A subscription | Data leaves the repo |

**3.1** is the whole of the recommended first slice: job-level history is *already stored*, by GitHub, and re-deriving it on each build means there is no state to corrupt, migrate or back up. Its ceiling is real though — per-test results live in artifacts, which expire (7 days for the Playwright failures, and 90 is the public-repo maximum), so decision 1.3 cannot be served this way beyond a rolling window.

**3.2** would keep the page live between deploys without a cron, and the public repo makes it possible without a token. The rate limit is per viewer IP and the work is a fan-out over runs and jobs, so a phone on a shared network can hit it. Reasonable as a *refresh* button over a baked baseline, not as the only source.

**3.3** is the cheapest durable store and the natural home for per-test results: an orphan branch, one file per run, appended by the same job that produced the results. It needs `contents: write`, which `ci.yml` deliberately withholds from every job that runs package code — so it belongs in a separate job, mirroring how `pages` is separated for exactly that reason.

**3.4** couples the dashboard to the product's own deployment and its real data. Rejected for that: the rule that nothing may re-seed or wipe production exists to keep that database boring, and CI telemetry is not worth a table in it.

*Assessment:* 3.1 for the first slice, 3.3 when decision 1.3 lands.

## Decision 4: publication and refresh

**4.1 A second page in the existing Pages deployment**, built by the `test-explorer` job and shipped in the same tarball. *Pros:* the URL, the permissions and the main-only rule all already exist and were argued once; a phone can read it without signing in, which is the whole reason that job exists. *Cons:* it refreshes only when something merges, and it makes the report's freshness a hostage to the `pages` job, which is already the one that fails main's CI when Pages is misconfigured.

**4.2 The same, plus a scheduled rebuild.** A `schedule:` trigger that regenerates and redeploys. *Pros:* "daily" becomes true even on a day with no merges, and it is also where option 2.3's repeat-run would naturally live. *Cons:* a second deploy path into the same Pages site, and the cron and the merge deploy can race — the `pages` concurrency group already handles that, at the cost of one lost deploy.

**4.3 A panel inside Cockpit.** Dogfooding, and the product is literally a dashboard. But it needs sign-in to read, puts CI data in the product database (see 3.4) and makes a routine CI question depend on the app being up.

**4.4 A local command.** `pnpm ci:stability` printing to a terminal. Cheapest by far, and it answers the question — but not the one asked, which was a page to glance at daily.

*Assessment:* 4.1, with 4.2 the day either the merge rate drops or option 2.3 lands and needs a schedule anyway.

## The slice, as decided

A generator in `tools/ci-stability`, beside `test-explorer` and sharing its analyze-model-render shape, reading the Actions API at build time and emitting a model and a page at `/stability/` in the existing Pages deployment.

| Reports | Over |
|---|---|
| Pass rate of completed runs, per job and per workflow, counts shown beside every percentage | 7 and 30 days |
| Median and p90 duration, per job | The same windows |
| How long `main` stayed red after each failure, and whether it still is | The same windows |
| The recent failures, each linked to its failing step | The last N |

Cancelled, skipped and still-running are excluded from every rate and shown separately. `main` only, and the CD workflows — Deploy staging, Promote to production — count as jobs like any other.

**It runs in a job of its own, not inside `test-explorer`.** That job runs the instrumented suite, and a suite failure would take down the page whose job is to report suite failures — which is the one moment it is worth reading. Checkout-only and dependency-free, like `scripts`; it needs `actions: read`, which the workflow-level `permissions` block withholds by default.

Deliberately not answered: which *test* is unreliable, and any number called flakiness. Both need the deferred slices.

The failure modes a data branch and a repeat runner would have to answer — unbounded growth, a rollup that deletes what it summarised, a repeat run pointed at a deployed environment by a stray `E2E_BASE_URL` — belong to those slices, and are why this one keeps no state.

## What building it found

Two things the discussion did not surface, both now answered in the code:

- **Dependabot's updates arrive as one pseudo-workflow per update**, named `npm_and_yarn in /. for esbuild - Update #1547810405` and pathed outside `.github/workflows/`. Each holds exactly one run, so a failed one reads as a workflow with a 0% pass rate — three of them sat above CI in the worst-first list on the first real run. Runs belonging to no workflow file are dropped now, and counted where the page can say so.
- **Job detail is one request per run against a cap of 1,000 an hour**, shared by every workflow in the repository. Thirty days costs about 400, which is why the report is built on `main` only: paying it on every branch push would spend an allowance that is not this report's to spend. What proves the generator on a branch is its own suite, which stubs the API.

The second slice (per-test) is larger than all of this was, because it adds a store.

## Risks

- **A rate is a story about a denominator.** Thirteen runs a day makes a *daily* per-job rate swing eight points on one failure. Hence the counts beside every percentage, and 7- and 30-day windows rather than a daily one.
- **API retention is an assumption.** Run records are held against the repository's retention setting; a 90-day window is the working assumption, and the generator should degrade to whatever it actually gets rather than reporting a shorter window as improvement.
- **Measuring what CI can see.** The known F3 instability is a Node crash on Windows (issue 207), and CI runs Ubuntu. A green stability page is evidence about the runner, not about the suite on a developer's machine.
- **The number becoming the goal.** A pass rate improves by deleting the test that fails. The flakiness policy already answers this — quarantine is tracked and a quarantined test is deleted — but the dashboard should show the suite's size next to its pass rate, so a shrinking denominator is visible.
