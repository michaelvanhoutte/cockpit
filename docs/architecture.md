# Architecture (v0.4)

*Status: draft for review. Owner: Michael. Companion to [functional-definition.md](functional-definition.md) (the what) and [testing-strategy.md](testing-strategy.md) (the proof). It records the technical decisions and the arguments behind them, because this repository is published as a worked example of agentic development and a decision without its reasoning is not reusable.*

## 1. Architectural drivers

Five constraints do most of the deciding; check every choice below against them.

1. **Agent-legibility is a first-class requirement.** This codebase is built primarily by AI agents, which makes "which stack are agents demonstrably strongest in" a real engineering criterion. It favors one language everywhere, mainstream tools, strict static typing, schema validation at every boundary, and explicit code over framework magic — conventions an agent can read beat conventions it must infer.
2. **The cold-open latency budget.** The app must open as fast as WhatsApp. Mail, Notion and Slack cost seconds to open, so quick notes migrate to whatever opens instantly; opening and capturing fast are survival criteria, enforced by budgets (§7). Capture must also work where no UI exists — the proven task-creator flow captures by voice in the car and by dictated SMS — so **capture is a backend capability with multiple front doors** (§6.5), not a web-client feature.
3. **The backend is connector- and job-shaped.** OAuth flows, Slack/Gmail webhooks, Notion polling, scheduled reconciliation, AI calls on ingest. That is a service with real background execution, not a bundle of request handlers.
4. **More than one user, SaaS-ready tomorrow.** Never hard-code how many accounts there are. Every row is tenant-scoped, and since "Sign in by picking a name, each user in their own account" (issue 86) that scoping is exercised rather than assumed. Auth is real OAuth *eventually* (§8.1); secrets are encrypted and workspace scoping is enforced server-side.
5. **The testing strategy is load-bearing.** [testing-strategy.md](testing-strategy.md) presupposes fast unit runners, integration tests against the service's own real database, thin capability-level end-to-end tests, and scheduled contract tests. The stack must make all of that cheap, and the fast-tier 5-minute budget gates the toolchain.

## 2. Language and ecosystem: TypeScript end-to-end

**TypeScript everywhere** — frontend, backend, shared contracts, tooling — in strict mode, in one monorepo, with Zod validation at every boundary.

## 3. System shape

Three deployable parts, one repository:

```
cockpit/
├── apps/
│   ├── web/          # React + Vite installed PWA (§5), served as static assets on Cloudflare
│   └── api/          # Cloudflare Worker: HTTP API + SSE + queue consumers + cron triggers (§6)
├── packages/
│   ├── shared/        # Item/Association domain types, Zod schemas, API contract
│   ├── connector-sdk/ # the connector SPI: what a connector is and what the host offers it (§6.2)
│   ├── connectors/
│   │   ├── gmail/     # each connector is its own package, depending ONLY on connector-sdk
│   │   ├── slack/
│   │   └── notion/
│   └── config/        # shared tsconfig, eslint, prettier
├── docs/             # this document and its siblings
├── poc/              # proofs of concept (kept; they are part of the showcase)
└── .github/          # CI/CD workflows (§9)
```

- **Monorepo, pnpm workspaces**, so a contract change and both sides of its implementation land in one reviewable PR. A second service only exists when a real boundary demands one.
- **`apps/api` is one Worker deployment** exposing the HTTP routes, the SSE endpoint, the queue consumers and the cron schedules together. Splitting them is a deployment decision for when load demands it.
- **`packages/shared` is the contract** — domain types, Zod schemas, command definitions (§4.3), API client. The frontend never redefines a server shape by hand.

## 4. Data layer

### 4.1 Cloudflare D1 (SQLite), via Drizzle

**Decision: D1** as the database, **Drizzle ORM** on top.

