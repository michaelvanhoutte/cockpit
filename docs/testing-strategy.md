# Testing Strategy & Test Automation Rules

**Status:** v0.2, authoritative. Binding for every agent and human writing or modifying tests here. Writing tests is now nearly free; *running* them is not. Every test is a permanent tax on every future change, paid by every agent and every CI run from now on.

## 1. Core principle: the testing pyramid is a cost model

Each level up is an order of magnitude slower to run, harder to debug, and more brittle. Therefore:

> **Always write a test at the lowest level that can prove the behavior. Only escalate to a higher level for the specific things the lower level physically cannot verify.**

The decision procedure:

1. Can a **unit test** prove this? If yes, write one and stop.
2. If the behavior depends on a real vertical dependency (a real database query, a real schema, real serialization), write an **integration test** covering *only the part that could not be unit tested*.
3. If it only exists when services talk to each other, write a **system test** covering *only the cross-service wiring*.
4. For anything user-visible, the same logic applies on the frontend side.

Duplicating coverage upward is a violation: if a unit test proves the calculation, the integration test proves only that it is *reachable and wired correctly*.

## 2. Test level definitions and dependency restrictions

**Vertical dependencies** are infrastructure owned by the service under test — its own database, queue, storage, cache. **Horizontal dependencies** cross a service boundary: other services, third-party APIs, the network.

### Backend levels

| Level | Vertical deps | Horizontal deps | Purpose |
|---|---|---|---|
| **L1: Unit** | **No real ones.** | **No real ones.** | Prove logic: calculations, branching, validation, error paths, edge cases. Correctness is exhaustively tested here. |
| **L2: Integration** | Allowed (real DB, queue, storage of *this* service) | **Forbidden. Fakes only.** | Prove the service works against its own real infrastructure, entered the way a real caller enters it: queries return what the code assumes, migrations match the models, requests are routed, validated and answered. |
| **L3: System** | Allowed, full | Allowed, full (third parties per §3) | Backend-only. Prove services wired together work at the API level. No browser. |

Hard rules per level:

- **L1 unit tests may not touch** the filesystem, the network, a database, a clock (inject time), environment variables, global state, or another process. If a test needs one, move it up a level or refactor.
- **L2 integration tests** exercise one service plus its own infrastructure. A test that spins up two services is a system test, whatever folder it sits in.
- **L2/L3 tests must enter through the service's own real interface** (its HTTP app, a queue consumer), not by importing an internal function. Routing, request validation and error serialization are as much "the service's own real infrastructure" as its database. Calling an internal function skips them silently: the test still touches real infrastructure and still passes, while the whole interface layer ends up with no coverage anywhere in the pyramid, and nothing marks the gap until a routing or validation bug reaches production. The same applies to F2.
  - **The one exception: a rule the real interface makes unreachable by construction.** The database constraints ("The database is the second lock" in the architecture) exist to catch writes the command handlers never validated — and the handlers shape-validate with Zod and check that what a command names exists, so no request can drive an invalid value at them. A test through the interface could only prove the handlers work, which the request-validation tests already prove, so those tests write to D1 directly — still the service's own real infrastructure. Narrow on purpose: it applies when the interface *cannot* reach the behaviour, never when going through it is merely inconvenient. It cuts the other way too — where a constraint *is* reachable, the caller-visible behaviour belongs at the HTTP tier: a capture naming a workspace that does not exist must be a 404, and only a test through the interface can hold it to that.
- **L3 system tests** are the only backend tests allowed to cross service boundaries.

### Mocking discipline (L1 and F1)

"No real dependencies" does not mean "mock everything":

1. **Prefer pure units over mocks.** Code that needs heavy mocking is a design smell to fix, not a mocking exercise to complete.
2. **Replace a boundary at the edge** (the API client, the repository, the clock), not deep inside the code under test.
3. **Assert on outcomes, not interactions** — what the code produced, not the sequence of calls it made. Choreographed mock sequences verify the code's conversation with its mocks, are brittle, and survive real breakage.

The failure mode this guards against is a mock-heavy suite staying green while the mocks drift from reality. The upper levels catch that drift; not building it in is the first line of defense.

### Frontend levels

