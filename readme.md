# Cockpit — Unified Inbox & Dashboards

The production application for the Unified Inbox & Dashboards concept, built to the recorded decisions in [docs/architecture.md](docs/architecture.md) (the how), [docs/functional-definition.md](docs/functional-definition.md) (the what), [docs/testing-strategy.md](docs/testing-strategy.md) (the proof), and [docs/deployment.md](docs/deployment.md) (the where). Unscheduled feature ideas are collected in [docs/ideas.md](docs/ideas.md) (the maybe).

The showcase is this repository, not a public instance: every deployed environment is behind Cloudflare Access, because production holds real mail and messages.

## Layout

```
cockpit/
├── apps/
│   ├── web/           # React + Vite installed PWA (TanStack Router/Query, Tailwind, Radix)
│   └── api/           # the Worker: Hono HTTP API + SSE, D1 via Drizzle, and the built SPA
├── packages/
│   ├── shared/        # THE contract: domain types, Zod schemas, commands, API shapes
│   ├── connector-sdk/ # the connector SPI (connectors land as packages/connectors/*)
│   └── config/        # shared tsconfig / prettier
├── docs/              # functional definition, architecture, testing strategy, deployment, options docs
├── scripts/           # local dev startup, the browser tier's stack, branch tidying
├── .github/           # CI, CodeQL, the three Claude workflows, the three deploy workflows, branch protection
├── .claude/           # project skills and Claude Code settings every session picks up
└── poc/               # proofs of concept (kept; they are part of the showcase)
```

One Worker per environment serves both the API and the SPA, on one origin (see [docs/deployment.md](docs/deployment.md)). `apps/api` is therefore the deployment, and `apps/web/dist` is its static-asset payload.

Not yet in place (deliberately, in build order): auth (§8.1), the connectors themselves (§6.2), and the task-creator merge (§6.5).

## Environments

Trunk-based: `main` is the trunk, every other branch is gated on push and deployed nowhere, merging deploys staging, and **production is a deliberate promotion pinned to one commit** rather than a consequence of merging. The model and its arguments are in [docs/deployment.md](docs/deployment.md).

All three are behind Cloudflare Access, `/health` excepted so the deploy checks and the uptime monitor can reach it.

| | Deployed by | URL |
|---|---|---|
| production | the *Promote to production* action | `cockpit.vanhoutte-michael.workers.dev` |
| staging | every commit on `main` | `cockpit-staging.vanhoutte-michael.workers.dev` |

Branches are gated on every push and deployed nowhere; the reason, and what it
costs, is "No branch environments" in [docs/deployment.md](docs/deployment.md).

## Run it

Prerequisites: Node ≥ 22 (pnpm comes via corepack).

```bash
corepack enable pnpm
pnpm install
pnpm dev
```

That is the whole thing. `pnpm dev` applies the local D1 migrations, seeds the database, builds `apps/web/dist` if it has never been built (Wrangler refuses to start without it), then runs the API on <http://localhost:8787> and the web app on <http://localhost:5173> together, output prefixed per process. Ctrl+C stops both, and either one exiting takes the other down rather than leaving half an app looking healthy.

Every setup step is idempotent, so it is safe to re-run and there is no one-time setup to remember or skip. `pnpm dev:api` and `pnpm dev:web` run one half alone; `pnpm build` when a real production build is wanted rather than the placeholder `dist`.

**It stays one command deliberately.** The testing strategy's definition of done requires that the application be started and the changed behaviour actually exercised before anything is claimed to work — green unit tests are never evidence that the app runs. Four commands across two terminals is the friction that quietly turns "start the app" into "the tests passed", so the friction is removed rather than documented.

`pnpm typecheck` and `pnpm test` run across all packages. Both assume the install matches `pnpm-lock.yaml`, and two ordinary things leave it behind: a freshly created worktree has no `node_modules` at all, and a pull that adds a workspace package or changes a dependency leaves the `node_modules` you have incomplete. Run `pnpm install` after either — it is the same idempotent command, so re-running it costs seconds and never hurts.

