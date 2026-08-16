# CLAUDE.md

Standing instructions for agents working in this repository. Required by [docs/testing-strategy.md](docs/testing-strategy.md) §10.

## The documents that decide

Read the one that governs your change before changing anything. They record decisions *and their arguments*, which is the point of this repository.

| Document | Governs |
|---|---|
| [docs/functional-definition.md](docs/functional-definition.md) | the what: capabilities, product rules |
| [docs/architecture.md](docs/architecture.md) | the how: stack, data model, budgets, CI shape |
| [docs/testing-strategy.md](docs/testing-strategy.md) | the proof: test levels, definition of done |
| [docs/deployment.md](docs/deployment.md) | the where: environments, promotion, runbook |

**Reading `docs/testing-strategy.md` is mandatory before writing or modifying any test.** Its §6 is the definition of done for agents, and it is binding.

When reality contradicts one of these documents, amend the document with the reasoning in the same change. Do not leave the code and the record disagreeing.

## Run it

Prerequisites: Node >= 22, `corepack enable pnpm`.

```bash
pnpm install
pnpm build                                     # apps/web/dist must exist before wrangler starts
pnpm --filter @cockpit/api db:migrate:local    # one time
pnpm --filter @cockpit/api db:seed:local       # one time
pnpm dev:api                                   # API on http://localhost:8787
pnpm dev:web                                   # web on http://localhost:5173, proxies /v1
```

`pnpm typecheck`, `pnpm test`, and `pnpm build` run across the workspace. Starting the app and exercising your change is not optional: testing-strategy §6.2 requires it, because green unit tests have never proven that the application runs.

Verification happens locally. All three deployed environments sit behind Cloudflare Access, so a preview URL is not reachable from an agent session.

## Conventions worth not rediscovering

- `packages/shared` is the contract. A shape crossing the client/server boundary is defined there once, never redeclared by hand on either side.
- Mutations are commands, not object PUTs (architecture §4.3).
- Every row carries `tenant_id`. Workspace scoping is enforced server-side in the query; the UI's scoping is presentation, not protection (§4.2, §8).
- Zod validation at every boundary.
- Client-generated IDs (UUIDv7/ULID) for user-created entities.
- Tombstones, not deletes, for items.
- Hard gates from architecture §7: initial compressed JS bundle under 200KB, cold open under 1s, interactions under 100ms. Heavy dependencies are lazy-loaded or rejected.
- Tests live separated by level per testing-strategy §9, each level runnable by its own command.

## Working on an issue

Use `/issue <number>`. It carries the full loop: read the issue and its comments, plan the test levels, build, run the fast tiers in full, exercise the change in a real browser, code review and security review, then PR.