| Level | Allowed dependencies | Purpose |
|---|---|---|
| **F1: Frontend unit** | **No real ones** (replace API clients, stores, router, timers). | Component and view-model logic: rendering branches, state transitions, formatting, input validation. |
| **F2: Service-frontend** | The frontend plus *only its own service's* backend, or a faithful local fake. | Prove the frontend and its backend agree: contracts, payload shapes, error handling, loading states. |
| **F3: End-to-end** | Everything real (third parties per §3). Real browser. | Prove a user-facing capability works with the whole system tied together. |

### Levels are roles, not mandatory folders

The six levels describe *roles* and need not all be populated. With only one service there is no horizontal boundary except third parties, so L2 and L3 largely collapse. Do not invent tests or empty folders to populate the taxonomy; the levels become distinct the moment a second service exists.

## 3. Third-party dependencies

Third-party APIs are the hardest horizontal dependency: sandboxes are often unavailable, slow, rate-limited or flaky.

1. **L1/F1:** third parties never appear.
2. **L2/F2 and per-change L3/F3 runs** use local fakes or recorded fixtures, built from real recorded responses rather than hand-invented shapes, living in the repository.
3. **Live contract tests:** a small separate suite runs on a schedule, never per-change, against the real APIs, purely to verify the fixtures still match reality. A failure makes updating the fixture priority work.

Without rule 3 the pyramid has a silent failure mode: every level green against a fake of Slack while real Slack has changed. Rule 3 is what makes rules 1 and 2 safe.

## 4. What each level is *for*

- **Correctness lives at the bottom.** Exhaustive input/output testing, boundary values and failure behavior belong in L1/F1, and in L2/F2 only where real infrastructure is intrinsic.
- **The top of the pyramid confirms wiring, nothing more.** L3 and F3 answer one question: when everything is tied together, does it work? They walk the happy path of a capability plus at most one representative cross-layer failure. They do not re-test business logic, enumerate edge cases, or assert on details proven lower down. A large E2E suite re-testing logic is a defect of the suite.
- Rule of thumb: if an L3/F3 test fails and the fix is in pure logic, coverage was missing lower down.

## 5. Mandatory coverage rules

1. **Every capability must have at least one frontend test** (F3, or F2 where F3 genuinely cannot reach it) validating it works for a user. A capability is a user-facing feature from the functional definition ("snooze an inbox item", "swipe to remove a row"). Unit and integration tests alone never count as that proof.
2. **Every bug fix gets a regression test at the lowest level that reproduces the bug.**
3. **New logic ships with L1/F1 tests in the same change.** Never a follow-up task.
4. **A test that cannot fail is not a test.** See the table go red before the implementation lands; where the implementation landed first, take the behaviour back out and watch it go red *then*, while the test is still in hand, rather than as a sweep at the end where it costs a rewrite instead of a minute. A test never seen red passes for two indistinguishable reasons: the behaviour works, or the test asks nothing of it. On "Recover from an expired sign-in instead of failing silently" (pull request 71) the obvious test for a stream error passed identically with the fix, without it, and with its guard removed, because the runner could not produce the condition at all — coverage until a mutation exposed it as decoration.
5. **A red check expires when the code it points at changes.** Red proves the test could fail against *the implementation it ran against*, not the one that ships, and a test can stop being able to fail without changing a character. Three did in one run: a migration case went vacuous when the handler stopped reading the column it folded; a preload case could never reach preload once a hover triggered it, which jsdom does not perform; an offline case re-read a copy still fresh enough that no read was attempted. All three had been seen red, all three passed at the end, all three asked nothing by then. Take the check again whenever the code under a test moves, and treat a test that survives a rewrite of its subject untouched as the suspicious case it is.
6. **State a rule as what the person ends up seeing, not as what the function returns.** Two bugs on that same change were correct logic wired to the wrong thing — a failure diagnosed correctly and then announced on a query no screen renders an error for, and a loop guard cleared by the read that is not the one arming it — and every test of the logic passed, because each asked what a function returned. *The workspace shows the sign-in banner* cannot pass while the wiring is wrong, which is why "Tests are named in the product's language, not the implementation's" (§9.1) is a correctness rule and not only a readability one.

## 6. Definition of done for agents (non-negotiable)

An agent may only claim that something works after **all** of the following:

