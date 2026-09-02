---
name: testing
description: Cockpit's binding rules for tests - which level a test goes at, where it lives, how it is named and shaped, and what must be run before claiming something works. Use whenever writing, moving, reviewing or deleting a test; when adding logic, fixing a bug or finishing a capability (tests ship in the same change); when generating a statement list (see the `scoping` skill, which drafts one for every new piece of work); and before reporting that a change works.
---

# Testing in Cockpit

**This file is complete on its own. Do not open the strategy document to write a test.** Every binding rule is restated here; [docs/testing-strategy.md](../../../docs/testing-strategy.md) holds the reasoning and is the version of record. Open it only to change a rule, to settle a case this file does not decide, or when asked why a rule exists — if the two disagree, the document wins and this file is what gets fixed.

The premise: writing tests is nearly free, running them is not. Every test is a permanent tax on every future change.

## Pick the level: lowest that can prove the behaviour

Ask in order, stop at the first yes:

1. Can a **unit test** prove it? Write a unit test.
2. Does it need a real vertical dependency (real DB query, real schema, real serialization)? Write an **integration test** covering *only* what the unit test could not.
3. Does it only exist when services talk to each other? Write a **system test** covering *only* the cross-service wiring. (Cockpit has one service today — see "This repo, today".)
4. User-visible? Same ladder on the frontend: frontend unit → frontend + its own backend → end-to-end browser.

**Duplicating coverage upward is a violation.** If a unit test proves the calculation, the integration test proves only that it is reachable and wired correctly.

The reason for escalating must name what stops a lower level proving it:

| Bad reason | Good reason |
|---|---|
| Integration, because it is integration-like | Integration, because a panel's contents are a query, so this only holds against a real database |
| End to end, because it is user-facing | End to end, because the drag only exists in a browser |

## Dependency restrictions per level

**Vertical** = infrastructure this service owns (its DB, queue, storage). **Horizontal** = anything crossing a service boundary (other services, Slack/Notion/Teams/WhatsApp/Mail, the network).

| Level | Vertical | Horizontal | Proves |
|---|---|---|---|
| L1 unit | none real | none real | logic: calculations, branching, validation, error paths, edge cases |
| L2 integration | real | forbidden, fakes only | the service works against its own real infrastructure, entered the way a real caller enters it |
| L3 system | real | real | services wired together work at the API level; backend only, no browser |
| F1 frontend unit | none real (replace API client, stores, router, timers) | none real | component / view-model logic |
| F2 frontend + own backend | its own service's backend, or a faithful local fake | nothing else | frontend and its backend agree: contracts, payloads, errors, loading states |
| F3 end-to-end | everything real | everything real | a user-facing capability works with the whole thing tied together |

**Enter through the real interface, not around it.** For a Worker, the HTTP entry point *is* the service's own infrastructure, exactly like its database. An L2/L3 test calls `SELF.fetch('/v1/...')` so routing, request validation and error-to-status mapping are exercised on the way to the real database. Importing a route handler's internal function skips all of that silently — it still touches real infrastructure and still passes, while the HTTP layer keeps zero coverage anywhere in the pyramid. Same for F2: call the frontend's real HTTP path.

| Wrong | Right |
|---|---|
| An L2 test `import`s `runCommand()` from the domain/service layer and calls it directly | An L2 test calls `SELF.fetch('/v1/commands/...')`, which runs the real route (validation, `runCommand()`, serialization) for you |

**The one exception: a rule the real interface makes unreachable by construction.** The database constraints (architecture, "The database is the second lock") catch writes the command handlers never validated, but the handlers shape-validate with Zod and check that what a command names exists, so no request can drive an invalid value at them. `apps/api/tests/integration/db/constraints.test.ts` therefore writes to D1 directly — still the service's own real infrastructure. This applies when the interface *cannot* reach the behaviour, never when going through it is merely inconvenient.

It cuts the other way too: where a constraint *is* reachable, only a test through the interface can hold the caller-visible behaviour — a capture naming a workspace that does not exist must come back 404, not the 500 a raw foreign-key error produces.

