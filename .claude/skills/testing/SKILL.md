---
name: testing
description: Cockpit's binding rules for tests - which level a test goes at, where it lives, how it is named and shaped, and what must be run before claiming something works. Use whenever writing, moving, reviewing or deleting a test; when adding logic, fixing a bug or finishing a capability (tests ship in the same change); when generating a statement list (see the `engineering-plan` skill, which drafts one for every new piece of work); and before reporting that a change works.
---

# Testing in Cockpit

This skill is Cockpit's test strategy, binding on every agent and person writing or changing a test. To change a rule, change it here. The premise: writing tests is nearly free, running them is not, so every test is a permanent cost paid by every later change and every CI run.

**Open a reference file when the work calls for it:**

| Open | When |
|---|---|
| [references/browser-tests.md](references/browser-tests.md) | writing, changing or debugging a browser walk under `tests/e2e/`, or anything about the F3 stack, its shards, budgets or selection |
| [references/third-parties.md](references/third-parties.md) | a test touching an outside service or a Claude prompt: fixtures, contract tests, behaviour suites, `scripts/outside-services.json`, credentials |
| [references/android-widget.md](references/android-widget.md) | a test of the home-screen widget (`apps/android-widget`, Kotlin) |
| [references/statement-lists.md](references/statement-lists.md) | generating a statement list, which the [engineering-plan](../engineering-plan/SKILL.md) skill does for every new piece of work. Worked example: [docs/statements-issue-36-experiment.md](../../../docs/statements-issue-36-experiment.md) |

## Pick the level: lowest that can prove the behaviour

Each level up is an order of magnitude slower to run, harder to debug and more brittle, so ask in order and stop at the first yes:

1. Can a **unit test** prove it? Write a unit test.
2. Does it need a real vertical dependency (real DB query, real schema, real serialization)? Write an **integration test** covering *only* what the unit test could not.
3. Does it only exist when services talk to each other? Write a **system test** covering *only* the cross-service wiring.
4. User-visible? Same ladder on the frontend: frontend unit, then frontend with its own backend, then end-to-end browser.

**Duplicating coverage upward is a violation.** If a unit test proves the calculation, the integration test proves only that it is reachable and wired correctly.

The reason for escalating must name what stops a lower level proving it:

| Bad reason | Good reason |
|---|---|
| Integration, because it is integration-like | Integration, because a panel's contents are a query, so this only holds against a real database |
| End to end, because it is user-facing | End to end, because the drag only exists in a browser |

## What each level may use

**Vertical** = infrastructure this service owns (its DB, queue, storage, cache). **Horizontal** = anything crossing a service boundary (other services, Slack/Notion/Teams/WhatsApp/Mail, third-party APIs, the network).

| Level | Vertical | Horizontal | Proves |
|---|---|---|---|
| L1 unit | none real | none real | logic: calculations, branching, validation, error paths, edge cases |
| L2 integration | real, this service's own | forbidden, fakes only | the service works against its own real infrastructure, entered the way a real caller enters it |
| L3 system | real | real | services wired together work at the API level; backend only, no browser |
| F1 frontend unit | none real (replace API client, stores, router, timers) | none real | component and view-model logic: rendering branches, state transitions, formatting, input validation |
| F2 frontend + own backend | its own service's backend, or a faithful local fake | nothing else | frontend and its backend agree: contracts, payloads, errors, loading states |
| F3 end-to-end | everything real | everything real (third parties per [references/third-parties.md](references/third-parties.md)) | a user-facing capability works with the whole thing tied together, in a real browser |

An L2 test that starts two services is a system test, whatever folder it sits in. L3 is the only backend level allowed to cross a service boundary.

**Levels are roles, not folders to fill.** With one service there is no horizontal boundary except third parties, so L2 and L3 collapse, and `system/` and `service/` are unbuilt. Never invent a test or an empty folder to populate the taxonomy; the levels become distinct the day a second service exists.