Skip it and the first run fails for that reason rather than for anything you changed, which is worth recognising because it does not look like a missing install. A package whose dependencies were never linked reports its test runner missing (`'vitest' is not recognized`), and the giveaway is above it: pnpm prints how many workspace projects it is running over, so `Scope: 6 of 7 workspace projects` against a repository that now has seven is the install being a package behind.

### Tidying up branches

```bash
pnpm branches:tidy        # --dry-run to see the plan without deleting
```

Deletes the local branches left behind by merged PRs, prunes worktree metadata for directories that no longer exist, and lists (without deleting) the branches that were never pushed.

It keys on the upstream being gone rather than on `git branch --merged`, because the squash-merge rule above makes `--merged` permanently answer "no": a branch's commits never reach the trunk, only a new commit carrying their content. GitHub deletes the remote branch when a PR merges, so an orphaned local branch is a merged one — and that is the signal. Branches that were never pushed have no such signal, so the script reports them for you to judge rather than guessing.

## Tests

Read [docs/testing-strategy.md](docs/testing-strategy.md) (the reasoning) or `.claude/skills/testing/` (the binding rules, restated so an agent never has to open the strategy doc to write a test) before adding, moving, or reviewing a test. The short version: pick the lowest level that can prove a behaviour, and never claim something works from green tests alone — the application has to actually be started and the change exercised in it.

```bash
# everything, as CI would: every fast tier, then the browser tier
pnpm test:all

# just the fast tiers — unit + frontend component tests, no browser, no servers;
# run this constantly while you work
pnpm test:fast

# every package's own tests — unit, integration and frontend — but no browser
pnpm test

# the browser tier alone
pnpm test:e2e

# the scripts that start the app and the test stack, and the security
# review's gate; no install needed
pnpm test:scripts
```

One-time, on a machine that has never run the browser tier: `pnpm exec playwright install chromium`. It is the only setup step `pnpm install` does not cover, it downloads about 150MB, and without it `pnpm test:e2e` fails immediately telling you to run exactly that.

One package at a time, when you only want the tests near what you're touching:

```bash
pnpm --filter @cockpit/shared test:unit       # domain types, schemas, ids — no real dependencies
pnpm --filter @cockpit/api test:unit          # domain logic — no real dependencies
pnpm --filter @cockpit/api test:integration   # command handling against real local storage (~25s, not in test:fast)
pnpm --filter @cockpit/web test:f-unit        # component logic, API client mocked at the boundary
pnpm test:e2e --project=phone                 # the browser walks on one device instead of both
pnpm test:e2e tests/e2e/capture.test.ts       # one browser walk
```

For a live-reloading loop while writing a test, run vitest directly instead of the `run`-only package script, e.g. `pnpm --filter @cockpit/web exec vitest`. The browser tier's equivalent is `pnpm test:e2e --ui`.

**Nothing has to be running first, and nothing you have running will be disturbed.** Every tier brings its own world:

- `apps/api`'s integration tests get a fresh, real D1 instance per test file from the Workers pool (`@cloudflare/vitest-pool-workers`), gone when the run ends. An account's own data lives in a real Durable Object rather than in D1, and there is one of those per account name rather than one per test file, so the cases that touch it empty it themselves between them (`tests/integration/seed.ts`).
- The browser tier starts a **second copy of the whole application** — its own Wrangler on :8887, its own Vite on :5273, its own state directory — and throws the storage away afterwards. Your `pnpm dev` on :5173/:8787 keeps running throughout, untouched: run the suite while you are clicking around and neither notices the other.

That storage is rebuilt before every run, so a run always starts from the same place and can never be made to pass or fail by something you did in the browser yesterday — but the two halves get there differently. The **register** is rebuilt by copying a template (about 220KB, 5 milliseconds) rather than by running migrations and the seed, which costs about seven seconds and is nearly all process startup; the template itself is rebuilt only when a migration or `seed.sql` changes, keyed by their contents, so there is no stale-template failure to remember. The **account's own store** is not in that template at all — a Durable Object is not something `wrangler` can write to from outside — so each run starts it empty and the run's first request creates it, brings it up to date and gives it the workspaces an account starts with. Same place every time, arrived at from the other end. A whole run costs about 7 seconds warm, about 18 the first time, when the template and possibly `apps/web/dist` have to be built.