**L1/F1 may not touch:** filesystem, network, database, the clock (inject time), environment variables, global state, or another process. If a test needs one, move it up a level or refactor.

**Mocking discipline (L1/F1).** "No real dependencies" is not "mock everything":

- Prefer pure units over mocks. Code needing heavy mocking is a design smell.
- Replace a boundary at the edge (the API client, the repository, the clock), not deep inside the code under test.
- **Assert on outcomes, not interactions** — what the code produced, not the sequence of calls it made. Choreographing mock calls survives real breakage and is a violation.

**Third parties.** Never at L1/F1. At L2/F2 and per-change L3/F3, use local fakes or fixtures recorded from real responses (not hand-invented shapes), checked in. Live contract tests run on a schedule only, to verify the fixtures still match reality; a failing one makes updating the fixture priority work.

## Where the test goes

Folders per level, inside the package that owns them — a folder is a boundary that can be policed, a filename is not.

```
apps/api/tests/{unit,integration}/
apps/web/tests/{unit,service}/
packages/shared/tests/unit/
packages/connectors/*/tests/{unit,contract}/    when connectors land
tests/e2e/                                       repo root - belongs to no package
```

Mirror the source layout inside `unit/` so an untested module stays visible. Levels with no reason to exist yet stay absent.

## Name it after the product, not the mechanism

The **outer describe is the feature area of the product**; the block inside it is the rule in product language.

```ts
describe('Triage', () => {
  describe('a dismissed item leaves the lists but is never erased', () => {
    // cases
  });
});
```

The runner then prints the statement list itself, so nothing is stored separately and nothing goes stale.

**A feature area, not an entity and not a function.** The areas: `Capture`, `Triage`, `Dashboards`, `Panels`, `Focus`, `Associations`, `Offline`, `Connector management`, `User management`, `Sign-in`, `Workspace management`, `Accounts`. Capitalised and undotted. `item.setStatus`, `command.idempotency` and `item.change` are all wrong for the same reason: they name an object or an operation.

**The area is not the file.** One file often spans two or three areas, and one area appears in several files at several levels. Group by what the rule is about.

**Everything the runner prints is the statement list** — outer describe, rule, *and* the `it.each` case labels. A table label interpolating an internal name (`$name` printing `set_status`) leaks the mechanism just as badly; give the table a `situation` field in product language and interpolate that.

### Where the product's words come from

**The Glossary at the end of [docs/functional-definition.md](../../../docs/functional-definition.md) is the binding vocabulary.** Use its nouns exactly as defined. Where a rule needs a word it does not have, prefer one the functional definition uses in prose; if the word is genuinely missing, **add it to the Glossary in the same change** rather than inventing a private synonym.

[docs/architecture.md](../../../docs/architecture.md) is the mechanism, and its words must never surface in anything the runner prints. The check is mechanical:

```bash
# a word in the architecture but not the functional definition is a mechanism word
grep -ci "command" docs/functional-definition.md   # 0  -> never appears in a test name
grep -ci "command" docs/architecture.md            # 19 -> it is the write path, an implementation
```

"Command", "envelope", "tombstone", "snapshot", "idempotency", "last-write-wins" are all in this class. What the product calls the same things: capturing a thought, triaging an item, dismissing it, what a panel shows, a change replayed after reconnecting, a change made against an older version.

A rule is **one behaviour in product language and one test body**; its cases are a table inside that body. Never one test per statement.

| Bad | Why |
|---|---|
| `commandService` dedupes by `commandId` | names the implementation, unreadable as intent |
| `command.idempotency` / `item.commands` | "command" is architecture vocabulary, not in the Glossary |
| `item.setStatus` | a method name wearing a dot |
| `item.change`, `item.identity` | invented words dressed as product concepts |
| `item.process` | still an object-and-operation; the area is `Triage` |
| every choice on an item asks for the change it names, for that item | circular — restates the label instead of stating what must hold |
| The panel contents query filters on assignment and excludes deleted rows | true, and still a mechanism statement |
| Actions work correctly | not falsifiable |