**Enter through the real interface, not around it.** For a Worker, the HTTP entry point is the service's own infrastructure, exactly like its database, so an L2/L3 test calls `SELF.fetch('/v1/...')` and routing, request validation and error-to-status mapping run on the way to the real database. Importing an internal function skips all of that silently: the test still passes against real infrastructure while the HTTP layer keeps no coverage anywhere, until a routing or validation bug reaches production. Same for F2: call the frontend's real HTTP path.

| Wrong | Right |
|---|---|
| An L2 test `import`s `runCommand()` from the domain/service layer and calls it directly | An L2 test calls `SELF.fetch('/v1/commands/...')`, which runs the real route (validation, `runCommand()`, serialization) for you |

**The one exception: a rule the real interface makes unreachable by construction.** The database constraints (architecture, "The database is the second lock") catch writes the command handlers never validated, but the handlers shape-validate with Zod and check that what a command names exists, so no request can drive an invalid value at them. `apps/api/tests/integration/db/constraints.test.ts` therefore writes to D1 directly, still the service's own real infrastructure. It applies when the interface *cannot* reach the behaviour, never when going through it is merely inconvenient. It cuts the other way too: where a constraint *is* reachable, only a test through the interface can hold the caller-visible answer, so a capture naming a workspace that does not exist must come back 404, not the 500 a raw foreign-key error produces.

**L1/F1 may not touch** the filesystem, the network, a database, environment variables, global state or another process. If a test needs one, move it up a level or refactor.

**Every tier injects time.** No `Date.now()` or argument-less `new Date()` in a test, since a real read fails on a Wednesday or under load: `pnpm test:scripts` refuses one on a line a branch adds (`scripts/lib/clock-rule.mjs`), naming file and line. Mark a deliberate read in place with `// clock-ok: <reason>`. Fake time (`vi.useFakeTimers`, `vi.setSystemTime`, `page.clock`) and `performance.now()` pass. The Test job lists every test that took over half its timeout in its step summary, and fails nothing.

**Mocking discipline (L1/F1).** "No real dependencies" is not "mock everything", because a mock-heavy suite stays green while the mocks drift from reality:

- Prefer pure units over mocks. Code needing heavy mocking is a design smell to fix.
- Replace a boundary at the edge (the API client, the repository, the clock), not deep inside the code under test.
- **Assert on outcomes, not interactions**: what the code produced, not the sequence of calls it made. Choreographed mock calls are brittle and survive real breakage, so they are a violation.

**Third parties never appear at L1/F1.** Below the contract tier they are faked at the network boundary from recorded real responses; [references/third-parties.md](references/third-parties.md) has the rules.

## What each level is for

- **Correctness lives at the bottom.** Exhaustive inputs and outputs, boundary values and failure behaviour belong in L1/F1, and in L2/F2 only where real infrastructure is intrinsic.
- **The top confirms wiring, nothing more.** L3 and F3 answer one question, whether it works when everything is tied together: the happy path of a capability plus at most one representative cross-layer failure. They never re-test business logic, enumerate edge cases or assert details proven lower down; a large browser suite re-testing logic is a defect of the suite.
- **If an L3/F3 test fails and the fix is in pure logic, coverage was missing lower down.** Add it there too.

## Where the test goes

Folders per level, inside the package that owns them, because a folder is a boundary that can be policed and a filename is not, and each level must run and gate on its own command.

```
apps/api/tests/{unit,integration}/
apps/api/tests/contract/                         the live contract tier (references/third-parties.md)
apps/web/tests/{unit,service}/                   service/ unbuilt until something needs F2
packages/shared/tests/unit/
packages/connectors/*/tests/{unit,contract}/    a connector's own logic, and its own live tier
tests/e2e/                                       F3, repo root because it belongs to no package
apps/android-widget/                             A1 and A2 (references/android-widget.md)
```

Mirror the source layout inside `unit/` so an untested module stays visible. No test in any `src/` tree.

## Name it after the product, not the mechanism

The **outer describe is the feature area of the product**; the block inside it is the rule in product language; the cases are a table inside that body.

```ts
describe('Triage', () => {
  describe('a dismissed item leaves the lists but is never erased', () => {
    // cases
  });
});
```

