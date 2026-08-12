# Testing Strategy & Test Automation Rules

**Status:** v0.2, authoritative. These rules are binding for every agent (and human) writing or modifying tests in this repository. They exist because writing tests is now nearly free, but *running* them is not. Every test added to this codebase is a permanent tax on every future change, paid by every agent and every CI run from now on. Cheap to write does not mean cheap to own.

## 1. Core principle: the testing pyramid is a cost model

Tests are ordered in levels. Each level up is an order of magnitude slower to run, harder to debug, and more brittle. Therefore:

> **Always write a test at the lowest level that can prove the behavior. Only escalate to a higher level for the specific things the lower level physically cannot verify.**

This is not a stylistic preference. The decision procedure is:

1. Can a **unit test** prove this behavior? If yes, write a unit test. Stop.
2. If not (the behavior depends on a real vertical dependency, e.g. a real database query, a real schema, real serialization), write an **integration test** covering *only the part that could not be unit tested*.
3. If not (the behavior only exists when services talk to each other), write a **system test** covering *only the cross-service wiring*.
4. For anything user-visible, the same logic applies on the frontend side (unit, then service-frontend, then end-to-end).

Duplicating coverage upward is a violation. If a unit test already proves the calculation is correct, the integration test must not re-prove the calculation; it proves only that the calculation is *reachable and wired correctly* through the real dependency.

## 2. Test level definitions and dependency restrictions

Two directions of dependency are distinguished:

- **Vertical dependencies:** infrastructure owned by the service under test. Its own database, its own message queue, its own file storage, its own cache.
- **Horizontal dependencies:** anything crossing a service boundary. Other services, third-party APIs (Slack, Notion, Teams, WhatsApp, Mail providers), the network in general.

### Backend levels

| Level | Vertical deps | Horizontal deps | Purpose |
|---|---|---|---|
| **L1: Unit** | **No real ones.** | **No real ones.** | Prove logic: calculations, branching, validation, error paths, edge cases. This is where correctness is exhaustively tested. |
| **L2: Integration** | Allowed (real DB, real queue, real storage of *this* service) | **Forbidden. Use fakes for all cross-service calls.** | Prove that the service's logic works against its own real infrastructure: queries return what the code assumes, migrations match the models, transactions behave. |
| **L3: System** | Allowed, full | Allowed, full (real services; third parties per §3) | Backend-only. Prove that services wired together actually work end to end at the API level. No browser. |

Hard rules per level:

- **L1 unit tests may not touch:** the filesystem, the network, a database, a clock (inject time), environment variables, global state, or any other process. If a test needs any of those, it is not a unit test; move it up a level or refactor the code so the logic is testable in isolation.
- **L2 integration tests** exercise one service plus its own infrastructure, nothing else. A test that spins up two services is a system test, no matter what folder it sits in.
- **L3 system tests** are the only backend tests allowed to cross service boundaries.

### Mocking discipline (applies to L1 and F1)

"No real dependencies" does not mean "mock everything". The order of preference is:

1. **Prefer pure units over mocks.** Design code so that logic takes data in and returns data out. A pure function needs no mocks at all, and code that needs heavy mocking to unit test is a design smell to fix, not a mocking exercise to complete.
2. **Where a boundary must be replaced, replace it at the edge** (the API client, the repository, the clock), not deep inside the code under test.
3. **Assert on outcomes, not interactions.** A unit test verifies what the code *produced* (return value, resulting state, emitted error), not the exact sequence of calls it made to its mocks. Tests that choreograph mock call sequences verify the code's conversation with its mocks rather than its behavior; they are brittle, they survive real breakage, and they are a violation of this document.

The failure mode this guards against: a mock-heavy suite that stays green while the mocks drift from reality and the real application breaks. The pyramid's upper levels (§4.1, §5.2) exist to catch that drift, but the first line of defense is not building the drift in.

### Frontend levels

