# Cockpit — Unified Inbox & Dashboards

The production application for the Unified Inbox & Dashboards concept, built to the recorded decisions in [docs/architecture.md](docs/architecture.md) (the how), [docs/functional-definition.md](docs/functional-definition.md) (the what), [docs/testing-strategy.md](docs/testing-strategy.md) (the proof), and [docs/deployment.md](docs/deployment.md) (the where). Unscheduled ideas are in [docs/ideas.md](docs/ideas.md) (the maybe).

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
├── tools/             # workspace packages that serve the build, not the product: the Test Explorer
├── docs/              # functional definition, architecture, testing strategy, deployment, options docs
├── scripts/           # local dev startup, the browser tier's stack, branch tidying
├── .github/           # CI, CodeQL, the three Claude workflows, the two deploy workflows, branch protection
├── .claude/           # project skills and Claude Code settings every session picks up
└── poc/               # proofs of concept (kept; they are part of the showcase)
```

One Worker per environment serves both the API and the SPA on one origin, so `apps/api` is the deployment and `apps/web/dist` is its static-asset payload.

Not yet in place, deliberately and in build order: app login ("App login: hand-rolled Google OIDC + own sessions" in [docs/architecture.md](docs/architecture.md)), the connectors ("Connectors: plugin-shaped, host-blind"), and the task-creator merge.

## Environments

Trunk-based: `main` is the trunk, every other branch is gated on push and deployed nowhere, merging deploys staging, and **production is a deliberate promotion pinned to one commit**. The model and its arguments — including why branches get no environment — are in [docs/deployment.md](docs/deployment.md).

Both are behind Cloudflare Access, `/health` excepted so the deploy checks and the uptime monitor can reach it.

| | Deployed by | URL |
|---|---|---|
| production | the *Promote to production* action | `cockpit.vanhoutte-michael.workers.dev` |
| staging | every commit on `main` | `cockpit-staging.vanhoutte-michael.workers.dev` |

## Run it

Prerequisites: Node ≥ 22 (pnpm comes via corepack).

```bash
corepack enable pnpm
pnpm install
pnpm dev
```

`pnpm dev` applies the local D1 migrations, seeds the database, builds `apps/web/dist` if it has never been built (Wrangler refuses to start without it), then runs the API on <http://localhost:8787> and the web app on <http://localhost:5173> together, output prefixed per process. Ctrl+C stops both, and either one exiting takes the other down rather than leaving half an app looking healthy. Every step is idempotent, so re-running is safe. `pnpm dev:api` and `pnpm dev:web` run one half alone; `pnpm build` for a real production build.

The first screen is the logon page listing the two people the seed creates: pick one and you are in their account. There is no password, deliberately and temporarily — see "App login" in [docs/architecture.md](docs/architecture.md).

**It stays one command deliberately.** The testing strategy requires the application to be started and the change actually exercised before anything is claimed to work, and four commands across two terminals is the friction that quietly turns "start the app" into "the tests passed".

`pnpm typecheck` and `pnpm test` run across all packages. Both assume the install matches `pnpm-lock.yaml`, which two ordinary things break: a fresh worktree has no `node_modules`, and a pull that adds a workspace package leaves yours incomplete. Run `pnpm install` after either.

Skip it and the first run fails for that reason rather than for anything you changed, which does not look like a missing install: a package whose dependencies were never linked reports its runner missing (`'vitest' is not recognized`), and the giveaway is the line above it — `Scope: 6 of 7 workspace projects` against a repository that now has seven.

### Tidying up branches

```bash
pnpm branches:tidy        # --dry-run to see the plan without deleting
```

Deletes the local branches left behind by merged PRs, prunes worktree metadata for directories that no longer exist, and lists (without deleting) branches that were never pushed.

It keys on the upstream being gone rather than on `git branch --merged`, because squash-merging makes `--merged` permanently answer "no": a branch's commits never reach the trunk, only a new commit carrying their content. GitHub deletes the remote branch when a PR merges, so an orphaned local branch is a merged one. Branches never pushed have no such signal, so the script reports them for you to judge.

## Tests

Read [docs/testing-strategy.md](docs/testing-strategy.md) (the reasoning) or `.claude/skills/testing/` (the binding rules, restated so no agent has to open the strategy doc) before adding, moving or reviewing a test. The short version: pick the lowest level that can prove a behaviour, and never claim something works from green tests alone.

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

# the scripts that start the app and the test stack, the post-deploy
# health check, and the security review's gate; no install needed
pnpm test:scripts
```