The runner then prints the statement list itself, so nothing is stored separately and nothing goes stale. This is a correctness rule and not only a readability one: a list that cannot be read as a description of the product cannot be reviewed for whether the right things are proven, and a rule phrased as what the person sees fails when the wiring is wrong ("State a rule as what the person ends up seeing", under Mandatory coverage).

**A feature area, not an entity, a function or a file.** `tools/test-explorer/concepts.json` is the list, and it nests the way the product does: `Accounts` (`Sign-in`, `User management`), `Workspaces` (`Inbox`: `Capture`, `Triage`; `Dashboards`: `Panels`, `Focus`; `Workspace management`, `Connector management`), `Across the app` (`Menus`, `Deleting`, `Ordering`, `Selection`, `Live updates`, `Updating`), `Associations`, `Offline`. Capitalised and undotted. `item.setStatus`, `command.idempotency` and `item.change` are all wrong, since they name an object or an operation. One file often spans several areas and one area spans several files and levels, so group by what the rule is about.

**Everything the runner prints is the statement list**: outer describe, rule *and* the `it.each` case labels. A label interpolating an internal name (`$name` printing `set_status`) leaks the mechanism as badly as a mechanism-named describe; give the table a `situation` field in product language and interpolate that.

### Where the product's words come from

**The Glossary in [docs/product/glossary.md](../../../docs/product/glossary.md) is the binding vocabulary.** Use its nouns exactly as defined. Where a rule needs a word it does not have, prefer one the product docs use in prose; if the word is genuinely missing, **add it to the Glossary in the same change**, since a private synonym invented in a test file is how the two vocabularies drift apart.

[docs/architecture.md](../../../docs/architecture.md) is the mechanism, and its words must never surface in anything the runner prints. The check is mechanical, a word in the architecture but not the product docs being a mechanism word:

```bash
grep -rci "command" docs/product/       # 3  -> only the Glossary's own list of implementation words to avoid
grep -ci "command" docs/architecture.md # 19 -> it is the write path, an implementation
```

"Command", "envelope", "tombstone", "snapshot", "idempotency" and "last-write-wins" are in this class; they belong inside the test body. What the product calls the same things: capturing a thought, triaging an item, dismissing it, what a panel shows, a change replayed after reconnecting, a change made against an older version.

A rule is **one behaviour in product language and one test body**; never one test per statement.

| Bad | Why |
|---|---|
| `commandService` dedupes by `commandId` | names the implementation, unreadable as intent |
| `command.idempotency` / `item.commands` | "command" is architecture vocabulary, not in the Glossary |
| `item.setStatus` | a method name wearing a dot |
| `item.change`, `item.identity` | invented words dressed as product concepts |
| `item.process` | still an object-and-operation; the area is `Triage` |
| every choice on an item asks for the change it names, for that item | circular: restates the label instead of stating what must hold |
| The panel contents query filters on assignment and excludes deleted rows | true, and still a mechanism statement |
| Actions work correctly | not falsifiable |

Good: *A panel shows exactly the actions assigned to it.* *A change replayed after reconnecting is applied only once.* *A change to an item that no longer exists is refused and nothing is stored.* *A dismissed item leaves the lists but is never erased.*

Prefer a rule whose **table grows as the product grows**: one "a change to an item that no longer exists is refused" with a row per change, not one rule per endpoint. On the frontend, "a change that fails puts the screen back" absorbs all of them.

**Frontend rules are about the UI's own behaviour and its wiring, never a restatement of a backend rule.** Bad: a browser test for "removing an action from a panel leaves it on the other panels". Good: "the remove control sends a remove for this panel", plus a browser walk per behaviour.

The shape, one body with tables as data, so adding a situation is one line:

```ts
describe.each(situations)('an action $name', (s) => {
  // arrange from s
  it.each(places)('$verb in $where', async ({ read, expected }) => {
    expect((await read()).some(a => a.id === ws.lastActionId)).toBe(expected);
  });
});
```

## Mandatory coverage