What that does *not* buy is isolation between tests inside one run: all the specs share the one stack, so each still creates what it needs and asserts only on its own rows rather than on counts. Real per-test isolation arrives with workspace creation, when a test can make its own.

`pnpm dev` is still the other required step: manually exercising a change the browser tier does not cover, which the testing strategy treats as non-negotiable proof that green tests alone can't provide.

## Development automation

Two different things get called "our automation", and keeping them apart saves a lot of confusion: what is **checked into this repository**, which every clone and every agent gets with no setup at all, and what has to be **configured once** — on the GitHub repository or on your own machine — which no amount of `pnpm install` will hand you. A missing piece of the second kind usually shows up as a workflow that is green while nothing actually happened.

### Checked in — GitHub Actions

| Workflow | Fires on | What it does |
|---|---|---|
| [CI](.github/workflows/ci.yml) | every push, and pull requests to `main` | Six parallel jobs, so a failure names itself. Five of them — `Typecheck`, `Test`, `E2E (F3)`, `Build`, `Scripts` — are five of the eight contexts the checked-in branch-protection payload lists, the other three being CodeQL's. The sixth, `Test Explorer`, publishes a report and deliberately does not gate. `E2E (F3)` installs Chromium and runs the browser tier against the same isolated local stack you would get locally, keeping its failure traces as an artifact. `Scripts` runs the unit tests for `scripts/lib/`, because a silent change in the test stack's guards would let a run start against a database it did not create, and a silent change in the review gate would let a non-review ship green. A branch with an open pull request is checked twice, once per event: `push` covers a branch that has no pull request at all, `pull_request` covers the merge result, and since this is the only gate a branch gets, running twice beats not running. |
| [CodeQL](.github/workflows/codeql.yml) | pushes and pull requests to `main` | Two parallel legs, one per language: `javascript-typescript` over the application sources, and `actions` over the workflow files themselves — which is where this repository's own risk sits, since its workflows run Claude against an OAuth token and check out pull request branches. Both read the sources directly (`build-mode: none`), so neither needs a toolchain. No path filters, deliberately: a required check that is skipped never reports, and a pull request waits on it forever. Superseded pull request runs are cancelled; runs on `main` are not, because the default branch's analysis is the baseline every pull request is compared against. |
| [Claude Code Review](.github/workflows/claude-code-review.yml) | every pull request opened, pushed to, reopened or marked ready for review | Runs the `code-review` plugin command against the pull request and posts its findings as inline comments (a summary comment when it finds nothing). A second step then asserts that the review *actually ran* — see below. |
| [Claude Security Review](.github/workflows/claude-security-review.yml) | every pull request opened, pushed to, reopened or marked ready for review | A security pass over the diff, scoped by [.github/security-review-instructions.md](.github/security-review-instructions.md) to the rules this project decided on — the ingress hardening template, tokens encrypted at rest and never logged, server-side workspace scoping, the hand-rolled auth surface, and the workflows themselves. CodeQL is the mechanical half and this is the judgement half, so the instructions say explicitly not to re-derive what CodeQL already reports. The run must end with a one-line verdict naming the highest severity it found; the check goes red when that line is missing (it never reached a verdict) or names the top severity. Skipped on pull requests from forks — see below. |
| [Claude Code](.github/workflows/claude.yml) | `@claude` in an issue, an issue or PR comment, or a review | Hands that comment to Claude with read access to the repository and to CI results, so an explanation or a fix can be asked for from the pull request itself. |
| [Deploy staging](.github/workflows/deploy-staging.yml) | every commit on `main`, plus manual re-runs | The same gate, then migrate and deploy, then assert `/health`. Never re-seeded: accumulated old data is the whole point of staging. |
| [Promote to production](.github/workflows/deploy-production.yml) | manual only, with an optional commit SHA | Refuses any commit that is not an ancestor of `origin/main`, since it has neither passed CI nor soaked on staging; then re-runs the full gate against that exact tree, migrates, deploys, and verifies `/health`. |