| Level | Allowed dependencies | Purpose |
|---|---|---|
| **F1: Frontend unit** | **No real ones** (replace API clients, stores, router, timers; same discipline as above). | Prove component/view-model logic: rendering branches, state transitions, formatting, input validation. |
| **F2: Service-frontend** | The frontend plus *only its own service's* backend (or a faithful local fake of it). No other services, no third-party APIs. | Prove the frontend and its own backend agree: contracts, payload shapes, error handling, loading states. |
| **F3: End-to-end** | Everything real (third parties per §3). Real browser. | Prove that a user-facing capability actually works when the whole system is tied together. |

### Levels are roles, not mandatory folders

The six levels describe *roles*. They do not all have to be populated at all times. Cockpit today is a single frontend plus third-party integrations; as long as there is only one service, there is no horizontal boundary to cross except third parties, and L2 and L3 largely collapse into each other. Do not invent tests (or empty folders) just to populate the taxonomy. The levels become distinct the moment a second service exists (e.g. a separate task-creator service), and new tests must then be placed according to the full model.

## 3. Third-party dependencies (Slack, Notion, Teams, WhatsApp, Mail)

Third-party APIs are the hardest horizontal dependency: real sandboxes are often unavailable, slow, rate-limited, or flaky. The rules:

1. **L1/F1:** third parties never appear, per §2.
2. **L2/F2 and per-change L3/F3 runs** use **local fakes or recorded fixtures** of the third-party APIs. These must be faithful (built from real recorded responses, not hand-invented shapes) and live in the repository.
3. **Live contract tests:** a small, separate suite runs on a schedule (e.g. nightly), never per-change, against the real third-party APIs. Its only job is to verify that the fakes and fixtures still match reality: authentication still works, response shapes are unchanged, the endpoints behave as recorded. When a contract test fails, updating the fixture (and whatever code the change breaks) becomes priority work.

Without rule 3, the pyramid has a silent failure mode: every level stays green against a fake of Slack while real Slack has changed. Rule 3 is what makes rules 1 and 2 safe.

## 4. What each level is *for* (division of responsibility)

- **Correctness lives at the bottom.** Exhaustive input/output testing, boundary values, and failure behavior ("does it fail correctly?") belong in L1/F1, and in L2/F2 only where real infrastructure is intrinsic to the behavior.
- **The top of the pyramid confirms wiring, nothing more.** System tests (L3) and end-to-end tests (F3) exist to answer exactly one question: *when everything is tied together, does it actually work?* They walk the happy path of a capability, plus at most one representative failure path if the failure crosses layers. They do **not** re-test business logic, do **not** enumerate edge cases, and do **not** assert on details already proven lower down. A large E2E suite re-testing logic is a defect of the test suite itself.
- Rule of thumb: if an L3/F3 test fails and the fix would be in pure logic, coverage was missing lower down. Add the lower-level test, keep the top-level test thin.

## 5. Mandatory coverage rules

1. **Every capability must have at least one frontend test (F3, or F2 where F3 genuinely cannot reach it) that validates the capability works for a user.** A capability is a user-facing feature as described in the functional definition (e.g. "snooze an inbox item", "mark a goal for this week", "swipe to remove a row"). Unit and integration tests alone never count as proof that a capability works.
2. **Every bug fix gets a regression test at the lowest level that reproduces the bug.**
3. **New logic ships with L1/F1 tests in the same change.** Tests are not a follow-up task.

## 6. Definition of done for agents (non-negotiable)

An agent may only claim that something works after **all** of the following:

1. **The required tests have been run and pass.**
   - **Fast tiers (L1, L2, F1, F2): always run in full.** No selection, no "only the tests near my change".
   - **Slow tiers (L3, F3): the agent must run at least every test covering the capabilities touched by the change.** Selection is by capability, and when in doubt about whether a test is affected, include it. CI runs the full suite on every merge, so a wrong selection is caught, but "I selected too narrowly" is never a valid explanation for a broken merge.