1. **The required tests have been run and pass.**
   - **Fast tiers (L1, L2, F1, F2): always in full.** No selection.
   - **Slow tiers (L3, F3): at least every test covering the capabilities touched.** Select by capability and include when in doubt. CI catches a wrong selection on merge, but "I selected too narrowly" is never a valid explanation for a broken merge.
2. **The application has actually been started and the changed behavior exercised.** Green unit and integration tests are never sufficient evidence that the app runs; the recurring failure this exists to prevent is an all-green suite over an app that crashes on startup. Use the F3 suite where one covers it, otherwise start the app and drive it in the browser.
3. **Test results are reported faithfully.** Failures quoted with their output; any tier skipped or narrowed stated, with why.
4. **New tests are placed at the correct level and respect the dependency restrictions.** A misplaced test is moved, not grandfathered in.

If step 2 reveals a failure the tests missed, add the missing test before finishing — the gap in the pyramid is itself a bug.

## 7. Run-time budget (hard gates)

- **The combined fast tiers must complete in under 5 minutes locally**, L1 + F1 alone in seconds. A hard gate, because "Definition of done for agents" (§6) requires running them in full on every change and that only survives if the run stays cheap. **Exceeding the budget makes restoring it priority work** — push tests down the pyramid, delete redundant ones, parallelize — never resolved by skipping runs.
- Keep L3/F3 few and thin. Before adding one, ask what it proves that nothing below can; if the answer is nothing, do not add it.
- Slow-tier tests must be organized by capability so the selective runs "Definition of done for agents" (§6) allows are actually possible.

## 8. Flakiness policy

A test that passes and fails intermittently without code changes is a bug in the suite:

- **Never retry-to-green.** It masks either a real intermittent bug or a broken test; both must be diagnosed, not laundered.
- **Never weaken assertions** to fix flakiness — no removed checks, widened tolerances or sleeps.
- Fix it immediately or **quarantine** it (out of the gating run, tracked as an open bug with an owner). A test that stays quarantined is deleted; a suite must consist only of tests whose failures mean something.

## 9. Directory and naming conventions

Tests are physically separated by level so each level can be run and gated independently:

```
apps/api/tests/
  unit/            # L1: no real dependencies
  integration/     # L2: own vertical deps only
  system/          # L3: backend, full deps, no browser
packages/shared/tests/unit/                      # L1
packages/connectors/*/tests/contract/            # the live contract tests (§3): scheduled runs only
apps/web/tests/
  unit/            # F1: no real dependencies
  service/         # F2: this service's frontend + backend only
tests/e2e/         # F3: full stack, real browser — repo root, because it belongs to no package
```

Level separation and one-command-per-level runnability are what is mandatory. Per the levels-are-roles rule, levels with no reason to exist yet stay absent — `system/`, `service/` and the connector `contract/` folders are unbuilt today.

**F3 gets its own stack and a database rebuilt per run.** The browser tier does not share the database the application is developed against: it starts a second copy of the application on its own ports, against its own storage, rebuilt before every run — the register restored from a migrated-and-seeded template, each account's own store created empty by the run's first request, since nothing outside the Worker can write to a Durable Object. Two things follow: test data never accumulates in the development database, and development never decides whether a test passes. The restore is a file copy rather than a re-run of the migrations because that is three orders of magnitude cheaper (5ms against 7s, nearly all process startup), which is what makes "fresh every run" affordable enough to be unconditional. The limit: specs within one run still share that storage, so a test asserts on rows it created rather than on totals.

