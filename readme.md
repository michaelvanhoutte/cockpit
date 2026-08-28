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
├── .github/           # CI and the three deploy workflows (§9.1)
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

## Proofs of concept

- [poc/prototype](poc/prototype/) — the original clickable HTML/CSS/JS mockup this app is converted from. Open `poc/prototype/index.html` directly in a browser; no build step. Kept until the app covers everything it demonstrates.
- [poc/slack-realtime](poc/slack-realtime/README.md) — tests whether Slack's Real-time Search API can supply the DMs and @mentions the follow-up inbox needs.
- [poc/notion-inbox](poc/notion-inbox/README.md) — the Notion follow-up inbox POC behind [docs/notion-integration-options.md](docs/notion-integration-options.md).
- [poc/coverage-explorer](poc/coverage-explorer/README.md): derives a per-node test coverage model from the repository and renders it as an explorer, behind [docs/coverage-reporting-options.md](docs/coverage-reporting-options.md). Outside the workspace, so it never runs in CI.