One-time, on a machine that has never run the browser tier: `pnpm exec playwright install chromium`. It is the only setup step `pnpm install` does not cover, and without it `pnpm test:e2e` fails immediately telling you to run exactly that.

One package at a time:

```bash
pnpm --filter @cockpit/shared test:unit       # domain types, schemas, ids — no real dependencies
pnpm --filter @cockpit/api test:unit          # domain logic — no real dependencies
pnpm --filter @cockpit/api test:integration   # command handling against real local storage (~25s, not in test:fast)
pnpm --filter @cockpit/web test:f-unit        # component logic, API client mocked at the boundary
pnpm test:e2e --project=phone                 # the browser walks on one device instead of both
pnpm test:e2e tests/e2e/capture.test.ts       # one browser walk
```

For a live-reloading loop, run vitest directly instead of the `run`-only package script (`pnpm --filter @cockpit/web exec vitest`); the browser tier's equivalent is `pnpm test:e2e --ui`.

**Nothing has to be running first, and nothing you have running will be disturbed.** Every tier brings its own world:

- `apps/api`'s integration tests get a fresh, real D1 instance per test file from the Workers pool, gone when the run ends. An account's own data lives in a real Durable Object, and there is one per account name rather than one per test file, so the cases that touch it empty it themselves (`tests/integration/seed.ts`).
- The browser tier starts a **second copy of the whole application** — its own Wrangler on :8887, its own Vite on :5273, its own state directory — and throws the storage away afterwards. Your `pnpm dev` keeps running untouched.

That storage is rebuilt before every run, so a run can never be made to pass or fail by something you did in the browser yesterday. The **register** is rebuilt by copying a template (about 220KB, 5ms) rather than by running migrations and the seed (about seven seconds, nearly all process startup); the template is rebuilt only when a migration or `seed.sql` changes, keyed by their contents, so there is no stale-template failure to remember. **Each account's own store** is not in that template — a Durable Object cannot be written from outside — so each run starts them empty and the first request that opens one creates it and gives it the workspaces an account starts with. A whole run costs about 7 seconds warm, 18 the first time.

What that does *not* buy is isolation between tests inside one run: all specs share the one stack, so each creates what it needs and asserts on its own rows rather than on counts. Real per-test isolation arrives with workspace creation.

`pnpm dev` is still the other required step: manually exercising a change the browser tier does not cover.

## Development automation

Two different things get called "our automation": what is **checked into this repository**, which every clone and every agent gets with no setup, and what has to be **configured once** on GitHub or on your machine. A missing piece of the second kind usually shows up as a workflow that is green while nothing happened.

### Checked in — GitHub Actions