**A stack that dies mid-run fails the run and says so, once.** `wrangler dev` can quit on a transient it ought to survive ([workers-sdk#15317](https://github.com/cloudflare/workers-sdk/issues/15317)), and Playwright watches its web server only while starting it — so every walk after that point used to fail on a symptom of its own and read like a dozen unrelated bugs. Now the stack prints why it went, reading the reason out of Wrangler's own log because what it prints to the terminal is often empty, and the walk that discovers the stack is gone fails while the rest are skipped naming it. **Nothing is retried and no run turns green**: skipping begins only after something has already failed, so a stack going away — which may be the application that has become unstable — is always visible as a red run.

**That transient is patched out rather than tolerated**, by a pinned `pnpm` patch that carries the incident, the reasoning and what a version bump costs (`pnpm-workspace.yaml`). Two consequences reach beyond it: the record is ordinary noise in Wrangler's log now, so `fatalReason` reads past that one pairing of reason and cause and no other (`scripts/lib/stack.mjs`); and the noise the same event makes in the *Worker's* log is a different thing again, owned by ["Close the live-updates stream quietly when a browser walks away" (issue 128)](https://github.com/michaelvanhoutte/cockpit/issues/128).

**A walk waits for the change, not for the picture of it.** Twice an intermittent CI failure has been a walk acting on something the browser had drawn but had not yet sent or read back: a workspace switched but not yet loaded, and a panel resize drawn on every pointer move and saved only when the hand stops — reloading over that request cancelled it, and the panel came back the width it started at. Where something on screen tells "drawn" from "kept" apart, wait on that; where nothing does, wait on the server's answer to the command (`answerTo`, `tests/e2e/panels.test.ts`).

**F3 runs every spec on more than one screen.** A capability is claimed to work *for a user*, and the user is on a phone as often as a desktop, so each spec runs under a desktop viewport with a mouse and a phone viewport with touch rather than one standing in for the other. Not a browser matrix: both are Chromium, and a second engine is a separate decision. Where an interaction exists on only one form factor (a swipe, a hover-revealed control) it is a different capability and gets its own spec. This cannot be pushed down the pyramid, which looks like a violation of "the testing pyramid is a cost model" (§1) and is not: the F1 runner is jsdom, which has no layout engine and reports every element as zero-sized, so viewport-dependent rendering and the touch event path are physically unprovable below a real browser.

Each level gets its own runner command (`test:unit`, `test:integration`, `test:system`, `test:f-unit`, `test:f-service`, `test:e2e`, `test:contract`), plus `test:fast` and `test:all`. CI runs `test:all` on merge and `test:contract` on schedule.

### 9.1 Tests are named in the product's language, not the implementation's

The outer `describe` is a **feature area of the product** — the parts a person would name if asked what the app does. `tools/test-explorer/concepts.json` is the list, and it nests the way the product does: Accounts (Sign-in, User management), Workspaces (Inbox — Capture, Triage; Dashboards — Panels, Focus; Workspace management, Connector management), Across the app (Menus, Deleting, Ordering, Selection, Live updates, Updating), Associations, Offline. The block inside states the rule in product language; the cases are a table inside that body. The runner then prints the statement list itself, so nothing is stored separately and nothing goes stale.

The area is deliberately not the entity and not the operation: `item.setStatus`, `command.idempotency` and `item.change` all name an object or a function, and a statement list built from those cannot be read as a description of what the app does. It is also not the file — one file commonly spans several areas, and one area spans several files and levels.

**The Glossary at the end of `docs/functional-definition.md` is the binding vocabulary**, and the architecture document is the mechanism whose words must not appear in anything the runner prints. This is checkable rather than a matter of taste: a word in `docs/architecture.md` but not in the functional definition is an implementation word. "Command", "envelope", "tombstone", "idempotency" and "last-write-wins" are all real, correct, and belong inside the test body. Where the product does something the Glossary has no word for, the Glossary gains the word in the same change — a private synonym invented in a test file is how the two vocabularies drift apart.

This applies to **everything the runner prints**, case labels included: an `it.each` printing `set_status` puts the mechanism into the statement list exactly as a mechanism-named `describe` would. The table carries a product-language field instead.

The failure this prevents is a statement list that cannot be read as a description of the product, at which point nobody can review whether the right things are being proven. Reviewability was long the only reason; rule 6 of the mandatory coverage rules names a second, because a rule phrased as an end state also fails when the logic is right and the wiring is wrong.

## 10. Enforcement

- A review must reject: tests at the wrong level; upward duplication of coverage; L1/F1 tests with real dependencies or interaction-choreography assertions; L2/F2 tests with horizontal dependencies; an L2/L3/F2 test bypassing the real interface by calling an internal function; capabilities without an F-level test; and any "done" claim not backed by the runs required in "Definition of done for agents" (§6).
- Where tooling allows, enforce mechanically rather than by review: network and filesystem access disabled in the unit runner, lint rules banning API-client imports under unit directories, CI jobs split per level, and the §7 budget checked in CI. Prefer making violations impossible over catching them in review.
- `CLAUDE.md` must require reading this document before writing or modifying tests, and must document the one-command way to start the application, because §6.2 is only enforceable if starting the app is trivial.
