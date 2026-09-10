# Architecture (v0.4)

*Status: draft for review. Owner: Michael. Companion to [functional-definition.md](functional-definition.md) (the what) and [testing-strategy.md](testing-strategy.md) (the proof). It records the technical decisions and the arguments behind them, because this repository is published as a worked example of agentic development and a decision without its reasoning is not reusable.*

## 1. Architectural drivers

Five constraints do most of the deciding; check every choice below against them.

1. **Agent-legibility is a first-class requirement.** This codebase is built primarily by AI agents, which makes "which stack are agents demonstrably strongest in" a real engineering criterion. It favors one language everywhere, mainstream tools, strict static typing, schema validation at every boundary, and explicit code over framework magic — conventions an agent can read beat conventions it must infer.
2. **The cold-open latency budget.** The app must open as fast as WhatsApp. Mail, Notion and Slack cost seconds to open, so quick notes migrate to whatever opens instantly; opening and capturing fast are survival criteria, enforced by budgets (§7). Capture must also work where no UI exists — the proven task-creator flow captures by voice in the car and by dictated SMS — so **capture is a backend capability with multiple front doors** (§6.5), not a web-client feature.
3. **The backend is connector- and job-shaped.** OAuth flows, Slack/Gmail webhooks, Notion polling, scheduled reconciliation, AI calls on ingest. That is a service with real background execution, not a bundle of request handlers.
4. **More than one user, SaaS-ready tomorrow.** Never hard-code how many accounts there are. Every row is tenant-scoped, and since "Sign in by picking a name, each user in their own account" (issue 86) that scoping is exercised rather than assumed. Auth is real OAuth, per "App login: hand-rolled Google OIDC + own sessions"; secrets are encrypted and workspace scoping is enforced server-side.
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
│   └── config/        # shared tsconfig, prettier
├── docs/             # this document and its siblings
├── poc/              # proofs of concept (kept; they are part of the showcase)
├── .github/          # CI/CD workflows (§9)
└── eslint.config.mjs # the lint layer, at the root because its rules span every package
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
- **Source-owned, app-owned and write-once fields are separate column groups.** Re-syncs overwrite source-owned columns unconditionally and never touch app-owned ones. The captured message is the third kind: written when the Item is made and never again, by a re-sync or by anything else. Nothing enforces that at the database, and nothing should — no command writes the column after capture, and a trigger is more machinery than a field with no writer needs. An Item's title is **app-owned**, not source-owned: a source's subject seeds it at ingest and never afterwards, so renaming an Item survives the next poll.

#### The database is the second lock

These conventions are enforced by the schema, not by the callers that happen to exist today. Every write currently goes through the command handlers, so the constraints can never fire in normal operation — that is the point. They are what still holds when a connector, a migration, a backfill or a hand-run `wrangler d1 execute` writes rows the handlers never saw.

- **STRICT tables.** SQLite's default is dynamic typing with affinity, so a `TEXT` column stores an integer without complaint. `STRICT` (3.37+, which D1 runs) makes declared types enforced. Its guarantee is precisely *no lossy conversion*: a blob into a text column is refused, while `12345` into that column is still accepted as `'12345'`. It is not a substitute for a CHECK.
- **A CHECK for what is true by definition, never for what the product tunes.** A timestamp is a timestamp, a flag is 0 or 1, an order index is not negative: those are held in `src/accounts/schema.ts` and `src/db/schema.ts`. The kinds a Panel can be, the statuses an Item moves through and the heights a row may take are the product's to extend, so their Zod enum is the only lock they get — a CHECK costs the rebuild below to *change* as much as to add, and a second lock on a set that grows buys a migration per product decision.
- **Foreign keys, which D1 enforces**, with `ON DELETE RESTRICT` throughout: nothing here is hard-deleted, so a cascade would silently answer a question that should be asked. The command log is the deliberate exception and carries no foreign keys, because an audit trail must outlive what it refers to.

**Drizzle cannot express STRICT** — absent from `sqlite-core` and never emitted by drizzle-kit — so every migration adds it by hand and a regenerated migration silently drops it. The rule *what the product stores is what comes back* in `apps/api/tests/integration/db/constraints.test.ts` asserts it against the applied schema for exactly that reason.

**A CHECK cannot be added to, changed in or removed from a table that already has children**, and neither can a column one names be dropped. SQLite cannot `ALTER TABLE` a CHECK at all, so any of those means rebuilding the table — and on D1 a table with rows pointing at it under `ON DELETE RESTRICT` cannot be dropped, because `DROP TABLE` performs an implicit delete the foreign key refuses. `PRAGMA foreign_keys = OFF` is not a way out: D1 accepts the statement and ignores it (both measured against a real D1 on 2026-08-31). So one new CHECK on `workspaces` costs rebuilding `workspaces`, `items` and `associations` together — worth paying for something true by definition, not worth paying for a set the product will extend, nor for a single nullable column only the command handlers write. `workspaces.deleted_at` is the recorded instance of the second, and migration 0002 says so. The limitation is about *altering*: an account's store creates its tables whole on first change, so the same column carries its CHECK there.

#### One store per account, and `tenant_id` stays

**Status: built.** An account's workspaces, dashboards, panels, screen sizes, layouts, items, associations and change log live in that account's own store; the register — which accounts exist — stays in D1. `apps/api/src/accounts/` is the only place either is read or written.

**A tenant is an account, not a Workspace.** Workspaces are the privacy boundary *inside* one account's data. One store per Workspace would break the Workspace switcher and every future cross-Workspace view.