Good: *A panel shows exactly the actions assigned to it.* *A change replayed after reconnecting is applied only once.* *A change to an item that no longer exists is refused and nothing is stored.* *A dismissed item leaves the lists but is never erased.*

Prefer a rule whose **table grows as the product grows**: one "a change to an item that no longer exists is refused" with a row per change, not one rule per endpoint. On the frontend, "a change that fails puts the screen back" absorbs all of them.

**Frontend rules are about the UI's own behaviour and its wiring, never a restatement of a backend rule.** Bad: a browser test for "removing an action from a panel leaves it on the other panels". Good: "the remove control sends a remove for this panel", plus one browser walk per capability.

The shape — one body, tables as data, so adding a situation is one line:

```ts
describe.each(situations)('an action $name', (s) => {
  // arrange from s
  it.each(places)('$verb in $where', async ({ read, expected }) => {
    expect((await read()).some(a => a.id === ws.lastActionId)).toBe(expected);
  });
});
```

## Mandatory coverage

1. **Every capability has at least one frontend test** (F3, or F2 where F3 genuinely cannot reach it) proving it works for a user. Unit and integration tests never count as that proof.
2. **Every bug fix gets a regression test at the lowest level that reproduces the bug.**
3. **New logic ships with L1/F1 tests in the same change.** Never a follow-up task.
4. A rule agreed but not yet built is `describe.todo` / `it.todo` in the real test file at the real level. **No todo may survive a merge** — removing one requires, in the same diff, either the test appearing or a comment saying we chose not to test it. A rule blocked on an unanswered product question becomes an issue, not a todo.
5. **A test that cannot fail is not a test.** See the whole table go red once before the implementation lands, and say so in the pull request; where the implementation landed first, take the behaviour back out and watch it go red then, while the test is still in hand. A test never seen red passes for two indistinguishable reasons — the behaviour works, or it asks nothing. The obvious test for a stream error once passed identically with the fix, without it, and with its guard removed, because the runner could not produce the condition at all.
6. **A red check expires when the code it points at changes.** Red proves the test could fail against *that* implementation. Reshape the code afterwards — for a review finding, for a bug the browser found — and take the check again. Three tests went vacuous that way in one run while still passing: a migration case once the handler stopped reading the column, a preload case once a hover triggered it (jsdom does not hover), an offline case re-reading a copy too fresh to re-read. A test that survives a rewrite of its subject untouched is the suspicious case.
7. **State a rule as what the person ends up seeing, not as what the function returns.** Correct logic wired to the wrong thing passes every test of the logic. *The workspace shows the sign-in banner* cannot pass while the wiring is wrong; *diagnose returns signed-out* can.

Tests are for confidence, not for covering everything. Cut a case only when it has **no distinct path** (same data, same query, same parameters) or is **already exercised** by something that would go red if it broke. "It is obvious" is not a reason on its own; if there is a distinct query, branch or decision behind a case, keep it.

## Definition of done - non-negotiable

Do not claim something works until **all** of these hold:

1. **Fast tiers (L1, L2, F1, F2) run in full and pass.** No selection.
2. **Slow tiers (L3, F3): every test covering the capabilities touched.** Select by capability, include when in doubt. "I selected too narrowly" is never a valid explanation for a broken merge.
3. **The application was actually started and the changed behaviour exercised.** Green unit and integration tests are never evidence that the app runs — this exists to prevent an all-green suite over an app that crashes on startup. Use the F3 suite where one covers it, otherwise start the app and drive it in the browser.
4. **Results reported faithfully.** Failures quoted with their output; any tier skipped or narrowed stated, with why.
5. **New tests sit at the right level and respect the dependency restrictions.** A misplaced test gets moved, not grandfathered in.

If step 3 reveals a failure the tests missed, add the missing test before finishing — the gap in the pyramid is itself a bug.