The four workflows that need a toolchain — CI and the three deploys — share [`.github/actions/setup`](.github/actions/setup/action.yml), so the pnpm version, the Node version and the frozen-lockfile install are declared once. The three Claude workflows need no such install, and neither does CodeQL: with `build-mode: none` it reads the sources rather than building them. *Claude Security Review* does run Node, for its gate, but only against the standard library, so it stays checkout-only for the same reason the `Scripts` job does.

**Why the security review's gate is a module and the code review's is not.** They answer the same question — did this run actually reach a verdict — and the older one answers it in about 120 lines of bash inside a `run:` block. Every incident recorded in that file's comments is a bug in that bash rather than in the reviewing: a `permission_denials_count` field missing from the result record and read as "no denials", a three-turn blocked session passing as clean, a seven-turn one doing the same, a result payload that is sometimes an array and sometimes an object. All four shipped green, and nothing covered them, because inline bash cannot be run by a test. The security review's version is [`scripts/lib/review-gate.mjs`](scripts/lib/review-gate.mjs) instead, a pure function from an execution record to a decision, asserted by `node --test` in the `Scripts` job with fabricated execution records as fixtures. Retrofitting the older gate onto it is the obvious follow-up and is deliberately not done here, because that gate is entangled with the stop-condition problem in "The review check goes green when the reviewer declined to look at the new commits" (issue 75), and doing both at once makes one change out of two.

**Why the verdict is a line and not a judgement about prose.** `/security-review` returns prose, and a check cannot read prose: grepping it for "critical" or "high" passes and fails on the same sentence depending on phrasing, since *no critical or high severity issues found* contains both words and means their opposite. So the run is held to a contract — end with exactly one `SECURITY-VERDICT:` line naming the highest severity found — and the gate reads that line, anchored to the start of a line so prose cannot match it. A missing line is red, because a run that gave no verdict did not reach one. **Two** lines is also red: a run that stated two answers has not given one, and choosing between them would invent a result nobody reported. **Only `HIGH` blocks** — `MEDIUM` and `LOW` land as inline comments for a person to weigh, on the same reasoning as the code-scanning threshold: a gate that stops a merge for every finding of any size is one people learn to route around.

**Why the two Claude review workflows skip pull requests from forks.** A fork's pull request runs with a read-only token and no repository secrets, so neither job can run at all. Left to fail they would report red for a reason having nothing to do with the change, which is how a check stops being read; skipping says so instead. The convenient fix — `pull_request_target` — is the one thing neither workflow will ever do: it runs the base branch's workflow with the secrets in scope against code the pull request author controls, which on a public repository that allows forking hands `CLAUDE_CODE_OAUTH_TOKEN` to anyone who opens one. Rotating it afterwards closes the window but undoes nothing done inside it.

**Why the review has a gate step.** `claude-code-action` reports success when the *session* ended cleanly, which is not the same as a review having happened: earlier runs here were blocked by a denied tool, or launched their subagents in the background and ended waiting for a completion notification that a one-shot run never sends — and every one of those was a green tick. The `Assert the review actually ran` step therefore reads the execution output and turns the check red unless Claude reached a verdict, the signal being that it *posted* something on the pull request, which with `--comment` every path to a verdict does. That last part is not free: the plugin command may stop without a word on a change it judges too simple to be worth reviewing, so the workflow's appended system prompt tells it to post that verdict like any other — otherwise a review that reached the right answer is indistinguishable from one that never ran, which is how a correct review of pull request 80 came to fail this gate. Denied tool calls are fatal only when no verdict landed and are otherwise a warning, and the turn count is never more than a warning, because a legitimately short run (the review declining to repeat itself) and a blocked one look alike. That history is written into the workflow file's comments, which is the honest place for it.