**This is a recorded reversal.** Earlier drafts chose Postgres, arguing SaaS-readiness demanded it. The Cloudflare hosting decision (§9) put that in conflict with the platform, and the review compared three exits: a second vendor for serverless Postgres (rejected — most moving parts, cross-network latency on every query, data held hostage to another company's free tier), leaving Cloudflare, or dropping Postgres. The Postgres argument was doing *speculative* work while the Cloudflare arguments do *concrete* work, so Postgres yielded:

- **The migration debt has a small principal.** Even iteration 2's full-firehose text for one user is single-digit gigabytes over years (attachments go to R2) against D1's 10GB ceiling, and the interest is only repaid if the SaaS future materializes — at which point a re-platforming project is happening anyway.
- **"SaaS-ready" is schema discipline, not an engine.** `tenant_id` columns work identically in SQLite, and the credible multi-tenant shape on this platform is **one store per tenant**, stronger isolation than row-scoping in a shared Postgres. *Which* store was settled later: a Durable Object per account, with the register staying in D1, measured in [account-storage-options.md](account-storage-options.md).
- **Test fidelity improves.** `wrangler`/miniflare runs actual SQLite locally, so L2 tests hit the production engine with zero containers, serving the 5-minute fast-tier budget.

**What is genuinely given up:** Postgres's toolbox — full-text search strength (SQLite's FTS5 is the designated answer for iteration 2's archive search), JSONB querying, and extensions such as pgvector (Vectorize is the platform answer if embeddings ever matter). D1's transaction model is batch-oriented rather than interactive; the command handlers already write in single batches, so it costs nothing at this scale but is a real constraint.

**Accepted risk, by owner decision: no upfront D1 verification.** D1 is assumed sufficient for single-user load and FTS5 is deferred to iteration 2. The recorded fallback is the co-located-Postgres platform (option B), not Cloudflare-plus-remote-Postgres (option A), because A was eliminated on its composition costs rather than on a tie-break.

**Drizzle over Prisma**, unchanged by the reversal: it stays close to SQL, the schema is TypeScript, and agents reason more reliably about SQL they can see than about a query engine they must trust. Keeping the SQL boringly standard is also what keeps the Postgres fallback real.

### 4.2 Schema conventions (the SaaS-ready and sync groundwork)

Cheap now, expensive to retrofit, so binding from the first migration:

- **`tenant_id` on every row**, non-null. It stays because it is what makes a request that reached the wrong store match no row instead of somebody else's ("One store per account, and `tenant_id` stays", below). Workspace scoping is enforced in queries server-side, never only in the UI.
- **Client-generated IDs** (UUIDv7/ULID) for user-created entities, so creating an item never waits on the server for an identity — which the capture path (§5.4) and any future offline work depend on. Server-generated rows use the same format.
- **Per-field `updated_at` semantics via command timestamps** (§4.3), giving last-write-wins per field, which is all a single-user-multi-device system needs.
- **Tombstones, not deletes**, for Items, matching the functional definition's reconciliation model.
- **Source-owned vs app-owned fields are separate column groups**, so re-syncs overwrite source-owned columns unconditionally and never touch app-owned ones.

#### The database is the second lock

These conventions are enforced by the schema, not by the callers that happen to exist today. Every write currently goes through the command handlers, so the constraints can never fire in normal operation — that is the point. They are what still holds when a connector, a migration, a backfill or a hand-run `wrangler d1 execute` writes rows the handlers never saw.

- **STRICT tables.** SQLite's default is dynamic typing with affinity, so a `TEXT` column stores an integer without complaint. `STRICT` (3.37+, which D1 runs) makes declared types enforced. Its guarantee is precisely *no lossy conversion*: a blob into a text column is refused, while `12345` into that column is still accepted as `'12345'`. It is not a substitute for a CHECK.
- **A CHECK for every closed set**, built in `src/accounts/schema.ts` and `src/db/schema.ts` from the same Zod enums the wire contract uses, so database and contract cannot drift.
- **Foreign keys, which D1 enforces**, with `ON DELETE RESTRICT` throughout: nothing here is hard-deleted, so a cascade would silently answer a question that should be asked. The command log is the deliberate exception and carries no foreign keys, because an audit trail must outlive what it refers to.

**Drizzle cannot express STRICT** — absent from `sqlite-core` and never emitted by drizzle-kit — so every migration adds it by hand and a regenerated migration silently drops it. The rule *what the product stores is what comes back* in `apps/api/tests/integration/db/constraints.test.ts` asserts it against the applied schema for exactly that reason.

**A CHECK cannot be added to a table that already has children.** SQLite cannot `ALTER TABLE` a CHECK in at all, so adding one means rebuilding the table — and on D1 a table with rows pointing at it under `ON DELETE RESTRICT` cannot be dropped, because `DROP TABLE` performs an implicit delete the foreign key refuses. `PRAGMA foreign_keys = OFF` is not a way out: D1 accepts the statement and ignores it (both measured against a real D1 on 2026-08-31). So one new CHECK on `workspaces` costs rebuilding `workspaces`, `items` and `associations` together — worth paying for a closed set the product depends on, not worth paying for a single nullable column only the command handlers write. `workspaces.deleted_at` is the recorded instance of the second, and migration 0002 says so. The limitation is about *altering*: an account's store creates its tables whole on first change, so the same column carries its CHECK there.

#### One store per account, and `tenant_id` stays

**Status: built.** An account's workspaces, dashboards, panels, layouts, items, associations and change log live in that account's own store; the register — which accounts exist — stays in D1. `apps/api/src/accounts/` is the only place either is read or written.

**A tenant is an account, not a Workspace.** Workspaces are the privacy boundary *inside* one account's data. One store per Workspace would break the Workspace switcher and every future cross-Workspace view.

**The store is a Durable Object, not a second D1 database**, measured rather than argued in [account-storage-options.md](account-storage-options.md). A D1 database per account cannot be provisioned without a deploy, since bindings resolve at deploy time, while a Durable Object is reached by name at runtime and created on first touch — and the price of that (each account applies outstanding schema changes inside somebody's request) turned out to be milliseconds. Three things follow, each visible in the code:

- **Bringing an account up to date happens inside a request**, so failure must be legible: `apps/api/src/accounts/up-to-date.ts` names the change and keeps the underlying cause, because the off-the-shelf migrator reports only `Rollback`.
- **The live-updates stream stays in the Worker**, polling the account's store rather than moving into it, because Durable Objects bill wall-clock duration and the stream is long-lived by design.
- **The register cannot be joined to account data** — D1 cannot join across bindings, and a Worker cannot join D1 to a Durable Object — so `tenant_id` carries no foreign key inside a store.

**`tenant_id` stays on every row even after the split.** It looks redundant once a store holds one account, and is not:

- **It is the second lock again.** Correctness otherwise rests entirely on addressing the right store; with `tenant_id` a routing bug returns nothing, without it that same bug serves another account's data.
- **It is the row's provenance** — the only thing that says whose a row is once it leaves its store in a backup, export or restore.
- **The platform choice is provisional.** The recorded fallback is co-located Postgres, where the credible shape is row-scoping and `tenant_id` is mandatory.
- **The cost is asymmetric**: keeping it is one text column already written and indexed; re-adding it means backfilling every row of every table.

**The move is a cutover, not a copy.** Rows in D1's `items`, `associations` and `commands` were not carried across: production holds `seed.sql` fixtures rather than real mail and staging holds what has been clicked through it, so there was nothing worth backfilling. Each environment gets a store that starts empty and creates the three starting workspaces on the first request.

**D1 still holds the four tables an account's data used to live in.** Removing them is a *contract* step for a later release, per "Migrations and rollback" in [deployment.md](deployment.md): a deploy applies migrations before the new code goes live, so dropping them in the same release would leave the old code reading tables already gone — and re-promoting the previous commit, the first way back, would leave it that way.

### 4.3 Mutations are commands, not object PUTs

All writes go through small, named, idempotent commands: `capture_item`, `set_status`, `snooze_until`, `associate`, `set_focus`. Each carries a client-generated command ID, the client timestamp, and a minimal Zod-validated payload from `packages/shared`.

Commands keep every door open at almost no cost: idempotent retries on flaky mobile networks, an audit trail for free, trivially testable pure handlers at L1, and exactly the API an offline queue would need if offline writes are ever promoted from exceptional to supported (§5.3). A generic `PUT /items/:id` gives none of that and invites lost updates between two devices.

## 5. Client architecture

### 5.1 React + Vite, installed PWA

**A plain SPA** — React, Vite, TanStack Router + Query — installed as a PWA with a service-worker-cached app shell. No server-side rendering: first paint comes from the persisted snapshot (§5.2), not from a server response.

### 5.2 The read model: persisted snapshot, revalidate, push

The server is authoritative; the client keeps a persisted cache purely for speed.

- On load the client paints **immediately from a snapshot in IndexedDB** (TanStack Query cache persistence), then revalidates in the background. Cold open makes zero blocking network requests.
- The working set is kilobytes, so the snapshot is **one API call per workspace**, not a replication protocol.
- **Panel rules evaluate client-side** against the snapshot, so reconfiguring, dragging, filtering and grouping stay inside the §7 interaction budget with no round trip.
- **Which layout a dashboard is drawn with is decided client-side too**, from that same snapshot, which carries every panel and every layout of the workspace: switching dashboard, resizing the window and picking a layout by hand all reflow without a request (functional definition, "Layouts: one arrangement per screen size"). Only *changing* an arrangement is a write, and it is one command carrying the whole arrangement rather than one per gesture.
- **Liveness via SSE**, since phone and desktop are commonly open at once: the API pushes invalidation events and the client also revalidates on focus. SSE over WebSockets because the channel is strictly server-to-client and SSE is plain HTTP — simpler to run, proxy and test. An idle SSE stream on Workers costs essentially nothing; a Durable Object is the designated upgrade path if connection churn ever bites.

  **`EventSource` reconnects natively — but only from some failures, and not the ones that matter.** Measured 2026-08-31 against the built app: a *dropped* connection retries every three seconds indefinitely, while a connection *answered* badly (a redirect to sign-in, a `503`) is abandoned after one attempt, permanently and silently. So the browser handles the failure that would heal anyway and gives up on the two that need handling. `apps/web/src/api/useServerEvents.ts` therefore replaces a permanently-closed stream itself, backing off 3s→60s, and asks the ungated `/health` first so an expired sign-in surfaces through the same screen a failed read uses rather than being announced twice.

### 5.3 The local-first decision, recorded

"Local-first" bundles three promises with very different costs, so the decision is recorded per promise:

| Promise | Verdict | Mechanism |
|---|---|---|
| **Instant render** (no spinner on open) | **Required.** Driver #2, and the reason the product will or won't get used. | Persisted snapshot + cached app shell (§5.2); budgets in §7. |
| **Offline read** (glance at state on a plane) | **Kept, at zero marginal cost.** Falls out of the same snapshot. | Nothing extra. |
| **Offline write** (triage offline, reconcile later) | **Rejected for v1.** Honestly exceptional in practice. A general mutation queue would double the staleness problem (source→server *and* server→client), add multi-device replay conflicts, and tax every future mutation with queue semantics and offline tests. | Not built. Commands (§4.3), client IDs and LWW timestamps keep a retrofit cheap. |

The general principle worth publishing: **the requirement was never "local-first", it was a latency budget.** Mail, Notion and Slack feel slow because of what happens before any data is requested — megabytes of JavaScript, hydration, auth redirects, workspace bootstrapping. Copy the mechanism, not the buzzword.

### 5.4 Capture: the one exception to "no offline queue"

Fast capture is the moment "I must jot this down before it evaporates", usually on a phone on a bad connection, and a note that fails to save is exactly the trust-destroyer the product exists to eliminate. So:

- **A create-only outbox.** New internal items are written to local storage first, rendered immediately, and flushed to `capture_item` commands when connectivity allows. Creates cannot conflict and client IDs make retries idempotent, so the whole mechanism is about a hundred lines. It must not grow into a general offline queue: a second command type wanting in reopens the §5.3 decision rather than sneaking past it.
- **Capture is a first-class entry point** — home-screen shortcut and PWA share-target land directly in a new-item view, inside the §7 capture budget.

### 5.5 How the client talks to the backend

Everything is plain HTTP to the one API in `apps/api`: no second protocol, no direct database access, no GraphQL, no WebSocket. Three patterns cover the entire client:

| Pattern | Transport | Used for |
|---|---|---|
| **Snapshot reads** | `GET`, one call per workspace | The read model of §5.2; every panel is derived locally rather than fetched. |
| **Commands** | `POST`, one endpoint per command (§4.3) | All writes, idempotent via client-generated command IDs. |
| **Push invalidation** | SSE (long-lived HTTP response) | "Something changed" events that trigger revalidation, keeping phone and desktop in agreement. |

So it is deliberately **not a resource-oriented REST surface**: a narrow contract of snapshots, commands and events, which is what makes the persisted cache, optimistic UI, the capture outbox and any future offline retrofit fall out of the same shapes.

**The contract is REST + OpenAPI, generated from the shared Zod schemas.** `@hono/zod-openapi` generates it, and Hono's typed client `hc` gives the frontend end-to-end inference from those same schemas, so no type is written twice. It stays language-neutral because non-TypeScript clients are foreseeable — the possible Kotlin car app (§10), a public API.

The service worker serves the cached app shell locally, and the capture outbox flushes to the same `capture_item` endpoint as an online capture — there is no separate "sync API".

### 5.6 Styling and components: Tailwind + Radix

**Tailwind for CSS, Radix for interactive primitives.**

- **Radix** supplies the menu and sheet primitives unstyled, so their focus trapping, keyboard navigation and ARIA are not ours to own and F1 tests cover Cockpit's logic rather than menu mechanics. The differentiating interactions — row swipe, drag-to-panel — are covered by no library and stay hand-written.
- **Tailwind** imposes no visual style: the prototype's palette, spacing, typography and workspace colors become design tokens in its config, and utilities stay co-located with the markup so deleting an element deletes its styling.
- Both sit well inside the §7 bundle gate, Tailwind emitting only the utilities used and Radix tree-shaking per primitive.

## 6. Backend architecture

### 6.1 Hono + Zod on Cloudflare Workers

**Hono** with Zod-validated routes (`@hono/zod-openapi`, which also generates the §5.5 contract), structured JSON logging into Workers Logs, and an explicit module layout.

Module layout inside `apps/api`:

```
src/
├── domain/        # pure logic: entities, command handlers, panel-rule engine (L1 territory)
├── db/            # Drizzle schema, migrations, repositories
├── http/          # Hono routes: thin adapters, validate → call domain → serialize
├── connectors/    # host side only: the registry wiring connector packages in, and the
│                  # generic /ingress/:connector webhook route (§6.2). No source-specific code.
├── jobs/          # queue consumers + cron handlers: sync schedules, reconciliation (§6.3)
└── ai/            # the AI layer behind an interface (§6.4)
```

The dependency rule is one-directional: `domain` imports nothing from the other layers, which makes the L1 tier a property of the design rather than a mocking exercise.

### 6.2 Connectors: plugin-shaped, host-blind

**Requirement (binding):** the core must not know Slack, Notion or Gmail exist, and no core behavior may be shaped by a particular source's behavior.

**Decision: plugin-shaped packages behind an SDK, not a dynamic plugin system.** A true runtime plugin mechanism is overkill for first-party connectors in one repository deployed together, but plain in-app separation erodes one convenient import at a time. So: **every connector is its own workspace package** (`packages/connectors/*`) that may import **only** `packages/connector-sdk`, and the application knows connectors **only** as a list of registrations in one composition-root file. That registry is the sole coupling point, so promotion to dynamic loading later is a change to one file. The boundary is enforced mechanically by import rules in CI.

**The SDK is a two-sided contract.**

- **A connector provides:** an id and manifest (display name, auth needed, push support); an OAuth descriptor the host runs generically; `sync(host)`; optionally `handleWebhook(request, host)`; and normalization from raw payloads to the source-agnostic shapes in `packages/shared`.
- **The host provides, and a connector may use nothing else:** a persisted private state store (an opaque blob per connector+account), decrypted credentials, scheduling hints, an `emit()` for normalized items and source-state changes, structured logging, and rate-limit helpers.

**Quirks stay inside the connector, verbatim.** The Slack POC established that saved messages need full-list-and-diff sync while DMs and mentions use a high-water mark, that mentions arrive as `<@U123|Name>` markup, and that bot and self messages must be filtered. All of that lives inside `packages/connectors/slack`, expressed against the opaque state store. The test for any interface change: *would this method exist if this particular source didn't?* An earlier draft had the core interface "supporting two sync strategies" — exactly the leak this rule forbids, kept here as the example.

**Webhook ingress is generic.** The host exposes `/ingress/:connectorId/*` and routes the raw request to the connector's handler; signature verification is the connector's job, using SDK helpers.

**Testing falls out of the boundary.** Connectors are tested in isolation against a fake host, the core against a fake connector; recorded fixtures cover L2, and the scheduled contract suite verifies reality still matches them. Each connector package carries its own README documenting its source's quirks, in the spirit of [poc/slack-realtime](../poc/slack-realtime/README.md).

### 6.3 Background jobs: Cloudflare Queues + Cron Triggers

**Decision: Cron Triggers** for schedules (sync cadences, reconciliation, nightly contract runs) and **Cloudflare Queues** for deferred work (AI enrichment on ingest, webhook-triggered pulls), both consumed by the same Worker.

- An earlier draft chose pg-boss, which assumes an always-on Node process polling Postgres; no such process exists on Workers, so the hosting decision ("Hosting, CI/CD, and observability", §9) re-derives this one too. The workload — dozens of jobs per minute at worst — is far below where heavier infrastructure earns its cost.
- **Job handlers are plain functions in `jobs/` calling `domain/`; the queue is an adapter**, so nothing in domain logic imports a Cloudflare API.
- One caveat inherited honestly: pg-boss offered enqueue-in-the-same-transaction, Queues do not. Handlers are idempotent (§4.3), so at-least-once delivery plus retries is sufficient and no exactly-once machinery is built.

### 6.4 AI layer

- **The Claude API behind a project-owned interface** (`ai/`): summarize item, extract next action, suggest associations, translate plain-English panel rules to structured queries. It takes and returns domain objects, so everything around it stays testable at L1 with the AI faked.
- **Prompts are versioned files in the repository**, reviewed like code.
- The provider is a third party like any other: recorded fixtures below L3, scheduled contract tests for drift.
- Enrichment runs **on ingest, in jobs**, and results are cached on the Item, so reads never wait on a model call.

### 6.5 Multi-channel capture and the task-creator merge

The existing task-creator project is the stopgap this product replaces: a Svelte PWA with an offline capture outbox plus a Worker that enriches captures with Claude and writes them to Notion. It also proved the **hands-free channel** — capture by voice in the car (Android Auto) or by dictating an SMS to a Twilio number, whose webhook feeds the same pipeline. That works because Android natively supports sending a message by voice, where custom app voice actions are no longer supported.

Cockpit absorbs task-creator rather than integrating with it:

- **`capture_item` is one command with many front doors.** The PWA capture view, the share-target and an `/ingress/sms` webhook (Twilio-signed, sender-allowlisted, `MessageSid` as the idempotency key) all converge on the same handler, enrichment job and Item model. The Notion destination retires with the stopgap.
- **The lessons transfer as requirements.** Its outbox is the direct ancestor of §5.4; its shared-secret + signature + idempotency + daily-cap hardening is the template for every ingress webhook, Slack events and Gmail push included; its possible WhatsApp Business swap stays open as a later channel behind the same command.
- **Nothing changes client-side**, the channel being server-side by construction, which is why it works from a car. The Svelte frontend is not inherited but the platform is: the pipeline re-lands inside `apps/api` as `http/` ingress → `domain` command → `jobs/` enrichment.
- **Car capture today vs the car app wanted tomorrow.** The SMS channel is the chosen v1 mechanism — proven, server-side, free of client constraints — but it has real seams (a multi-turn Assistant dialog, per-SMS cost, contact-name recognition, the Assistant→Gemini transition), and the standing preference is a **pure Android Auto app if feasible**. That is genuinely uncertain: it needs a native Kotlin app on the Android for Cars App Library, whose approved categories and driver-distraction rules may not admit note capture at all. Options document plus POC before any commitment (§10). The architecture already prices it in: a car app is a thin native front door to the same `capture_item` command, so pursuing it never reopens the PWA decision.

## 7. Performance budgets (hard gates)

Budgets are gates, not aspirations; exceeding one makes restoring it priority work. Enforced in CI where tooling allows (bundle-size check per PR, timing checks on merge), measured against a throttled mid-range mobile profile:

| Budget | Target |
|---|---|
| Cold open → glanceable dashboard (installed PWA, warm cache) | **< 1s** |
| Capture: entry point → note persisted (excluding typing) | **< 2s** |
| Panel interactions (filter, drag, reorder, switch dashboard) | **< 100ms** |
| Initial JS bundle (compressed) | **< 200KB**, hard CI gate |
| Snapshot revalidation after cold open | background, never blocking paint |

Two standing rules follow: **never block paint on auth** (paint the cached snapshot, verify the session in the background; long-lived sessions with silent refresh, no OAuth redirect on the hot path), and **heavy dependencies are lazy-loaded or rejected**, which the bundle gate makes mechanical.

## 8. Security

- **App login per "App login: hand-rolled Google OIDC + own sessions" (§8.1)**; no passwords stored, ever. The session, cookie and request gate are built; the proof of identity in front of them is a logon page you sign in at by choosing a name — an identity selector, not an authentication control — and nothing else authenticates a deployed environment until that changes.
- **Source tokens encrypted at rest** (application-level encryption for connected-account OAuth tokens).
- **Workspace scoping enforced server-side** on every query via `tenant_id` plus workspace filters; the UI's scoping is presentation, not protection. The account those filters carry is resolved from the session on every request, never from anything the client sends.
- **Message content sent to the AI provider is an explicit, documented flow** (which fields, which provider, retention posture) — the single most sensitive thing this product does.
- **Secrets** live in the platform's secret store; the public repository contains `.env.example` files only.
- **No pull request merges unanalysed.** CodeQL reads the sources *and* the workflow files on every pull request (§9.1) — the second half because this repository's workflows run Claude against an OAuth token and check out pull request branches, making them its highest-value target. High-severity alerts turn the check red. That is the mechanical half, and it does not model this document's own rules — a webhook missing the ingress hardening template, a source token reaching a log, a workspace-scoped read with no tenant filter. The judgement half is a Claude pass over every diff, scoped by a checked-in instructions file and required to end with an explicit verdict, so a run that never reached one is red rather than silent.

### 8.1 App login: hand-rolled Google OIDC + own sessions

Cockpit has two auth problems and only one was ever open. **Connector OAuth** is hand-rolled by necessity — no login library manages third-party integration credentials. The open question was **app login**:

**Google sign-in via the OIDC code flow, implemented in the project, with sessions in a D1 table plus an httpOnly cookie** (sliding long-lived expiry). Small protocol helpers (Arctic/Oslo-style); no auth framework, no auth vendor. Google-only and passwordless means there is no password storage, no reset flow and no email verification anywhere in the system.

**`auth/` is security-critical code we maintain**, so it carries rules the rest does not: state, nonce, CSRF, cookie flags and session fixation are exhaustively L1-tested, login, expiry and silent refresh have F3 coverage, and agent changes there get the strictest review.

**Staged, and what has shipped (2026-09-01).** Everything above is built *except the proof of identity*. Issue 86 shipped the whole downstream half: a session row in D1, an httpOnly cookie with sliding expiry, a gate that refuses in the application's own JSON rather than with a web page, users and accounts in the register, and an account resolved per request. What stands in for the OIDC flow is a **logon page listing the users, where you sign in by clicking a name**.

Said plainly: **a passwordless list of names is an identity selector, not an authentication control.** It establishes *which* user you are for scoping data and nothing about whether you are entitled to be that user. Two consequences, neither optional:

- **This is the only thing in front of a deployed environment**, so anyone who can reach the URL can be anyone in the list. Nothing else authenticates staging or production.
- **When Google sign-in arrives it replaces one step**, how we come to believe who you are; everything downstream is already built and tested. That was the point of building the session for real.

Two things ship as data with no behaviour, deliberately: a **role** on each user (`user` or `admin`), so role logic is in the schema from the start and the first admin-only page brings the gate with it; and **nothing about sharing**, which will attach to the workspace rather than the account and so is purely additive.

**Cloudflare Access used to stand in front, and was removed on 2026-09-02** ("Remove Cloudflare Access from staging and production", issue 123). It was a perimeter around a deployment rather than the application's identity model, put there because this proof-of-identity half is not built — and taken off ahead of the trigger this section had recorded for it, which was OAuth login shipping. What made that acceptable is that production holds `seed.sql` fixtures rather than real mail; **it stops being acceptable when the first connector lands**, which is the same moment this section's remaining half becomes urgent. Removing it also took away a real cost, since an expired Access session answered background revalidation and the SSE stream with somebody else's HTML login page where JSON or events were expected, and the client carried a whole recovery path for that.

## 9. Hosting, CI/CD, and observability

**Decision: Cloudflare, all of it.** The Worker plus static assets, with D1 (§4.1), Queues and Cron Triggers. The platform is already proven in this household (www.conselit.be and the task-creator worker), the workload shape fits (request-driven API, scheduled sync, cheap SSE streams, no long-CPU work), the tiers price a single-user app at essentially zero, and there is one vendor and zero servers to patch. Stated honestly: local dev and CI run on `wrangler`/miniflare, which executes the real runtime and real SQLite but *emulates* Queues and cron, and platform limits (CPU time, subrequest counts) are a new class of constraint that L3 tests and nightly runs must respect.

Note the reach: this re-derived the backend framework (Fastify → Hono, since Fastify assumes a Node server process), the job infrastructure (pg-boss → Queues + Cron, §6.3) and the database itself (Postgres → D1, §4.1). A hosting choice is never just a hosting choice.

### 9.1 CI/CD

GitHub Actions, structured to make the testing strategy and the budgets mechanical:

- **Per branch** (triggered on `push`, so draft PRs and branchless pushes are gated too): lint, typecheck, the connector-boundary import rules; the fast tiers in full, one job per tier so a misplaced test is visible; bundle-size gate; build. Per-branch **preview deployments were removed**: Cloudflare withholds version preview URLs from a Worker that implements a Durable Object, and gating a replacement cost more per branch than previews got for free (deployment, "No branch environments").
- **On merge to `main`:** the same gate, plus (when they exist) the full suite including L3/F3 against a wrangler-run stack and performance timing checks; then migrate and deploy to **staging**.
- **On every pull request against `main`, and on `main` itself:** CodeQL over the application sources *and* the workflow files (§8). High-severity alerts turn the check red; the rest land in the Security tab. Which parts are repository settings rather than files is in the bootstrap runbook in [deployment.md](deployment.md).
- **Production is a promotion, not a merge:** an explicit `workflow_dispatch` run pinned to a commit, which migrates and then deploys via `wrangler deploy`.
- **Scheduled (nightly):** `test:contract` against real third parties; failures create priority work to re-record fixtures.

**Decision: trunk-based development with one long-lived branch.** Full model and arguments in [deployment.md](deployment.md).

**Two recorded corrections, both from building it:**

- **~~Previews share one D1 database.~~** Superseded: there are no previews, and the isolation argument now lives in deployment rather than here.
- **Staging needed an environment, not a branch, and production needed a gate.** This section once implied merge-to-`main`-deploys-production, and an intermediate draft gave staging its own long-lived `dev` branch; both were wrong in the same place. Triggers attach to a Worker's *active deployment*, so something must run every commit continuously before production sees it — the per-branch preview versions fired no sync cadence, aged no token into a refresh and tripped no dead-man's switch, and today nothing is deployed per branch at all. Pointing staging at the trunk satisfies that with one branch, and an explicit pinned promotion supplies the gate merging used to provide. The two-branch draft bought the same soak at the price of a promotion merge and a `hotfix/*` path with a mandatory back-merge — machinery that exists only to reconcile long-lived branches.

### 9.2 Observability

The operator is the single user and watches no dashboards, so anything important must push to them or surface in-app; pull-only observability effectively doesn't exist. Four layers, each answering what the previous can't:

- **Workers Logs = forensics.** Structured JSON, correlated across request → queue → connector by command IDs. What you read *after* being told something is wrong.
- **Sentry (both sides) = detection and triage.** Fingerprints errors into issues with lifecycle state, alerts on *new* issues and post-release regressions only, ties errors to deploys, and gives the client side its only possible home. The browser SDK lazy-loads after first paint to protect the §7 bundle gate.
- **Connector dead-man's switch = the failure that matters most.** A connector going silently stale throws no exception and is invisible to Sentry. Per-connector last-success timestamps, already required for the "synced 2 min ago" display, are checked by a cron watchdog that alerts on a missed cadence, and affected panels show a warning state.
- **External uptime check** on `/health`, verifying that the register answers *and* that an account store can be opened and brought up to date — the only layer not running on the app's own code. Both halves, because a check on D1 alone would report a deployment healthy while every request to it failed. The store it opens belongs to no account, the endpoint being deliberately unauthenticated.

Alert channel: email — zero infrastructure, works when Cockpit itself is broken, and alerts are rare by construction. Deferred with reasons: OpenTelemetry (one service plus a queue hop is reconstructable from correlated logs; tracing earns its cost across service boundaries) and production RUM (the CI gates cover regressions; revisit if production feel diverges from CI numbers).

## 10. Open decisions

Decisions taken during review live in the section they belong to, each with its arguments. What remains genuinely open:

1. **Native Android Auto capture app (§6.5).** Preferred over the SMS workaround if feasible; needs its own options document and POC to answer whether a capture app can fit the Android for Cars App Library's approved categories and driver-distraction rules at all. If yes it ships as a thin native client for `capture_item`; if no, SMS remains with WhatsApp Business as the candidate upgrade. Not a blocker for v1.

## 11. What this document is not

It records architecture: the decisions that are expensive to change. Framework versions, folder micro-layout and library minutiae live in the code and CLAUDE.md. When reality contradicts an argument made here, the document gets amended and the amendment records why, because the changelog of arguments is part of what this repository exists to publish.