**Budget.** The fast tiers stay under 5 minutes locally, L1+F1 in seconds. Exceeding it makes restoring it priority work (push tests down the pyramid, delete redundant ones, parallelize), never resolved by skipping runs. Keep L3/F3 few and thin: before adding one, ask what it proves that nothing below can.

**Flakiness.** Never retry-to-green; never weaken assertions, widen tolerances or add sleeps. Fix immediately or quarantine with an owner and an open bug; a test that stays quarantined is deleted.

## This repo, today

Verify against `package.json` before relying on this section — it goes stale.

- **One service**, so L2 and L3 collapse: the API-in-process tests against real local storage — D1 for the account register, a real Durable Object for an account's own data (`@cloudflare/vitest-pool-workers`, `apps/api/vitest.config.ts`) — are the backend tests. L3 becomes a real tier the day a second service exists. "API-in-process" means through `SELF.fetch(...)` (see `apps/api/tests/integration/http/item-changes.test.ts`), never by importing a handler function.
- **Runner:** Vitest below the browser (`apps/api`, `packages/shared`, `apps/web`); **Playwright for F3**, configured at the repo root in `playwright.config.ts`. `pnpm test:e2e` boots its own copy of the stack (`scripts/e2e-stack.mjs`: its own Wrangler and Vite on this checkout's own pair — :8887 and :5273 in the primary checkout, derived from the path in a worktree so two can run at once (`scripts/lib/ports.mjs`) — and its own state directory rebuilt from a template before every run, so it never touches the storage `pnpm dev` uses) and runs every spec under two projects, `desktop` and `phone` — the same walk with a mouse at 1280px and with touch at 480px, because "it works on that device" is a claim about each device. Both are Chromium: a viewport and input matrix, not a browser matrix. Point it at a deployed environment with `E2E_BASE_URL` plus `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`.
- **`pnpm test`** runs `-r test` across packages. Today: `apps/api` has `test:unit` and `test:integration`; `packages/shared` and `apps/web` have `test:unit`/`test:f-unit` only, having no vertical dependency to integration-test against. Every package has `test:fast` and `test:all`, mirrored at the root; `pnpm test:e2e` runs F3, which `test:all` includes and `test:fast` deliberately does not. `test:f-service` and `test:contract` stay unadded until something needs that level.
- **The per-level folders are populated**: `apps/api/tests/{unit,integration}`, `packages/shared/tests/unit`, `apps/web/tests/unit`, `tests/e2e/`. No stray tests in any `src/` tree. F3 specs must be named `*.test.ts` (not Playwright's `.spec.ts` default) or `tools/test-explorer` will not count them.
- **Starting the app** (needed by the definition of done): `pnpm dev`, which does the migrations, the seed and both halves in one command and **prints the two addresses** — :8787 and :5173 in the primary checkout, a derived pair in a worktree. Read them off that line rather than assuming; `pnpm dev:api` and `pnpm dev:web` run one half alone, on the same ports. Full sequence in [readme.md](../../../readme.md).

## Reviewing tests

Reject: tests at the wrong level; coverage duplicated upward; L1/F1 tests with real dependencies or interaction-choreography assertions; L2/F2 tests with horizontal dependencies; an L2/L3/F2 test calling an internal function instead of entering through the real interface; a capability with no frontend test; an outer describe that is not a feature area; a rule **or table label** carrying a word the Glossary does not have (run the grep above), or a rule so circular it restates its own label; a surviving todo; a test that still passes once the behaviour it covers is taken back out; a rule stated as what a function returns where the wiring is what could be wrong; a "done" claim not backed by the definition of done.

Prefer making a violation impossible over catching it in review: no network or filesystem in the unit runner, lint rules banning API-client imports under unit folders, a CI job per level, the time budget checked in CI.

## When generating a statement list

Read [references/statement-lists.md](references/statement-lists.md) — the passes in order, the collapsing step agents skip, the pruning criterion, the output shape. Worked example: [docs/statements-issue-36-experiment.md](../../../docs/statements-issue-36-experiment.md).

Invoked by the [scoping](../scoping/SKILL.md) skill for every new piece of work, not only work being filed as a GitHub issue.
