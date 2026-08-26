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
├── scripts/           # branch-alias derivation for preview URLs (+ its assertions)
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

# one-time local database setup
pnpm --filter @cockpit/api db:migrate:local
pnpm --filter @cockpit/api db:seed:local

# one-time: the Worker serves apps/web/dist as static assets, so that
# directory has to exist before wrangler will start
pnpm build

# terminal 1: the API on http://localhost:8787 (wrangler + local D1)
pnpm dev:api

# terminal 2: the web app on http://localhost:5173 (proxies /v1 to the API)
pnpm dev:web
```

`pnpm typecheck` and `pnpm test` run across all packages.

## Proofs of concept

- [poc/prototype](poc/prototype/) — the original clickable HTML/CSS/JS mockup this app is converted from. Open `poc/prototype/index.html` directly in a browser; no build step. Kept until the app covers everything it demonstrates.
- [poc/slack-realtime](poc/slack-realtime/README.md) — tests whether Slack's Real-time Search API can supply the DMs and @mentions the follow-up inbox needs.
- [poc/notion-inbox](poc/notion-inbox/README.md) — the Notion follow-up inbox POC behind [docs/notion-integration-options.md](docs/notion-integration-options.md).
- [poc/coverage-explorer](poc/coverage-explorer/README.md): derives a per-node test coverage model from the repository and renders it as an explorer, behind [docs/coverage-reporting-options.md](docs/coverage-reporting-options.md). Outside the workspace, so it never runs in CI.