1. **Every capability has at least one frontend test** (F3, or F2 where F3 genuinely cannot reach it) proving it works for a user. A capability is a user-facing feature from the functional definition ("snooze an inbox item", "swipe to remove a row"). Unit and integration tests never count as that proof.
2. **Every bug fix gets a regression test at the lowest level that reproduces the bug.**
3. **New logic ships with L1/F1 tests in the same change.** Never a follow-up task.
4. A rule agreed but not yet built is `describe.todo` / `it.todo` in the real test file at the real level. **No todo may survive a merge**: removing one requires, in the same diff, either the test appearing or a comment saying we chose not to test it. A rule blocked on an unanswered product question becomes an issue, not a todo.
5. **A test that cannot fail is not a test.** See the whole table go red once before the implementation lands, and say so in the pull request; where the implementation landed first, take the behaviour back out and watch it go red then, while the test is still in hand, where it costs a minute rather than a rewrite. A test never seen red passes for two indistinguishable reasons: the behaviour works, or it asks nothing. On "Recover from an expired sign-in instead of failing silently" (pull request 71) the obvious test for a stream error passed with the fix, without it and with its guard removed, because the runner could not produce the condition at all.
6. **A red check expires when the code it points at changes.** Red proves the test could fail against *that* implementation, and a test can stop being able to fail without changing a character. Reshape the code afterwards (for a review finding, for a bug the browser found) and take the check again. Three tests went vacuous that way in one run while still passing: a migration case once the handler stopped reading the column it folded, a preload case once a hover triggered it (jsdom does not hover), an offline case re-reading a copy too fresh to re-read. A test that survives a rewrite of its subject untouched is the suspicious case.
7. **State a rule as what the person ends up seeing, not as what the function returns.** Correct logic wired to the wrong thing passes every test of the logic: two bugs on that same change were a failure diagnosed correctly and announced on a query no screen renders an error for, and a loop guard cleared by the read that is not the one arming it. *The workspace shows the sign-in banner* cannot pass while the wiring is wrong; *diagnose returns signed-out* can.

Tests are for confidence, not for covering everything. Cut a case only when it has **no distinct path** (same data, same query, same parameters) or is **already exercised** by something that would go red if it broke. "It is obvious" is not a reason on its own; if there is a distinct query, branch or decision behind a case, keep it.

## Definition of done - non-negotiable

**This is the full definition, for a change that touches product code.** CLAUDE.md's Tests section carries a table scaling it down for a change confined to documentation or to tests alone; ask `node scripts/local-changes.mjs` rather than judging which row applies.

Do not claim something works until **all** of these hold:

1. **Fast tiers (L1, L2, F1, F2) run in full and pass.** No selection.
2. **Slow tiers (L3, F3): every test covering the capabilities touched.** Select by capability, include when in doubt. CI catches a wrong selection on merge, but "I selected too narrowly" is never a valid explanation for a broken merge.
3. **The application was actually started and the changed behaviour exercised.** Green unit and integration tests are never evidence that the app runs; this exists to prevent an all-green suite over an app that crashes on startup. Use the F3 suite where one covers it, otherwise start the app and drive it in the browser. The home-screen widget, which has no browser, is proven on a real phone instead ([references/android-widget.md](references/android-widget.md)).
4. **Results reported faithfully.** Failures quoted with their output; any tier skipped or narrowed stated, with why.
5. **New tests sit at the right level and respect the dependency restrictions.** A misplaced test gets moved, not grandfathered in.

If step 3 reveals a failure the tests missed, add the missing test before finishing: the gap in the pyramid is itself a bug.

### Running the tiers

Verify against `package.json` before relying on this; it goes stale.

| Command | Runs |
|---|---|
| `pnpm dev` | starts the app: migrations, seed and both halves in one command, **printing the addresses** (read them off that line; a worktree derives its own pair, `scripts/lib/ports.mjs`). `pnpm dev:api` and `pnpm dev:web` run one half. Full sequence in [readme.md](../../../readme.md) |
| `pnpm test:fast` | L1/F1 everywhere, in seconds, plus the repository's own checks (`test:scripts`, `test:lint`, `test:runners`). It leaves `apps/api`'s L2 out, since that alone takes over three minutes and would push the run near the budget |
| `pnpm --filter @cockpit/api test:integration` | the API's L2: the API in process through `SELF.fetch(...)` against real local storage, D1 for the account register and a real Durable Object for an account's own data (`@cloudflare/vitest-plugin`, `apps/api/vitest.config.ts`); model in `apps/api/tests/integration/http/item-changes.test.ts` |
| `pnpm test:e2e` | F3 on its own stack ([references/browser-tests.md](references/browser-tests.md)) |
| `pnpm test:all` | `test:fast`, the L2 and F3 with its walk ceilings; CI runs it on merge |
| `pnpm test` | `-r test` across packages |
| `test:contract` | the live tier, in neither `test:fast` nor `test:all`, which stay free of anything that costs money or reaches a third party ([references/third-parties.md](references/third-parties.md)) |

