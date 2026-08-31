# Architecture (v0.4)

*Status: draft for review. Owner: Michael. Companion to [functional-definition.md](functional-definition.md) (the what) and [testing-strategy.md](testing-strategy.md) (the proof). This document records the technical decisions, and more importantly the arguments behind them, because this repository is published as a worked example of how to build a production application with agentic development. A decision without its reasoning is not reusable by anyone else.*

## 1. Architectural drivers

Five constraints do most of the deciding. Every choice below should be checked against them, the same way every design choice in the functional definition is checked against its problem list.

1. **Agent-legibility is a first-class requirement.** This codebase is built primarily by AI agents and published as a demonstration of that way of working. That makes "which stack are agents demonstrably strongest in" a real engineering criterion, not a fashion question. It favors: one language everywhere, mainstream and massively documented tools, strict static typing, schema validation at every boundary, and explicit code over framework magic. Types and schemas are the cheapest guardrails against agent mistakes available, and conventions an agent can read beat conventions an agent must infer.
2. **The cold-open latency budget.** The requirement behind "local-first" turned out to be simpler and harder: the app must open as fast as WhatsApp. The observed failure of existing tools (mail, Notion, Slack) is that opening them costs seconds, so quick notes migrate to whatever opens instantly. Opening fast and capturing fast are the product's survival criteria, and they are enforced by budgets (§7), not by intentions.
   Capture also has to work where no app UI exists at all: the proven task-creator flow captures by voice in the car (Android Auto) and on the bike via a dictated SMS hitting a webhook. Cockpit absorbs that project (§6.5), which means **capture is a backend capability with multiple front doors** (web, phone, voice/SMS), not a feature of the web client.
3. **The backend is connector- and job-shaped.** OAuth flows, Slack/Gmail webhooks, Notion polling, scheduled reconciliation, and AI calls on ingest. That is a service with real background execution (schedules, queues, push ingress), not a bundle of request handlers.
4. **Single user today, SaaS-ready tomorrow.** Per the functional definition (§3): assume one tenant, never hard-code that assumption. Every row is tenant-scoped, auth is real OAuth, secrets are stored encrypted, and workspace scoping is enforced server-side.
5. **The testing strategy is load-bearing.** [testing-strategy.md](testing-strategy.md) presupposes fast unit runners, integration tests against the service's own real database, thin capability-level end-to-end tests, and scheduled live contract tests against third parties. The stack must make all of that cheap, and the pyramid's budgets (fast tiers under 5 minutes) gate the toolchain choices.

## 2. Language and ecosystem: TypeScript end-to-end

**Decision: TypeScript everywhere** (frontend, backend, shared contracts, tooling), strict mode, in a single monorepo.

The argument, in order of weight:

- **One language halves the context an agent needs.** Shared types flow from the database schema through the API contract into the UI without translation. A cross-boundary refactor is one typed change, not two changes and a prayer that they agree.
- **TypeScript is, with Python, the language agents are strongest in**, and unlike Python it is also the language the frontend must use anyway. Choosing it everywhere means no seam where competence drops.
- **The type system is the guardrail.** Strict TypeScript plus runtime schema validation (Zod) at every boundary turns whole classes of agent mistakes into compile errors and 400s instead of production bugs.

**Rejected alternatives:**

- **Python (FastAPI) backend.** Excellent AI ecosystem, but it splits the repository into two languages and destroys the shared-contract story, which is one of the best agent guardrails available. The AI layer here is API calls to a model provider, not numerical computing; there is no ecosystem pull toward Python.
- **C#/.NET.** A perfectly respectable production stack, rejected deliberately: it is the stack the author knows best, and this project exists partly to demonstrate work outside it. It would also split the languages.
- **Go.** Great for small, sharp services; weaker for rapid product iteration on a data-model-heavy app, and again two languages.

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

- **Monorepo, pnpm workspaces.** The frontend, backend, and shared contract package version together; a contract change and both sides of its implementation land in one reviewable PR. No premature service split: per the testing strategy (§2), a second service only exists when a real boundary demands one.
- **`apps/api` is one Worker deployment** exposing the HTTP routes, the SSE endpoint, the queue consumers, and the cron-triggered schedules together. They share the domain model and the database; splitting them is a deployment decision to take when load demands it, not an architecture decision to take today.
- **`packages/shared` is the contract.** Domain types, Zod schemas, command definitions (§4.3), and the API client. The frontend never redefines a server shape by hand.

## 4. Data layer

### 4.1 Cloudflare D1 (SQLite), via Drizzle

**Decision: D1** as the database, **Drizzle ORM** on top.

