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
├── scripts/           # local dev startup, branch-alias derivation (+ its assertions), branch tidying
├── .github/           # CI, the two Claude workflows, the three deploy workflows, branch protection
├── .claude/           # project skills and Claude Code settings every session picks up
└── poc/               # proofs of concept (kept; they are part of the showcase)
```

One Worker per environment serves both the API and the SPA, on one origin (see [docs/deployment.md](docs/deployment.md)). `apps/api` is therefore the deployment, and `apps/web/dist` is its static-asset payload.

Not yet in place (deliberately, in build order): auth (§8.1), the connectors themselves (§6.2), and the task-creator merge (§6.5).

## Environments

Trunk-based: `main` is the trunk, every other branch gets its own Access-gated preview URL, merging deploys staging, and **production is a deliberate promotion pinned to one commit** rather than a consequence of merging. The model and its arguments are in [docs/deployment.md](docs/deployment.md).

All three are behind Cloudflare Access, `/health` excepted so the deploy checks and the uptime monitor can reach it.

| | Deployed by | URL |
|---|---|---|
| production | the *Promote to production* action | `cockpit.vanhoutte-michael.workers.dev` |
| staging | every commit on `main` | `cockpit-staging.vanhoutte-michael.workers.dev` |
| preview | every push to any other branch | `<branch-alias>-cockpit-preview.vanhoutte-michael.workers.dev` |

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

`pnpm typecheck` and `pnpm test` run across all packages. A freshly created worktree has no `node_modules`, so run `pnpm install` in it before either, or the first run fails for that reason rather than for anything you changed.

### Tidying up branches

```bash
pnpm branches:tidy        # --dry-run to see the plan without deleting
```

Deletes the local branches left behind by merged PRs, prunes worktree metadata for directories that no longer exist, and lists (without deleting) the branches that were never pushed.

It keys on the upstream being gone rather than on `git branch --merged`, because the squash-merge rule above makes `--merged` permanently answer "no": a branch's commits never reach the trunk, only a new commit carrying their content. GitHub deletes the remote branch when a PR merges, so an orphaned local branch is a merged one — and that is the signal. Branches that were never pushed have no such signal, so the script reports them for you to judge rather than guessing.

## Tests

Read [docs/testing-strategy.md](docs/testing-strategy.md) (the reasoning) or `.claude/skills/testing/` (the binding rules, restated so an agent never has to open the strategy doc to write a test) before adding, moving, or reviewing a test. The short version: pick the lowest level that can prove a behaviour, and never claim something works from green tests alone — the application has to actually be started and the change exercised in it.

```bash
# everything, as CI would
pnpm test:all

# just the fast tiers — unit + frontend component tests, no database spin-up;
# run this constantly while you work
pnpm test:fast