Each level has its own runner command (`test:unit`, `test:integration`, `test:system`, `test:f-unit`, `test:f-service`, `test:e2e`, `test:contract`) where the level exists: `apps/api` has `test:unit`, `test:integration` and `test:contract`; each connector has `test:unit`, plus `test:contract` where it has a live tier; `packages/shared` and `apps/web` have `test:unit`/`test:f-unit` only, having no vertical dependency to integrate against. Vitest runs everything below the browser, Playwright runs F3 (`playwright.config.ts` at the root), Gradle runs the widget.

## Budget

- **The fast tiers complete in under 5 minutes locally, L1 + F1 in seconds.** A hard gate, because the definition of done runs them in full on every change and that only survives while the run stays cheap. Exceeding it makes restoring it priority work (push tests down the pyramid, delete redundant ones, parallelize), never resolved by skipping runs.
- **Keep L3/F3 few and thin.** Before adding one, ask what it proves that nothing below can; if nothing, do not add it.
- **Organize slow-tier tests by capability**, so the selective runs the definition of done allows are possible.
- **A browser walk proves one behaviour in at most 15 seconds on CI, and each area has a ceiling on its walks.** The rules, the shard budget and how they are measured are in [references/browser-tests.md](references/browser-tests.md).

## Flakiness

A test that passes and fails without a code change is a bug in the suite.

- **Never retry-to-green.** It masks either a real intermittent bug or a broken test, and both must be diagnosed, not laundered.
- **Never weaken an assertion** to fix it: no removed checks, widened tolerances or sleeps.
- **Fix it at once or quarantine it**, out of the gating run and tracked as an open bug with an owner. A test that stays quarantined is deleted, so a suite holds only tests whose failures mean something.

The cause found every time so far is a browser walk acting on what the app has drawn rather than on what it has kept; [references/browser-tests.md](references/browser-tests.md) has the answers and how to reproduce the class.

## Reviewing tests

Reject: tests at the wrong level; coverage duplicated upward; L1/F1 tests with real dependencies or interaction-choreography assertions; L2/F2 tests with horizontal dependencies; an L2/L3/F2 test calling an internal function instead of entering through the real interface; a capability with no frontend test; an outer describe that is not a feature area; a rule **or table label** carrying a word the Glossary does not have (run the grep above), or a rule so circular it restates its own label; a surviving todo; a test that still passes once the behaviour it covers is taken back out; a rule stated as what a function returns where the wiring is what could be wrong; a "done" claim not backed by the definition of done.

**Make a violation impossible rather than catch it in review**: no network or filesystem in the unit runner, a CI job per level, the time budget checked in CI, the dependency table as lint rules. Built today:

- `eslint.config.mjs`, run by CI's `Lint` job and `pnpm lint`, fails a filesystem, network or database import under a `tests/unit/` folder, a focused test (`it.only`, `test.describe.only`) in any test file, and a component formatting a date itself rather than through `apps/web/src/dateFormat.ts`. The API client is not banned, since what F1 tests import from it (the refusal error class and the module they then mock) reaches no network. An import ban is weaker than blocking the runner, which would also catch a global `fetch`. A misplaced dependency is a red check: move the test up a level, never widen the glob.
- `pnpm test:scripts` holds the clock rule, the outside-services list and the browser-walk conventions; CI's `E2E (F3)` shards hold the walk ceilings and shard budget.
- `CLAUDE.md` requires following this skill before writing or changing a test, and documents the one-command start, because "the application was started" is only enforceable while starting it is trivial.
