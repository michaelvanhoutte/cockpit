# Cockpit — Unified Inbox & Dashboards

The production application for the Unified Inbox & Dashboards concept, built to the recorded decisions in [docs/architecture.md](docs/architecture.md) (the how), [docs/functional-definition.md](docs/functional-definition.md) (the what), and [docs/testing-strategy.md](docs/testing-strategy.md) (the proof).

## Layout

```
cockpit/
├── apps/
│   ├── web/           # React + Vite installed PWA (TanStack Router/Query, Tailwind, Radix)
│   └── api/           # Cloudflare Worker: Hono HTTP API + SSE, D1 via Drizzle
├── packages/
│   ├── shared/        # THE contract: domain types, Zod schemas, commands, API shapes
│   ├── connector-sdk/ # the connector SPI (connectors land as packages/connectors/*)
│   └── config/        # shared tsconfig / prettier
├── docs/              # functional definition, architecture, testing strategy, options docs
└── poc/               # proofs of concept (kept; they are part of the showcase)
```

Not yet in place (deliberately, in build order): auth (§8.1), CI/CD (§9.1), the connectors themselves (§6.2), and the task-creator merge (§6.5).

## Run it

Prerequisites: Node ≥ 22 (pnpm comes via corepack).

```bash
corepack enable pnpm
pnpm install

# one-time local database setup
pnpm --filter @cockpit/api db:migrate:local
pnpm --filter @cockpit/api db:seed:local

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