One consequence worth knowing: the action refuses to run when the workflow file differs from the copy on `main`, so **a pull request that edits `claude-code-review.yml` is not reviewed by it**. The gate makes that red rather than green, on purpose.

**Posting the findings is where the automation stops.** Answering them is manual, and it is a rule rather than a courtesy: reply in each review thread naming the commit that fixed it, then resolve it — see "Review findings" in [CLAUDE.md](CLAUDE.md). Nothing about pushing a fix, or merging, closes a thread, so a pull request whose review still looks untouched is exactly what a fully handled review looks like until someone answers it.

Note the ordering this implies. The review is triggered *by* the push, so it has not run yet at the moment the pull request appears — opening one and calling the work done reliably leaves findings nobody has read. Wait for the checks to settle first (`until ! gh pr checks <number> | grep -q 'pending'; do sleep 30; done`), then answer what came back.

### Checked in — agent configuration

| What | Where | Effect |
|---|---|---|
| Project instructions | [CLAUDE.md](CLAUDE.md) | Loaded into every session in this repository: how to run it, when to scope, the two testing rules that get skipped most, and what answering a review's findings requires. |
| `scoping` skill | [.claude/skills/scoping/](.claude/skills/scoping/SKILL.md) | Sharpen fuzzy requirements, size the work as a vertical slice, enumerate the failure modes of anything that changes state it cannot put back, produce its statement list — before any code. Triggers on work starting, not on the decision to file an issue. |
| `testing` skill | [.claude/skills/testing/](.claude/skills/testing/SKILL.md) | The binding test rules, restated in full so no agent has to open the strategy document to write a test. |
| `github-issue` skill | [.claude/skills/github-issue/](.claude/skills/github-issue/SKILL.md) | The issue body template and the `gh` publishing step, once scoping has run. |
| Enabled plugin | [.claude/settings.json](.claude/settings.json) | Records that `mattpocock-skills` should be on for this project. The plugin itself is installed per machine (below); the repository only records the intent. |

Skills trigger themselves from their descriptions, so nobody has to remember to invoke them — which is the point of them living in the repository rather than in one person's setup.

### Checked in — local commands