| Workflow | Fires on | What it does |
|---|---|---|
| [CI](.github/workflows/ci.yml) | every push, and pull requests to `main` | Six parallel jobs, so a failure names itself. `Typecheck`, `Test`, `E2E (F3)`, `Build` and `Scripts` are five of the eight contexts the branch-protection payload lists (the other three are CodeQL's); `Test Explorer` publishes a report and deliberately does not gate. `E2E (F3)` installs Chromium and runs the browser tier against the same isolated local stack you get locally, keeping failure traces as an artifact. `Scripts` runs the unit tests for `scripts/lib/`, because a silent change in the test stack's guards would let a run start against a database it did not create, and one in the review gate would let a non-review ship green. A branch with an open pull request is checked twice, once per event: `push` covers a branch with no pull request, `pull_request` covers the merge result. |
| [CodeQL](.github/workflows/codeql.yml) | pushes and pull requests to `main` | Two legs: `javascript-typescript` over the application sources, and `actions` over the workflow files — where this repository's own risk sits, since its workflows run Claude against an OAuth token and check out pull request branches. Both read the sources directly (`build-mode: none`). No path filters, deliberately: a required check that is skipped never reports, and a pull request waits on it forever. Superseded pull request runs are cancelled; runs on `main` are not, being the baseline every pull request is compared against. |
| [Claude Code Review](.github/workflows/claude-code-review.yml) | pull request opened, pushed to, reopened, ready for review | Runs the `code-review` plugin command and posts findings as inline comments. A second step asserts the review *actually ran* — see below. |
| [Claude Security Review](.github/workflows/claude-security-review.yml) | same | A security pass over the diff, scoped by [.github/security-review-instructions.md](.github/security-review-instructions.md) to this project's own rules. CodeQL is the mechanical half and this is the judgement half, so the instructions say not to re-derive what CodeQL reports. The run must end with a one-line verdict naming the highest severity found; the check goes red when that line is missing or names the top severity. Skipped on pull requests from forks — see below. |
| [Claude Code](.github/workflows/claude.yml) | `@claude` in an issue, comment or review | Hands that comment to Claude with read access to the repository and CI results. |
| [Deploy staging](.github/workflows/deploy-staging.yml) | every commit on `main`, plus manual re-runs | The same gate, then migrate and deploy, then assert `/health`. Never re-seeded: accumulated data is the point of staging. |
| [Promote to production](.github/workflows/deploy-production.yml) | manual only, with an optional commit SHA | Refuses any commit that is not an ancestor of `origin/main`; then re-runs the full gate against that tree, migrates, deploys, and verifies `/health`. |

The three workflows that need a toolchain — CI and the two deploys — share [`.github/actions/setup`](.github/actions/setup/action.yml), so the pnpm version, the Node version and the frozen-lockfile install are declared once.

**Why the security review's gate is a module and the code review's is not.** They answer the same question — did this run reach a verdict — and the older one answers it in about 120 lines of bash inside a `run:` block. Every incident recorded in that file's comments is a bug in that bash rather than in the reviewing: a `permission_denials_count` field read as "no denials", two blocked sessions passing as clean, a result payload that is sometimes an array and sometimes an object. All four shipped green, because inline bash cannot be run by a test. The security review's version is [`scripts/lib/review-gate.mjs`](scripts/lib/review-gate.mjs), a pure function from an execution record to a decision, asserted by `node --test`. Retrofitting the older gate onto it is deliberately not done here, because that gate is entangled with "The review check goes green when the reviewer declined to look at the new commits" (issue 75).

**Why the verdict is a line and not a judgement about prose.** A check cannot read prose: grepping for "critical" or "high" passes and fails on the same sentence depending on phrasing, since *no critical or high severity issues found* contains both words and means their opposite. So the run is held to a contract — exactly one `SECURITY-VERDICT:` line naming the highest severity — and the gate reads that line, anchored to the start of a line. A missing line is red, because a run that gave no verdict did not reach one. **Two** lines is also red: choosing between them would invent a result nobody reported. **Only `HIGH` blocks**; `MEDIUM` and `LOW` land as inline comments, on the same reasoning as the code-scanning threshold — a gate that stops a merge for every finding is one people learn to route around.

**The gate writes the summary comment, not the reviewer.** The prompt used to ask the reviewer to post one when it found nothing, and on the first run that reached a verdict it posted nothing at all — a green check whose only evidence was inside the job log. Asking harder would repeat the sibling workflow's mistake of inferring a review from whether Claude spoke. The gate already knows the verdict, so it says so itself, editing its previous note rather than adding one per push. Posting is never fatal: failing a clean review over a comment that could not be left would be the gate doing what it refuses in the reviewer.

**Why the two Claude review workflows skip pull requests from forks.** A fork's pull request runs with a read-only token and no secrets, so neither job can run; left to fail they would report red for a reason having nothing to do with the change. The convenient fix — `pull_request_target` — is the one thing neither will ever do: it runs the base branch's workflow with the secrets in scope against code the pull request author controls, which hands `CLAUDE_CODE_OAUTH_TOKEN` to anyone who opens one.

**Why the review has a gate step.** `claude-code-action` reports success when the *session* ended cleanly, which is not the same as a review having happened: earlier runs here were blocked by a denied tool, or ended waiting for a completion notification a one-shot run never sends, and every one was a green tick. The `Assert the review actually ran` step turns the check red unless Claude reached a verdict, the signal being that it *posted* something. That is not free: the plugin command may stop without a word on a change it judges too simple to review, so the workflow's system prompt tells it to post that verdict like any other — otherwise a review that reached the right answer is indistinguishable from one that never ran, which is how a correct review of pull request 80 came to fail this gate. Denied tool calls are fatal only when no verdict landed; the turn count is never more than a warning, because a legitimately short run and a blocked one look alike.

One consequence, which is the action's behaviour rather than either workflow's: it refuses to run when the workflow file differs from the copy on `main`, so **a pull request editing `claude-code-review.yml` is not reviewed by it, and one editing `claude-security-review.yml` is not security-reviewed by it**. Both gates make that red on purpose, and the cost is that a fix to either cannot be watched working until it merges.

**Posting the findings is where the automation stops.** Answering them is manual and it is a rule: reply in each review thread naming the commit that fixed it, then resolve it — see "Review findings" in [CLAUDE.md](CLAUDE.md). Nothing about pushing a fix or merging closes a thread.

Note the ordering. The review is triggered *by* the push, so it has not run when the pull request appears — and it has not necessarily been *created* either, since `ci.yml` also runs on `push`, so a commit can carry a full set of finished check runs while the pull-request-triggered ones have not been dispatched. Wait for the checks to settle first; the command is in "Review findings" in [CLAUDE.md](CLAUDE.md), and lives there alone because the copy that used to sit here went stale the day that one was fixed.

### Checked in — agent configuration

| What | Where | Effect |
|---|---|---|
| Project instructions | [CLAUDE.md](CLAUDE.md) | Loaded into every session: how to run it, how to write, when to scope, the two testing rules that get skipped most, and what answering a review requires. |
| `scoping` skill | [.claude/skills/scoping/](.claude/skills/scoping/SKILL.md) | Sharpen requirements, size the vertical slice, enumerate failure modes, produce the statement list — before any code. |
| `testing` skill | [.claude/skills/testing/](.claude/skills/testing/SKILL.md) | The binding test rules, restated in full so no agent has to open the strategy document. |
| `github-issue` skill | [.claude/skills/github-issue/](.claude/skills/github-issue/SKILL.md) | The issue body template, its length rules, and the `gh` publishing step. |
| Enabled plugin | [.claude/settings.json](.claude/settings.json) | Records that `mattpocock-skills` should be on. The plugin itself is installed per machine. |

Skills trigger themselves from their descriptions, which is the point of them living in the repository rather than in one person's setup.

### Checked in — local commands

| Command | What it does |
|---|---|
| `pnpm dev` | Migrates, seeds, builds `dist` if it has never been built, then runs both halves. |
| `pnpm branches:tidy` | Reaps the local branches and worktree metadata that squash-merging leaves behind. |
| `pnpm typecheck`, `pnpm test`, `pnpm build` | The same three gates CI runs, so a red pipeline is reproducible locally. |
| `scripts/health-check.mjs` | The post-deploy assertion against `/health`. It asks until the deployment says it is well or a minute is up, because the first request after a deploy is the one that brings an account store up to date. |
| [.vscode/launch.json](.vscode/launch.json) | Debug the SPA in Chrome, attach to the Worker's inspector on `:9229`, or both. |

**There are no git hooks in this repository, on purpose.** The gate is CI: it cannot be skipped with `--no-verify`, and it runs on the machine that decides. When you want to be interrupted locally is a personal preference, so it belongs in the machine-local list below.

### Set up once on the GitHub repository (not in the code)

This lives in repository settings, so a fresh fork gets none of it. The reasoning is in [docs/deployment.md](docs/deployment.md) under *Secrets and access* and *Bootstrap runbook*.

| Kind | Name | Needed by |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | both deploy workflows |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | both deploy workflows |
| Secret | `CLAUDE_CODE_OAUTH_TOKEN` | all three Claude workflows |
| Variable | `CLOUDFLARE_WORKERS_SUBDOMAIN` | the deploy URLs and the health checks |

- **Branch protection on `main`**, whose payload *is* checked in — [.github/branch-protection.json](.github/branch-protection.json) — but which the owner still has to apply, because configuration nobody can review or restore is not really configuration:

  ```bash
  gh api -X PUT repos/michaelvanhoutte/cockpit/branches/main/protection --input .github/branch-protection.json
  ```

  Because applying it is a separate act, **the payload and the live setting drift** and nothing fails when they disagree — on 2026-09-01 the file listed eight required checks and `main` enforced four. Read the live one whenever the answer matters: `gh api repos/michaelvanhoutte/cockpit/branches/main/protection --jq '.required_status_checks.contexts'`.
- **The GitHub-native security controls.** Secret scanning and push protection were already on; Dependabot alerts and security updates were turned on by two `gh api` calls. Routine dependency bumps are deliberately off and the code-scanning failure threshold is deliberately left at its default. Commands and dates are in the bootstrap runbook.
- **Automatically delete head branches.** `pnpm branches:tidy` keys on a local branch's upstream being `[gone]`, so it is only trustworthy while that setting is on.
- **The Claude GitHub App**, installed on the repository, plus the OAuth token above — usually via `/install-github-app` from an interactive session.
- **Cloudflare Access on both environments**, with a Bypass policy scoped to `/health`. Dashboard only.
- The `staging` and `production` **GitHub environments**, for deployment history and somewhere to hang a required reviewer later.

### Set up on your own machine (recommended, none of it in the code)

- **Node ≥ 22 with corepack** (`corepack enable pnpm`), so the pnpm version comes from `package.json`.
- **`gh`, authenticated** (`gh auth login`) — the `github-issue` skill, the branch-protection command, and pull requests all need it.
- **Commit attribution.** Commits authored with an address GitHub cannot link are orphaned, and this repository has history in exactly that state. Use **your own** noreply address, shown under Settings → Emails, rather than the owner's in `docs/deployment.md`:

  ```bash
  git config --global user.email "<id>+<username>@users.noreply.github.com"
  ```

  It links commits correctly, keeps an address out of a public repository, and is bound to the GitHub account rather than to a mail provider.
- **The Claude Code plugin this project enables.** `.claude/settings.json` records that `mattpocock-skills` should be on; the marketplace and plugin install per machine, from `/plugin`.
- **Worktrees.** Claude Code sessions work in `.claude/worktrees/<name>`, which is gitignored. A fresh worktree has no `node_modules`, so `pnpm install` there first, and `pnpm branches:tidy` afterwards.
- **`wrangler` authentication**, only for owner-level work: the bootstrap, `wrangler secret put`, a version rollback, or D1 Time Travel. Day-to-day development never needs it.
- **A pre-push hook, if you want one.** Not in the repository, but nothing stops you: point `core.hooksPath` at your own directory and run `pnpm test:fast`. Keep it to the fast tiers — a hook slow enough to be worth skipping gets skipped.

## Proofs of concept

- [poc/prototype](poc/prototype/) — the original clickable HTML/CSS/JS mockup this app is converted from. Open `index.html` directly; no build step. Kept until the app covers everything it demonstrates.
- [poc/slack-realtime](poc/slack-realtime/README.md) — whether Slack's Real-time Search API can supply the DMs and @mentions the follow-up inbox needs.
- [poc/notion-inbox](poc/notion-inbox/README.md) — the Notion follow-up inbox POC behind [docs/notion-integration-options.md](docs/notion-integration-options.md).
- [poc/coverage-explorer](poc/coverage-explorer/README.md) — derives a per-node test coverage model and renders it as an explorer, behind [docs/coverage-reporting-options.md](docs/coverage-reporting-options.md). Outside the workspace, so it never runs in CI.