- **This is a recorded reversal.** Earlier drafts chose Postgres from day one, arguing that SaaS-ready demanded it and that "SQLite would suffice for one user and then charge interest on the migration forever." The Cloudflare hosting decision (§9) put that argument in conflict with the platform (Cloudflare has no managed Postgres), and the review compared three exits: add a second vendor for serverless Postgres (rejected: the most moving parts, cross-network latency on every query, and the data held hostage to another company's free-tier strategy), leave Cloudflare for a co-located-Postgres platform, or drop Postgres. Re-examined, the Postgres argument turned out to be doing *speculative* work while the Cloudflare arguments do *concrete* work today, so Postgres yielded:
  - **The migration debt has a small principal.** The working set is kilobytes; even iteration 2's full-firehose text for one user is single-digit gigabytes over years (attachments go to R2, not the database) against D1's 10GB-per-database ceiling. The interest is only ever repaid if the SaaS future materializes, at which point a re-platforming project is happening anyway.
  - **"SaaS-ready" is schema discipline, not an engine.** The functional definition's rule is "never hard-code single-tenancy into the schema"; `tenant_id` columns work identically in SQLite. And the credible multi-tenant shape on this platform is **one database per tenant**, which gives stronger isolation than row-scoping in a shared Postgres would. See "One database per tenant, and `tenant_id` stays" below for what that does and does not mean.
  - **Test fidelity improves.** `wrangler`/miniflare runs actual SQLite locally, so L2 integration tests hit the same engine production uses with zero containers, and faster, which serves the testing strategy's 5-minute fast-tier budget.
- **What is genuinely given up** (recorded, not waved away): Postgres's toolbox. Full-text search strength (iteration 2 keeps archived items searchable; SQLite's FTS5 is the designated answer), JSONB-style querying, and extensions such as pgvector (Cloudflare's Vectorize is the platform answer if embeddings ever matter). D1's transaction model is also batch-oriented rather than interactive; command handlers (§4.3) already write in single batches, so this costs nothing at this scale, but it is a real constraint to design within.
- **Accepted risk, by owner decision: no upfront D1 verification.** Given the limited load of a single-user deployment, D1 is assumed sufficient; the FTS5 question is deferred to iteration 2, when archive search is actually built. If reality disagrees, the recorded fallback is the co-located-Postgres platform (option B of the comparison), not Cloudflare-plus-remote-Postgres (option A), because A was eliminated on its composition costs, not on a tie-break.
- **Drizzle over Prisma**, unchanged by the reversal: it stays close to SQL, the schema is TypeScript, the queries are transparent, and agents reason more reliably about SQL they can see than about a query engine they must trust. No codegen step between schema and types. Keeping the SQL boringly standard is also the cheap insurance that keeps the Postgres fallback real.

### 4.2 Schema conventions (the SaaS-ready and sync groundwork)

These conventions are cheap now and expensive to retrofit, so they are binding from the first migration:

- **`tenant_id` on every row**, non-null, even while there is exactly one tenant. Workspace scoping (the privacy boundary of the functional definition §4.1) is enforced in queries server-side, never only in the UI.
- **Client-generated IDs** (UUIDv7/ULID) for user-created entities. Creating an item never waits on the server for an identity, which the capture path (§5.4) and any future offline work both depend on. Server-generated rows use the same format.
- **Per-field `updated_at` semantics via command timestamps** (§4.3), giving last-write-wins conflict resolution per field, which is all a single-user-multi-device system needs.
- **Tombstones, not deletes**, for Items, matching the reconciliation model of the functional definition (§10.1): an item resolved or removed at the source is marked, not erased.
- **Source-owned vs app-owned fields are separate column groups**, mirroring the functional definition's reconciliation rule: re-syncs overwrite source-owned columns unconditionally and never touch app-owned ones.

#### The database is the second lock

The conventions above are enforced by the schema, not left to the callers that happen to exist today. Every write currently goes through one door — the command handlers (§4.3), validated by the Zod schemas in `packages/shared` — so these constraints can never fire in normal operation. That is the point: they are what still holds when a connector, a migration, a backfill script or a hand-run `wrangler d1 execute` writes rows the command handlers never saw.

- **STRICT tables.** SQLite's default is dynamic typing with affinity, so a `TEXT` column stores an integer without complaint. `STRICT` (SQLite 3.37+, which D1 runs) makes declared types enforced. Its guarantee is precisely *no lossy conversion*: a blob into a text column is refused, while the integer `12345` into that same column is still accepted as `'12345'`, because that conversion loses nothing. It is not a substitute for a CHECK.
- **A CHECK for every closed set**, generated in `src/db/schema.ts` from the same Zod enums the wire contract uses, so the database and the API contract cannot drift into disagreeing about what a status is.
- **Foreign keys, which D1 enforces**, with `ON DELETE RESTRICT` throughout: nothing in this model is hard-deleted, so a cascade would be a silent answer to a question that should be asked explicitly. The command log is the deliberate exception and carries no foreign keys, because an audit trail has to outlive what it refers to.

**Drizzle cannot express STRICT** — it is absent from drizzle-orm's `sqlite-core` table API and drizzle-kit never emits the keyword. Every migration therefore adds it by hand, and a regenerated migration will silently drop it. The rule *what the product stores is what comes back* in `apps/api/tests/integration/db/constraints.test.ts` asserts it against the applied schema for exactly that reason; it is the only thing standing between a routine `db:generate` and losing the guarantee.

#### One database per tenant, and `tenant_id` stays

**A tenant is an account, not a Workspace.** The multi-tenant shape recorded above is one database per *tenant* — per person or organization paying for Cockpit. Workspaces (Work, Atlas Copco, Personal) are the privacy boundary *inside* one tenant's data, per the functional definition's workspace model. One database per Workspace would be the wrong reading: it breaks the Workspace switcher and every future cross-Workspace view, which are the whole point of Workspaces being one person's compartments rather than separate accounts.

D1 supports the pattern directly — it is [designed for horizontal scale-out](https://developers.cloudflare.com/d1/best-practices/) across many small databases, priced on queries and storage rather than per database. The limits that shape it: **50,000 databases** per account on Workers Paid, **10 GB per database** (a hard ceiling), and each database is a single Durable Object processing one query at a time, so throughput is roughly 1,000 queries/second at 1 ms each ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). Note that Cloudflare presents this as one of two options, alongside row-level isolation in a shared database, rather than as a single prescription.

**`tenant_id` stays on every row even after the split.** It looks redundant once a database holds one tenant, and it is not:

- **It is the second lock again.** Under one-database-per-tenant, correctness rests entirely on the routing layer binding the right database. `tenant_id`, and the filters every query in `apps/api/src/db/repo.ts` already applies, is the check behind it. With it, a routing bug returns nothing; without it, that same bug silently serves another tenant's data — the worst available failure mode for a privacy boundary.
- **It is the row's provenance.** The moment a row leaves its database — a backup, an export, a support copy, a restore into the wrong place — `tenant_id` is the only thing that says whose it is.
- **The platform choice is provisional.** The recorded fallback is the co-located-Postgres platform, where the credible shape is row-scoping in a shared database and `tenant_id` is mandatory. Dropping it now would bet the schema on a decision this document already flags as reversible.
- **The cost is asymmetric**, which is the general form of the argument for every convention here: keeping it is one text column already written, indexed and filtered; re-adding it later means backfilling every row of every table.

### 4.3 Mutations are commands, not object PUTs

All writes go through small, named, idempotent commands: `capture_item`, `set_status`, `snooze_until`, `associate`, `set_focus`. Each carries a client-generated command ID (making retries idempotent), the client timestamp, and a minimal payload validated by a Zod schema from `packages/shared`.

The argument: commands are the shape that keeps every door open at almost no cost. They give idempotent retries (flaky mobile networks), an audit trail for free, trivially testable pure handlers at L1, and they are the exact API an offline queue would need if offline writes are ever promoted from "exceptional" to "supported" (§5.5). A generic `PUT /items/:id` gives none of that and invites lost-update bugs between two devices.

## 5. Client architecture

### 5.1 React + Vite, installed PWA

**Decision: a plain SPA** (React, Vite, TanStack Router + TanStack Query), installed as a PWA on phone and desktop, service-worker-cached app shell.

- **React** because the showcase argument favors the ecosystem with the deepest agent training data and the widest audience, and nothing in this app needs anything React can't do.
- **A plain SPA rather than a server-rendering meta-framework (Next.js et al.)** because first paint comes from the locally persisted snapshot (§5.2), not from a server response. SSR optimizes a network path this design has deliberately made network-free, and it would add a server rendering runtime, hydration complexity, and framework magic that costs agent-legibility while buying nothing measurable against the §7 budgets.

### 5.2 The read model: persisted snapshot, revalidate, push

The server is authoritative; the client keeps a persisted cache purely for speed:

- On load, the client paints **immediately from a snapshot persisted in IndexedDB** (TanStack Query cache persistence), then revalidates in the background. Cold open makes zero blocking network requests.
- The working set is small (the open items of one user across all workspaces is thousands of rows at most, i.e. kilobytes), so the snapshot is **one API call per workspace**, not a replication protocol.
- **Panel rules evaluate client-side** against the snapshot. Reconfiguring a panel, dragging an item between panels, filtering and grouping are all local operations inside the §7 interaction budget; no round trip.
- **Liveness via SSE.** Phone and desktop are commonly open simultaneously, so the API pushes invalidation events (item changed, sync completed) over server-sent events; the client also revalidates on focus/visibility change. SSE over WebSockets because the channel is strictly server-to-client notifications and SSE is plain HTTP: simpler to run, to proxy, and to test. On Workers (§9) an idle SSE stream costs essentially nothing (CPU-time billing) and `EventSource` reconnects natively if the platform recycles a long-lived connection; if connection churn ever becomes a real problem, a Durable Object is the designated upgrade path, not a reason to complicate v1.

### 5.3 The local-first decision, recorded

The functional definition (§3, §10) says "local-first." Challenged during architecture review, that label turned out to bundle three different promises with very different costs, and the decision is recorded per promise:

| Promise | Verdict | Mechanism |
|---|---|---|
| **Instant render** (no spinner on open) | **Required.** This is driver #2 and the reason the product will or won't get used. | Persisted snapshot + cached app shell (§5.2); budgets in §7. |
| **Offline read** (glance at state on a plane) | **Kept, at zero marginal cost.** It falls out of the same persisted snapshot. | Nothing extra. |
| **Offline write** (triage offline, reconcile later) | **Rejected for v1.** Honest usage assessment: exceptional. A general offline mutation queue would double the staleness problem the functional definition already fights (source→server *and* server→client), add multi-device replay conflicts, and tax every future mutation with queue semantics and offline tests. | Not built. The command API (§4.3), client IDs, and LWW timestamps keep a retrofit cheap if reality ever disagrees. |

The general principle worth publishing: **the requirement was never "local-first," it was a latency budget.** Mail, Notion, and Slack feel slow not because their data is remote but because of what happens before any data is requested: megabytes of JavaScript, hydration, auth redirects, workspace bootstrapping. WhatsApp feels instant because a tiny shell paints from local storage in milliseconds. Copy the mechanism, not the buzzword.

### 5.4 Capture: the one exception to "no offline queue"

Fast capture (functional definition, issue 2) is the moment "I must jot this down before it evaporates," usually on a phone, often on a bad connection. A note that fails to save because the network hiccupped is precisely the trust-destroyer the product exists to eliminate. Therefore:

- **A create-only outbox.** New internal items are written to local storage first, rendered immediately, and flushed to `capture_item` commands when connectivity allows. Creates cannot conflict, client IDs make retries idempotent, and the whole mechanism is on the order of a hundred lines. This is not a general offline queue and must not grow into one; any second command type wanting into the outbox reopens the §5.3 decision instead of sneaking past it.
- **Capture is a first-class entry point**: home-screen shortcut and PWA share-target land directly in a new-item view, inside the capture budget of §7.

### 5.5 How the client talks to the backend

Everything is plain HTTP to the one API in `apps/api`. There is no second protocol, no direct database access, no GraphQL, no WebSocket. Three interaction patterns cover the entire client:

| Pattern | Transport | Used for |
|---|---|---|
| **Snapshot reads** | `GET`, one call per workspace | The read model of §5.2. The client does not compose its views from dozens of fine-grained REST resources; it fetches the workspace snapshot and derives every panel locally. |
| **Commands** | `POST`, one endpoint per command (§4.3) | All writes: `capture_item`, `set_status`, `snooze_until`, `associate`, ... Idempotent via client-generated command IDs. |
| **Push invalidation** | SSE (long-lived HTTP response) | Server-to-client "something changed" events that trigger snapshot revalidation, keeping simultaneous phone + desktop in agreement. |

So: yes, the client always talks to the HTTP API, but it is deliberately **not a classic resource-oriented REST surface** (no `GET /items/17`, `PUT /items/17` choreography). It is a narrow contract of snapshots + commands + events, which is what makes the persisted cache (§5.2), optimistic UI, the capture outbox (§5.4), and any future offline retrofit all fall out of the same shapes.

**Decision: the contract is described as REST + OpenAPI, generated from the shared Zod schemas — not tRPC.** Four arguments, in order of weight: (a) non-TypeScript clients are foreseeable (the possible Kotlin car app, §10; a public API if the SaaS future materializes), and tRPC's wire format is TS-internal; (b) the API surface above is a snapshot, a dozen commands, and SSE, too small for tRPC's procedure-management strengths to pay rent, while its subscription story fits SSE poorly; (c) no type safety is lost: `@hono/zod-openapi` generates the contract from the shared Zod schemas and Hono's typed client (`hc`) gives the frontend tRPC-grade end-to-end inference from those same schemas, so no types are written twice; (d) OpenAPI is transferable teaching material, tRPC is TS-monoculture advice.

Two boundary notes: the service worker serves the cached app shell locally (no network involved in painting), and the capture outbox flushes to the same `capture_item` command endpoint as an online capture; there is no separate "sync API."

### 5.6 Styling and components: Tailwind + Radix

**Decision: Tailwind for CSS, Radix for interactive primitives.** These are two independent axes, decided separately:

- **Behavior (Radix).** Cockpit's UI is menu- and sheet-heavy: context menus, panel "···" menus, bottom sheets, the "Handled?" prompt sheet. Production-grade focus trapping, keyboard navigation, and ARIA handling for those is a long tail of bugs not worth owning; Radix primitives buy that boring 80% completely unstyled, so the prototype's visual identity survives, and per the testing strategy the F1 tests then cover Cockpit's logic instead of re-proving menu mechanics. The differentiating interactions (row swipe, drag-to-panel with the placeholder) are covered by no library and stay hand-written either way; buying the boring parts is what funds them.
- **CSS (Tailwind).** Utilities are co-located with markup, so an agent editing a component sees everything relevant in one place, deletes styling by deleting the element, and cannot create cross-component side effects. A shared hand-rolled stylesheet (the prototype's approach) decays predictably: dead selectors nobody can prove safe to delete, specificity conflicts, `!important` creep. Tailwind imposes no visual style; the prototype's palette, spacing, typography, and workspace-color identity become design tokens in the Tailwind config.
- **Budget fit:** Tailwind emits only the utilities actually used (tens of KB); Radix imports and tree-shakes per primitive. Both together sit well inside the §7 bundle gate.

## 6. Backend architecture

### 6.1 Hono + Zod on Cloudflare Workers

**Decision: Hono** with Zod-validated routes (`@hono/zod-openapi`, which also generates the OpenAPI contract of §5.5), structured JSON logging into Workers Logs, and an explicit, boring module layout.

- Hono over NestJS/Express-style frameworks: NestJS buys conventions at the price of decorator/DI magic that obscures control flow, which is exactly what agent-legibility argues against. Cockpit's conventions live in this document and CLAUDE.md, where an agent can read them, and the module layout below makes them mechanical.
- **Hono over Fastify is a recorded correction.** An earlier draft chose Fastify with the argument "nothing here targets edge runtimes." The Cloudflare hosting decision (§9) falsified that premise: Fastify assumes a Node server process, while Hono is native to Workers, and its typed client (`hc`) plus zod-openapi close the type-safety loop that was half the appeal of tRPC (§5.5). When a premise dies, the decision built on it gets re-derived, not defended; that is the practice this document exists to demonstrate.

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

The dependency rule is one-directional: `domain` imports nothing from the other layers. That is what makes the testing pyramid's L1 tier ("no real dependencies, pure in/out") a property of the design rather than a mocking exercise, per the testing strategy's mocking discipline.

### 6.2 Connectors: plugin-shaped, host-blind

**Requirement (binding):** the core application must not know Slack, Notion, or Gmail exist, and no core behavior may be designed a particular way because of a particular source's behavior. Sources are plugins to Cockpit, whether or not a full dynamic plugin mechanism ever exists.

**Decision: plugin-shaped packages behind an SDK, not a dynamic plugin system.** Two options were on the table: (A) a true plugin mechanism (connectors discovered and loaded at runtime, possibly out-of-process), and (B) connectors as part of the application with maximal separation. A dynamic mechanism is overkill for a system whose connectors are all first-party, in one repository, deployed together: it would add loading, versioning, and sandboxing machinery with no user for it. But plain option B tends to erode, one convenient import at a time. So the decision is B with A's boundary: **every connector is its own workspace package** (`packages/connectors/*`) that may import **only** `packages/connector-sdk`, never the application; and the application knows connectors **only** as a list of registrations in one composition-root file. That line-per-connector registry is the sole coupling point, which means promotion to true dynamic loading later is a change to one file, not a refactor. The boundary is enforced mechanically (dependency-cruiser/ESLint import rules in CI), per the testing strategy's principle of preferring violations that are impossible over violations that are caught in review.

**The SDK is a two-sided contract.** `connector-sdk` defines both what a connector must provide and the only capabilities the host offers it:

- **A connector provides:** an id and manifest (display name, which auth it needs, whether it supports push); an OAuth descriptor the host can run generically; `sync(host)` to pull changes; optionally `handleWebhook(request, host)` for push sources; and normalization from raw payloads to the source-agnostic `Item`/source-state shapes of `packages/shared`.
- **The host provides (and a connector may use nothing else):** a persisted private state store (an opaque blob per connector+account, for cursors and sync bookkeeping), decrypted credentials, scheduling hints, an `emit()` for normalized items and source-state changes (tombstones, completions), structured logging, and rate-limit/backoff helpers.

**Quirks stay inside the connector, verbatim.** The Slack POC established that saved messages need full-list-and-diff sync while DMs and mentions use a high-water mark, that mentions arrive as `<@U123|Name>` markup, and that bot/self messages must be filtered. All of that is Slack's private business: it lives inside `packages/connectors/slack`, expressed against the opaque state store, and the core never learns a concept like "high-water mark" because of it. The test for any interface change is: *would this method exist if this particular source didn't?* If not, it doesn't go in the SDK. (An earlier draft of this section had the core interface "supporting two sync strategies"; that was exactly the leak this rule forbids, and the correction is preserved here as the example.)

**Webhook ingress is generic.** The host exposes `/ingress/:connectorId/*` and routes the raw request to the connector's handler; signature verification is the connector's job (it knows its source's scheme), using SDK helpers. The application layer contains no Slack- or Google-specific routes.

**Testing falls out of the boundary.** Connectors are tested in isolation against a fake host (unit tests for normalization and sync logic, with the POC findings as L1 cases); the core is tested against a fake connector; recorded fixtures cover L2, and the scheduled contract suite (testing strategy §3) verifies per connector that reality still matches the fixtures. Each connector package carries its own README documenting its source's quirks, in the spirit of [poc/slack-realtime](../poc/slack-realtime/README.md).

### 6.3 Background jobs: Cloudflare Queues + Cron Triggers

**Decision: Cron Triggers** for the schedules (connector sync cadences, reconciliation passes, nightly contract runs) and **Cloudflare Queues** for deferred work (AI enrichment on ingest, webhook-triggered pulls), both consumed by the same Worker.

- An earlier draft chose pg-boss, which assumes an always-on Node process polling Postgres; no such process exists on Workers, so the platform decision (§9) re-derives this one too. The workload itself (dozens of jobs per minute at worst) is far below where any heavier infrastructure would earn its cost.
- **Job handlers are plain functions in `jobs/`, calling `domain/`; the queue is an adapter.** Nothing in domain logic imports a Cloudflare API, which keeps L1 tests pure and keeps the door open to any future runtime.
- One caveat is inherited honestly: pg-boss offered enqueue-in-the-same-transaction as the data change; Queues do not. The mitigation is the discipline §4.3 already imposes: handlers are idempotent, so at-least-once delivery plus retries is sufficient, and no exactly-once machinery is built.

### 6.4 AI layer

- **The Claude API behind a project-owned interface** (`ai/`): summarize item, extract next action, suggest associations, translate plain-English panel rules to structured queries. The interface takes domain objects and returns domain objects, so everything around it stays testable at L1 with the AI faked.
- **Prompts are versioned files in the repository**, reviewed like code.
- The AI provider is a third party like any other: recorded fixtures below L3, scheduled contract tests for drift (model deprecations, response-shape changes), per testing strategy §3.
- Enrichment runs **on ingest, in jobs**, and results are cached on the Item (functional definition §12.6), so reads never wait on a model call.

### 6.5 Multi-channel capture and the task-creator merge

The existing task-creator project (`c:\github\task-creator`) is the stopgap this product replaces (functional definition, issue 2): a Svelte PWA with an offline capture outbox (Dexie/IndexedDB) plus a Cloudflare Worker that receives captures, enriches them with Claude, and writes them to Notion. It also proved the **hands-free channel**: capture by voice in the car (Android Auto) or on the bike by dictating an SMS to a Twilio number ("Hey Google, text Task Inbox: ..."), whose webhook feeds the same pipeline. That works because Android natively supports sending a message by voice, where custom app voice actions are no longer supported; no native car app is required.

Cockpit absorbs task-creator rather than integrating with it:

- **`capture_item` is one command with many front doors.** The PWA capture view (§5.4), the PWA share-target, and an `/ingress/sms` webhook (Twilio-signed, sender-allowlisted, `MessageSid` as the idempotency key, exactly as task-creator does it today) all converge on the same command handler, the same AI enrichment job, and the same Item model. A captured item lands in Cockpit's database as an internal Item instead of a Notion row; the Notion destination retires with the stopgap.
- **The lessons transfer as requirements.** task-creator's outbox is the direct ancestor of §5.4; its shared-secret + signature + idempotency + daily-cap hardening is the template for every ingress webhook (Slack events and Gmail push notifications included); its possible WhatsApp Business swap (fee-free, longer messages, same webhook shape) stays open here as a later channel behind the same command.
- **Consequences for the stack:** nothing changes client-side (the channel is server-side by construction, which is exactly why it works from a car). The stopgap's Svelte frontend is not inherited, but its platform is: with Cockpit's API itself a Cloudflare Worker (§9), the pipeline re-lands inside `apps/api` on the same platform it already runs on (`http/` ingress route → `domain` command → `jobs/` enrichment via a queue).
- **Car capture today vs the car app wanted tomorrow.** The SMS/voice channel is the chosen v1 mechanism: proven, server-side, and free of client constraints. But it is a workaround with real seams (a multi-turn Assistant dialog, per-SMS cost, contact-name recognition, Google's Assistant→Gemini transition), and the standing preference is a **pure Android Auto app if that is feasible**. Feasibility is genuinely uncertain: it requires a native Android app (Kotlin) built on the Android for Cars App Library, whose approved app categories and driver-distraction rules may not admit a note-capture app at all, and Google has withdrawn the custom voice App Actions that would have been the natural fit. This gets the same treatment as every other uncertain integration in this project: an options document plus a POC before any commitment (open decision, §10). Crucially, the architecture already prices it in: a car app would be nothing more than a thin native front door to the same `capture_item` command, so pursuing it never reopens the PWA decision for the main client.

## 7. Performance budgets (hard gates)

Same philosophy as the testing strategy's 5-minute rule: budgets are gates, not aspirations, and exceeding one makes restoring it priority work. Enforced in CI where tooling allows (bundle-size check on every PR; Lighthouse/Playwright timing checks on merge), measured against a throttled mid-range mobile profile:

| Budget | Target |
|---|---|
| Cold open → glanceable dashboard (installed PWA, warm cache) | **< 1s** |
| Capture: entry point → note persisted (excluding typing) | **< 2s** |
| Panel interactions (filter, drag, reorder, switch page) | **< 100ms** |
| Initial JS bundle (compressed) | **< 200KB**, hard CI gate |
| Snapshot revalidation after cold open | background, never blocking paint |

Two standing rules fall out of these: **never block paint on auth** (paint the cached snapshot, verify the session in the background; long-lived sessions with silent refresh, no OAuth redirect on the hot path), and **heavy dependencies are lazy-loaded or rejected** (the bundle gate makes this mechanical).

## 8. Security

- **App login per §8.1**; no passwords stored, ever.
- **Source tokens encrypted at rest** (application-level encryption for OAuth tokens of connected accounts), per the functional definition §11.
- **Workspace scoping enforced server-side** on every query via `tenant_id` + workspace filters; the UI's scoping is presentation, not protection.
- **Message content sent to the AI provider is an explicit, documented flow** (which fields, which provider, retention posture), since third-party processing of private messages is the single most sensitive thing this product does.
- **Secrets** live in the deployment platform's secret store; the public repository contains `.env.example` files only. This being a public codebase is a feature, and it forces the hygiene the showcase should demonstrate.

### 8.1 App login: hand-rolled Google OIDC + own sessions

Cockpit contains two separate auth problems, and only one was ever open. **Connector OAuth** (obtaining and refreshing Gmail/Slack/Notion tokens) is hand-rolled by necessity: no login library manages third-party integration credentials; that is connector plumbing (§6.2's OAuth descriptor, encrypted storage above). The open question was **app login**, and the decision is:

**Google sign-in via the OIDC code flow, implemented in the project, with sessions in a D1 table + httpOnly cookie** (sliding long-lived expiry). Small protocol helpers (Arctic/Oslo-style) for the OAuth dance; no auth framework, no auth vendor. The arguments:

- **The usual "don't write auth yourself" warning is at its weakest here.** Google-only and passwordless by design means the genuinely scary surface (password storage, reset flows, email verification) does not exist; what remains is a code-flow redirect, ID-token verification, and a session table, a few hundred reviewable lines. The connector work builds the same OAuth muscle anyway, so the marginal cost is unusually low. This mirrors the current guidance of the TS ecosystem's best-known auth library author (Lucia), who deprecated the library in favor of exactly this understand-and-write-it approach.
- **Auth is where framework magic costs most.** A library or vendor puts a black box in the most security-sensitive spot, which is the worst trade available under the agent-legibility driver. Explicit code here is also first-rate showcase material, since auth is the topic developers most cargo-cult.
- **Full control over never-block-paint (§7):** paint the cached snapshot immediately, verify the session in the background, redirect only when actually expired.
- **The risk is owned deliberately:** session/callback logic (state, nonce, CSRF, cookie flags, fixation) is security-critical code we now maintain. Mitigation per the testing strategy: the logic is pure and exhaustively L1-tested, with F3 coverage for login, expiry, and silent refresh, and agent changes to `auth/` code get the strictest review.

**Interim note (2026-08-13): Cloudflare Access currently fronts all three deployed environments, production included** ([deployment.md](deployment.md) §6). This does not reverse the decision below: Access is a perimeter around a deployment, not the application's identity model, and it exists precisely *because* this section is not built yet, so production would otherwise have no authentication at all while holding real mail and messages. It does mean the second rejection reason below is being lived with in the meantime, and it is a real cost, not a theoretical one: an expired Access session returns HTML to the client's background revalidation and SSE stream, which on the installed PWA looks like an inbox that quietly stopped updating. Mitigated with a long session duration. **When this section ships, Access on production gets reconsidered rather than left in place by inertia.**

**Rejected:** managed vendors (Clerk, Auth0: a second vendor after D1 was chosen precisely to stay single-vendor, per-MAU pricing if the SaaS future arrives, heavy client SDKs against the §7 gate); Cloudflare Access (single-vendor but the internal-tool pattern: it can never become customer auth, so the schema's tenancy stays unexercised, and its expired-session redirects to an HTML login page break silent `fetch`/`EventSource` refresh); self-hosted libraries (better-auth, the honest runner-up: battle-tested flows and an organizations plugin that is the strongest argument against this decision, but it buys breadth this design excluded, and by the D1 logic its SaaS value is speculative work while its opacity costs concretely today; the swap-if-real is one bounded subsystem).

## 9. Hosting, CI/CD, and observability

**Decision: Cloudflare, all of it.** The Worker (`apps/api`) plus static assets (`apps/web`), with D1 (§4.1), Queues, and Cron Triggers. The argument: the platform is already proven in this exact household (www.conselit.be and the task-creator worker both run on it), the workload shape fits (request-driven API, scheduled sync, tiny always-cheap SSE streams, no long-CPU work outside AI calls that are I/O-bound anyway), the free/paid tiers price a single-user app at essentially zero, and with D1 there is exactly one vendor and zero servers to keep patched. The trade honestly stated: local dev and CI run on `wrangler`/miniflare, which executes the real runtime (workerd) and real SQLite but *emulates* Queues and cron scheduling, and platform limits (CPU time per invocation, subrequest counts) are a new class of constraint that L3 tests and the nightly contract runs must respect.

Note the reach this decision had: it re-derived the backend framework (Fastify → Hono, §6.1), the job infrastructure (pg-boss → Queues + Cron Triggers, §6.3), and, after a deliberate three-way comparison (add a Postgres vendor / leave Cloudflare / drop Postgres), the database itself (Postgres → D1, §4.1). A hosting choice is never just a hosting choice.

### 9.1 CI/CD

GitHub Actions, structured to make the testing strategy and the budgets mechanical:

- **Per branch** (not per PR: the trigger is `push`, so draft PRs and branches without a PR are deployed too): lint + typecheck + the connector-boundary import rules (§6.2); fast test tiers (L1, L2, F1, F2) in full, split as one job per tier so a misplaced test is visible (testing strategy §10); bundle-size gate; build; a **preview deployment** (a Workers preview version, addressed by a per-branch alias), so every branch is clickable before merge.
- **On merge to `main`:** the same gate, plus (when they exist) the full suite including L3/F3 against a wrangler-run stack (workerd + local D1) and performance timing checks; then migrate and deploy to **staging**.
- **Production is a promotion, not a merge:** an explicit `workflow_dispatch` run pinned to a commit, which migrates and then deploys via `wrangler deploy` (one operation for the Worker and the static assets, per §9's single-Worker shape).
- **Scheduled (nightly):** `test:contract` against real third parties (Slack, Gmail, Notion, AI provider); failures create priority work to re-record fixtures.

**Decision: trunk-based development with one long-lived branch.** `main` is the trunk, every other branch gets a preview, merging deploys staging, and production is promoted deliberately. Full model and arguments in [deployment.md](deployment.md), which also holds the topology and the runbook.

**Two recorded corrections, both from building it:**

- **Previews share one D1 database; they are not isolated per branch.** An earlier draft of this section specified "an isolated preview D1 database" per preview. Per-branch isolation needs a database created on first push, its id injected into a generated Wrangler config, and a reaper for deleted branches, and the free plan's ten-database ceiling does not fit the branch count this repository already carries. What is given up is recorded rather than waved away: two branches with incompatible migrations will collide. The escalation, if it bites, is per-branch databases on the paid plan.
- **Staging needed an environment, not a branch, and production needed a gate.** This section previously implied merge-to-`main`-deploys-production, and an intermediate draft gave staging its own long-lived `dev` branch. Both were wrong in the same place. The real requirement is that *something* runs every commit continuously before production sees it, because triggers attach to a Worker's *active deployment*: a preview version never fires a §6.3 sync cadence, never ages a token into a refresh, and never trips the §9.2 dead-man's switch. Pointing staging at the trunk satisfies that with one branch; making production an explicit pinned promotion supplies the gate that merging used to provide. The two-branch draft bought the same soak at the price of a promotion merge and a `hotfix/*` path with a mandatory back-merge, which is machinery that exists only to reconcile long-lived branches that can diverge.

### 9.2 Observability

Governing principle: the operator is the single user and watches no dashboards, so anything important must push to them or surface in-app; pull-only observability effectively doesn't exist. Four layers, each answering what the previous can't:

- **Workers Logs = forensics.** Structured JSON, correlated across request → queue → connector by the §4.3 command IDs. What you read *after* being told something is wrong.
- **Sentry (both sides) = detection and triage.** Fingerprints errors into issues with lifecycle state, alerts on *new* issues and post-release regressions only, ties errors to deploys, and gives the client side its only possible home (the browser cannot write to Workers Logs; the phone PWA is otherwise a debugging black hole). Browser SDK lazy-loads after first paint to protect the §7 bundle gate.
- **Connector dead-man's switch = the failure that matters most.** The worst failure is a connector silently going stale (expired OAuth token, third-party drift), which throws no exception and is invisible to Sentry. Per-connector last-success timestamps (already required for the "synced 2 min ago" freshness display) are checked by a cron watchdog that alerts when a connector misses its expected cadence, and affected panels show a warning state in-app.
- **External uptime check** on a `/health` endpoint verifying D1 connectivity: the only layer not running on the app's own code.

Alert channel: email (zero infrastructure, works when Cockpit itself is broken; alerts are rare by construction). Deferred with reasons, as right-sizing rather than corner-cutting: OpenTelemetry (a single service plus one queue hop is reconstructable from correlated logs; tracing earns its cost when requests cross service boundaries) and production RUM (§7's CI gates cover regressions; revisit if production feel diverges from CI numbers).

## 10. Open decisions

Decisions taken during review live in the section they belong to (contract style §5.5, styling §5.6, auth §8.1, hosting and observability §9), each with its arguments. What remains genuinely open:

1. **Native Android Auto capture app (§6.5).** Preferred over the SMS workaround if feasible. Needs its own options document and POC: can a capture app fit the Android for Cars App Library's approved categories and driver-distraction rules at all? If yes, it ships as a thin native client for the `capture_item` command; if no, the SMS channel remains, with WhatsApp Business as the candidate upgrade. Not a blocker for anything in v1.

## 11. What this document is not

It records architecture: the decisions that are expensive to change. Framework versions, folder micro-layout, and library minutiae live in the code and CLAUDE.md. When reality contradicts an argument made here, the document gets amended, and the amendment records why, because the changelog of arguments is part of what this repository exists to publish.