| Command | What it does |
|---|---|
| `pnpm dev` | Migrates, seeds, builds `dist` if it has never been built, then runs both halves. One command, deliberately: see [Run it](#run-it). |
| `pnpm branches:tidy` | Reaps the local branches and worktree metadata that squash-merging leaves behind: see [Tidying up branches](#tidying-up-branches). |
| `pnpm typecheck`, `pnpm test`, `pnpm build` | The same three gates CI runs, so a red pipeline is reproducible locally. |
| `scripts/health-check.sh` | The post-deploy assertion against `/health`, which is Bypass-policied out of Cloudflare Access so it tests the app rather than a login page. |
| [.vscode/launch.json](.vscode/launch.json) | Debug the SPA in Chrome, attach to the Worker's inspector on `:9229`, or both at once. |

**There are no git hooks in this repository, on purpose.** Nothing installs a `pre-commit` or `pre-push` hook and there is no husky/lefthook dependency. The gate is CI: it cannot be skipped with `--no-verify`, and it runs on the machine that decides. When you want to be interrupted locally is a personal preference, so it belongs in the machine-local list below.

### Set up once on the GitHub repository (not in the code)

This lives in repository settings, so a fresh fork gets none of it. The deployment-side reasoning is in [docs/deployment.md](docs/deployment.md) under *Secrets and access* and *Bootstrap runbook*; the short list:

| Kind | Name | Needed by |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | all three deploy workflows |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | all three deploy workflows |
| Secret | `CLAUDE_CODE_OAUTH_TOKEN` | all three Claude workflows |
| Variable | `CLOUDFLARE_WORKERS_SUBDOMAIN` | the deploy URLs and the health checks |

- **Branch protection on `main`**, whose payload *is* checked in — [.github/branch-protection.json](.github/branch-protection.json) — but which still has to be applied, by the repository owner, because configuration nobody can review or restore is not really configuration:

  ```bash
  gh api -X PUT repos/michaelvanhoutte/cockpit/branches/main/protection --input .github/branch-protection.json
  ```

- **The GitHub-native security controls.** Secret scanning and push protection were already on before anything was built for them; Dependabot alerts and security updates were turned on by two `gh api` calls. Routine dependency version bumps are deliberately off, and the code-scanning failure threshold is deliberately left at its default. The commands, the dates they were checked, and the reasoning are in [docs/deployment.md](docs/deployment.md) under *Bootstrap runbook*.
- **Automatically delete head branches**, in the repository settings. `pnpm branches:tidy` keys on a local branch's upstream being `[gone]`, so it is only trustworthy while that setting is on.
- **The Claude GitHub App**, installed on the repository, plus the OAuth token above. The usual path is `/install-github-app` from an interactive Claude Code session, which installs the app and stores the secret for you.
- **Cloudflare Access on all three environments**, with a Bypass policy scoped to `/health`. Dashboard only; the reasoning is in the deployment doc.
- The `staging` and `production` **GitHub environments**, which give deployment history in the UI and somewhere to hang a required reviewer later without touching a workflow file.

### Set up on your own machine (recommended, none of it in the code)

None of this arrives with `pnpm install`, and all of it is per-developer:

- **Node ≥ 22 with corepack** (`corepack enable pnpm`), so the pnpm version comes from `package.json` rather than from whatever is on your PATH.
- **`gh`, authenticated** (`gh auth login`). The `github-issue` skill files issues with it, the branch-protection command above needs it, and it is how pull requests get opened and merged.
- **Commit attribution.** Commits authored with an address GitHub cannot link are orphaned — no profile, no contribution graph. This repository has history in exactly that state. Use **your own** noreply address, which GitHub shows you under Settings → Emails, rather than the one in `docs/deployment.md`, which is the owner's:

  ```bash
  git config --global user.email "<id>+<username>@users.noreply.github.com"
  ```

  The `users.noreply.github.com` form is preferred over a real address: it links commits correctly, keeps an address out of a public repository where it would be scraped, and is bound to the GitHub account rather than to a mail provider.

- **The Claude Code plugin this project enables.** `.claude/settings.json` records that `mattpocock-skills` should be on, but the marketplace and the plugin are installed per machine, from `/plugin` in an interactive session.
- **Worktrees.** Claude Code sessions work in `.claude/worktrees/<name>`, which is gitignored. A fresh worktree has no `node_modules`, so `pnpm install` there before running anything, and `pnpm branches:tidy` afterwards to prune the ones whose directories are gone.
- **`wrangler` authentication**, only for owner-level work: the one-time bootstrap, `wrangler secret put`, `wrangler versions list`/`deploy` for a rollback, or D1 Time Travel. Day-to-day development never needs it, because `pnpm dev` runs against a local D1.
- **A pre-push hook, if you want one.** Not in the repository, for the reason above, but nothing stops you: point `core.hooksPath` at a directory of your own and run `pnpm test:fast` from it. Keep it to the fast tiers — a hook slow enough to be worth skipping gets skipped.

## Proofs of concept

- [poc/prototype](poc/prototype/) — the original clickable HTML/CSS/JS mockup this app is converted from. Open `poc/prototype/index.html` directly in a browser; no build step. Kept until the app covers everything it demonstrates.
- [poc/slack-realtime](poc/slack-realtime/README.md) — tests whether Slack's Real-time Search API can supply the DMs and @mentions the follow-up inbox needs.
- [poc/notion-inbox](poc/notion-inbox/README.md) — the Notion follow-up inbox POC behind [docs/notion-integration-options.md](docs/notion-integration-options.md).
- [poc/coverage-explorer](poc/coverage-explorer/README.md): derives a per-node test coverage model from the repository and renders it as an explorer, behind [docs/coverage-reporting-options.md](docs/coverage-reporting-options.md). Outside the workspace, so it never runs in CI.