# same as test:all right now, kept for muscle memory
pnpm test
```

One package at a time, when you only want the tests near what you're touching:

```bash
pnpm --filter @cockpit/shared test:unit       # domain types, schemas, ids — no real dependencies
pnpm --filter @cockpit/api test:unit          # domain logic — no real dependencies
pnpm --filter @cockpit/api test:integration   # command handling against a real local D1 (~15s, not in test:fast)
pnpm --filter @cockpit/web test:f-unit        # component logic, API client mocked at the boundary
```

For a live-reloading loop while writing a test, run vitest directly instead of the `run`-only package script, e.g. `pnpm --filter @cockpit/web exec vitest`.

Tests never require `pnpm dev` to be running — `apps/api`'s integration tests spin up their own ephemeral, real D1 instance for the duration of the run (`@cloudflare/vitest-pool-workers`), separate from whatever `pnpm dev` would start. `pnpm dev` is for the other required step: manually exercising the changed behaviour in the browser, which the testing strategy treats as non-negotiable proof that green tests alone can't provide.

## Development automation

Two different things get called "our automation", and keeping them apart saves a lot of confusion: what is **checked into this repository**, which every clone and every agent gets with no setup at all, and what has to be **configured once** — on the GitHub repository or on your own machine — which no amount of `pnpm install` will hand you. A missing piece of the second kind usually shows up as a workflow that is green while nothing actually happened.

### Checked in — GitHub Actions

| Workflow | Fires on | What it does |
|---|---|---|
| [CI](.github/workflows/ci.yml) | pushes and pull requests to `main` | Four parallel jobs — `Typecheck`, `Test`, `Build`, `Scripts` — which are exactly the four contexts branch protection requires, so a failure names itself. `Scripts` runs `scripts/branch-alias.test.sh`, because a silent change in the preview-alias derivation would collide two branches onto one URL. Deliberately *not* triggered on every branch push: the preview deploy already runs the same checks there, and doing both would run everything twice. |
| [Claude Code Review](.github/workflows/claude-code-review.yml) | every pull request opened, pushed to, reopened or marked ready for review | Runs the `code-review` plugin command against the pull request and posts its findings as inline comments (a summary comment when it finds nothing). A second step then asserts that the review *actually ran* — see below. |
| [Claude Code](.github/workflows/claude.yml) | `@claude` in an issue, an issue or PR comment, or a review | Hands that comment to Claude with read access to the repository and to CI results, so an explanation or a fix can be asked for from the pull request itself. |
| [Deploy preview](.github/workflows/deploy-preview.yml) | pushes to any branch except `main` | Typechecks and tests first (a broken build must not replace a working preview), derives the branch alias, migrates and seeds the shared preview database, uploads a new Worker version behind `<alias>-cockpit-preview…`, and comments the URL on the pull request if there is one. Triggered on `push`, not `pull_request`, so a branch with no PR — or a draft one — still gets an environment. |
| [Deploy staging](.github/workflows/deploy-staging.yml) | every commit on `main`, plus manual re-runs | The same gate, then migrate and deploy, then assert `/health`. Never re-seeded: accumulated old data is the whole point of staging. |
| [Promote to production](.github/workflows/deploy-production.yml) | manual only, with an optional commit SHA | Refuses any commit that is not an ancestor of `origin/main`, since it has neither passed CI nor soaked on staging; then re-runs the full gate against that exact tree, migrates, deploys, and verifies `/health`. |

The four workflows that need a toolchain — CI and the three deploys — share [`.github/actions/setup`](.github/actions/setup/action.yml), so the pnpm version, the Node version and the frozen-lockfile install are declared once. The two Claude workflows need no such install.

**Why the review has a gate step.** `claude-code-action` reports success when the *session* ended cleanly, which is not the same as a review having happened: earlier runs here were blocked by a denied tool, or launched their subagents in the background and ended waiting for a completion notification that a one-shot run never sends — and every one of those was a green tick. The `Assert the review actually ran` step therefore reads the execution output and turns the check red unless Claude reached a verdict, the signal being that it *posted* something on the pull request, which with `--comment` every path to a verdict does. Denied tool calls are fatal only when no verdict landed and are otherwise a warning, and the turn count is never more than a warning, because a legitimately short run (the review declining to repeat itself) and a blocked one look alike. That history is written into the workflow file's comments, which is the honest place for it.

One consequence worth knowing: the action refuses to run when the workflow file differs from the copy on `main`, so **a pull request that edits `claude-code-review.yml` is not reviewed by it**. The gate makes that red rather than green, on purpose.

### Checked in — agent configuration

| What | Where | Effect |
|---|---|---|
| Project instructions | [CLAUDE.md](CLAUDE.md) | Loaded into every session in this repository: how to run it, when to scope, and the two testing rules that get skipped most. |
| `scoping` skill | [.claude/skills/scoping/](.claude/skills/scoping/SKILL.md) | Sharpen fuzzy requirements, size the work as a vertical slice, produce its statement list — before any code. Triggers on work starting, not on the decision to file an issue. |
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
| `scripts/branch-alias.sh` | Derives a branch's preview hostname. Used by the preview deploy, and asserted by its own test script in CI. |
| `scripts/health-check.sh` | The post-deploy assertion against `/health`, which is Bypass-policied out of Cloudflare Access so it tests the app rather than a login page. |
| [.vscode/launch.json](.vscode/launch.json) | Debug the SPA in Chrome, attach to the Worker's inspector on `:9229`, or both at once. |

**There are no git hooks in this repository, on purpose.** Nothing installs a `pre-commit` or `pre-push` hook and there is no husky/lefthook dependency. The gate is CI and the preview deploy: they cannot be skipped with `--no-verify`, and they run on the machine that decides. When you want to be interrupted locally is a personal preference, so it belongs in the machine-local list below.

### Set up once on the GitHub repository (not in the code)

This lives in repository settings, so a fresh fork gets none of it. The deployment-side reasoning is in [docs/deployment.md](docs/deployment.md) under *Secrets and access* and *Bootstrap runbook*; the short list:

| Kind | Name | Needed by |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | all three deploy workflows |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | all three deploy workflows |
| Secret | `CLAUDE_CODE_OAUTH_TOKEN` | both Claude workflows |
| Variable | `CLOUDFLARE_WORKERS_SUBDOMAIN` | the deploy URLs and the health checks |

- **Branch protection on `main`**, whose payload *is* checked in — [.github/branch-protection.json](.github/branch-protection.json) — but which still has to be applied, by the repository owner, because configuration nobody can review or restore is not really configuration:

  ```bash
  gh api -X PUT repos/michaelvanhoutte/cockpit/branches/main/protection --input .github/branch-protection.json
  ```

- **Automatically delete head branches**, in the repository settings. `pnpm branches:tidy` keys on a local branch's upstream being `[gone]`, so it is only trustworthy while that setting is on.
- **The Claude GitHub App**, installed on the repository, plus the OAuth token above. The usual path is `/install-github-app` from an interactive Claude Code session, which installs the app and stores the secret for you.
- **Cloudflare Access on all three environments**, with a Bypass policy scoped to `/health`. Dashboard only; the reasoning is in the deployment doc.
- The `staging` and `production` **GitHub environments**, which give deployment history in the UI and somewhere to hang a required reviewer later without touching a workflow file.

### Set up on your own machine (recommended, none of it in the code)

None of this arrives with `pnpm install`, and all of it is per-developer:

- **Node ≥ 22 with corepack** (`corepack enable pnpm`), so the pnpm version comes from `package.json` rather than from whatever is on your PATH.
- **`gh`, authenticated** (`gh auth login`). The `github-issue` skill files issues with it, the branch-protection command above needs it, and it is how pull requests get opened and merged.
- **Commit attribution.** Commits authored with an address GitHub cannot link are orphaned — no profile, no contribution graph. This repository has history in exactly that state:

  ```bash
  git config --global user.email "43439790+michaelvanhoutte@users.noreply.github.com"
  ```

- **The Claude Code plugin this project enables.** `.claude/settings.json` records that `mattpocock-skills` should be on, but the marketplace and the plugin are installed per machine, from `/plugin` in an interactive session.
- **Worktrees.** Claude Code sessions work in `.claude/worktrees/<name>`, which is gitignored. A fresh worktree has no `node_modules`, so `pnpm install` there before running anything, and `pnpm branches:tidy` afterwards to prune the ones whose directories are gone.
- **`wrangler` authentication**, only for owner-level work: the one-time bootstrap, `wrangler secret put`, `wrangler versions list`/`deploy` for a rollback, or D1 Time Travel. Day-to-day development never needs it, because `pnpm dev` runs against a local D1.
- **A pre-push hook, if you want one.** Not in the repository, for the reason above, but nothing stops you: point `core.hooksPath` at a directory of your own and run `pnpm test:fast` from it. Keep it to the fast tiers — a hook slow enough to be worth skipping gets skipped.

## Proofs of concept

- [poc/prototype](poc/prototype/) — the original clickable HTML/CSS/JS mockup this app is converted from. Open `poc/prototype/index.html` directly in a browser; no build step. Kept until the app covers everything it demonstrates.
- [poc/slack-realtime](poc/slack-realtime/README.md) — tests whether Slack's Real-time Search API can supply the DMs and @mentions the follow-up inbox needs.
- [poc/notion-inbox](poc/notion-inbox/README.md) — the Notion follow-up inbox POC behind [docs/notion-integration-options.md](docs/notion-integration-options.md).
- [poc/coverage-explorer](poc/coverage-explorer/README.md): derives a per-node test coverage model from the repository and renders it as an explorer, behind [docs/coverage-reporting-options.md](docs/coverage-reporting-options.md). Outside the workspace, so it never runs in CI.