**The store is a Durable Object, not a second D1 database**, measured rather than argued in [account-storage-options.md](account-storage-options.md). A D1 database per account cannot be provisioned without a deploy, since bindings resolve at deploy time, while a Durable Object is reached by name at runtime and created on first touch — and the price of that (each account applies outstanding schema changes inside somebody's request) turned out to be milliseconds. Three things follow, each visible in the code:

- **Bringing an account up to date happens inside a request**, so failure must be legible: `apps/api/src/accounts/up-to-date.ts` names the change and keeps the underlying cause, because the off-the-shelf migrator reports only `Rollback`.
- **The live-updates stream stays in the Worker**, polling the account's store rather than moving into it, because Durable Objects bill wall-clock duration and the stream is long-lived by design.
- **The register cannot be joined to account data** — D1 cannot join across bindings, and a Worker cannot join D1 to a Durable Object — so `tenant_id` carries no foreign key inside a store.

**No statement's parameter count grows with the data.** A store's SQLite binds at most 100 values per statement, so a query holding one variable per row it found, or an insert holding one per row it writes, works until somebody has enough and then fails — and it fails as a 500 on the read or the change the screen depends on, not as a slow query. Reach a set through a join; split a write with `inBatchesOf` (`src/domain/statements.ts`), inside one transaction so it stays all-or-nothing. Never build an `IN` list or a multi-row insert whose length is the user's. Every instance found so far was reachable by ordinary use — a workspace stopped painting at 100 layouts, a dashboard could not be rearranged past 16 panels, and a panel refused a 21st item — which is why the arithmetic lives in one function rather than per table.

**`tenant_id` stays on every row even after the split.** It looks redundant once a store holds one account, and is not:

- **It is the second lock again.** Correctness otherwise rests entirely on addressing the right store; with `tenant_id` a routing bug returns nothing, without it that same bug serves another account's data.
- **It is the row's provenance** — the only thing that says whose a row is once it leaves its store in a backup, export or restore.
- **The platform choice is provisional.** The recorded fallback is co-located Postgres, where the credible shape is row-scoping and `tenant_id` is mandatory.
- **The cost is asymmetric**: keeping it is one text column already written and indexed; re-adding it means backfilling every row of every table.

**The move is a cutover, not a copy.** Rows in D1's `items`, `associations` and `commands` were not carried across: production *then* held `seed.sql` fixtures rather than real mail and staging held what had been clicked through it, so there was nothing worth backfilling. Each environment gets a store that starts empty and gives itself the workspace an account starts with on the first request. **A cutover like this one is no longer available**: both environments hold real data from 7 September 2026, so the next store-shaped change carries its rows across — see "The environments" in [deployment.md](deployment.md).

**D1 still holds the four tables an account's data used to live in.** Removing them is a *contract* step for a later release, per "Migrations and rollback" in [deployment.md](deployment.md): a deploy applies migrations before the new code goes live, so dropping them in the same release would leave the old code reading tables already gone — and re-promoting the previous commit, the first way back, would leave it that way.

### 4.3 Mutations are commands, not object PUTs

All writes go through small, named, idempotent commands: `capture_item`, `create_item_type`, `rename_item_type`, `set_done`, `set_dismissed`, `associate`. Each carries a client-generated command ID, the client timestamp, and a minimal Zod-validated payload from `packages/shared`.

Commands keep every door open at almost no cost: idempotent retries on flaky mobile networks, an audit trail for free, trivially testable pure handlers at L1, and exactly the API an offline queue would need if offline writes are ever promoted from exceptional to supported (§5.3). A generic `PUT /items/:id` gives none of that and invites lost updates between two devices.

### 4.4 `packages/shared`: schema and command rationale

The Zod schemas in `packages/shared/src` are the wire contract; where a decision is shared across several schemas, or carries a history worth keeping, it is written once here and cited from the source rather than restated at every schema that depends on it.

**Shared rules behind the command payloads (`commands.ts`):**

- **A client-generated uuid names what a command creates; the envelope's plain string names what a command already expects to exist.** `create_workspace`'s `workspaceId`, `add_dashboard`'s `dashboardId` and similar carry a fresh client-generated id — the client has to hand the same id back on a replay, and nothing on the server can derive a uuid. `rename_workspace`, `rename_dashboard`, `rename_screen_size`, `delete_screen_size` and `rename_item_type` instead take the envelope's plain string, because they name something that may predate client-generated ids: the dashboard every workspace was given when dashboards landed, the screen size called *Default*, the *Task* and *Note* every account starts with — none of those are uuids.
- **A whole order, never a relative move.** `reorder_workspaces`, `reorder_item_types`, `move_item_to_panel` and `add_item_to_panel` all carry the entire order they leave behind. Two reasons hold for all four: commands are resolved last-write-wins on the client's clock (§4.3 above), and a whole order is a value that rule can be applied to while a relative move is not — two out-of-turn relative moves compose into an order nobody asked for. It also makes staleness visible: an order that no longer names the same set the account holds is refused, where a relative move would quietly succeed against a list nobody was looking at. Each such payload is refined against exactly two rules: no id names two positions, and the id the command is *about* is present in the order it left behind — either failing is not a smaller change, it is an inconsistent one. (`move_item_to_panel` targeting the Inbox is the one exception to the second rule: a null `panelId` carries an empty order, and the moved item must be *absent* from it — see its row below.) The moved-out id is not redundant with the list even though the refine rule already requires it there: it is what the command log reads back afterwards, since "the whole order changed" on its own says nothing about what somebody did.
- **One command per whole concept, not one per gesture.** `save_layout` (a dashboard's whole arrangement), `move_item_to_panel`/`add_item_to_panel` (a panel's whole order) and `set_workspace_theme` (all four colors together) each cover every gesture that changes the same underlying thing, rather than splitting into one command per gesture — which would mean several commands writing the same rows, and several chances for them to disagree.
- **Three commands carry no client and no route.** `propose_item_texts`, `propose_item_panel` and `write_routing_summary` are sent by the enrichment job over the account's own store, never by a browser, so none is mounted in `apps/api/src/http/app.ts`. They are in `commandSchemas` because that is what types the store's one write path, not because they are reachable from a client — `SelfSentCommandName`/`ClientCommandName` keep the three apart so a command a browser cannot send fails the client's typecheck rather than getting published as a dead endpoint.
- **Renaming carries the exact schema creating does.** `rename_workspace`, `rename_item_type` and, informally, `rename_dashboard` all validate the new name with the same schema their `create_`/`add_` counterpart uses, rather than a copy of it — so the two rules cannot drift apart, and uniqueness (the one thing that differs between them) is left to the handler and the index behind it rather than encoded in the schema.

**What each command's payload says beyond those shared rules:**

| Command | Beyond the shared rules above |
|---|---|
| `create_workspace` | No color: it is a function of the colors every other workspace already has, and the client's copy of that list can be stale, so the server picks it. No `dashboardId`: the workspace's first dashboard takes an id derived from the workspace's own (`firstDashboardId`), which `panelId` cannot — several other commands (`rename_panel`, `delete_panel`, `set_panel_text`...) need a real uuid to address a panel by, and a derived one would leave the first panel unable to be renamed, deleted or filed into. |
| `rename_workspace` | See "renaming carries the exact schema creating does" above. |
| `delete_workspace` | The envelope alone. Its items are left where they are — tombstones, not deletes (§4.2) — because the router learns from the whole history of where things were filed. |
| `reorder_workspaces` | See "a whole order" above. |
| `set_workspace_theme` | See "one command per whole concept" above — the four colors together, not a theme name, because four colors is what a workspace stores. The server still refuses a set that is not one of the eight palette entries (`hexColorSchema` only validates `#rrggbb` shape, not membership), which is what keeps "picked from designed options" true rather than merely intended. |
| `add_dashboard` | Name uniqueness is decided by the handler in the scope of the *workspace*, so two workspaces may each have a Research dashboard ("Add and switch dashboards", issue 32). |
| `rename_dashboard` | Same naming rule as `add_dashboard`, informally (see "renaming carries the exact schema creating does" above); `dashboardId` is a plain string per "client-generated uuid" above. |
| `delete_dashboard` | Its panels go with it; the actions they showed are keyed to the workspace and untouched — nothing written down is lost by removing a place it was shown. |
| `add_panel` | `kind` defaults to `'items'`, so a client that has never heard of panel kinds adds the panel it always added. Where the new panel lands is the handler's job, not the payload's: it is appended to every layout the dashboard has, which only the store can compute, since the client's copy of those layouts can be stale. |
| `rename_panel` | Every panel is client-created, so unlike a dashboard's, `panelId` really is a uuid. |
| `delete_panel` | It leaves every layout of its dashboard with it — a layout naming a panel nobody can see would be a hole nothing could fill. |
| `set_panel_text` | The *whole* text of a text panel, not a patch, like every other text this app stores. Sent whole so two people typing at once resolve to the later write rather than an unrequested merge, and so the same change sent twice lands once. Whether the panel is one of text, and whether it is read-only, are the handler's to check — both are facts about the stored panel, not about the shape of the request. |
| `set_panel_format` | Says how a text panel's words are *drawn*, not what they are — the text itself is untouched, so nothing here can rewrite a word somebody wrote. |
| `save_layout` | See "one command per whole concept" above. **Still an upsert**: a `layoutId` the dashboard already has *updates* that layout, a fresh client-generated one *creates* it — which of the two is no longer a question anybody is asked, since the client always sends the id of the layout on screen. `screenWidth`/`screenSizeId` are read only when the layout is *created* — a layout has nothing left to rename once its screen size carries the name (`rename_screen_size`). `screenSizeId` is optional because one caller cannot name a size in advance: an ordinary arrangement gesture on a dashboard with nothing defined resolves the size on the way in — the account's nearest size, or one called *Default* at `screenWidth` where the account has none at all; sent explicitly, it means *Define a layout for X*. `rows` is a list because the order it holds is what draws the panels top to bottom, and each panel may sit in at most one cell across the whole layout — keyed into two rows, it would silently replace itself in one and the arrangement would come back a cell short. |
| `delete_layout` | The panels stay exactly where they are; only one way of arranging them goes. Deleting a dashboard's last layout is allowed — having none is normal, not something to protect against. It used to be refused; a dashboard with nothing defined is now simply drawn fitted to the screen. |
| `create_screen_size` | Name and width are both typed by hand ("Draw a dashboard against the screen sizes its account has", issue 263) — `width` is never a measurement the client took. Account-scoped: the envelope's `workspaceId` is only where the change announces itself, not what the size belongs to — one list, offered on every dashboard the account has. |
| `rename_screen_size` | Renames it for every dashboard that offers it, the way renaming a type does for every item wearing it. `screenSizeId` is a plain string per "client-generated uuid" above — *Default*, the one size the product still makes for itself, has an id derived from the account's own. |
| `delete_screen_size` | Every layout at that size goes with it, across every dashboard of every workspace — not only one dashboard's, which is the whole difference from `delete_layout`. Deleting the account's last size is allowed, the same as deleting a dashboard's last layout is. |
| `capture_item` | The one command with many front doors (§5.4, §6.5). `message` is capped where a description is capped, since it lands in the same snapshot every device holds a copy of — capped only on the way in; the read model stays permissive, so a pre-cap capture still opens. `typeId` is required: it was optional while the pickers offered *No type*, and both pickers now make it unavoidable — a front door with no picker (a dictated note, a connector) captures nothing until something can answer for it. `workspaceDecided` defaults to true, so every front door that captures into a named workspace keeps saying what it always said; only the Capture page sends `false`, while its Where row is left on *Any workspace* — the whole of what "I have not decided yet" means on the wire. |
| `create_item_type` | Made only from the types-management page ("Make a type where types are managed, not while capturing", issue 203) — capture no longer creates a type from an unmatched name. No colour: which one is free is a fact about the account, not the request, so the store decides it, which is also what makes a replay harmless — the same command twice cannot pick two different colours. |
| `rename_item_type` | See "renaming carries the exact schema creating does" above; uniqueness here is decided by the handler in the scope of the account. `typeId` is a plain string per "client-generated uuid" above. |
| `delete_item_type` | Its items are left where they are and simply stop having a type — the way deleting a workspace leaves its items filed against it. |
| `reorder_item_types` | See "a whole order" above. |
| `move_item_to_panel` | See "a whole order" and "one command per whole concept" above. A null `panelId` is the Inbox — not a panel, but the absence of one: the item is taken off every panel it was on and, being filed nowhere, is in the Inbox again. Nothing has to name the Inbox for that to work. |
| `add_item_to_panel` | `move_item_to_panel` without the taking-off. The same item can genuinely belong on two panels at once, which is the whole reason a panel is a view over one shared list rather than a folder. There is no null panel here — adding an item to the Inbox is not a thing, because the Inbox is what is filed nowhere. |
| `remove_item_from_panel` | Not a delete and not a move — the item is untouched, one place it was shown stops showing it. Removing it from its only panel leaves it filed nowhere, i.e. back in the Inbox, so there is no separate "put this back" command needed. Carries no `order`: what remains keeps the places it had, and a gap in the numbering is not a hole anybody can see. |
| `set_done` | A flag rather than a pair of commands each way, because undoing is the same command with the flag turned round — nothing has to remember which of "mark done" and "reopen" inverts the other. |
| `set_title` / `set_description` | Two commands rather than one save, because the two fields resolve last-write-wins independently — the form sends only what changed, so leaving the title alone cannot carry a stale copy over an edit made on another device. A null description is the same as never having had one; there is no third state. |
| `propose_item_texts` | See "no client and no route" above. One command for both texts, unlike the two the form sends: this is one reading of one note, and half of it landing would leave the item describing itself two ways. Both texts are required, stricter than the form — a person may clear a title, but Cockpit proposing they should is not a proposal. `readings` is never omitted (empty where there is only the one reading, which is most notes), so a caller always says whether it found any alternatives. |
| `propose_item_panel` | See "no client and no route" above. `reason` is required and non-empty — a proposal that would not say why is not a proposal. No null panel, unlike `move_item_to_panel`'s: this command only ever names a panel, since "nothing fits" is the job of simply not sending the command at all. |
| `set_routing_summary_correction` | The empty string clears it, unlike `set_description`'s `null` for the same idea — this field has no third state to spend `null` on (`domain/routing-summary.ts`, `packages/shared`). Upserts `workspace_routing_summary`, writing only its own two columns; the summary a nightly job wrote is never touched by this write. |
| `write_routing_summary` | See "no client and no route" above — a third command with neither, sent by the nightly summary job (`jobs/enrichment.ts`'s `summarizeWorkspace`). Upserts the same row `set_routing_summary_correction` does, writing only `summary`/`summary_generated_at`; a correction already written is never touched by this write. |

**Item, Workspace, Dashboard, Association (`domain/item.ts`):**

- **The three texts and their caps are functional-definition.md's** ("An Item carries three texts", §4.2): `capturedMessage` (write-once), `title` (200 characters, blank allowed) and `description` (60,000 characters). Neither cap is enforced by a database CHECK: adding one means rebuilding `items` (§4.2 above, "A CHECK cannot be added to... a table that already has children"), which is not worth paying for a nullable column only the command handlers write — both are refused on the way in instead, since repairing input is where bypasses live.
- **`itemReadingSchema`** offers an alternative title/description pair beside the one Cockpit already proposed ("Offer the other readings when a captured note says two things", issue 297), obeying the same schemas a chosen reading would — a reading the form would refuse is not a reading Cockpit may offer. `description` may be empty where `title` may not: a reading exists to offer a different title, and where there is nothing more to add, repeating the same message under both readings tells nobody anything. The main proposal has no such case — it is the one reading Cockpit is confident enough to write onto the item unasked, so it has to justify itself with more than a title.
- **`itemSchema`'s fields are grouped write-once / source-owned / app-owned** (§4.2). `title` is app-owned even though a source proposes it: a subject seeds it at ingest and never afterwards, so renaming an item survives the next poll.
- **`workspaceDecided`**'s product meaning is functional-definition.md's ("Capture something before you know which workspace it belongs to", issue 165). Read through `workspaceIsDecided` rather than directly: a snapshot older than the field rehydrates without reparsing, so a missing value has to read as *decided* — an item wrongly shown in one workspace is where it always was, where one wrongly shown in all of them crosses a privacy boundary.
- **`title` in the read model is the permissive, uncapped `z.string()`**, for the reason every permissive read-back field below is: `capture_item` accepted an uncapped title until the cap landed, the whole snapshot parses at once, and refusing an over-length title would blank the workspace rather than draw one row oddly. The write path (`setTitleSchema`) enforces the cap; the read model does not re-enforce what the write path already refused.
- **`textsSettledAt` / `readings`** — that editing either text settles both is functional-definition.md's rule ("Clean up a captured note into a clear title and a fuller message", issue 296; also issue 297). One timestamp field carries it, rather than a flag per text, since half of a proposal landing after somebody rewrote the other half would leave the item describing itself two ways; the first answer wins, the way `workspaceDecided` does. `readings` is read as offered only while `textsSettledAt` is null: once texts are taken over there is nothing left for an alternate reading to be an alternative to.
- **`proposedPanelId` / `proposedPanelReason`** ("Propose where a captured note belongs, without filing it there", issue 298) are read as a proposal only while the item is filed nowhere — filing an item *is* settling its routing, so once it leaves the Inbox a leftover proposal is never read again.
- **`typeId`** is nullable (an item captured before types existed, or whose type was deleted, has none, and is drawn rather than hidden) and a permissive plain string, for the reason every seeded id below is permissive: the *Task* and *Note* every account starts with have ids derived from the account's own, and a `z.uuid()` here would have refused the whole snapshot the first time one of them was used.
- **`completedAt`** is a timestamp rather than a boolean for the reason functional-definition.md gives ("An item is either yours to deal with or finished with", issue 154). App-owned — a re-sync from a source never clears it.
- **`itemLabel`** — what a row shows — is worked out where it is drawn rather than stored, so it can never go stale behind the two texts it stands for: the next action if there is one, else the title, else "Untitled." Blank counts as absent for both, and when both are blank it says so explicitly, since a row, a drag or an undo offer rendering as a gap is worse than any label. Runs of whitespace collapse, since a title written before it was one line may still hold a line break.
- **`textsFromCapture`** — what names an item at capture — makes the captured message *become* the title (rather than letting the row fall through to the raw message, which used to put two names on one item), cut to the title's own length limit without splitting a surrogate pair in half; where the message does not fit as a title, the *whole* message becomes the description too, so nothing typed is only in a text nobody edits.
- **`workspaceNameSchema`**: trimmed, 1–60 characters, one line — refused rather than cleaned up if it holds a tab, newline or paragraph separator (a browser breaks a line on U+2028 as readily as on `\n`), since repairing input is where bypasses live. Not `\p{Cf}`, which would take the zero-width joiner with it and refuse half the emoji anybody would type. The cap is a product decision — a tab label unreadable past ~60 characters — not a storage one. Shared verbatim by `dashboardNameSchema` here and by `panelNameSchema`/`itemTypeNameSchema`/`screenSizeNameSchema` below — each differs only in *where* uniqueness is decided (workspace, dashboard, account), which is not a shape and so is not encoded in the schema.
- **`workspaceSchema` stores all four colors rather than a theme name**, for the reason `domain/workspace-themes.ts` below gives. Every read-back field on `workspaceSchema` and `dashboardSchema` is deliberately the permissive `z.string()` rather than the validating schema, for the same reason `title` above is: this is what is read *back*, and a stored value that predates a rule should still render rather than blank the screen it appears on — the rules apply only on the way in.

**Panels and Layouts (`domain/panel.ts`):**

- **`GRID_COLUMNS = 12`** is the grid every dashboard is drawn on, always the whole width of the page — so a panel five columns wide is five-twelfths of the screen, never a pixel count that might not fit, and horizontal scrolling cannot happen. A layout made at 2560px and opened at 1280px keeps every panel's *share* of the width and halves what that share measures (text keeps its own size, since nothing here scales type). Twelve divides evenly by 1, 2, 3 and 4 — the whole range of "how many fit across" — so a panel is always a whole number of columns and a row never ends in a sliver.
- **`MIN_ROW_HEIGHT`/`MAX_ROW_HEIGHT` (160–720px)**: without a cap, a drag could hand a row a height no screen can show, with nothing on the page explaining why what follows it had vanished. **The floor is the header plus a list, not the header.** A panel's header is a fixed 56px and takes no items, so a floor near twice that leaves a well of about one row — too little to read, and too little to aim an item at; a drop onto a panel that short missed the list and hit the header, which is not a drop target. 160px leaves two rows under the header, the least that still reads as a list.
- **`DEFAULT_CELL_SPAN = 12`** is the share a panel gets when nothing has said otherwise. Any value would do, since spans are read as proportions rather than absolute widths — twelve is chosen because it makes the whole numbers a divider drag moves between the same twelfths the grid (`GRID_COLUMNS`) is already drawn in.
- **`MOST_ACROSS = 4`**: past four panels in a row, a 2560px screen gives each just 640px and they stop being boxes you read. A rule about the gestures, not the table — a row converted from an arrangement that wrapped six narrow panels onto one line is still drawn, six across.
- **`panelKindSchema`** ("Put a panel of text on a dashboard, and write in it", issue 250) is decided when a panel is made and never after — turning an items panel into text (or back) is a question about what happens to what is already in it, and nobody has needed it answered. `'items'` is the default both ways: on read, so a panel stored before kinds existed reads as one; on write, so a client that has never heard of kinds adds the panel it always added. **`panelTakesItems`** is one function rather than the check written at each call site — the server refusing a filing, the server offering panels to a routing proposal, and the client's own picker — so they cannot come to disagree about what a panel will take; `refuseAPanelOfText` in `apps/api/src/accounts/command-service.ts` enforces the same shape of rule.
- **`panelFormatSchema`** ("Format what a panel says, without making every dashboard pay for an editor", issue 251) is not a conversion either way — the same Markdown is stored throughout, so switching between plain and rich loses nothing. `'plain'` is the default for performance: drawing characters needs nothing fetched, while formatting needs a renderer and writing it needs an editor, so a dashboard costs nothing to open until a panel asks for formatting.
- **`panelTextSchema` (60,000 characters)** is the same cap a description carries, since both are typed Markdown and a second number would be a second rule to explain. Not trimmed, unlike a description — a panel's text is written on every pause rather than saved off a form, and trimming would take the blank line somebody is mid-typing out from under the cursor.
- **`layoutCellSchema`'s `span` is a share, not a width**: a row's panels divide it in proportion to their spans, so two cells of 6 and 6 take half each and so do two of 1 and 1. Requiring spans to sum to twelve would be a second rule saying the same thing, repaired every time a panel joined or left a row.
- **`layoutRowSchema`'s `height`** belongs to the row, not each panel in it, because the thing a person drags is the line under the row. Null means "as tall as what is in it" — what a row is until somebody says otherwise. Stored in pixels, since the gesture that sets it is a pointer dragging an edge — there is no unit between that and the screen for a row count to be worth.
- **`layoutSchema`**: what a person reads as its name is the screen size's own (issue 263) — a layout used to carry its own `name`/`screenWidth`, dropped once every layout hung off a screen size ("Take the width and the name off a layout, now that its size carries them", issue 264). `screenSizeId` is required — every layout from here on is defined at a size the account has.
- **Read-back shapes (`panelSchema`, `layoutCellSchema`, `filingSchema`) are deliberately permissive** — plain strings and unbounded numbers rather than the validating schemas — for the reason `domain/item.ts`'s read-back fields are: this is what is read back, and something stored before a rule existed (or a `kind`/`format` this version has never heard of) should still render rather than blank the dashboard it sits on. `panelSchema.kind`/`format` use `.catch()` specifically so a missing field — what a panel written mid-deploy looks like — also falls back rather than failing to parse.
- **`cellInputSchema`/`rowInputSchema`**, the *write* side, are where the real limits live: a span of zero or over a whole row, or a row with no cells, is refused rather than clamped, since repairing input is where bypasses live. How many cells a row may hold is deliberately not checked here — `MOST_ACROSS` is a rule about the gestures, and a row already holding more (six panels wrapped from an old arrangement) is still a row worth storing.
- **`filingSchema`**: an item may be filed on as many panels as you like, which is what makes a panel a view over one shared list rather than a folder ("Panels hold the items filed into them, and the Inbox holds the rest", issue 36). The order is per panel, not per item — a single shared order would mean reordering one panel silently reordered every other. The Inbox is the *absence* of a filing, not a panel with rows of its own, which is what makes filing an item the thing that removes it from the Inbox.

**Item Types (`domain/item-type.ts`):**

- **The type set is open, not a fixed enum** — a closed set would want a database CHECK, and a CHECK cannot be altered on a table with children under `RESTRICT` (§4.2), so a closed set costs rebuilding three tables while an open one is a table of its own plus a nullable column. The set genuinely is not knowable in advance (*question*, *decision*, *reference* are all plausible next entries), and each would otherwise be its own migration. Type and done-ness are separate axes — the eight-value status this replaced could not manage that: a thought could not be a task, and *task* was really a type wearing a status's hat (issue 154).
- **Colours are the theme palette's tints and nothing new** — one palette rather than two, since the tints were designed and checked for legibility together (`workspace-themes.ts`). A type wears only the saturated tint (the row's dot), never a surface, since a type tints a mark rather than a page.
- **Repeating a colour, once the palette runs out, is the right failure** — two types sharing a dot is one pair you have to read the word to tell apart, while refusing to create a type over a decoration would stop you saying what a thing *is*. The name carries the meaning; the colour just makes a list scannable.
- **`ACCOUNT_WIDE`**: every command's envelope carries a workspace, since that is what a change announces itself on — but types belong to the account, outside any workspace. This value says "the whole account": nothing is stored against it, and the client reads it as every workspace's read model having changed, which is what a type change actually does.
- **`itemTypeSchema`'s `id`/`name` are permissive read-back fields**, for the reason `domain/item.ts`'s are — the *Task* and *Note* every account starts with predate client-generated ids and validating name rules, and a stored value should render rather than blank the screen. `position` is written by nothing yet ("Manage the types, and put them in the order you want", issue 156); every read breaks ties on `createdAt`, so the order is total whatever the table holds.

**Users and access (`api/users.ts`):**

- **`userSchema`'s `role` is the one field that crosses the boundary the rest of a user's identity stays behind.** The app needs it to decide whether to offer the way into the admin pages, and it does not enforce anything on its own — the server re-checks the register on every request, so a client that lies about this only changes what it draws. Which account somebody owns, and the Google identity they sign in with, stay server-side (only the auth gate reads those). `ROLES` is written once so both sides compare against the same word; the database's own CHECK (`users_role_is_known`) is what actually enforces it — this is what stops a typo like `'adminstrator'` type-checking its way to a comparison that then silently never matches.
- **`registeredUserSchema`** is deliberately more than `userSchema` tells anyone about anyone else, since it is what the admin pages alone see. `hasSignedIn` rather than the Google identity itself — what an admin needs is whether a person has ever got in, which the identity Google keys them by can answer without being a thing to publish. `email` is nullable because the register's own column is: it arrived after the rows did ("Record the Google account each user signs in with", issue 195), so a row without one is a person nobody can sign in as, worth showing rather than hiding. `disabled` is a boolean rather than a timestamp, since when it happened is not a question this page asks and there is no audit trail to put it in ("Take somebody's access away without taking their work", issue 233).
- **`addUserSchema`'s bounds only refuse what is not a request at all** ("Add a user on the admin page, so a second person no longer needs SQL", issue 231) — anything shaped like a real request is answered by the server's own, more specific rules (which address is already taken, what a name leaves nothing of), so `min(1)` rather than a length that merely looks like a real address: `ab` is a request, and being told it is not an address is more use than "validation failed." No role (everyone arrives ordinary — making someone an admin is its own page) and no account (a person owns exactly one, made with them, so naming it would ask for a choice the product does not offer).
- **`userAddedSchema`'s `accountReady`** is `false` rather than an error, because the person is added either way — their account opens as they are added so a change that will not apply lands on the admin who added them rather than surprising the new user's first sign-in, which retries if it did not.
- **`changeUserSchema`** sends name and role together because they are one form: a form that sends only what changed has to decide what "changed" means, and a role left out is indistinguishable from a role set back to what it already was ("Rename a user, and make somebody an admin", issue 232). The address is not here — changing it is a different question with its own failure modes (a changed address must not become a way into the previous holder's account) and is not asked yet.
- **`setAccessSchema`** is its own request rather than a third form field, since disabling access is one action taken from a row's own menu, ends the sign-ins that person is holding, and carries refusals (see `losingAdminIsRefused`) the form does not (issue 233).
- **`losingAdminIsRefused`** is the one rule both the form and the server check against, written once rather than twice, so the choice reads as unavailable before Save and is refused after Save for the same reason rather than a stale one. Two independent refusals, not one: the last admin may not lose the role or access at all, whoever asks: and an admin may never take their *own* admin status away, even where others exist to cover — only a different admin may do that. Gaining the role is never refused; only losing it can lock everybody out.

**Snapshot and events (`api/snapshot.ts`, `api/events.ts`):**

- **One snapshot call per workspace** (§5.2) — every panel is derived client-side from it; there are no fine-grained per-item resources. `dashboards` and `panels`/`layouts` cover the *whole* workspace, not just the dashboard on screen, so switching dashboards, or asking how many panels deleting a dashboard takes with it, reads the same copy already held, with no second call and no second revalidation to get wrong.
- **`filings` is a flat list, not items nested under each panel** — an item filed on several panels would otherwise be sent once per panel. Filings of deleted panels are left out server-side, like the panels themselves, so an item whose only panel is gone is back in the Inbox without the client having to know anything about deletion.
- **`itemTypes` and `screenSizes` ride in the workspace snapshot even though both belong to the account** — every screen that draws an item needs types, a dashboard's own bar offers sizes, and the workspace snapshot is the one call a workspace makes; a separate resource would be a second thing to revalidate and a second chance for a row to draw before its data arrives.
- **`upTo`** is the newest change the snapshot is built on, stamped by the account's own store — compared against a `snapshot_invalidated` event's `at` below so a tab can skip a refetch it already covers. Deliberately not `generatedAt`: that is the Worker's wall clock, stamped by a different, possibly skewed process — comparing the two would decide a refetch on clock skew rather than on the change itself. Optional, since an account that has never taken a change, or a snapshot from before this field existed, has none to report — a tab holding one refetches the way it does today. **Known limit**: a millisecond is not a monotone cursor, so two changes stamped in the same millisecond with a read between them can be mistaken for one; the command log has a real sequence to fix this with, not yet wired in.
- **`serverEventSchema`** says only *that* something changed and *when*, never *what* — SSE is a doorbell, not a data channel (§5.2). `snapshot_invalidated`'s `at` is optional and validated as a datetime, since the comparison against `upTo` is a string comparison and only fixed-width ISO strings order correctly under it — optional rather than required so a client deployed ahead of a Worker that does not yet send it stays listening instead of dropping every event whole.

**Screen sizes and workspace themes (`domain/screen-size.ts`, `domain/workspace-themes.ts`):**

- **A screen size belongs to the account, not to a dashboard** ("Give the account a list of screen sizes, before anything reads it", issue 262) — a layout used to carry its own name/width, so the sizes you care about were redeclared on every dashboard; renaming one screen size across six dashboards used to be six renames.
- **`width` is matched by distance, not membership** — there is no fixed set of sizes to belong to, so "which size is this screen's" is a nearest-neighbour question (`nearestScreenSize`, shared by server and client so a tie-break cannot answer differently on the two sides of one save), not a lookup.
- **`DEFAULT_SCREEN_SIZE_NAME`** is the one name the product still generates rather than asks for — the account's first size, made the first time an arrangement change needs one and there is none to be nearest to (issue 263).
- **The four colors and what each surface is are functional-definition.md's** ("Container hierarchy", §4.1). `bar` is stored rather than computed from the other three, so an entry stays tunable by hand and a future free-form color picker is a second writer of the same four fields, not a migration.
- **The eight themes' saturation was tuned in the running app, not held at the source artboard's own value** — at the artboard's 13%, two themes (Violet, Blue) were indistinguishable side by side on a near-black bar; at roughly a third they read as distinct near-blacks while staying dark enough for the fixed light text.
- **`DEFAULT_WORKSPACE_THEME`** is what an unrecognised tint falls back to, since a workspace whose tint is not in the palette is not a corrupt row — just one that looks slightly wrong — and refusing to show it, or refusing a deploy over it, would be the wrong loudness. Contrast two workspaces sharing a *name*, which is refused: that is two things a person genuinely cannot tell apart.

**First-run names (`domain/starting.ts`):**

- **`FIRST_WORKSPACE_NAME` and its siblings are numbered, not descriptive** — a plausible name like *Work* or *Personal* reads as a decision already made and gets left alone; a number reads as an invitation to rename it. Defined once and read from both apps: `apps/api` writes them when an account's first workspace, dashboard or panel is created, and `apps/web` reads the workspace's name to know whether anybody has started on the account yet — two copies of a name that has to match is one of them being wrong. Changing one of these only changes what a *new* account is given: a change already run is recorded and never reruns, so no existing account is renamed by editing this.

## 5. Client architecture

### 5.1 React + Vite, installed PWA

**A plain SPA** — React, Vite, TanStack Router + Query — installed as a PWA with a service-worker-cached app shell. No server-side rendering: first paint comes from the persisted snapshot (§5.2), not from a server response.

### 5.2 The read model: persisted snapshot, revalidate, push

The server is authoritative; the client keeps a persisted cache purely for speed.

- On load the client paints **immediately from a snapshot in IndexedDB** (TanStack Query cache persistence), then revalidates in the background. Cold open makes zero blocking network requests.
- The working set is kilobytes, so the snapshot is **one API call per workspace**, not a replication protocol.
- **Panel rules evaluate client-side** against the snapshot, so reconfiguring, dragging, filtering and grouping stay inside the §7 interaction budget with no round trip.
- **Which layout a dashboard is drawn with is decided client-side too**, from that same snapshot, which carries every panel and every layout of the workspace: switching dashboard, resizing the window and picking a layout by name all reflow without a request (functional definition, "Layouts: the arrangement that follows your screen"). Only *changing* an arrangement is a write, and it is one command carrying the whole arrangement rather than one per gesture.
- **Liveness via SSE**, since phone and desktop are commonly open at once: the API pushes invalidation events and the client also revalidates on focus. SSE over WebSockets because the channel is strictly server-to-client and SSE is plain HTTP — simpler to run, proxy and test. An idle SSE stream on Workers costs essentially nothing; a Durable Object is the designated upgrade path if connection churn ever bites.

  **An event says *that* something changed and when, never what.** The stamp is there so a tab can tell it already holds the change and skip the read — a change made in a tab otherwise cost it two full snapshots, one immediately and one when its own event came back 0.2–3.0s later. It is compared against the same stamp on the snapshot, both taken from the account's own store: the Worker's clock and the object's are different clocks, and a comparison across them would decide a read on skew. The event still carries nothing *about* the change, so the doorbell does not say who is at the door.

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
| **Commands** | `POST`, one endpoint per command (§4.3) | Every write to an **account's** data, idempotent via client-generated command IDs. |
| **Push invalidation** | SSE (long-lived HTTP response) | "Something changed, at this moment" events that trigger revalidation, keeping phone and desktop in agreement — and let a tab that already read the change skip it. |

So it is deliberately **not a resource-oriented REST surface**: a narrow contract of snapshots, commands and events, which is what makes the persisted cache, optimistic UI, the capture outbox and any future offline retrofit fall out of the same shapes.

**The admin pages are outside all three, and are the only thing that is** ("Add a user on the admin page, so a second person no longer needs SQL", issue 231): `/v1/admin/` reads and writes the *register*, which is the environment's rather than an account's. None of what the three patterns buy applies to it — there is no snapshot to derive a page from, nothing to cache for offline, and nothing to replay, since a command is addressed to one account's store and adding a person is what creates one. So they are ordinary requests, and a write there is REST — `POST /v1/admin/<what>` to make one, `PATCH /v1/admin/<what>/{id}` to change one ("Rename a user, and make somebody an admin", issue 232) — rather than a command.

**The contract is REST + OpenAPI, generated from the shared Zod schemas.** `@hono/zod-openapi` generates it, and Hono's typed client `hc` gives the frontend end-to-end inference from those same schemas, so no type is written twice. It stays language-neutral because non-TypeScript clients are foreseeable — the possible Kotlin car app (§10), a public API.

The service worker serves the cached app shell locally, and the capture outbox flushes to the same `capture_item` endpoint as an online capture — there is no separate "sync API".

### 5.6 Styling and components: Tailwind + Radix

**Tailwind for CSS, Radix for interactive primitives.**

- **Radix** supplies the menu and sheet primitives unstyled, so their focus trapping, keyboard navigation and ARIA are not ours to own and F1 tests cover Cockpit's logic rather than menu mechanics. The differentiating interactions — row swipe, drag-to-panel — are covered by no library and stay hand-written.
- **Tailwind** imposes no visual style: the prototype's palette, spacing, typography and workspace colors become design tokens in its config, and utilities stay co-located with the markup so deleting an element deletes its styling.
- Both sit well inside the §7 bundle gate, Tailwind emitting only the utilities used and Radix tree-shaking per primitive.
- **A form is a Radix `Dialog` whose open state is a route**, not component state (functional definition, "Editing more than one field at a time"). The router owns what is open and the dialog draws it, so the back button and a pasted link both work without either half being rewritten.
- **The rich-text editor is lazy-loaded** ("Format a description, and edit its source", issue 160), like the Sentry browser SDK below (§9.2, "Observability"). The editor measures 115KB compressed, over a 21KB Markdown core it shares with the panel renderer below — two thirds of the whole budget between them — so it loads behind the form rather than on the cold-open path, and the form is an async boundary with a loading state by design. **A panel of text draws formatted words without it** ("Format what a panel says, without making every dashboard pay for an editor", issue 251): reading is a 15KB renderer over that same core, and only writing formatted text fetches the editor. Candidates, measured sizes and the decision are in [rich-text-options.md](rich-text-options.md).

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

**Queues are wired as of "Clean up a captured note into a clear title and a fuller message" (issue 296)**, which is the first job: one queue per environment in `apps/api/wrangler.jsonc` (`queues` is not inheritable, so a shared name would let staging write to production's accounts), consumed by this same Worker's `queue` handler. **Cron Triggers are wired as of "Show what the system learned, in a sentence you can correct" (issue 301)**: one schedule, declared once at the top level of `wrangler.jsonc` because `triggers` *is* inheritable, so staging runs it too — `handleScheduled` enumerates every account and Workspace and queues one `summarize-workspace` message per Workspace onto the same enrichment queue, rather than calling a model from inside the scheduled handler's own tight execution budget.

Three decisions that job settled for every job after it:

- **A message names what to work on, never the work itself.** `{kind, accountName, itemId}` and no note text: the store is warm anyway, and reading there is what finds an item that has been dismissed, or one whose texts somebody has since edited, *before* a model call is paid for.
- **Acknowledged and retried per message, not per batch.** Throwing out of the consumer would put the whole batch back, so one rate-limited call would re-run work that had already been written.
- **A decision is a return and a failure is a throw.** Everything the job decides — no key, no such item, nothing usable back — ends quietly; only a call that failed is left to the queue's retries. A message the running version cannot parse is dropped rather than redelivered for ever.

### 6.4 AI layer

- **The Claude API behind a project-owned interface** (`ai/`): cleaning up a captured note today, which now also answers with the other ways the note could genuinely be read where it finds any ("Offer the other readings when a captured note says two things", issue 297) and which Panel it belongs on, where one clearly fits ("Propose where a captured note belongs, without filing it there", issue 298) — the same call each time, not a second ask; suggesting Person/Project/Topic associations and translating plain-English panel rules to structured queries land as their own methods when each does. It takes and returns domain values, so everything around it stays testable with the model faked. One method per thing that asks, added when that thing lands — the interface carried two placeholders nothing called for a month, and they were removed rather than implemented.
- **Prompts are versioned files in the repository**, reviewed like code, and a change to *what is asked for* gets the next version rather than an edit: the contract tests are pinned to a version, and two prompts cannot otherwise be told apart by their measurements.
- The provider is a third party like any other: faked at the network boundary below the contract tier, scheduled contract tests for drift (`.github/workflows/contract.yml`).
- Enrichment runs **on ingest, in jobs**, and results are written onto the Item, so reads never wait on a model call.
- **The credential is the application's own, not anybody's**, so it gets no settings screen: `ANTHROPIC_API_KEY` per environment, with `ANTHROPIC_WORKSPACE_ID` beside it where the key is scoped to an organisation rather than a workspace (docs/deployment.md, "Secrets and access"). `/health` reports whether the key is *present* and never what it is, and deliberately does not fold it into the verdict — an environment with no key works, and what it cannot otherwise do is say that it will never enrich anything.

**Three things issue 296 settled by measurement rather than by preference**, recorded because the next prompt will ask the same questions:

- **The model and the effort.** `claude-opus-5` at `effort: "low"`: default effort took 6.0-11.5s against low's 3.8-5.7s, and low routed *better* rather than worse. `claude-haiku-4-5` was measured too — same warm latency, a fifth of the price — and twice out of four handed the captured note straight back as the title, unshortened, which is the one thing the feature exists to stop.
- **A structural answer beats a firmer instruction.** "Answer in the language of the note. Do not translate." turned roughly one English note in three into Dutch, because the prompt's examples are in both languages and the model matched the corpus rather than the note. The fix is to have the model *name* the note's language as the first field of a constrained answer, before it writes anything.
- **What comes back is validated and discarded, never repaired.** An answer is refused against the same schemas the Item's own form enforces, and the Item then keeps the mechanical title capture wrote — text known to contain only what was typed. Trimming a model's answer to fit would make the rule that outranks the rest, *add nothing the note does not contain*, unenforceable.

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
| Any one file fetched separately (compressed) | **< 200KB**, same gate, charged on its own |
| Snapshot revalidation after cold open | background, never blocking paint |

**A lazy chunk gets its own line because charging it to the entry would defeat the point of splitting it.** Today the entry is 183KB and the editor's chunk is 115KB, so a single combined budget would be failing already. The gate (`scripts/bundle-budget.mjs`) reads every JavaScript file under `apps/web/dist` after a build and splits them by what `index.html` names: what it names is the initial bundle, and everything else is charged on its own. **Every file lands on one line or the other**, which is what keeps the service worker and its registration script from being missed — the PWA plugin writes those beside `assets/` rather than inside it, and the document references one of them.

Two standing rules follow: **never block paint on auth** (paint the cached snapshot, verify the session in the background; long-lived sessions with silent refresh, no OAuth redirect on the hot path), and **heavy dependencies are lazy-loaded or rejected**, which the bundle gate makes mechanical.

## 8. Security

- **App login per "App login: hand-rolled Google OIDC + own sessions" (§8.1)**; no passwords stored, ever. Signing in is a Google account, checked against the register, which is the allowlist; the session, cookie and request gate behind it are the application's own.
- **Source tokens encrypted at rest** (application-level encryption for connected-account OAuth tokens).
- **Workspace scoping enforced server-side** on every query via `tenant_id` plus workspace filters; the UI's scoping is presentation, not protection. The account those filters carry is resolved from the session on every request, never from anything the client sends.
- **Message content sent to the AI provider is an explicit, documented flow** (which fields, which provider, retention posture) — the single most sensitive thing this product does. **The flow that exists, as of "Clean up a captured note into a clear title and a fuller message" (issue 296) and "Offer the other readings when a captured note says two things" (issue 297):**

  | | |
  |---|---|
  | What leaves | one Item's `captured_message`, on its own, and the versioned prompt in `apps/api/src/ai/prompts/`. Nothing else of the account travels with it: the request carries no other Item, no Workspace, no Panel, no name and no address, and the job reads the note by id rather than assembling context. |
  | Where to | the Anthropic Messages API, over HTTPS, authenticated by this environment's own key. No other provider, and no gateway in between. |
  | When | once per note captured, in a queue job, from the release this shipped onwards. Nothing sweeps what already exists. |
  | Retention | whatever Anthropic's own commercial terms say for API traffic on this account, which is the thing to read before a second field is ever added to that request — it is not something this repository can assert. Zero-retention arrangements are the provider's to grant, so if the answer ever has to be "nothing is kept", that is a conversation with them rather than a change here. |
  | What comes back | a title and a description, and the other readings of the same note where it finds any (issue 297) - every one of them refused unless it fits the same shapes the Item's own form enforces, and written onto that one Item. |

  **What would make this flow bigger is a decision, not an implementation detail.** Sending the surrounding notes for context, or an account's filing history to a router, changes what leaves this system — so it belongs in an issue that says so, and in this table.
- **Secrets** live in the platform's secret store; the public repository contains `.env.example` files only.
- **The operator's routes are behind a secret, not behind a role.** `/v1/operator/` hands an operator every account's data for a backup ("Take a backup of an environment, or of one user", issue 208), and it is gated by `BACKUP_TOKEN` rather than by the `admin` role every user already carries — because a role is carried by a session and these have no caller who can hold one: a command-line tool has no browser to send to Google and back. An environment with no secret set refuses them outright rather than opening them. **The role check arrived with the first admin-only page** ("See who can sign in, on a page only an admin can open", issue 230) and is `auth/admin.ts`; the two gates stand in front of different prefixes and neither is a spare for the other. *(The original argument here was that signing in proved nothing, being a list of names to pick from; "Sign in with Google, and retire the list of names" (issue 196) retired that argument and left the conclusion standing on the reason above.)*
- **The two prefixes say which gate they are behind**, since "Give the operator's routes the operator's name, and free /v1/admin/ for the admin section" (issue 229): `/v1/operator/` is the secret's, `/v1/admin/` is the sign-in's plus the `admin` role. The operator's routes held `/v1/admin/` first, which named neither their caller nor their gate and stood on the address the admin pages need. The old subtrees answer `410` naming the new one rather than being refused, for the reason `apps/api/src/auth/operator.ts` records.
- **No pull request merges unanalysed.** CodeQL reads the sources *and* the workflow files on every pull request (§9.1) — the second half because this repository's workflows run Claude against an OAuth token and check out pull request branches, making them its highest-value target. High-severity alerts turn the check red. That is the mechanical half, and it does not model this document's own rules — a webhook missing the ingress hardening template, a source token reaching a log, a workspace-scoped read with no tenant filter. The judgement half is a Claude pass over every diff, scoped by a checked-in instructions file and required to end with an explicit verdict, so a run that never reached one is red rather than silent.

### 8.1 App login: hand-rolled Google OIDC + own sessions

Cockpit has two auth problems and only one was ever open. **Connector OAuth** is hand-rolled by necessity — no login library manages third-party integration credentials. The open question was **app login**:

**Google sign-in via the OIDC code flow, implemented in the project, with sessions in a D1 table plus an httpOnly cookie** (sliding long-lived expiry). Small protocol helpers (Arctic/Oslo-style); no auth framework, no auth vendor. Google-only and passwordless means there is no password storage, no reset flow and no email verification anywhere in the system.

**`auth/` is security-critical code we maintain**, so it carries rules the rest does not: state, nonce, CSRF, cookie flags and session fixation are exhaustively L1-tested, login, expiry and silent refresh have F3 coverage, and agent changes there get the strictest review.

**Shipped whole, 2026-09-06.** Issue 86 built the downstream half — a session row in D1, an httpOnly cookie with sliding expiry, a gate that refuses in the application's own JSON rather than with a web page, users and accounts in the register, an account resolved per request — behind a logon page you signed in at by clicking a name. "Sign in with Google, and retire the list of names" (issue 196) replaced that one step, and the picker is gone along with the endpoint that listed everybody: publishing who has an account buys nothing once it is no longer the way in.

**The register is the allowlist.** Proving who you are at Google is not being entitled to an account here: an address the register holds gets in, anyone else is refused with nothing written on their behalf. Somebody is looked for by their Google subject first and by their address only if that finds nobody, so a changed address does not lock a person out and a *reassigned* one is not a way into the previous owner's account.

**Only `openid email` is asked for.** The name shown in the app is the register's, so asking Google for a profile it would never read would be collecting somebody's data for nothing; and neither scope is sensitive, which is what keeps a verification review out of the way of a working sign-in.

**Local development and the browser suite sign in against a stub issuer we run** (`scripts/lib/stub-issuer.mjs`), pointed at by `OIDC_ISSUER`, which no deployed environment sets. That is what keeps there being one sign-in path: the alternative was the name picker kept alive behind a flag, which is a bypass compiled into the deployed application and defended by a variable being unset. The application runs the same code either way — real redirect, real code exchange, real RS256 signature check, real state, nonce and PKCE — and no `localhost` redirect URI is ever registered with Google, which matters because every worktree has ports of its own (`scripts/lib/ports.mjs`) and a web OAuth client demands exact redirect URIs.

One thing ships as data with no behaviour, deliberately: **nothing about sharing**, which will attach to the workspace rather than the account and so is purely additive. The **role** on each user was the other, and stopped being so when the admin pages arrived with the gate that reads it (issue 230) — no migration was needed for it, which is what carrying it from the start bought.

**Cloudflare Access used to stand in front, and was removed on 2026-09-02** ("Remove Cloudflare Access from staging and production", issue 123). It was a perimeter around a deployment rather than the application's identity model, put there because the proof of identity was not built — and taken off ahead of the trigger this section had recorded for it, which was OAuth login shipping. That trigger has now passed on the other side: Google sign-in is what stands in front of a deployed environment, and it is the application's own. Removing it also took away a real cost, since an expired Access session answered background revalidation and the SSE stream with somebody else's HTML login page where JSON or events were expected, and the client carried a whole recovery path for that.

## 9. Hosting, CI/CD, and observability

**Decision: Cloudflare, all of it.** The Worker plus static assets, with D1 ("Cloudflare D1 (SQLite), via Drizzle"), Queues and Cron Triggers. The platform is already proven in this household (www.conselit.be and the task-creator worker), the workload shape fits (request-driven API, scheduled sync, cheap SSE streams, no long-CPU work), the tiers price a single-user app at essentially zero, and there is one vendor and zero servers to patch. Stated honestly: local dev and CI run on `wrangler`/miniflare, which executes the real runtime and real SQLite and *emulates* Queues and cron — the emulation is good enough that the backend tests drive a real capture through a real queue to a real consumer (`apps/api/tests/integration/http/note-cleanup.test.ts`), which is more than "emulated" suggested — and platform limits (CPU time, subrequest counts) are a new class of constraint that L3 tests and nightly runs must respect.

Note the reach: this re-derived the backend framework (Fastify → Hono, since Fastify assumes a Node server process), the job infrastructure (pg-boss → Queues + Cron, §6.3) and the database itself (Postgres → D1, §4.1). A hosting choice is never just a hosting choice.

### 9.1 CI/CD

GitHub Actions, structured to make the testing strategy and the budgets mechanical:

- **Per branch, once a pull request is open** (`pull_request`, which tests the merge result and is the only event that checks an open branch — a branch with no open pull request is checked by nothing, an accepted gap since `/issue`'s own process already runs these by hand): lint, typecheck, the connector-boundary import rules; the fast tiers in full, one job per tier so a misplaced test is visible; bundle-size gate; build. Per-branch **preview deployments were removed**: Cloudflare withholds version preview URLs from a Worker that implements a Durable Object, and gating a replacement cost more per branch than previews got for free (deployment, "No branch environments").
- **On merge to `main`:** the same gate, plus (when they exist) the full suite including L3/F3 against a wrangler-run stack and performance timing checks; then migrate and deploy to **staging**.
- **On every pull request against `main`, and on `main` itself:** CodeQL over the application sources *and* the workflow files (§8). High-severity alerts turn the check red; the rest land in the Security tab. Which parts are repository settings rather than files is in the bootstrap runbook in [deployment.md](deployment.md).
- **On a diff that touches only `docs/`, `.claude/` or a root-level `*.md`:** the five gated jobs — lint, typecheck, the fast tiers, the browser tier, build — skip their work and report as skipped, which a required check accepts where a workflow-level path filter would report nothing at all ("Skip the mechanical checks on a pull request that touches nothing they cover", issue 345). The classification is `scripts/lib/what-changed.mjs`, an allowlist, so an unrecognised path runs the lot, and it is taken from the base commit rather than from the branch, so a pull request cannot rule on its own diff. `Scripts` is not gated, deliberately: its writing-rules test reads exactly the prose the others skip on. `Test Explorer` carries no gate of its own either, but skips anyway — it depends on `Test`, and a skipped dependency is not a successful one. The two remaining report jobs gate nothing regardless, and CodeQL is untouched, for the reason in deployment.md's "Bootstrap runbook".
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