2. **The application has actually been started and the changed behavior exercised.** Green unit and integration tests are *never* sufficient evidence that the application runs. The recurring failure mode this document exists to prevent: an agent writes many L1/L2 tests, everything is green, and the app crashes on startup. Therefore: start the app (or the relevant service), load it, and exercise the changed capability, via the F3 suite when one covers it, or manually via the browser tooling when it does not yet.
3. **Test results are reported faithfully.** If any test fails, say so with the output. If a tier was skipped or narrowed, say so and why. Never report success on a partial run without disclosing what was left out.
4. **New tests are placed at the correct level per §1 and respect the dependency restrictions per §2.** A test placed at the wrong level must be moved, not grandfathered in.

If step 2 reveals a failure that all tests missed, the agent must also add the missing test (per §5) before finishing, because the gap in the pyramid is itself a bug.

## 7. Run-time budget (hard gates)

- **The combined fast tiers (L1 + L2 + F1 + F2) must complete in under 5 minutes locally**, with L1 + F1 alone in seconds. This is a hard gate, not an aspiration: the definition of done in §6 requires running the fast tiers in full on every change, and that requirement only survives if the run stays cheap. **The moment the budget is exceeded, restoring it becomes priority work** (push tests down the pyramid, delete redundant ones, parallelize), and it is never resolved by skipping runs.
- L3/F3 are the expensive tier; keep them few and thin. When adding an L3/F3 test, ask: "what does this prove that nothing below can?" If the answer is nothing, don't add it.
- Slow-tier tests must be tagged or organized by capability so that the selective runs allowed in §6.1 are actually possible.

## 8. Flakiness policy

A test that passes and fails intermittently without code changes is a **flaky test**, and it is treated as a bug in the suite:

- **Never retry-to-green.** Re-running a failing test until it passes masks either a real intermittent bug in the product or a broken test; both must be diagnosed, not laundered.
- **Never fix flakiness by weakening assertions** (removing checks, widening tolerances, adding sleeps).
- A flaky test is either fixed immediately or **quarantined** (excluded from the gating run, tracked as an open bug with an owner). A quarantined test that stays quarantined is deleted; a suite must consist only of tests whose failures mean something.

## 9. Directory and naming conventions

Tests must be physically separated by level so each level can be run (and gated) independently:

```
tests/
  unit/            # L1: no real dependencies
  integration/     # L2: own vertical deps only
  system/          # L3: backend, full deps, no browser
  contract/        # §3.3: live third-party contract tests, scheduled runs only
frontend/tests/
  unit/            # F1: no real dependencies
  service/         # F2: this service's frontend + backend only
  e2e/             # F3: full stack, real browser
```

(Exact paths may be adapted to the final project layout, but the level separation and one-command-per-level runnability are mandatory. Per §2, levels that have no reason to exist yet stay absent.)

Each level gets its own runner command (e.g. `test:unit`, `test:integration`, `test:system`, `test:f-unit`, `test:f-service`, `test:e2e`, `test:contract`), plus `test:fast` (all fast tiers) and `test:all`. CI runs `test:all` on merge and `test:contract` on schedule; agents follow §6.

## 10. Enforcement

- A code review (human or agent) must reject: tests at the wrong level, upward duplication of coverage, L1/F1 tests with real dependencies or interaction-choreography assertions (§2, Mocking discipline), L2/F2 tests with horizontal dependencies, capabilities without an F-level test, and any "done" claim not backed by the runs required in §6.
- Where tooling allows, restrictions must be enforced mechanically rather than by review: network and filesystem access disabled in the unit-test runner, lint rules banning API-client imports under the unit-test directories, CI jobs split per level so misplaced tests are visible, and the fast-tier time budget (§7) checked in CI. Prefer making violations impossible over catching them in review.
- The project's `CLAUDE.md` must require reading this document before writing or modifying tests, and must document the one-command way to start the application, because §6.2 is only enforceable if starting the app is trivial.
