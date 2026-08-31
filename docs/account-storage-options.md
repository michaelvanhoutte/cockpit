# Where an account's data lives

**Status: decided.** One Durable Object per account, adopted when multiple users land. Written from [poc/account-storage](../poc/account-storage/README.md), which measured the two things the argument turned on rather than assuming them.

Multiple-user support forces a question deferred since the first migration. Every row has carried a `tenant_id` since then, on the rule from the functional definition's "personal-first, SaaS-ready" decision: assume one account today, never hard-code that assumption. The column has never been exercised — there has only ever been one account, resolved from a constant in `apps/api/src/tenancy.ts`. Deciding what that constant becomes is deciding this.

## What forces the question

Cloudflare's limits are explicit that **each D1 database is single-threaded and processes queries one at a time**. On one shared database that means one account's connector sync serialises against another account's reads. The problem is not slowness — a personal instance is three orders of magnitude below the ceiling — it is **shared fate**: my Gmail sync stalls your inbox, and no amount of headroom makes that stop being true.

The second forcing function is nearer. Ideas backlog wants user management in a UI, and a UI cannot deploy. Whether provisioning an account requires a deploy therefore decides whether that idea is buildable at all.

## The three shapes

### A. One shared D1 for every account

What exists today, extended with a `user_id` or left scoped by `tenant_id`.

Cheapest by a distance while the schema churns: one database per environment, one `wrangler d1 migrations apply`, one seed, and the browser tier's template unchanged. It keeps shared fate, keeps everyone under one 10 GB ceiling, and — since iteration 2 ingests full mail bodies, estimated at single-digit gigabytes over years *per user* — that ceiling is a real date rather than a theoretical one.

### B. One D1 database per account

Cloudflare's own recommended scale-out shape, and the one that cannot be provisioned at runtime. **D1 bindings are static**: they are names resolved when a Worker version is deployed. Adding an account means creating the database, adding the binding to production, staging and preview (`d1_databases` is not inheritable), and deploying.

Three consequences, in descending order of how much they matter:

- **`wrangler.jsonc` becomes state that must track live infrastructure.** Create a database through the API without committing the binding and the next CI deploy silently removes an account's access to its own data. That failure is invisible until someone signs in and their workspaces are gone.
- **A UI can never provision an account** — only rename, disable and delete.
- **Account lookup is `env[\`DB_${id}\`]`**, a string index into the environment that TypeScript cannot check.

In exchange, migrations stay exactly what they are today: offline, verifiable, before the deploy. That is the entire case for this option, and during a phase of daily schema changes it is not a small one.

There is an escape hatch, recorded and not recommended: pre-create and bind a pool of empty spare databases and hand one out at runtime, turning signup into a claim. It reintroduces migrating a database at first use, which is the weakness B exists to avoid.

### C. One Durable Object per account

One binding, naming a *namespace* rather than a database. Every account is reached by name at runtime — `env.ACCOUNT.idFromName(account)` — and created on first touch. No account appears in configuration, no deploy, nothing to drift, and provisioning from a UI becomes ordinary.

The price is that migrations become lazy: each object applies outstanding migrations when someone next wakes it, inside a request. That is what the proof of concept measured.

## What the proof found

| | Measured | Read as |
|---|---|---|
| Adding a column, 2,000 and 20,000 items | **+0 ms** | free, as SQLite promises |
| Rewriting the whole table, 2,000 items | **+6 ms** | linear, ~4.5 µs a row |
| Rewriting the whole table, 20,000 items | **+90 ms** | 100,000 items ≈ half a second, once, for whoever opens first |
| Copying a 40 MB state directory | **33 ms** | the browser tier's template trick survives untouched |
| A migration that cannot apply | HTTP 500, every account, data intact, error text lost | recoverable, but opaque by default |

**The measurement that decided it is the first three rows.** Lazy migration was the main argument against C, on the assumption that the cost was large and unpredictable. It is neither: an added column is free at any size, and even a full table rewrite is a fraction of a second at volumes iteration 2 would produce. Against the roughly 7 seconds `wrangler d1 migrations apply` plus seed costs in this repository, the lazy version is not slower — it is differently placed, moving cost from the deploy onto one user's first request.

Two findings sharpen how it must be built rather than whether:

- **A bad migration takes down every account, one at a time as they wake.** Partitioning the data buys no blast-radius protection, because the *code* is what is shared. Whatever a deploy-time migration gate would have caught, something else must now catch — which is an argument for applying migrations against a scratch object in CI before the deploy, not an argument against the shape.
- **The failure is opaque.** Drizzle's migrator reports only `DrizzleError: Rollback`; the real SQL error appears nowhere, in the response or the logs. Fixable in a few lines by running the migration set directly, and it must be fixed *before* this ships, because the first time it matters is the first time something goes wrong in production.

## The decision

**C, one Durable Object per account.** In order of weight:

1. **Provisioning.** B has a failure mode that silently removes an account's access to its own data, and it forecloses user management in a UI permanently. C has neither, because no account is ever named in configuration.
2. **The cost of C turned out to be small and predictable**, which is the finding that reverses the argument that used to favour B.
3. **A now has a date on it.** Shared fate and a single 10 GB ceiling both bite once there is more than one real user and iteration 2 is ingesting mail.
4. Real transactions inside the object, rather than D1's batch-only model — a constraint the architecture document already records having designed around.

Two things this decision does *not* change:

- **The register stays in D1.** Users, sessions and the account register are global, are queried before any account is known, and are small. They also stay physically separate from account data, which the platform then enforces: D1 cannot join across bindings, and a Worker cannot join D1 to a Durable Object at all.
- **The live-updates stream stays in the Worker.** Durable Objects bill wall-clock duration, an open connection keeps an object in memory and billing for up to 15 minutes at a stretch, and hibernation covers WebSockets only. The Worker polls the object; the object does not hold the stream. If that is ever revisited, the prize is dropping the 3-second poll for a push, and the price is a WebSocket.

## What would reverse it

- **Lazy migration turning out worse in production than locally.** Everything measured ran on `workerd` and miniflare, where an object's storage is a file on disk rather than replicated. The shape of the answer should hold; the constant may not. The first deployed schema change is the check.
- **Rolling migrations proving unmanageable in practice** — an account untouched for months, opened after five schema changes, hitting a combination nothing exercised. Mitigated by migrating a scratch object in CI, and worth watching rather than assuming.
- **The register needing to join account data.** It must not; if a requirement appears that makes it necessary, that is a bigger reversal than a storage choice and belongs in its own decision.

## Rejected, and why it is written down

Workers for Platforms — a dispatch namespace with a Worker per account — provisions dynamically and would have worked. It exists to host *customers' own code*, which is not the problem here, and it is the only option where updating the application means touching more than one deployment.
